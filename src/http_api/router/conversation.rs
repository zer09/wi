use std::collections::HashMap;

use axum::{
    body::Body,
    http::{HeaderMap, header},
    response::IntoResponse,
};

use super::{ApiError, ApiState, ErrorView, Response, Route, parse_id, storage};
use crate::{
    conversation::{ContentCursor, ConversationQuery, EntryId, LiveCursor, wire::DisplayJson},
    storage::{ApplicationSessionId, ConversationError, RunId},
};

pub(super) mod events;

pub(super) enum Read {
    Page(ConversationQuery),
    Entry(RunId, EntryId),
    Content(ContentCursor),
    Events(LiveCursor),
}
impl Read {
    pub(super) fn parse(
        route: Route<'_>,
        query: &HashMap<String, String>,
        headers: &HeaderMap,
    ) -> Result<Option<Self>, Box<ErrorView>> {
        let read = match route {
            Route::Conversation(_) => {
                let selection = match (query.get("before"), query.get("within")) {
                    (None, None) => ConversationQuery::Latest,
                    (Some(before), None) => {
                        ConversationQuery::Before(before.parse().map_err(|_| invalid_cursor())?)
                    }
                    (None, Some(within)) => {
                        ConversationQuery::Within(within.parse().map_err(|_| invalid_cursor())?)
                    }
                    (Some(_), Some(_)) => {
                        return Err(ErrorView::api(ApiError::InvalidRequest).into());
                    }
                };
                Self::Page(selection)
            }
            Route::ConversationEntry(_, run, entry) => {
                let run = parse_id(run).map_err(ErrorView::api)?;
                let entry = entry_segment(entry)?;
                Self::Entry(run, entry)
            }
            Route::ConversationContent(_) => Self::Content(
                query
                    .get("cursor")
                    .ok_or_else(|| ErrorView::api(ApiError::InvalidRequest))?
                    .parse()
                    .map_err(|_| invalid_cursor())?,
            ),
            Route::ConversationEvents(_) => {
                let token = query
                    .get("after")
                    .ok_or_else(|| ErrorView::api(ApiError::InvalidRequest))?;
                let last = super::boundary::single(headers, "last-event-id")
                    .map_err(|_| invalid_cursor())?;
                // Compare the decoded query spelling, not just the parsed cursor value.
                if last.is_some_and(|last| last != token) {
                    return Err(invalid_cursor().into());
                }
                Self::Events(token.parse().map_err(|_| invalid_cursor())?)
            }
            _ => return Ok(None),
        };
        Ok(Some(read))
    }

    pub(super) async fn open(
        self,
        state: &ApiState,
        session_id: ApplicationSessionId,
    ) -> Result<Response, Box<ErrorView>> {
        let session = state
            .host
            .storage()
            .open_session(session_id)
            .await
            .map_err(storage)?;
        // Typed reads retire SQL and locks before encoding or network delivery.
        match self {
            Self::Page(query) => {
                let page = session
                    .conversation_page(query)
                    .await
                    .map_err(|error| ErrorView::conversation(&error))?;
                response(DisplayJson::Page(&page))
            }
            Self::Entry(run, entry) => {
                let page = session
                    .conversation_entry(run, entry)
                    .await
                    .map_err(|error| ErrorView::conversation(&error))?;
                response(DisplayJson::EntryPage(&page))
            }
            Self::Events(after) => events::open(state, session, after).await,
            Self::Content(cursor) => {
                let page = session
                    .conversation_content(cursor)
                    .await
                    .map_err(|error| ErrorView::conversation(&error))?;
                response(DisplayJson::EntryPage(&page))
            }
        }
    }
}

fn response(json: DisplayJson<'_>) -> Result<Response, Box<ErrorView>> {
    let bytes = json.encode().map_err(|_| ErrorView::integrity())?;
    Ok((
        [(header::CONTENT_TYPE, "application/json")],
        Body::from(bytes),
    )
        .into_response())
}

fn invalid_cursor() -> ErrorView {
    ErrorView::conversation(&ConversationError::CursorInvalid)
}

fn entry_segment(raw: &str) -> Result<EntryId, Box<ErrorView>> {
    // Decode only this segment. The typed grammar rejects slashes and resource redirection.
    let mut input = raw.bytes();
    let mut decoded = Vec::with_capacity(raw.len());
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let high = input.next().and_then(|b| (b as char).to_digit(16));
            let low = input.next().and_then(|b| (b as char).to_digit(16));
            match (high, low) {
                (Some(high), Some(low)) => decoded.push((high * 16 + low) as u8),
                _ => return Err(invalid_cursor().into()),
            }
        } else {
            decoded.push(byte);
        }
    }
    std::str::from_utf8(&decoded)
        .ok()
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| invalid_cursor().into())
}
