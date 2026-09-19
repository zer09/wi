//! Regression inventory for the owner's native-platform support decision.
//! Historical documents and transitive dependency metadata are not source support.
use std::{fs, path::Path};

fn inspect(directory: &Path, root: &Path, findings: &mut Vec<String>) {
    for entry in fs::read_dir(directory).expect("read source directory") {
        let entry = entry.expect("read source entry");
        let kind = entry.file_type().expect("read source entry type");
        let path = entry.path();
        if kind.is_dir() {
            inspect(&path, root, findings);
            continue;
        }
        if !kind.is_file() || path == root.join("tests/platform_support.rs") {
            continue;
        }
        let extension = path.extension().and_then(|value| value.to_str());
        if matches!(extension, Some("ps1" | "bat" | "cmd")) {
            findings.push(path.strip_prefix(root).unwrap().display().to_string());
            continue;
        }
        if !matches!(extension, Some("rs" | "mjs" | "js" | "py")) {
            continue;
        }
        let source = fs::read_to_string(&path).expect("read UTF-8 source");
        let compact: String = source.chars().filter(|value| !value.is_whitespace()).collect();
        let markers = [
            "cfg(windows)",
            "cfg!(windows)",
            "not(windows)",
            "(windows,",
            ",windows)",
            ",windows,",
            "target_os=\"windows\"",
            "target_family=\"windows\"",
            "std::os::windows",
            "tokio::signal::windows",
            "\"win32\"",
            "'win32'",
            "os.name==\"nt\"",
            "os.name=='nt'",
        ];
        let found: Vec<_> = markers
            .into_iter()
            .filter(|marker| compact.contains(marker))
            .collect();
        if !found.is_empty() {
            findings.push(format!(
                "{}: {}",
                path.strip_prefix(root).unwrap().display(),
                found.join(", ")
            ));
        }
    }
}

#[test]
fn first_party_native_windows_compatibility_is_removed() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut findings = Vec::new();
    for directory in ["src", "tests", "examples", "scripts"] {
        inspect(&root.join(directory), root, &mut findings);
    }
    findings.sort();
    assert!(
        findings.is_empty(),
        "retired native-platform compatibility remains:\n{}",
        findings.join("\n")
    );
    let workflow = fs::read_to_string(root.join(".github/workflows/ci.yml")).unwrap();
    assert!(!workflow.contains("windows-latest"));
    assert!(workflow.contains("ubuntu-latest"));
    assert!(workflow.contains("macos-latest"));
}
