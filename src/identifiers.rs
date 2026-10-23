use uuid::Uuid;

pub(crate) fn is_canonical_uuid(value: &str) -> bool {
    if value.len() != 36 || !value.is_ascii() {
        return false;
    }
    let Ok(id) = Uuid::parse_str(value) else {
        return false;
    };
    !id.is_nil() && id.hyphenated().to_string() == value
}

// The adapter uses its local counter, not the upstream provider counter.
pub(crate) fn is_local_event_id(event: &str, session: &str, sequence: u64) -> bool {
    if !is_canonical_uuid(session) || sequence == 0 || event.len() > 57 {
        return false;
    }
    event
        .strip_prefix(session)
        .and_then(|suffix| suffix.strip_prefix(':'))
        .is_some_and(|decimal| decimal == sequence.to_string())
}

#[cfg(test)]
pub(crate) fn invalid_uuid_spellings() -> Vec<String> {
    let canonical = "01234567-89ab-4cde-8fab-0123456789ab";
    vec![
        String::new(),
        "x".repeat(36),
        Uuid::nil().to_string(),
        canonical.to_uppercase(),
        canonical.replace('-', ""),
        format!("{{{canonical}}}"),
        format!("urn:uuid:{canonical}"),
        format!(" {canonical}"),
        format!("{canonical}\n"),
        canonical.replace('a', "雪"),
        "a".repeat(35),
        "a".repeat(37),
        "x".repeat(524_289),
    ]
}

#[cfg(test)]
pub(crate) fn invalid_local_events(session: &str) -> Vec<(String, u64)> {
    vec![
        (String::new(), 1),
        (format!("{session}:0"), 0),
        (format!("{session}:1"), 2),
        (format!("{session}:01"), 1),
        (format!("{session}:+1"), 1),
        (format!("{session}:1 "), 1),
        (format!("{session}:1\n"), 1),
        (format!("{session}:1:1"), 1),
        (format!("{}:1", session.to_uppercase()), 1),
        ("00000000-0000-0000-0000-000000000000:1".into(), 1),
        ("01234567-89ab-1cde-8fab-1123456789ab:1".into(), 1),
        (format!("{session}:18446744073709551616"), u64::MAX),
        ("x".repeat(524_289), 1),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id2b_local_composite_uses_exact_positive_local_u64_spelling() {
        let session = "01234567-89ab-1cde-8fab-0123456789ab";
        for sequence in [1, 3, 999, u64::MAX] {
            assert!(is_local_event_id(
                &format!("{session}:{sequence}"),
                session,
                sequence
            ));
        }
        assert_eq!(format!("{session}:{}", u64::MAX).len(), 57);
        for (event, sequence) in invalid_local_events(session) {
            assert!(!is_local_event_id(&event, session, sequence));
        }
        for malformed in invalid_uuid_spellings() {
            assert!(!is_local_event_id(&format!("{malformed}:1"), &malformed, 1));
        }
    }

    #[test]
    fn canonical_uuid_matches_storage_spelling_without_a_version_restriction() {
        for value in [
            "01234567-89ab-4cde-8fab-0123456789ab",
            "01234567-89ab-1cde-8fab-0123456789ab",
            "01234567-89ab-5cde-8fab-0123456789ab",
            "01234567-89ab-7cde-8fab-0123456789ab",
        ] {
            assert!(is_canonical_uuid(value));
            let stored: crate::storage::ApplicationSessionId = value.parse().unwrap();
            assert_eq!(stored.as_str(), value);
        }
        for value in invalid_uuid_spellings() {
            assert!(!is_canonical_uuid(&value));
            assert!(
                value
                    .parse::<crate::storage::ApplicationSessionId>()
                    .is_err()
            );
        }
    }
}
