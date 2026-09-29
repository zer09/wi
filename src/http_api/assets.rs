use axum::{
    body::{Body, HttpBody},
    extract::Request,
    http::{HeaderValue, Method, header},
    response::Response,
};

use super::dto::ApiError;

const HTML_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

pub(super) fn response(request: &Request) -> Option<Result<Response, ApiError>> {
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return None;
    }
    let (bytes, mime): (&'static [u8], &'static str) = match request.uri().path() {
        "/" | "/index.html" => (
            include_bytes!("../../web/index.html"),
            "text/html; charset=utf-8",
        ),
        "/assets/wi.css" => (
            include_bytes!("../../web/style.css"),
            "text/css; charset=utf-8",
        ),
        "/assets/api.js" => (
            include_bytes!("../../web/dist/api.js"),
            "text/javascript; charset=utf-8",
        ),
        "/assets/app.js" => (
            include_bytes!("../../web/dist/app.js"),
            "text/javascript; charset=utf-8",
        ),
        "/assets/client.js" => (
            include_bytes!("../../web/dist/client.js"),
            "text/javascript; charset=utf-8",
        ),
        "/assets/sse.js" => (
            include_bytes!("../../web/dist/sse.js"),
            "text/javascript; charset=utf-8",
        ),
        "/assets/state.js" => (
            include_bytes!("../../web/dist/state.js"),
            "text/javascript; charset=utf-8",
        ),
        "/assets/view.js" => (
            include_bytes!("../../web/dist/view.js"),
            "text/javascript; charset=utf-8",
        ),
        _ => return None,
    };
    // Require a body already known to be empty. Never wait for unauthenticated input,
    // and reject chunked framing even when it contains only the final empty chunk.
    if request.uri().query().is_some()
        || request.headers().contains_key(header::TRANSFER_ENCODING)
        || !request.body().is_end_stream()
    {
        return Some(Err(ApiError::InvalidRequest));
    }
    let body = if request.method() == Method::HEAD {
        Body::empty()
    } else {
        Body::from(bytes)
    };
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, bytes.len())
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(body)
        .expect("static asset headers");
    if mime == "text/html; charset=utf-8" {
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(HTML_CSP),
        );
    }
    Some(Ok(response))
}
