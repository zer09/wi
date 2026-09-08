use super::*;
use serde_json::json;

fn created() -> String {
    format!(
        "data: {}\n\n",
        json!({"type":"response.created","response":{"id":"private-世界"}})
    )
}
fn chunks(parts: Vec<Vec<u8>>) -> ByteStream {
    Box::pin(futures_util::stream::iter(parts.into_iter().map(Ok)))
}
async fn admitted_bytes(parts: Vec<Vec<u8>>) -> Vec<u8> {
    let (result, state, _) = admit_sse_prolog(chunks(parts)).await;
    assert_eq!(state, SampleState::SsePrologAdmitted);
    let mut stream = result.unwrap();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend(chunk.unwrap());
    }
    bytes
}

#[tokio::test]
async fn prolog_all_splits_bom_unicode_endings_metadata_multidata_and_replay() {
    for ending in ["\n", "\r", "\r\n"] {
        for label in [
            "event: wrong\nevent: response.created\n",
            "event: wrong\nevent:\n",
            "",
        ] {
            let text = format!("\u{feff}: comment\n\nid: old\nid: new\nretry: 01\nretry: 2\n{label}data: {{\ndata: \"type\":\"response.created\",\ndata: \"response\":{{\"id\":\"世界\"}}}}\n\n").replace('\n', ending);
            let tail =
                b"data: {\"type\":\"tail1\"}\n\ndata: {\"type\":\"tail2\"}\n\ndata: {\"partial\":";
            let mut bytes = text.into_bytes();
            bytes.extend(tail);
            for split in 0..=bytes.len() {
                assert_eq!(
                    admitted_bytes(vec![bytes[..split].to_vec(), bytes[split..].to_vec()]).await,
                    bytes
                );
            }
            assert_eq!(
                admitted_bytes(bytes.iter().map(|b| vec![*b]).collect()).await,
                bytes
            );
        }
    }
}

#[tokio::test]
async fn prolog_first_data_is_decisive_and_prefixes_are_strict() {
    for first in [
        "data:\n\n",
        "data\n\n",
        "data: \t \n\n",
        "data: [DONE]\n\n",
        "data: garbage\n\n",
        "data: {}\n\n",
        "data: {\"type\":\"future\",\"response\":{\"id\":\"x\"}}\n\n",
        "<html>\n",
        "plain\n",
        "{}\n",
        "unknown: x\n",
        "event: wrong\n",
        "retry:\n",
        "retry: +1\n",
        "retry: ١\n",
        "id: x\0\n",
        ": bad\u{7f}\n",
        "data: bad\u{0085}\n",
    ] {
        let bytes = format!("{first}{}", created()).into_bytes();
        let stream: ByteStream =
            Box::pin(chunks(vec![bytes]).chain(futures_util::stream::pending()));
        let (result, state, _) =
            tokio::time::timeout(Duration::from_secs(1), admit_sse_prolog(stream))
                .await
                .unwrap();
        assert!(
            matches!(result, Err(GatewayError::UnexpectedContentType)),
            "{first:?}"
        );
        assert_eq!(state, SampleState::SsePrologRejected);
    }
    let (result, state, class) =
        admit_sse_prolog(chunks(vec![b": \xff\n".to_vec(), created().into_bytes()])).await;
    assert!(result.is_err());
    assert_eq!(state, SampleState::SsePrologRejected);
    assert_eq!(class, Some(BodyClass::BinaryOrNonUtf8));
}

#[tokio::test]
async fn prolog_terminal_qualifiers_require_trial_decoder_and_bounded_identity() {
    for kind in [
        "response.created",
        "response.completed",
        "response.done",
        "response.incomplete",
        "response.failed",
        "response.cancelled",
    ] {
        for id in ["".to_owned(), "é".repeat(256), "é".repeat(256) + "x"] {
            for malformed in [false, true] {
                let status = match kind {
                    "response.incomplete" => "incomplete",
                    "response.failed" => "failed",
                    "response.cancelled" => "cancelled",
                    _ => "completed",
                };
                let mut value =
                    json!({"type":kind,"response":{"id":id,"status":status,"output":[]}});
                if malformed {
                    value["response"] = json!({"id":id,"status":"bad","output":null});
                }
                let bytes = format!("event: {kind}\ndata: {value}\n\n").into_bytes();
                let (result, state, _) = admit_sse_prolog(chunks(vec![bytes])).await;
                let valid =
                    !id.is_empty() && id.len() <= 512 && (!malformed || kind == "response.created");
                assert_eq!(result.is_ok(), valid, "{kind} {} {malformed}", id.len());
                assert_eq!(state == SampleState::SsePrologAdmitted, valid);
            }
        }
    }
    for id in [Value::Null, json!(42), json!({})] {
        assert!(!qualifies_sse_prolog(
            &json!({"type":"response.created","response":{"id":id}}).to_string(),
            ""
        ));
    }
}

#[tokio::test]
async fn prolog_eof_requires_blank_line_but_labeled_decoder_keeps_eof_behavior() {
    for bytes in [
        vec![],
        b": comment\n\n".to_vec(),
        created().trim_end().as_bytes().to_vec(),
        created()
            .trim_end()
            .as_bytes()
            .iter()
            .copied()
            .chain(*b"\n")
            .collect(),
    ] {
        let (result, state, _) = admit_sse_prolog(chunks(vec![bytes])).await;
        assert!(result.is_err());
        assert_eq!(state, SampleState::SsePrologRejected);
    }
    let mut ordinary = SseDecoder::default();
    assert!(
        ordinary
            .feed(created().trim_end().as_bytes())
            .unwrap()
            .is_empty()
    );
    assert_eq!(ordinary.finish().unwrap().len(), 1);
}

#[tokio::test]
async fn prolog_exact_raw_cap_and_cap_plus_one_and_private_classifier_bound() {
    for extra in [0, 1] {
        let proof = created();
        let mut bytes = format!(
            ":{}\n{}",
            "a".repeat(MAX_SSE_PROLOG - proof.len() - 2 + extra),
            proof
        )
        .into_bytes();
        bytes.extend(b"data: tail\n\n");
        let (result, state, class) = admit_sse_prolog(chunks(vec![bytes])).await;
        assert_eq!(result.is_ok(), extra == 0);
        assert_eq!(
            state,
            if extra == 0 {
                SampleState::SsePrologAdmitted
            } else {
                SampleState::SsePrologTruncated
            }
        );
        assert_eq!(class, Some(BodyClass::TextOrOther));
    }
    let mut bytes = format!(":{}\n", "x".repeat(4095)).into_bytes();
    bytes.extend(b"\xff\n");
    let (_, state, class) = admit_sse_prolog(chunks(vec![bytes])).await;
    assert_eq!(state, SampleState::SsePrologRejected);
    assert_eq!(class, Some(BodyClass::TextOrOther));
}

#[tokio::test]
async fn prolog_absolute_timeout_covers_stall_and_drip_without_reset() {
    let stall: ByteStream = Box::pin(futures_util::stream::pending());
    let drip: ByteStream = Box::pin(async_stream::stream! {
        loop {
            yield Ok(b": keepalive\n\n".to_vec());
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
    let start = std::time::Instant::now();
    let (a, b) = tokio::join!(admit_sse_prolog(stall), admit_sse_prolog(drip));
    for result in [&a, &b] {
        assert!(matches!(result.0, Err(GatewayError::UnexpectedContentType)));
        assert_eq!(result.1, SampleState::SsePrologTimeout);
    }
    assert_eq!(a.2, None);
    assert_eq!(b.2, Some(BodyClass::TextOrOther));
    assert!(start.elapsed() >= SSE_PROLOG_TIMEOUT);
    assert!(start.elapsed() < SSE_PROLOG_TIMEOUT + Duration::from_secs(2));
}

#[tokio::test]
async fn prolog_read_errors_and_fetched_limit_before_retention() {
    for prefix in [vec![], b": private\n".to_vec()] {
        let stream = Box::pin(
            chunks(vec![prefix.clone()])
                .chain(futures_util::stream::iter([Err(GatewayError::Transport)])),
        );
        let (result, state, class) = admit_sse_prolog(stream).await;
        assert!(matches!(result, Err(GatewayError::UnexpectedContentType)));
        assert_eq!(state, SampleState::SsePrologReadError);
        assert_eq!(class.is_some(), !prefix.is_empty());
    }
    for extra in [0, 1] {
        let mut bytes = created().into_bytes();
        bytes.resize(MAX_RESPONSE_BYTES + extra, b' ');
        let (result, state, _) = admit_sse_prolog(chunks(vec![bytes])).await;
        assert_eq!(result.is_ok(), extra == 0);
        if extra == 1 {
            assert!(matches!(result, Err(GatewayError::StreamTooLarge)));
            assert_eq!(state, SampleState::SsePrologTruncated);
        }
    }
    let mut first = b":\n".to_vec();
    let mut second = created().into_bytes();
    second.resize(MAX_RESPONSE_BYTES - first.len() + 1, b' ');
    let (result, _, _) = admit_sse_prolog(chunks(vec![std::mem::take(&mut first), second])).await;
    assert!(matches!(result, Err(GatewayError::StreamTooLarge)));
}
