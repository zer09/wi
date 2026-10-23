use super::*;
use crate::{CallOrigin, ResponseOutcome};
use serde_json::json;

const PRIVATE: &str = "PRIVATE_NATIVE_CANARY";
const TEXT: &str = "exact\0\r\n\t\u{1b}雪🙂";

fn item(kind: ItemKind, native: Value) -> OutputItem {
    OutputItem {
        id: Some("item".into()),
        kind,
        native_type: PRIVATE.into(),
        function_call: None,
        native,
    }
}
fn response(output: Vec<OutputItem>, text: &str) -> ModelResponse {
    ModelResponse {
        id: "response".into(),
        model: None,
        outcome: ResponseOutcome::Completed,
        output_provenance: OutputProvenance::NativeTerminal,
        output,
        text: text.into(),
        usage: None,
        native: json!({"output": [], "private": PRIVATE}),
    }
}
fn message(texts: &[(&str, &str)]) -> OutputItem {
    item(
        ItemKind::Message,
        json!({"content": texts.iter().map(|(kind, text)| {
        if *kind == "refusal" { json!({"type": kind, "refusal": text}) }
        else { json!({"type": kind, "text": text}) }
    }).collect::<Vec<_>>()}),
    )
}
fn visible<'a>(projection: &ResponseProjection<'a>) -> Vec<(FieldKind, &'a str)> {
    projection
        .fields
        .iter()
        .map(|field| (field.part.kind, field.part.text))
        .collect()
}

#[test]
fn native_allowlist_preserves_order_bytes_and_unsupported_positions() {
    let input = item(
        ItemKind::Message,
        json!({"content":[
        {"type":"output_text", "text":TEXT, "annotations":[{"url":PRIVATE}], "signature":PRIVATE},
        {"type":"unknown", "text":PRIVATE},
        {"type":"refusal", "refusal":"independent refusal"},
        {"type":"output_text", "text":""},
        {"type":"output_text", "text":{"secret":PRIVATE}},
        {"type":"summary_text", "text":PRIVATE}
    ], "encrypted_content":PRIVATE}),
    );
    let before = serde_json::to_vec(&input).unwrap();
    let safe = project_item(&input);
    assert_eq!(safe.item_id, Some("item"));
    assert_eq!(safe.kind, ItemKind::Message);
    assert!(safe.function_call.is_none());
    assert!(safe.unsupported_content());
    assert_eq!(
        safe.parts
            .iter()
            .map(|part| (part.kind, part.text))
            .collect::<Vec<_>>(),
        vec![
            (FieldKind::Text, TEXT),
            (FieldKind::Unsupported, "Unsupported content"),
            (FieldKind::Refusal, "independent refusal"),
            (FieldKind::Text, ""),
            (FieldKind::Unsupported, "Unsupported content"),
            (FieldKind::Unsupported, "Unsupported content")
        ]
    );
    for (index, part) in safe.parts.iter().enumerate() {
        assert_eq!(part.source, PartSource::Content(Some(index)));
        assert!(!part.text.contains(PRIVATE));
    }
    assert_eq!(serde_json::to_vec(&input).unwrap(), before);
}

#[test]
fn reasoning_arrays_and_typed_functions_are_the_only_other_scalars() {
    let input = item(
        ItemKind::Reasoning,
        json!({
            "summary":[{"type":"summary_text","text":"s0"}, {"type":"reasoning_text","text":"s1"}],
            "content":[{"type":"reasoning_text","text":TEXT}, {"type":"summary_text","text":"c1"}, {"type":"output_text","text":PRIVATE}],
            "encrypted_content":PRIVATE
        }),
    );
    let safe = project_item(&input);
    assert_eq!(
        safe.parts.iter().map(|part| part.text).collect::<Vec<_>>(),
        ["s0", "s1", TEXT, "c1", "Unsupported content"]
    );
    assert_eq!(safe.parts[0].source, PartSource::Summary(Some(0)));
    assert_eq!(safe.parts[1].source, PartSource::Summary(Some(1)));
    assert_eq!(safe.parts[2].source, PartSource::Content(Some(0)));
    assert_eq!(safe.parts[3].kind, FieldKind::ReasoningSummary);
    let mut input = item(
        ItemKind::FunctionCall,
        json!({"name":PRIVATE, "arguments":PRIVATE}),
    );
    input.function_call = Some(FunctionCall {
        call_id: "call".into(),
        name: "function".into(),
        arguments: TEXT.into(),
        origin: CallOrigin::Programmatic,
        namespace: Some("namespace".into()),
        complete: false,
    });
    let safe = project_item(&input);
    let call = safe.function_call.unwrap();
    assert_eq!(call.call_id, "call");
    assert_eq!(call.origin, CallOrigin::Programmatic);
    assert!(!call.complete);
    assert_eq!(safe.parts[0].kind, FieldKind::FunctionName);
    assert_eq!(safe.parts[0].text, "function");
    assert_eq!(safe.parts[1].kind, FieldKind::FunctionArguments);
    assert_eq!(safe.parts[1].text, TEXT);
    assert!(!safe.unsupported_content());
}

#[test]
fn unknown_or_malformed_native_shapes_never_dump_objects() {
    for kind in [
        ItemKind::Unknown,
        ItemKind::CustomToolCall,
        ItemKind::ToolSearchCall,
        ItemKind::ToolSearchOutput,
        ItemKind::Program,
        ItemKind::ProgramOutput,
        ItemKind::FunctionCall,
    ] {
        let input = item(kind, json!({"text":PRIVATE}));
        let safe = project_item(&input);
        assert!(safe.unsupported_content());
        assert!(safe.function_call.is_none());
        assert_eq!(safe.parts.len(), 1);
        assert_eq!(safe.parts[0].text, "Unsupported content");
    }
    for kind in [ItemKind::Message, ItemKind::Reasoning] {
        for native in [
            Value::Null,
            json!({}),
            json!({"content":PRIVATE}),
            json!({"content":[null, 1, true, [], {"type":"output_text","text":false}]}),
            json!({"summary":null}),
        ] {
            let input = item(kind.clone(), native);
            let safe = project_item(&input);
            assert!(safe.unsupported_content());
            assert!(
                safe.parts
                    .iter()
                    .all(|part| part.text == "Unsupported content")
            );
        }
    }
    for kind in [ItemKind::Message, ItemKind::Reasoning] {
        let input = item(kind, json!({"summary":[], "content":[]}));
        let safe = project_item(&input);
        assert!(!safe.unsupported_content());
        assert!(safe.parts.is_empty());
    }
}

#[test]
fn fallback_order_keys_preserve_original_content_boundary() {
    use crate::conversation::interpretation::part_order;

    for provenance in [
        OutputProvenance::NativeTerminal,
        OutputProvenance::ValidatedOutputItemDone,
    ] {
        for first_answer in ["output_text", "refusal"] {
            let mut input = response(
                vec![message(&[("unknown", PRIVATE), (first_answer, "covered")])],
                "covered suffix",
            );
            input.output_provenance = provenance;
            if first_answer == "refusal" {
                input.output[0] = message(&[("unknown", PRIVATE), ("refusal", "independent")]);
            }
            let projected = project_response(&input);
            assert_eq!(projected.output_provenance, provenance);
            assert_eq!(projected.fields[0].part.kind, FieldKind::Unsupported);
            assert_eq!(projected.fields[1].part.kind, FieldKind::AuthoritativeText);
            assert_eq!(
                projected.fields[1].part.source,
                PartSource::Fallback(Some(1))
            );
            let mut ordered: Vec<_> = projected.fields.iter().collect();
            ordered.sort_by_key(|field| {
                part_order(field.output_index as u64, field.part.source).unwrap()
            });
            assert_eq!(
                ordered
                    .iter()
                    .map(|field| (field.part.kind, field.part.text))
                    .collect::<Vec<_>>(),
                visible(&projected),
            );
            if first_answer == "refusal" {
                assert_eq!(projected.fields[2].part.text, "independent");
            }
        }
    }
}

#[test]
fn represented_individual_concatenated_or_newline_answers_need_no_fallback() {
    for (parts, text) in [
        (vec![("output_text", "abc")], "bc"),
        (vec![("output_text", "a"), ("output_text", "b")], "ab"),
        (vec![("output_text", "a"), ("refusal", "b")], "a\nb"),
        (vec![("refusal", "refused")], "refused"),
        (vec![("output_text", TEXT)], TEXT),
        (vec![("output_text", "nonempty")], ""),
    ] {
        let input = response(vec![message(&parts)], text);
        let projected = project_response(&input);
        assert_eq!(projected.fields.len(), parts.len());
        assert!(
            projected
                .fields
                .iter()
                .all(|field| field.part.kind != FieldKind::AuthoritativeText)
        );
    }
}

#[test]
fn fallback_replaces_only_covered_answers_at_the_first_answer() {
    let input = response(
        vec![
            item(
                ItemKind::Reasoning,
                json!({"summary":[{"type":"summary_text","text":"covered"}]}),
            ),
            message(&[
                ("output_text", "covered"),
                ("refusal", "independent refusal"),
                ("output_text", ""),
                ("refusal", "also covered"),
                ("output_text", "independent answer"),
            ]),
            item(ItemKind::Unknown, json!({"text":PRIVATE})),
        ],
        "covered and also covered, plus a suffix",
    );
    let projected = project_response(&input);
    assert_eq!(
        visible(&projected),
        vec![
            (FieldKind::ReasoningSummary, "covered"),
            (
                FieldKind::AuthoritativeText,
                "covered and also covered, plus a suffix"
            ),
            (FieldKind::Refusal, "independent refusal"),
            (FieldKind::Text, ""),
            (FieldKind::Text, "independent answer"),
            (FieldKind::Unsupported, "Unsupported content"),
        ]
    );
    assert_eq!(projected.fields[1].output_index, 1);
    assert_eq!(
        projected.fields[1].part.source,
        PartSource::Fallback(Some(0))
    );
    let whitespace = response(vec![message(&[("output_text", "answer")])], "  answer\n");
    assert_eq!(
        visible(&project_response(&whitespace)),
        [(FieldKind::AuthoritativeText, "  answer\n")]
    );
}

#[test]
fn missing_answers_append_one_fallback_without_changing_function_or_native_output() {
    let mut function = item(ItemKind::FunctionCall, json!({"secret":PRIVATE}));
    function.function_call = Some(FunctionCall {
        call_id: "c".into(),
        name: "f".into(),
        arguments: TEXT.into(),
        origin: CallOrigin::Direct,
        namespace: None,
        complete: true,
    });
    let input = response(vec![function], "answer");
    let before = serde_json::to_vec(&input).unwrap();
    let projected = project_response(&input);
    assert_eq!(
        visible(&projected),
        [
            (FieldKind::FunctionName, "f"),
            (FieldKind::FunctionArguments, TEXT),
            (FieldKind::AuthoritativeText, "answer")
        ]
    );
    assert_eq!(projected.fields[2].output_index, 1);
    assert_eq!(serde_json::to_vec(&input).unwrap(), before);
    assert_eq!(input.native["output"], json!([]));
    let empty = response(vec![], "");
    assert!(project_response(&empty).fields.is_empty());
    let fallback = response(vec![], "answer");
    assert_eq!(
        visible(&project_response(&fallback)),
        [(FieldKind::AuthoritativeText, "answer")]
    );
}

#[test]
fn authoritative_snapshots_are_replacements_not_accumulated_provisional_text() {
    let provisional = message(&[("output_text", "provisional")]);
    let snapshot = message(&[("refusal", "replacement")]);
    assert_eq!(project_item(&provisional).parts[0].text, "provisional");
    let parts = project_item(&snapshot).parts;
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].text, "replacement");
    for provenance in [
        OutputProvenance::NativeTerminal,
        OutputProvenance::ValidatedOutputItemDone,
    ] {
        let mut final_response = response(vec![snapshot.clone()], "replacement");
        final_response.output_provenance = provenance;
        let projected = project_response(&final_response);
        assert_eq!(projected.output_provenance, provenance);
        assert_eq!(visible(&projected), [(FieldKind::Refusal, "replacement")]);
        assert_eq!(final_response.native["output"], json!([]));
    }
}
