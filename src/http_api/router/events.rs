use std::{convert::Infallible, time::Duration};

use axum::{
    http::HeaderMap,
    response::sse::{Event, Sse},
};

use super::*;
use crate::storage::{HistoryPage, SessionHandle};

#[cfg(test)]
pub(super) mod test_hooks;
#[cfg(test)]
mod tests;

const PAGE_SIZE: u64 = 32;
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

pub(super) fn cursor(
    after: Option<Cursor>,
    headers: &HeaderMap,
) -> Result<Option<Cursor>, ApiError> {
    let last = boundary::single(headers, "last-event-id")
        .map_err(|_| ApiError::CursorInvalid)?
        .map(str::parse::<Cursor>)
        .transpose()
        .map_err(|_| ApiError::CursorInvalid)?;
    if let (Some(after), Some(last)) = (&after, &last)
        && after != last
    {
        return Err(ApiError::CursorInvalid);
    }
    Ok(after.or(last))
}

pub(super) async fn open(
    state: &ApiState,
    sid: ApplicationSessionId,
    after: Option<Cursor>,
) -> Result<Response, Box<ErrorView>> {
    if state.network_close.is_cancelled() {
        return Err(ErrorView::api(ApiError::Closed).into());
    }
    let session = state
        .host
        .storage()
        .open_session(sid)
        .await
        .map_err(storage)?;
    let after = after.as_ref().map_or(0, Cursor::sequence);
    // Read and validate the captured head before sending HTTP success headers.
    let page = session
        .history_page(after, None, PAGE_SIZE)
        .await
        .map_err(|error| {
            if error.kind() == StorageErrorKind::InvalidInput {
                ErrorView::api(ApiError::CursorInvalid)
            } else {
                storage(error)
            }
        })?;
    #[cfg(test)]
    state.event_hooks.page(after, None, &page).await;
    Ok(stream_response(
        session,
        page,
        after,
        state.network_close.clone(),
        #[cfg(test)]
        state.event_hooks.clone(),
    ))
}

fn stream_response(
    session: SessionHandle,
    mut page: HistoryPage,
    mut after: u64,
    closing: CancellationToken,
    #[cfg(test)] hooks: Arc<test_hooks::Hooks>,
) -> Response {
    #[cfg(test)]
    let reader = hooks.enter();
    let stream = async_stream::stream! {
        #[cfg(test)]
        let _reader = reader;
        let mut through = Some(page.through_sequence());
        let mut heartbeat = tokio::time::Instant::now() + HEARTBEAT_INTERVAL;
        'pages: loop {
            for record in page.records() {
                if closing.is_cancelled() {
                    yield Ok::<_, Infallible>(closed());
                    break 'pages;
                }
                // history_page has already closed its connection and released its lock.
                // Only this bounded page survives a slow network write; no producer runs ahead.
                let event = Event::default()
                    .event("wi.event")
                    .id(format!("{}:{}", session.session_id(), record.sequence()))
                    .json_data(dto::EventView::from(record))
                    .expect("closed EventView serialization");
                after = record.sequence();
                heartbeat = tokio::time::Instant::now() + HEARTBEAT_INTERVAL;
                yield Ok(event);
            }
            let more = page.has_more();
            drop(page);
            if !more {
                if through.is_some() {
                    // Attach immediately after the fixed snapshot using the same canonical source.
                    through = None;
                } else {
                    let poll = tokio::time::sleep(POLL_INTERVAL);
                    tokio::pin!(poll);
                    loop {
                        tokio::select! {
                            biased;
                            _ = closing.cancelled() => {
                                yield Ok(closed());
                                break 'pages;
                            }
                            // Heartbeats also wait until storage has released its guards.
                            _ = tokio::time::sleep_until(heartbeat) => {
                                heartbeat = tokio::time::Instant::now() + HEARTBEAT_INTERVAL;
                                yield Ok(Event::default().comment("keep-alive"));
                            }
                            _ = &mut poll => break,
                        }
                    }
                }
            }
            let result = tokio::select! {
                biased;
                // Dropping this read waiter does not abort storage's owned SQL operation.
                _ = closing.cancelled() => break,
                result = session.history_page(after, through, PAGE_SIZE) => result,
            };
            match result {
                Ok(next) => {
                    #[cfg(test)]
                    hooks.page(after, through, &next).await;
                    page = next;
                },
                Err(error) => {
                    yield Ok(Event::default().event("wi.error")
                        .json_data(ErrorView::storage(&error))
                        .expect("closed ErrorView serialization"));
                    break;
                }
            }
        }
    };
    Sse::new(stream).into_response()
}

fn closed() -> Event {
    Event::default()
        .event("wi.closed")
        .data(r#"{"api_version":1,"reason":"shutdown"}"#)
}
