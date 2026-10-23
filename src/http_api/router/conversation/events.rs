use std::{convert::Infallible, time::Duration};

use axum::response::{
    IntoResponse,
    sse::{Event, Sse},
};
use tokio_util::sync::CancellationToken;

use super::{ApiState, DisplayJson, ErrorView, Response};
use crate::{
    conversation::{ConversationChanges, LiveCursor},
    storage::SessionHandle,
};

#[cfg(test)]
pub(crate) mod test_hooks;

const POLL_INTERVAL: Duration = Duration::from_millis(250);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

pub(super) async fn open(
    state: &ApiState,
    session: SessionHandle,
    after: LiveCursor,
) -> Result<Response, Box<ErrorView>> {
    if state.network_close.is_cancelled() {
        return Err(ErrorView::api(super::ApiError::Closed).into());
    }
    // Validate the resource and prepare bounded wire bytes before HTTP success.
    let batch = session
        .conversation_changes(after.clone())
        .await
        .map_err(|error| ErrorView::conversation(&error))?;
    let event = encode(&batch)?;
    #[cfg(test)]
    state.display_hooks.retired(&after, &batch).await;
    Ok(stream_response(
        session,
        batch,
        event,
        after,
        state.network_close.clone(),
        #[cfg(test)]
        state.display_hooks.clone(),
    ))
}

fn encode(batch: &ConversationChanges) -> Result<Event, Box<ErrorView>> {
    let bytes = DisplayJson::Changes(batch)
        .encode()
        .map_err(|_| ErrorView::integrity())?;
    let data = String::from_utf8(bytes).map_err(|_| ErrorView::integrity())?;
    Ok(Event::default()
        .event("wi.conversation")
        .id(batch.next_after().to_string())
        .data(data))
}

fn stream_response(
    session: SessionHandle,
    mut batch: ConversationChanges,
    mut event: Event,
    mut after: LiveCursor,
    closing: CancellationToken,
    #[cfg(test)] hooks: std::sync::Arc<test_hooks::Hooks>,
) -> Response {
    #[cfg(test)]
    let guard = hooks.observer();
    let stream = async_stream::stream! {
        #[cfg(test)]
        let _guard = guard;
        let heartbeat_interval = HEARTBEAT_INTERVAL;
        #[cfg(test)]
        let heartbeat_interval = hooks.heartbeat_interval().unwrap_or(heartbeat_interval);
        let mut heartbeat = tokio::time::Instant::now() + heartbeat_interval;
        'batches: loop {
            if closing.is_cancelled() {
                yield Ok::<_, Infallible>(closed());
                break;
            }
            let progress = !batch.changes().is_empty() || batch.next_after() != &after;
            let more = batch.has_more();
            after = batch.next_after().clone();
            // No connection, lock, or producer survives delivery. Keep only this encoded frame.
            drop(batch);
            if progress {
                heartbeat = tokio::time::Instant::now() + heartbeat_interval;
                yield Ok(event);
            }
            if !more {
                let poll = tokio::time::sleep(POLL_INTERVAL);
                tokio::pin!(poll);
                loop {
                    tokio::select! {
                        biased;
                        _ = closing.cancelled() => {
                            yield Ok(closed());
                            break 'batches;
                        }
                        _ = tokio::time::sleep_until(heartbeat) => {
                            heartbeat = tokio::time::Instant::now() + heartbeat_interval;
                            yield Ok(Event::default().comment("keep-alive"));
                        }
                        _ = &mut poll => break,
                    }
                }
            }
            let result = tokio::select! {
                biased;
                // Storage keeps ownership of admitted SQL if this observer goes away.
                _ = closing.cancelled() => break,
                result = session.conversation_changes(after.clone()) => result,
            };
            match result {
                Ok(next) => {
                    match encode(&next) {
                        Ok(encoded) => event = encoded,
                        Err(error) => {
                            yield Ok(failed(*error));
                            break;
                        }
                    }
                    #[cfg(test)]
                    tokio::select! {
                        biased;
                        _ = closing.cancelled() => break,
                        _ = hooks.retired(&after, &next) => (),
                    }
                    batch = next;
                }
                Err(error) => {
                    yield Ok(failed(ErrorView::conversation(&error)));
                    break;
                }
            }
        }
    };
    Sse::new(stream).into_response()
}

fn failed(error: ErrorView) -> Event {
    Event::default()
        .event("wi.error")
        .json_data(error)
        .expect("closed ErrorView serialization")
}

fn closed() -> Event {
    Event::default()
        .event("wi.closed")
        .data(r#"{"api_version":1,"reason":"shutdown"}"#)
}
