use super::*;
use crate::conversation::{FieldKind, projection::project_response};
use ring::digest::{SHA256, digest};

fn function() -> OutputItem {
    OutputItem {
        id: None,
        kind: ItemKind::FunctionCall,
        native_type: "function_call".into(),
        function_call: Some(crate::FunctionCall {
            call_id: "call".into(),
            name: "function".into(),
            arguments: "{}".into(),
            origin: crate::CallOrigin::Direct,
            namespace: None,
            complete: true,
        }),
        native: json!({"private":"PRIVATE_NATIVE_CANARY"}),
    }
}

#[tokio::test]
async fn a3_mixed_sections_and_no_answer_fallback_follow_shared_sql_order() {
    for provenance in [
        OutputProvenance::NativeTerminal,
        OutputProvenance::ValidatedOutputItemDone,
    ] {
        for with_answer in [false, true] {
            let mut f = Fixture::new().await;
            f.start().await;
            let reasoning = OutputItem {
                id: None,
                kind: ItemKind::Reasoning,
                native_type: "reasoning".into(),
                function_call: None,
                native: json!({"summary":[{"type":"summary_text","text":"summary"}],"content":[{"type":"reasoning_text","text":"detail"}]}),
            };
            let mut output = vec![reasoning, function()];
            if with_answer {
                let mut item = message("");
                item.native = json!({"content":[
                    {"type":"unknown","text":"PRIVATE_NATIVE_CANARY"},
                    {"type":"refusal","refusal":"independent"},
                    {"type":"output_text","text":"covered"}
                ]});
                output.push(item);
                output.push(function());
            }
            output.push(OutputItem {
                id: None,
                kind: ItemKind::Unknown,
                native_type: "private".into(),
                function_call: None,
                native: json!({"private":"PRIVATE_NATIVE_CANARY"}),
            });
            let mut terminal = response(output, "covered suffix");
            terminal.output_provenance = provenance;
            let projected = project_response(&terminal);
            let expected: Vec<_> = projected
                .fields
                .iter()
                .map(|field| (field.part.kind, field.part.text.to_owned()))
                .collect();
            let fallback = projected
                .fields
                .iter()
                .find(|field| field.part.kind == FieldKind::AuthoritativeText)
                .unwrap();
            if with_answer {
                assert_eq!(fallback.output_index, 2);
                assert_eq!(
                    fallback.part.source,
                    crate::conversation::projection::PartSource::Fallback(Some(1))
                );
            } else {
                assert_eq!(fallback.output_index, terminal.output.len());
                assert_eq!(expected.last().unwrap().0, FieldKind::AuthoritativeText);
            }
            f.provider("t1", ProviderEvent::ResponseFinished { response: terminal })
                .await;
            let entry = f.assistant("t1").await;
            let actual: Vec<_> = f
                .fields(entry.id)
                .await
                .into_iter()
                .map(|(kind, text, _)| (fields::decode_kind(&kind).unwrap(), text))
                .collect();
            assert_eq!(actual, expected);
            assert!(
                !f.visible_and_metadata()
                    .await
                    .contains("PRIVATE_NATIVE_CANARY")
            );
            f.close().await;
        }
    }
}

#[tokio::test]
async fn a3_source_ids_generations_and_epoch_survive_matching_snapshots() {
    let mut f = Fixture::new().await;
    f.start().await;
    f.provider(
        "t1",
        delta(0, Some(0), None, DeltaKind::ReasoningSummary, "summary"),
    )
    .await;
    f.provider("t1", delta(1, None, Some(1), DeltaKind::Text, "cover"))
        .await;
    let original = f.assistant("t1").await;
    let generation = f.fields(original.id).await[1].2;
    f.provider("t1", delta(1, None, Some(1), DeltaKind::Text, "ed"))
        .await;
    assert_eq!(f.assistant("t1").await.epoch, original.epoch);
    assert_eq!(f.fields(original.id).await[1].2, generation);
    let mut item = message("");
    item.native = json!({"content":[{"type":"unknown"},{"type":"output_text","text":"covered"}]});
    f.provider(
        "t1",
        ProviderEvent::OutputItemFinished {
            response_id: "repeated".into(),
            output_index: 1,
            item: item.clone(),
        },
    )
    .await;
    let after_item = f.assistant("t1").await;
    let reasoning = OutputItem {
        id: None,
        kind: ItemKind::Reasoning,
        native_type: "reasoning".into(),
        function_call: None,
        native: json!({"summary":[{"type":"summary_text","text":"summary"}]}),
    };
    f.provider(
        "t1",
        ProviderEvent::ResponseFinished {
            response: response(vec![reasoning.clone(), item.clone()], "covered"),
        },
    )
    .await;
    let after_terminal = f.assistant("t1").await;
    assert_eq!(after_terminal.id, original.id);
    assert_eq!(after_terminal.epoch, after_item.epoch);
    assert_eq!(f.fields(original.id).await[2].2, generation);
    for (kind, spelling) in [
        (
            "reasoning_summary",
            "10000000000000000:0:10000000000000000:0",
        ),
        ("text", "10000000000000001:2:0:10000000000000001"),
    ] {
        let old_tuple = serde_json::to_vec(&(
            1,
            "wi.conversation.field",
            f.run.as_str(),
            original.id.to_string(),
            spelling,
        ))
        .unwrap();
        let expected: String = digest(&SHA256, &old_tuple)
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let id: String = sqlx::query_scalar(
            "SELECT field_id FROM conversation_fields WHERE run_id=? AND entry_id=? AND kind=?",
        )
        .bind(f.run.as_str())
        .bind(original.id.to_string())
        .bind(kind)
        .fetch_one(&mut f.sql)
        .await
        .unwrap();
        assert_eq!(id, expected);
    }
    assert!(
        !f.visible_and_metadata()
            .await
            .contains("PRIVATE_NATIVE_CANARY")
    );
    f.close().await;
}
