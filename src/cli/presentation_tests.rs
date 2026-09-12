use std::io::Write;

pub(super) const GOLDEN: &[(&str, &str)] = &[
    ("first\n\tsecond", "first\n\tsecond"),
    ("first\r\n\tsecond\r", "first\n\tsecond"),
    (
        "  before\n```rust\n\tlet x = \"雪\";\n```\n  after  ",
        "  before\n```rust\n\tlet x = \"雪\";\n```\n  after  ",
    ),
    (
        "café e\u{0301} 雪 🦀\u{200d}\u{202e}\u{2028}\u{2029}",
        "café e\u{0301} 雪 🦀\u{200d}\u{202e}\u{2028}\u{2029}",
    ),
    ("", ""),
    (
        "\x1b[31mred\x1b[0m\x07\0\r\x7f\u{0085}\u{009b}\u{009c}",
        "[31mred[0m",
    ),
    ("\x1b]0;title\x07\x1b\\\n\tend", "]0;title\\\n\tend"),
    ("\u{0080}\u{009f}\x01\x08\x0b\x0c\x1f", ""),
];

pub(super) const FRAGMENTS: &[(&str, &str)] = &[
    ("first\r", "first"),
    ("\n\t\x1b", "\n\t"),
    ("[31m雪", "[31m雪"),
    ("\x1b", ""),
    ("[0m\x1b]0;title", "[0m]0;title"),
    ("\x07\0\r\x7f\u{009b}", ""),
    ("1mend", "1mend"),
];

#[derive(Default)]
pub(super) struct Captured {
    pub(super) bytes: Vec<u8>,
    pub(super) flushes: usize,
}
impl Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.flushes += 1;
        Ok(())
    }
}

#[test]
fn r1_multiline_policy_golden_all_controls_and_every_split() {
    for &(raw, plain) in GOLDEN {
        assert_eq!(super::context_cli::filtered_multiline(raw), plain);
        for split in raw
            .char_indices()
            .map(|(index, _)| index)
            .chain([raw.len()])
        {
            let (prefix, suffix) = raw.split_at(split);
            assert_eq!(
                super::context_cli::filtered_multiline(prefix)
                    + &super::context_cli::filtered_multiline(suffix),
                plain,
            );
        }
    }
    let controls: String = ('\0'..='\u{009f}').filter(|c| c.is_control()).collect();
    assert_eq!(super::context_cli::filtered_multiline(&controls), "\t\n");
}

#[test]
fn r1_single_line_diagnostics_still_drop_all_controls() {
    for &(raw, plain) in GOLDEN {
        assert_eq!(
            super::context_cli::filtered(raw),
            plain.replace(['\n', '\t'], "")
        );
    }
    let controls: String = ('\0'..='\u{009f}').filter(|c| c.is_control()).collect();
    assert_eq!(super::context_cli::filtered(&controls), "");
}
