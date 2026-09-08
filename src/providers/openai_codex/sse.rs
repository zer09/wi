//! Incremental SSE framing. HTTP chunks, UTF-8 characters, lines and events have
//! independent boundaries. Also accepts a final unseparated frame at Codex EOF.

use crate::{GatewayError, Result};

const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Default)]
pub(super) struct SseDecoder {
    line: Vec<u8>,
    data: String,
    after_cr: bool,
    first_line_seen: bool,
    frame_bytes: usize,
    strict_prolog: bool,
    event_label: String,
    dispatched_label: String,
}

impl SseDecoder {
    pub fn strict_prolog() -> Self {
        Self {
            strict_prolog: true,
            ..Self::default()
        }
    }

    pub fn dispatched_label(&self) -> &str {
        &self.dispatched_label
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        let mut frames = Vec::new();
        for &byte in bytes {
            if self.after_cr {
                self.after_cr = false;
                if byte == b'\n' {
                    continue;
                }
            }
            self.frame_bytes += 1;
            if self.frame_bytes > MAX_FRAME_BYTES {
                return Err(GatewayError::StreamTooLarge);
            }
            match byte {
                b'\r' => {
                    self.finish_line(&mut frames)?;
                    self.after_cr = true;
                }
                b'\n' => self.finish_line(&mut frames)?,
                _ => self.line.push(byte),
            }
        }
        Ok(frames)
    }

    pub fn finish(&mut self) -> Result<Vec<String>> {
        let mut frames = Vec::new();
        if !self.line.is_empty() {
            self.finish_line(&mut frames)?;
        }
        self.dispatch(&mut frames);
        Ok(frames)
    }

    fn finish_line(&mut self, frames: &mut Vec<String>) -> Result<()> {
        let line = std::mem::take(&mut self.line);
        let mut text = std::str::from_utf8(&line)
            .map_err(|_| GatewayError::Protocol("SSE line is not UTF-8"))?;
        if !self.first_line_seen {
            self.first_line_seen = true;
            text = text.strip_prefix('\u{feff}').unwrap_or(text);
        }
        if self.strict_prolog {
            if text.chars().any(|c| c.is_control() && c != '\t') {
                return Err(GatewayError::UnexpectedContentType);
            }
            if !text.is_empty() && !text.starts_with(':') {
                let (field, value) = text.split_once(':').unwrap_or((text, ""));
                let value = value.strip_prefix(' ').unwrap_or(value);
                match field {
                    "data" | "id" => {}
                    "event" => self.event_label = value.into(),
                    "retry" if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {}
                    _ => return Err(GatewayError::UnexpectedContentType),
                }
            }
        }
        if text.is_empty() {
            self.dispatch(frames);
        } else if let Some(value) = text.strip_prefix("data:") {
            self.data.push_str(value.strip_prefix(' ').unwrap_or(value));
            self.data.push('\n');
        } else if text == "data" {
            self.data.push('\n');
        }
        // Ignore comments, event/id/retry fields. JSON payload carries its type.
        Ok(())
    }

    fn dispatch(&mut self, frames: &mut Vec<String>) {
        if !self.data.is_empty() {
            let _ = self.data.pop(); // remove the newline appended by the last data field
            frames.push(std::mem::take(&mut self.data));
        }
        if self.strict_prolog {
            self.dispatched_label = std::mem::take(&mut self.event_label);
        }
        self.frame_bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_possible_chunk_boundary_including_unicode_and_crlf() {
        let input = "\u{feff}: keepalive\r\nevent: response\r\ndata: {\"text\":\"Hello 世界\"}\r\n\r\ndata: [DONE]";
        for split in 0..=input.len() {
            let mut decoder = SseDecoder::default();
            let mut frames = decoder.feed(&input.as_bytes()[..split]).unwrap();
            frames.extend(decoder.feed(&input.as_bytes()[split..]).unwrap());
            frames.extend(decoder.finish().unwrap());
            assert_eq!(frames, vec!["{\"text\":\"Hello 世界\"}", "[DONE]"]);
        }
    }

    #[test]
    fn byte_by_byte_with_all_sse_line_endings() {
        for ending in ["\n", "\r\n", "\r"] {
            let input = format!("data: one{ending}data: two{ending}{ending}");
            let mut decoder = SseDecoder::default();
            let mut frames = Vec::new();
            for byte in input.bytes() {
                frames.extend(decoder.feed(&[byte]).unwrap());
            }
            frames.extend(decoder.finish().unwrap());
            assert_eq!(frames, vec!["one\ntwo"]);
        }
    }

    #[test]
    fn empty_data_and_comments() {
        let mut decoder = SseDecoder::default();
        assert_eq!(decoder.feed(b": heartbeat\n\ndata:\n\n").unwrap(), vec![""]);
    }

    #[test]
    fn invalid_utf8_is_not_silently_replaced() {
        assert!(SseDecoder::default().feed(b"data: \xff\n\n").is_err());
    }

    #[test]
    fn refuses_unbounded_frames() {
        let mut decoder = SseDecoder::default();
        assert!(matches!(
            decoder.feed(&vec![b'x'; MAX_FRAME_BYTES + 1]),
            Err(GatewayError::StreamTooLarge)
        ));
    }
}
