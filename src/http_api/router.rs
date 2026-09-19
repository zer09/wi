use std::{net::SocketAddr, sync::Arc};

use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::{
    ApiConfig, ConfigError,
    boundary::{self, Boundary},
    dto::{self, ApiError, ErrorView},
    input, validate_listener,
    wire::{Cursor, parse_page_limit, parse_sequence},
};
use crate::{
    service::{CancelDisposition, RunClient, RunHost},
    storage::{
        ApplicationSessionId, CreateSession, OperationId, RunId, StorageError, StorageErrorKind,
    },
};

mod events;
mod runs;

struct ApiState {
    host: Arc<RunHost>,
    client: RunClient,
    config: ApiConfig,
    boundary: Boundary,
    network_close: CancellationToken,
    #[cfg(test)]
    run_hooks: Arc<runs::test_hooks::Hooks>,
    #[cfg(test)]
    event_hooks: Arc<events::test_hooks::Hooks>,
}

pub(super) fn router(
    host: Arc<RunHost>,
    config: ApiConfig,
    listener: SocketAddr,
    network_close: CancellationToken,
) -> Result<Router, ConfigError> {
    router_inner(
        host,
        config,
        listener,
        network_close,
        #[cfg(test)]
        Default::default(),
        #[cfg(test)]
        Default::default(),
    )
}

fn router_inner(
    host: Arc<RunHost>,
    config: ApiConfig,
    listener: SocketAddr,
    network_close: CancellationToken,
    #[cfg(test)] run_hooks: Arc<runs::test_hooks::Hooks>,
    #[cfg(test)] event_hooks: Arc<events::test_hooks::Hooks>,
) -> Result<Router, ConfigError> {
    validate_listener(listener)?;
    let boundary = Boundary::new(&config, listener)?;
    let client = host.client();
    Ok(Router::new()
        .fallback(handle)
        .with_state(Arc::new(ApiState {
            host,
            client,
            config,
            boundary,
            network_close,
            #[cfg(test)]
            run_hooks,
            #[cfg(test)]
            event_hooks,
        })))
}

#[derive(Clone, Copy)]
enum Route<'a> {
    Settings,
    Sessions,
    Session(&'a str),
    Rename(&'a str),
    Refresh(&'a str),
    History(&'a str),
    Run(&'a str, &'a str),
    Cancel(&'a str, &'a str),
    Operation(&'a str, &'a str),
    Tasks(&'a str),
    Events(&'a str),
}

impl<'a> Route<'a> {
    fn find(path: &'a str) -> Option<Self> {
        let parts: Vec<_> = path.split('/').collect();
        match parts.as_slice() {
            ["", "v1", "settings"] => Some(Self::Settings),
            ["", "v1", "sessions"] => Some(Self::Sessions),
            ["", "v1", "sessions", sid] => Some(Self::Session(sid)),
            ["", "v1", "sessions", sid, "rename"] => Some(Self::Rename(sid)),
            ["", "v1", "sessions", sid, "refresh"] => Some(Self::Refresh(sid)),
            ["", "v1", "sessions", sid, "history"] => Some(Self::History(sid)),
            ["", "v1", "sessions", sid, "runs", rid] => Some(Self::Run(sid, rid)),
            ["", "v1", "sessions", sid, "runs", rid, "cancel"] => Some(Self::Cancel(sid, rid)),
            ["", "v1", "sessions", sid, "operations", oid] => Some(Self::Operation(sid, oid)),
            ["", "v1", "sessions", sid, "runs"] => Some(Self::Tasks(sid)),
            ["", "v1", "sessions", sid, "events"] => Some(Self::Events(sid)),
            _ => None,
        }
    }

    fn supports(self, method: &str) -> bool {
        match self {
            Self::Sessions => matches!(method, "GET" | "POST"),
            Self::Rename(_) | Self::Refresh(_) | Self::Cancel(..) | Self::Tasks(_) => {
                method == "POST"
            }
            _ => method == "GET",
        }
    }

    fn allow(self) -> &'static str {
        match self {
            Self::Sessions => "GET, POST, OPTIONS",
            Self::Rename(_) | Self::Refresh(_) | Self::Cancel(..) | Self::Tasks(_) => {
                "POST, OPTIONS"
            }
            _ => "GET, OPTIONS",
        }
    }

    fn query_keys(self, method: &str) -> &'static [&'static str] {
        match self {
            Self::Sessions if method == "GET" => &["after_id", "limit"],
            Self::History(_) => &["after", "through", "limit"],
            Self::Events(_) => &["after"],
            _ => &[],
        }
    }

    fn session(self) -> Result<Option<ApplicationSessionId>, ApiError> {
        let sid = match self {
            Self::Settings | Self::Sessions => return Ok(None),
            Self::Session(sid)
            | Self::Rename(sid)
            | Self::Refresh(sid)
            | Self::History(sid)
            | Self::Run(sid, _)
            | Self::Cancel(sid, _)
            | Self::Operation(sid, _)
            | Self::Tasks(sid)
            | Self::Events(sid) => sid,
        };
        match self {
            Self::Run(_, rid) | Self::Cancel(_, rid) => {
                parse_id::<RunId>(rid)?;
            }
            Self::Operation(_, oid) => {
                parse_id::<OperationId>(oid)?;
            }
            _ => (),
        }
        parse_id(sid).map(Some)
    }
}

async fn handle(State(state): State<Arc<ApiState>>, mut request: Request) -> Response {
    let mut origin = None;
    let result = async {
        state
            .boundary
            .check_authority(request.headers(), request.uri())
            .map_err(ErrorView::api)?;
        origin = state
            .boundary
            .check_origin(request.headers())
            .map_err(ErrorView::api)?;
        if request.method() == Method::OPTIONS {
            return Ok(preflight(&request, origin.is_some()).map_err(ErrorView::api)?);
        }
        boundary::authenticate(request.headers_mut(), &state.config).map_err(ErrorView::api)?;
        tokio::select! {
            biased;
            // End only the HTTP waiter. Dispatched runs and admitted SQL retain their owners.
            _ = state.network_close.cancelled() => Err(ErrorView::api(ApiError::Closed)
                .with_certainty(crate::storage::CommitCertainty::Unknown).into()),
            result = dispatch(&state, request) => result,
        }
    }
    .await;
    let mut response = match result {
        Ok(response) => response,
        Err(error) => error_response(*error),
    };
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    if let Some(origin) = origin {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    response
}

fn preflight(request: &Request, has_origin: bool) -> Result<Response, ApiError> {
    if !has_origin {
        return Err(ApiError::OriginForbidden);
    }
    let route = Route::find(request.uri().path()).ok_or(ApiError::NotFound)?;
    route.session()?;
    let method = boundary::single(
        request.headers(),
        header::ACCESS_CONTROL_REQUEST_METHOD.as_str(),
    )?
    .ok_or(ApiError::InvalidRequest)?;
    if !route.supports(method) {
        return Ok(method_not_allowed(route));
    }
    boundary::preflight_headers(request.headers())?;
    input::query(request.uri().query(), route.query_keys(method))?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(if method == "GET" { "GET" } else { "POST" }),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Authorization, Content-Type, Last-Event-ID"),
    );
    Ok(response)
}

fn method_not_allowed(route: Route<'_>) -> Response {
    let mut response = error_response(ErrorView::api(ApiError::MethodNotAllowed));
    response
        .headers_mut()
        .insert(header::ALLOW, HeaderValue::from_static(route.allow()));
    response
}

async fn dispatch(state: &ApiState, request: Request) -> Result<Response, Box<ErrorView>> {
    let uri = request.uri().clone();
    let route = Route::find(uri.path()).ok_or_else(|| ErrorView::api(ApiError::NotFound))?;
    if !route.supports(request.method().as_str()) {
        return Ok(method_not_allowed(route));
    }
    let session_id = route.session().map_err(ErrorView::api)?;
    let query = input::query(uri.query(), route.query_keys(request.method().as_str()))
        .map_err(ErrorView::api)?;
    let limit = query
        .get("limit")
        .map(|s| parse_page_limit(s))
        .transpose()
        .map_err(|_| ErrorView::api(ApiError::InvalidRequest))?
        .unwrap_or(32);
    let after_id = query
        .get("after_id")
        .map(|s| parse_id(s))
        .transpose()
        .map_err(ErrorView::api)?;
    let after = query
        .get("after")
        .map(|s| s.parse::<Cursor>())
        .transpose()
        .map_err(|_| ErrorView::api(ApiError::CursorInvalid))?;
    let after = if matches!(route, Route::Events(_)) {
        events::cursor(after, request.headers()).map_err(ErrorView::api)?
    } else {
        after
    };
    let through = query
        .get("through")
        .map(|s| parse_sequence(s))
        .transpose()
        .map_err(|_| ErrorView::api(ApiError::CursorInvalid))?;
    if let (Some(after), Some(sid)) = (&after, &session_id) {
        after
            .validate(sid, through.unwrap_or(i64::MAX as u64))
            .map_err(|_| ErrorView::api(ApiError::CursorInvalid))?;
    }
    let post = request.method() == Method::POST;
    let (parts, body) = request.into_parts();
    let bytes = input::body(&parts.headers, body, post)
        .await
        .map_err(ErrorView::api)?;
    let store = state.host.storage();
    match route {
        Route::Settings => Ok(ok(dto::SettingsView::from(state.config.settings()))),
        Route::Sessions if post => {
            let command: input::Create = input::json(&bytes).map_err(ErrorView::api)?;
            if state
                .config
                .settings()
                .workspace(&command.workspace)
                .is_none()
            {
                return Err(ErrorView::api(ApiError::WorkspaceForbidden).into());
            }
            let input =
                CreateSession::new(command.operation_id, command.title, Some(command.workspace))
                    .map_err(storage)?;
            let created = store.create_session(input).await.map_err(storage)?;
            let status = if created.duplicate() {
                StatusCode::OK
            } else {
                StatusCode::CREATED
            };
            Ok((status, Json(dto::CreateView::from(&created))).into_response())
        }
        Route::Sessions => {
            let page = store
                .list_sessions(after_id, limit as u64)
                .await
                .map_err(storage)?;
            Ok(ok(dto::CatalogView::from(&page)))
        }
        Route::Cancel(_, rid) => {
            input::json::<input::Empty>(&bytes).map_err(ErrorView::api)?;
            let sid = session_id.unwrap();
            let rid = parse_id(rid).map_err(ErrorView::api)?;
            let (status, disposition) = match state.client.cancel(&sid, &rid) {
                CancelDisposition::Requested => {
                    (StatusCode::ACCEPTED, dto::CancelDisposition::Requested)
                }
                CancelDisposition::NotTracked => {
                    (StatusCode::OK, dto::CancelDisposition::NotTracked)
                }
                CancelDisposition::Closed => return Err(ErrorView::api(ApiError::Closed).into()),
            };
            Ok((status, Json(dto::CancelView::new(sid, rid, disposition))).into_response())
        }
        Route::Rename(_) => {
            let command: input::Rename = input::json(&bytes).map_err(ErrorView::api)?;
            let session = store
                .open_session(session_id.unwrap())
                .await
                .map_err(storage)?;
            let commit = session
                .rename(command.operation_id, command.title)
                .await
                .map_err(storage)?;
            // A later catalog failure cannot revoke the canonical receipt.
            let refresh = if commit.cleanup_warning().is_some() {
                dto::CatalogRefresh::NotAttempted
            } else {
                match session.refresh_catalog().await {
                    Ok(result) => result.into(),
                    Err(_) => dto::CatalogRefresh::Failed,
                }
            };
            Ok(ok(dto::RenameView::new(&commit, refresh)))
        }
        Route::Refresh(_) => {
            input::json::<input::Empty>(&bytes).map_err(ErrorView::api)?;
            let sid = session_id.unwrap();
            let session = store.open_session(sid.clone()).await.map_err(storage)?;
            let refresh = session.refresh_catalog().await.map_err(storage)?;
            Ok(ok(dto::RefreshView::new(sid, refresh)))
        }
        Route::Session(_) | Route::History(_) | Route::Run(..) | Route::Operation(..) => {
            let sid = session_id.unwrap();
            let session = store.open_session(sid.clone()).await.map_err(storage)?;
            match route {
                Route::Session(_) => Ok(ok(dto::SessionView::from(
                    &session.manifest().await.map_err(storage)?,
                ))),
                Route::History(_) => {
                    let page = session
                        .history_page(
                            after.as_ref().map_or(0, Cursor::sequence),
                            through,
                            limit as u64,
                        )
                        .await
                        .map_err(|error| {
                            if error.kind() == StorageErrorKind::InvalidInput {
                                ErrorView::api(ApiError::CursorInvalid)
                            } else {
                                storage(error)
                            }
                        })?;
                    Ok(ok(dto::HistoryView::new(sid, &page)
                        .map_err(|_| ErrorView::api(ApiError::CursorInvalid))?))
                }
                Route::Run(_, rid) => {
                    let run = session
                        .run_record(parse_id(rid).map_err(ErrorView::api)?)
                        .await
                        .map_err(storage)?
                        .ok_or_else(|| ErrorView::api(ApiError::NotFound))?;
                    Ok(ok(dto::RunView::from(&run)))
                }
                Route::Operation(_, oid) => {
                    let receipt = session
                        .lookup_receipt(parse_id(oid).map_err(ErrorView::api)?)
                        .await
                        .map_err(storage)?
                        .ok_or_else(|| ErrorView::api(ApiError::NotFound))?;
                    Ok(ok(dto::OperationView::from(&receipt)))
                }
                _ => unreachable!(),
            }
        }
        Route::Tasks(_) => {
            let command = input::json::<input::Task>(&bytes).map_err(ErrorView::api)?;
            let accepted = runs::submit(state, session_id.unwrap(), command).await?;
            Ok((StatusCode::ACCEPTED, Json(accepted)).into_response())
        }
        Route::Events(_) => events::open(state, session_id.unwrap(), after).await,
    }
}

fn parse_id<T: std::str::FromStr>(value: &str) -> Result<T, ApiError> {
    value.parse().map_err(|_| ApiError::InvalidRequest)
}
fn storage(error: StorageError) -> ErrorView {
    ErrorView::storage(&error)
}
fn ok(value: impl Serialize) -> Response {
    Json(value).into_response()
}
fn error_response(error: ErrorView) -> Response {
    let unauthorized = error.status() == 401;
    let mut response = (
        StatusCode::from_u16(error.status()).expect("static status"),
        Json(error),
    )
        .into_response();
    if unauthorized {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
    }
    response
}

#[cfg(test)]
mod tests;
