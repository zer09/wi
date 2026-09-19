use std::net::{IpAddr, SocketAddr};

use axum::http::{HeaderMap, HeaderValue, Uri, header, uri::Authority};
use reqwest::Url;

use super::{ApiConfig, ConfigError, dto::ApiError};

#[derive(PartialEq, Eq)]
struct AuthorityKey {
    host: String,
    port: u16,
}

pub(super) struct Boundary {
    public: AuthorityKey,
    listener: AuthorityKey,
    public_scheme: String,
    origin: HeaderValue,
}

impl Boundary {
    pub(super) fn new(config: &ApiConfig, listener: SocketAddr) -> Result<Self, ConfigError> {
        let origin = config.settings().public_origin();
        let url = Url::parse(origin).expect("validated origin");
        Ok(Self {
            // URL-valid host names can still be ambiguous HTTP authorities, such as comma forms.
            public: authority(&origin[origin.find("://").unwrap() + 3..], url.scheme())
                .ok_or(ConfigError::Origin)?,
            listener: authority(&listener.to_string(), "http").expect("validated listener"),
            public_scheme: url.scheme().to_owned(),
            origin: HeaderValue::from_str(origin).expect("validated serialized origin"),
        })
    }

    pub(super) fn check_authority(&self, headers: &HeaderMap, uri: &Uri) -> Result<(), ApiError> {
        let host = single(headers, header::HOST.as_str())
            .map_err(|_| ApiError::AuthorityInvalid)?
            .ok_or(ApiError::AuthorityInvalid)?;
        let public = authority(host, &self.public_scheme);
        let local = authority(host, "http");
        let host = if public.as_ref() == Some(&self.public) {
            &self.public
        } else if local.as_ref() == Some(&self.listener) {
            &self.listener
        } else {
            return Err(ApiError::AuthorityInvalid);
        };
        if let Some(absolute) = uri.authority() {
            let scheme = uri.scheme_str().ok_or(ApiError::AuthorityInvalid)?;
            if authority(absolute.as_str(), scheme).as_ref() != Some(host) {
                return Err(ApiError::AuthorityInvalid);
            }
        } else if uri.scheme().is_some() {
            return Err(ApiError::AuthorityInvalid);
        }
        Ok(())
    }

    pub(super) fn check_origin(
        &self,
        headers: &HeaderMap,
    ) -> Result<Option<HeaderValue>, ApiError> {
        let origin =
            single(headers, header::ORIGIN.as_str()).map_err(|_| ApiError::OriginForbidden)?;
        let Some(origin) = origin else {
            return Ok(None);
        };
        let (scheme, host) = origin.split_once("://").ok_or(ApiError::OriginForbidden)?;
        // An Origin is an origin only, not a URL with a path or parser-repaired suffix.
        let key = authority(host, scheme).ok_or(ApiError::OriginForbidden)?;
        if !scheme.eq_ignore_ascii_case(&self.public_scheme) || key != self.public {
            return Err(ApiError::OriginForbidden);
        }
        Ok(Some(self.origin.clone()))
    }
}

fn authority(value: &str, scheme: &str) -> Option<AuthorityKey> {
    let default_port = if scheme.eq_ignore_ascii_case("https") {
        443
    } else if scheme.eq_ignore_ascii_case("http") {
        80
    } else {
        return None;
    };
    if value.is_empty()
        || value.ends_with(':')
        || value
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control() || b"@,/?#\\%".contains(&b))
    {
        return None;
    }
    let parsed: Authority = value.parse().ok()?;
    let port = match parsed.port() {
        Some(port) => port.as_str().parse::<u16>().ok()?,
        None => default_port,
    };
    // URL parsing supplies DNS case folding and canonical IPv6. Refuse shorthand IPv4 repairs.
    let url = Url::parse(&format!("{scheme}://{value}")).ok()?;
    let host = url.host_str()?;
    if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>()
        && parsed
            .host()
            .trim_matches(['[', ']'])
            .parse::<IpAddr>()
            .ok()
            != Some(ip)
    {
        return None;
    }
    Some(AuthorityKey {
        host: host.to_owned(),
        port,
    })
}

pub(super) fn single<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>, ApiError> {
    let mut values = headers.get_all(name).iter();
    let value = values.next();
    if values.next().is_some() {
        return Err(ApiError::InvalidRequest);
    }
    value
        .map(|value| value.to_str().map_err(|_| ApiError::InvalidRequest))
        .transpose()
}

pub(super) fn authenticate(headers: &mut HeaderMap, config: &ApiConfig) -> Result<(), ApiError> {
    for (name, value) in headers.iter_mut() {
        if name == header::AUTHORIZATION {
            value.set_sensitive(true);
        }
    }
    let value = single(headers, header::AUTHORIZATION.as_str())
        .map_err(|_| ApiError::Unauthorized)?
        .ok_or(ApiError::Unauthorized)?;
    let (scheme, token) = value.split_once(' ').ok_or(ApiError::Unauthorized)?;
    if !scheme.eq_ignore_ascii_case("Bearer") || !config.owner_token().verify(token.as_bytes()) {
        return Err(ApiError::Unauthorized);
    }
    Ok(())
}

pub(super) fn preflight_headers(headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(value) = single(headers, header::ACCESS_CONTROL_REQUEST_HEADERS.as_str())? else {
        return Ok(());
    };
    let mut seen = Vec::new();
    for name in value.split(',').map(str::trim) {
        let name = name.to_ascii_lowercase();
        if !matches!(
            name.as_str(),
            "authorization" | "content-type" | "last-event-id"
        ) || seen.contains(&name)
        {
            return Err(ApiError::InvalidRequest);
        }
        seen.push(name);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authority_normalizes_only_unambiguous_hosts_and_ports() {
        for (left, right, scheme) in [
            ("Wi.Example.Test", "wi.example.test:443", "https"),
            ("127.0.0.1", "127.0.0.1:80", "http"),
            ("[0:0:0:0:0:0:0:1]", "[::1]:80", "http"),
        ] {
            assert!(authority(left, scheme) == authority(right, scheme));
            assert!(authority(left, scheme).is_some());
        }
        for invalid in [
            "",
            "a,b",
            "a@b",
            "a/",
            "a?",
            "a#",
            "a\\b",
            "a:99999",
            "a:",
            "127.1",
            "2130706433",
            " a",
            "a b",
            "%61",
            "::1",
            "[::1]:bad",
        ] {
            assert!(authority(invalid, "http").is_none(), "{invalid}");
        }
        assert!(authority("a", "ftp").is_none());
        assert!(authority("a", "http") != authority("a:443", "http"));
    }
}
