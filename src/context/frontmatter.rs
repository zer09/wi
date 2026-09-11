use std::{collections::BTreeMap, io::BufRead};

use serde_json::{Number, Value};
use yaml_rust2::{
    Yaml,
    parser::{Event, Parser},
    scanner::TScalarStyle,
};

use super::{ContextErrorKind, valid_name};
use crate::provider::MAX_INPUT_BYTES;

// Only metadata is consumed. BufRead implementations may physically read ahead,
// but an unselected body is never parsed, retained, or measured against this limit.
pub(super) fn read(reader: &mut impl BufRead) -> Result<Value, ContextErrorKind> {
    let mut consumed = 0;
    let opening = line(reader, &mut consumed)?;
    let opening = opening.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&opening);
    if without_eol(opening) != b"---" {
        return Err(ContextErrorKind::InvalidFrontmatter);
    }
    let mut yaml = Vec::new();
    loop {
        let next = line(reader, &mut consumed)?;
        if next.is_empty() {
            return Err(ContextErrorKind::InvalidFrontmatter);
        }
        if without_eol(&next) == b"---" {
            break;
        }
        yaml.extend_from_slice(&next);
    }
    let yaml = std::str::from_utf8(&yaml).map_err(|_| ContextErrorKind::InvalidFrontmatter)?;
    let value = parse(yaml)?;
    validate(&value)?;
    Ok(value)
}

fn line(reader: &mut impl BufRead, consumed: &mut usize) -> Result<Vec<u8>, ContextErrorKind> {
    let mut bytes = Vec::new();
    // One extra byte distinguishes an oversized line without allocating its body.
    let remaining = MAX_INPUT_BYTES - *consumed;
    std::io::Read::take(reader, (remaining + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| ContextErrorKind::ReadFailed)?;
    if bytes.len() > remaining {
        return Err(ContextErrorKind::InputTooLarge);
    }
    *consumed += bytes.len();
    Ok(bytes)
}

fn without_eol(line: &[u8]) -> &[u8] {
    match line.strip_suffix(b"\n") {
        Some(line) => line.strip_suffix(b"\r").unwrap_or(line),
        None => line,
    }
}

enum Frame {
    Sequence(Vec<Value>),
    Mapping(BTreeMap<String, Value>, Option<String>),
}

// The event API exposes anchors/tags and duplicate keys before a YAML loader
// could expand aliases or replace earlier keys. Only JSON-shaped data is built.
fn parse(yaml: &str) -> Result<Value, ContextErrorKind> {
    let invalid = ContextErrorKind::InvalidFrontmatter;
    let mut parser = Parser::new_from_str(yaml);
    let mut stack = Vec::new();
    let mut root = None;
    let mut documents = 0;
    loop {
        let (event, _) = parser.next_token().map_err(|_| invalid)?;
        let value = match event {
            Event::StreamStart | Event::DocumentEnd => continue,
            Event::DocumentStart => {
                documents += 1;
                if documents != 1 {
                    return Err(invalid);
                }
                continue;
            }
            Event::StreamEnd => break,
            Event::Scalar(text, style, 0, None) => {
                // Quoted keys and scalar values containing << are ordinary data.
                if style == TScalarStyle::Plain
                    && text == "<<"
                    && matches!(stack.last(), Some(Frame::Mapping(_, None)))
                {
                    return Err(invalid);
                }
                scalar(text, style)?
            }
            Event::SequenceStart(0, None) => {
                stack.push(Frame::Sequence(Vec::new()));
                continue;
            }
            Event::MappingStart(0, None) => {
                stack.push(Frame::Mapping(BTreeMap::new(), None));
                continue;
            }
            Event::SequenceEnd => {
                let Some(Frame::Sequence(values)) = stack.pop() else {
                    return Err(invalid);
                };
                Value::Array(values)
            }
            Event::MappingEnd => {
                let Some(Frame::Mapping(values, None)) = stack.pop() else {
                    return Err(invalid);
                };
                Value::Object(values.into_iter().collect())
            }
            // Includes aliases, all anchor-bearing events and all tags.
            _ => return Err(invalid),
        };
        match stack.last_mut() {
            Some(Frame::Sequence(values)) => values.push(value),
            Some(Frame::Mapping(values, key)) => {
                if let Some(key) = key.take() {
                    if values.insert(key, value).is_some() {
                        return Err(invalid);
                    }
                } else {
                    let Value::String(text) = value else {
                        return Err(invalid);
                    };
                    *key = Some(text);
                }
            }
            None => {
                if root.replace(value).is_some() {
                    return Err(invalid);
                }
            }
        }
    }
    if documents != 1 || !stack.is_empty() {
        return Err(invalid);
    }
    root.filter(Value::is_object).ok_or(invalid)
}

fn scalar(text: String, style: TScalarStyle) -> Result<Value, ContextErrorKind> {
    if style != TScalarStyle::Plain {
        return Ok(Value::String(text));
    }
    // The parser's scalar helper omits these YAML core-schema null spellings.
    if matches!(text.as_str(), "Null" | "NULL") {
        return Ok(Value::Null);
    }
    // JSON also represents unsigned integers outside the parser's i64 range.
    if let Ok(number) = text.parse::<u64>() {
        return Ok(Value::Number(number.into()));
    }
    let value = match Yaml::from_str(&text) {
        Yaml::String(value) => Value::String(value),
        Yaml::Integer(value) => Value::Number(value.into()),
        Yaml::Real(value) => {
            let number = value
                .parse::<f64>()
                .ok()
                .and_then(Number::from_f64)
                .ok_or(ContextErrorKind::InvalidFrontmatter)?;
            Value::Number(number)
        }
        Yaml::Boolean(value) => Value::Bool(value),
        Yaml::Null => Value::Null,
        _ => return Err(ContextErrorKind::InvalidFrontmatter),
    };
    Ok(value)
}

fn validate(value: &Value) -> Result<(), ContextErrorKind> {
    let invalid = ContextErrorKind::InvalidFrontmatter;
    if !value
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(valid_name)
    {
        return Err(invalid);
    }
    let description = value
        .get("description")
        .and_then(Value::as_str)
        .ok_or(invalid)?;
    if description.trim().is_empty() || description.chars().count() > 1024 {
        return Err(invalid);
    }
    for key in ["license", "allowed-tools"] {
        if value.get(key).is_some_and(|value| !value.is_string()) {
            return Err(invalid);
        }
    }
    if let Some(compatibility) = value.get("compatibility") {
        let text = compatibility.as_str().ok_or(invalid)?;
        if text.trim().is_empty() || text.chars().count() > 500 {
            return Err(invalid);
        }
    }
    if let Some(metadata) = value.get("metadata") {
        let metadata = metadata.as_object().ok_or(invalid)?;
        if !metadata.values().all(Value::is_string) {
            return Err(invalid);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn context_frontmatter_stops_at_delimiter() {
        let metadata = b"\xef\xbb\xbf---\r\nname: review\r\ndescription: 'Review: code'\r\n---\r\n";
        let mut bytes = metadata.to_vec();
        bytes.extend_from_slice(b"\xffBODY_MUST_NOT_BE_CONSUMED");
        let mut input = Cursor::new(bytes);
        let parsed = read(&mut input).unwrap();
        assert_eq!(parsed["description"], "Review: code");
        assert_eq!(input.position(), metadata.len() as u64);
    }

    #[test]
    fn context_frontmatter_byte_limit_is_inclusive() {
        let prefix = "---\nname: review\ndescription: review\n#";
        let suffix = "\n---\n";
        let text = format!(
            "{prefix}{}{suffix}",
            "x".repeat(MAX_INPUT_BYTES - prefix.len() - suffix.len())
        );
        assert!(read(&mut Cursor::new(text.as_bytes())).is_ok());
        let oversized = text.replacen('#', "#x", 1);
        assert_eq!(
            read(&mut Cursor::new(oversized)).unwrap_err(),
            ContextErrorKind::InputTooLarge
        );
        assert_eq!(
            read(&mut Cursor::new(vec![b'x'; MAX_INPUT_BYTES + 100])).unwrap_err(),
            ContextErrorKind::InputTooLarge
        );
    }

    #[test]
    fn context_frontmatter_rejects_multiple_yaml_documents() {
        assert!(parse("name: review\ndescription: review\n...\n---\nname: other\n").is_err());
        assert!(parse("name: review\ndescription: review\n...\n--- {name: other}\n").is_err());
    }
}
