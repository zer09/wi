use super::*;

const SID: &str = "11111111-1111-4111-8111-111111111111";
const RID: &str = "22222222-2222-4222-8222-222222222222";

fn cursor(prefix: &str, fields: &Value) -> String {
    format!("{prefix}.{}", URL_SAFE_NO_PAD.encode(fields.to_string()))
}
fn roundtrip<T: FromStr<Err = CursorError> + fmt::Display + fmt::Debug + PartialEq>(
    value: &str,
) -> T {
    let parsed: T = value.parse().unwrap();
    assert_eq!(parsed.to_string(), value);
    assert_eq!(
        format!("{parsed:?}"),
        format!(
            "{}([redacted])",
            std::any::type_name::<T>().rsplit("::").next().unwrap()
        )
    );
    assert_eq!(parsed.to_string().parse::<T>().unwrap(), parsed);
    parsed
}
fn rejected(prefix: &str, fields: &Value) {
    let value = cursor(prefix, fields);
    let result = match prefix {
        "g11b" => value.parse::<BlockCursor>().map(|_| ()),
        "g11s" => value.parse::<ActivityCursor>().map(|_| ()),
        "g11c" => value.parse::<ContentCursor>().map(|_| ()),
        "g11l" => value.parse::<LiveCursor>().map(|_| ()),
        _ => unreachable!(),
    };
    assert_eq!(result, Err(CursorError));
}

#[test]
fn cursors_roundtrip_all_integer_bits_and_remain_distinct() {
    for n in [1, (1 << 53) + 1, i64::MAX as u64, u64::MAX] {
        let number = n.to_string();
        let block = cursor("g11b", &json!([1, SID, number]));
        let b = roundtrip::<BlockCursor>(&block);
        assert_eq!(b.session_id().as_str(), SID);
        assert_eq!(b.before_accepted_sequence(), n);
        let activity = cursor("g11s", &json!([1, SID, RID, number, number]));
        let a = roundtrip::<ActivityCursor>(&activity);
        assert_eq!(a.session_id().as_str(), SID);
        assert_eq!(a.run_id().as_str(), RID);
        assert_eq!(a.before_entry_sequence(), n);
        assert_eq!(a.before_slot(), n);
        let content = cursor(
            "g11c",
            &json!([1, SID, RID, "e:1:0", number, "text", number, number]),
        );
        let c = roundtrip::<ContentCursor>(&content);
        assert_eq!(c.session_id().as_str(), SID);
        assert_eq!(c.run_id().as_str(), RID);
        assert_eq!(c.entry_id().to_string(), "e:1:0");
        assert_eq!(c.content_epoch(), n);
        assert_eq!(c.upper_field_id(), "text");
        assert_eq!(c.upper_generation(), n);
        assert_eq!(c.exclusive_upper_byte(), n);
        let live = cursor("g11l", &json!([1, SID, number, "3", "", ""]));
        let l = roundtrip::<LiveCursor>(&live);
        assert_eq!(l.session_id().as_str(), SID);
        assert_eq!(l.sequence(), n);
        assert_eq!(l.rank(), 3);
        assert_eq!(l.run_id(), None);
        assert_eq!(l.entry_id(), None);
        for (index, value) in [block, activity, content, live].iter().enumerate() {
            assert_eq!(value.parse::<BlockCursor>().is_ok(), index == 0);
            assert_eq!(value.parse::<ActivityCursor>().is_ok(), index == 1);
            assert_eq!(value.parse::<ContentCursor>().is_ok(), index == 2);
            assert_eq!(value.parse::<LiveCursor>().is_ok(), index == 3);
        }
    }
}

#[test]
fn cursor_fields_require_exact_types_counts_versions_ids_and_decimals() {
    for (prefix, fields, numeric) in [
        ("g11b", json!([1, SID, "1"]), vec![2]),
        ("g11s", json!([1, SID, RID, "1", "0"]), vec![3, 4]),
        (
            "g11c",
            json!([1, SID, RID, "e:1:0", "1", "text", "1", "0"]),
            vec![4, 6, 7],
        ),
        ("g11l", json!([1, SID, "1", "3", "", ""]), vec![2, 3]),
    ] {
        for bad in [
            json!(0),
            json!(2),
            json!(1.0),
            json!("1"),
            Value::Null,
            json!(true),
        ] {
            let mut copy = fields.clone();
            copy[0] = bad;
            rejected(prefix, &copy);
        }
        for position in 1..fields.as_array().unwrap().len() {
            for bad in [Value::Null, json!(1), json!(false), json!([]), json!({})] {
                let mut copy = fields.clone();
                copy[position] = bad;
                rejected(prefix, &copy);
            }
        }
        for position in numeric {
            for bad in [
                "",
                "00",
                "01",
                "+1",
                "-1",
                " 1",
                "1\n",
                "1.0",
                "1e0",
                "１",
                "18446744073709551616",
            ] {
                let mut copy = fields.clone();
                copy[position] = json!(bad);
                rejected(prefix, &copy);
            }
        }
        for bad in [
            "",
            "../private-path",
            "00000000-0000-0000-0000-000000000000",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaA",
            "11111111111141118111111111111111",
        ] {
            let mut copy = fields.clone();
            copy[1] = json!(bad);
            rejected(prefix, &copy);
            if prefix == "g11s" || prefix == "g11c" {
                copy = fields.clone();
                copy[2] = json!(bad);
                rejected(prefix, &copy);
            }
        }
        let mut copy = fields.clone();
        copy.as_array_mut().unwrap().pop();
        rejected(prefix, &copy);
        let mut copy = fields.clone();
        copy.as_array_mut().unwrap().push(json!("extra"));
        rejected(prefix, &copy);
        rejected(prefix, &json!({"fields": fields}));
    }
    rejected(
        "g11c",
        &json!([1, SID, RID, "e:0:0", "1", "text", "1", "0"]),
    );
    rejected("g11c", &json!([1, SID, RID, "e:1:0", "1", "", "1", "0"]));
    // Event references are positive; slots and byte boundaries can still be zero.
    rejected("g11b", &json!([1, SID, "0"]));
    rejected("g11s", &json!([1, SID, RID, "0", "0"]));
    rejected("g11l", &json!([1, SID, "0", "3", "", ""]));
    rejected("g11l", &json!([1, SID, "1", "2", RID, "e:2:0"]));
    for (epoch, generation) in [("0", "1"), ("1", "0")] {
        rejected(
            "g11c",
            &json!([1, SID, RID, "e:1:0", epoch, "text", generation, "0"]),
        );
    }
    for (epoch, generation) in [("1", "2"), ("2", "1")] {
        rejected(
            "g11c",
            &json!([1, SID, RID, "e:2:0", epoch, "text", generation, "0"]),
        );
    }
    roundtrip::<ActivityCursor>(&cursor("g11s", &json!([1, SID, RID, "1", "0"])));
    roundtrip::<ContentCursor>(&cursor(
        "g11c",
        &json!([1, SID, RID, "e:1:0", "1", "text", "1", "0"]),
    ));
}

#[test]
fn live_rank_requires_its_exact_identity_shape() {
    for rank in 0..=4 {
        for run in ["", RID] {
            for entry in ["", "e:1:0"] {
                let value = cursor("g11l", &json!([1, SID, "1", rank.to_string(), run, entry]));
                let valid = match rank {
                    0 | 3 => run.is_empty() && entry.is_empty(),
                    1 => !run.is_empty() && entry.is_empty(),
                    2 => !run.is_empty() && !entry.is_empty(),
                    _ => false,
                };
                assert_eq!(value.parse::<LiveCursor>().is_ok(), valid);
                if valid {
                    let live = roundtrip::<LiveCursor>(&value);
                    assert_eq!(live.rank(), rank);
                    assert_eq!(live.run_id().map(RunId::as_str).unwrap_or(""), run);
                    assert_eq!(
                        live.entry_id().map(ToString::to_string).unwrap_or_default(),
                        entry
                    );
                }
            }
        }
    }
    for bad in ["not-a-run", "../path"] {
        rejected("g11l", &json!([1, SID, "1", "1", bad, ""]));
        rejected("g11l", &json!([1, SID, "1", "2", RID, bad]));
    }
}

#[test]
fn cursor_encoding_is_minified_unpadded_url_safe_and_bounded() {
    let valid = cursor("g11b", &json!([1, SID, "1"]));
    for value in [
        String::new(),
        valid.replacen("g11b", "g11B", 1),
        format!("{valid}="),
        format!("{valid}\n"),
        format!(" {valid}"),
        "g11b.+/==".into(),
        format!("g11b.{}", URL_SAFE_NO_PAD.encode([0xff])),
        format!(
            "g11b.{}",
            URL_SAFE_NO_PAD.encode(format!("[1, \"{SID}\",\"1\"]"))
        ),
        format!(
            "g11b.{}",
            URL_SAFE_NO_PAD.encode(format!("[1,\"{SID}\",\"\\u0031\"]"))
        ),
        format!("g11b.{}", "A".repeat(MAX_CURSOR_BYTES)),
    ] {
        let error = value.parse::<BlockCursor>().unwrap_err();
        assert_eq!(error.to_string(), "conversation.cursor_invalid");
        assert_eq!(format!("{error:?}"), "CursorError");
    }
    // Nonzero unused trailing base64 bits are not a second spelling of a cursor.
    assert!("g11b.WzFd".parse::<BlockCursor>().is_err());
    let mut noncanonical = valid.clone().into_bytes();
    let last = noncanonical.last_mut().unwrap();
    *last += 1;
    assert!(
        String::from_utf8(noncanonical)
            .unwrap()
            .parse::<BlockCursor>()
            .is_err()
    );

    let fields = |size| json!([1, SID, RID, "e:1:0", "1", "x".repeat(size), "1", "0"]);
    let max = (0..4096)
        .find(|size| cursor("g11c", &fields(*size)).len() > MAX_CURSOR_BYTES)
        .unwrap();
    let below = cursor("g11c", &fields(max - 1));
    assert!(below.len() <= MAX_CURSOR_BYTES);
    // Fitting the encoded bound does not make an arbitrary field ID valid.
    assert!(below.parse::<ContentCursor>().is_err());
    roundtrip::<ContentCursor>(&cursor(
        "g11c",
        &json!([1, SID, RID, "e:1:0", "1", "a".repeat(64), "1", "0"]),
    ));
    assert!(
        cursor("g11c", &fields(max))
            .parse::<ContentCursor>()
            .is_err()
    );
    let private = cursor(
        "g11c",
        &json!([
            1,
            SID,
            RID,
            "e:1:0",
            "1",
            "/synthetic/private-field",
            "1",
            "0"
        ]),
    );
    let error = private.parse::<ContentCursor>().unwrap_err();
    assert_eq!(error.to_string(), "conversation.cursor_invalid");
    assert_eq!(format!("{error:?}"), "CursorError");
}
