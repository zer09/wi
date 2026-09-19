use super::*;
use crate::http_api::{ApiSettings, OwnerToken};

#[tokio::test]
async fn comma_authorities_are_rejected_at_request_boundary() {
    let server = Server::new().await;
    for host in ["wi,example.test", "wi%2cexample.test"] {
        error(
            server.get("/v1/settings").header(header::HOST, host),
            421,
            "api.authority_invalid",
        )
        .await;
        error(
            server
                .get("/v1/settings")
                .header(header::ORIGIN, format!("https://{host}")),
            403,
            "api.origin_forbidden",
        )
        .await;
    }
    server.finish().await;
}

#[tokio::test]
async fn ipv6_public_default_port_and_actual_listener_authority_over_tcp() {
    let server = Server::new().await;
    let http = server.http.clone();
    let (temp, host) = server.stop_http().await;
    let listener = TcpListener::bind("[::1]:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let settings = ApiSettings::new(
        "https://[::1]",
        vec![temp.path().join("workspace")],
        temp.path().join("missing-skills"),
        "http-test".into(),
        SessionOptions::new("synthetic-model"),
        false,
    )
    .unwrap();
    let token = OwnerToken::load(&temp.path().join("private-token-path-canary")).unwrap();
    let stop = CancellationToken::new();
    let app = router(
        host.clone(),
        ApiConfig::new(settings, token),
        address,
        stop.clone(),
    )
    .unwrap();
    let stopping = stop.clone();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(stopping.cancelled_owned())
            .await
    });
    let server = Server {
        temp,
        host,
        address,
        http,
        run_hooks: Default::default(),
        event_hooks: Default::default(),
        stop,
        task,
    };
    for host in [
        "[::1]".to_owned(),
        "[0:0:0:0:0:0:0:1]:443".to_owned(),
        address.to_string(),
    ] {
        let reply = server
            .get("/v1/settings")
            .header(header::HOST, host)
            .header(header::ORIGIN, "https://[0:0:0:0:0:0:0:1]:443")
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), 200);
        assert_eq!(
            reply.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "https://[::1]"
        );
    }
    for host in ["::1", "[::1]:80", "[::2]", "[::1]:99999"] {
        error(
            server.get("/v1/settings").header(header::HOST, host),
            421,
            "api.authority_invalid",
        )
        .await;
    }
    for (target, status) in [
        ("https://[::1]:443/v1/settings", 200),
        ("http://[::1]/v1/settings", 421),
        ("https://[::2]/v1/settings", 421),
    ] {
        let (actual, _, _) = server.raw(format!("GET {target} HTTP/1.1\r\nHost: [::1]\r\nAuthorization: Bearer {TOKEN}\r\nConnection: close\r\n\r\n")).await;
        assert_eq!(actual, status);
    }
    server.finish().await;
}
