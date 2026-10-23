use super::*;
use crate::conversation::{EntryKind, RecordedState};

#[test]
fn a5b1_minimum_uses_exact_encoding_across_decimal_cursor_widths() {
    let session = ApplicationSessionId::new();
    let run = RunId::new();
    for total in [10, 101, 1001, 10001] {
        let entry = EntryView::new(
            run.clone(),
            "e:2:0".parse().unwrap(),
            2,
            2,
            EntryKind::Human,
            RecordedState::Accepted,
            false,
            None,
            None,
            None,
            None,
            vec![
                FieldFragment::new(
                    "text".into(),
                    "0".into(),
                    FieldKind::Text,
                    2,
                    total,
                    0,
                    total,
                    "a".repeat(total as usize),
                )
                .unwrap(),
            ],
            None,
            true,
        )
        .unwrap();
        let actual = minimum(&session, entry.clone()).unwrap();
        let mut expected = DisplayJson::Entry(&entry).json_size().unwrap();
        for cut in 1..total as usize {
            let value = text_suffix(&session, &entry, cut).unwrap();
            expected = expected.min(DisplayJson::Entry(&value).json_size().unwrap());
        }
        assert_eq!(DisplayJson::Entry(&actual).json_size().unwrap(), expected);
        let reduced = fit(&session, entry, |value| {
            DisplayJson::Entry(value)
                .json_size()
                .is_ok_and(|size| size <= expected)
        })
        .unwrap();
        assert_eq!(DisplayJson::Entry(&reduced).json_size().unwrap(), expected);
    }
}
