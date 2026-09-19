use std::collections::HashMap;

use axum::{
    body::Body,
    http::{HeaderMap, header},
};
use futures_util::StreamExt;
use serde::{Deserialize, de::DeserializeOwned};

use super::{boundary::single, dto::ApiError};
use crate::{
    MAX_INPUT_BYTES,
    storage::{OperationId, RunId},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Create {
    pub operation_id: OperationId,
    pub title: String,
    pub workspace: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Rename {
    pub operation_id: OperationId,
    pub title: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Task {
    pub operation_id: OperationId,
    pub run_id: RunId,
    pub text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Empty {}

pub(super) fn json<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ApiError> {
    // Serde structs can also accept arrays. The HTTP command grammar requires an object.
    if bytes.iter().find(|b| !b.is_ascii_whitespace()) != Some(&b'{') {
        return Err(ApiError::InvalidRequest);
    }
    serde_json::from_slice(bytes).map_err(|_| ApiError::InvalidRequest)
}

pub(super) async fn body(headers: &HeaderMap, body: Body, json: bool) -> Result<Vec<u8>, ApiError> {
    if let Some(encoding) = single(headers, header::CONTENT_ENCODING.as_str())
        .map_err(|_| ApiError::UnsupportedMedia)?
        && !encoding.eq_ignore_ascii_case("identity")
    {
        return Err(ApiError::UnsupportedMedia);
    }
    if json {
        let mime = single(headers, header::CONTENT_TYPE.as_str())
            .map_err(|_| ApiError::UnsupportedMedia)?
            .ok_or(ApiError::UnsupportedMedia)?;
        let mut parts = mime.split(';');
        if !parts
            .next()
            .unwrap()
            .trim()
            .eq_ignore_ascii_case("application/json")
        {
            return Err(ApiError::UnsupportedMedia);
        }
        if let Some(parameter) = parts.next() {
            let (key, value) = parameter
                .trim()
                .split_once('=')
                .ok_or(ApiError::UnsupportedMedia)?;
            if !key.trim().eq_ignore_ascii_case("charset")
                || !(value.trim().eq_ignore_ascii_case("utf-8")
                    || value.trim().eq_ignore_ascii_case("\"utf-8\""))
                || parts.next().is_some()
            {
                return Err(ApiError::UnsupportedMedia);
            }
        }
    }
    if let Some(length) = single(headers, header::CONTENT_LENGTH.as_str())? {
        let length: u64 = length.parse().map_err(|_| ApiError::InvalidRequest)?;
        if length > MAX_INPUT_BYTES as u64 {
            return Err(ApiError::BodyTooLarge);
        }
    }
    let mut stream = body.into_data_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ApiError::InvalidRequest)?;
        if chunk.len() > MAX_INPUT_BYTES - bytes.len() {
            return Err(ApiError::BodyTooLarge);
        }
        if !json && !chunk.is_empty() {
            return Err(ApiError::InvalidRequest);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(super) fn query(
    raw: Option<&str>,
    allowed: &[&str],
) -> Result<HashMap<String, String>, ApiError> {
    let mut fields = HashMap::new();
    let Some(raw) = raw.filter(|value| !value.is_empty()) else {
        return Ok(fields);
    };
    for field in raw.split('&') {
        let (key, value) = field.split_once('=').ok_or(ApiError::InvalidRequest)?;
        let key = decode(key)?;
        let value = decode(value)?;
        if !allowed.contains(&key.as_str()) || fields.insert(key, value).is_some() {
            return Err(ApiError::InvalidRequest);
        }
    }
    Ok(fields)
}

fn decode(raw: &str) -> Result<String, ApiError> {
    let mut input = raw.bytes();
    let mut result = Vec::with_capacity(raw.len());
    while let Some(byte) = input.next() {
        result.push(match byte {
            b'+' => b' ',
            b'%' => {
                let high = input.next().and_then(|b| (b as char).to_digit(16));
                let low = input.next().and_then(|b| (b as char).to_digit(16));
                match (high, low) {
                    (Some(high), Some(low)) => (high * 16 + low) as u8,
                    _ => return Err(ApiError::InvalidRequest),
                }
            }
            byte => byte,
        });
    }
    String::from_utf8(result).map_err(|_| ApiError::InvalidRequest)
}
