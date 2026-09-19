use super::*;
use serde_json::{Value, json};

fn fixture(root: &Path) -> Value {
    json!({"schema_version":1, "listen":"127.0.0.1:0", "public_origin":"https://wi.example.test/",
        "data_root": root.join("data"), "client_token_file":root.join("secret-path-canary"),
        "global_skills_root": root.join("missing-skills"), "workspaces":[root],
        "model":"synthetic-model", "instructions":"private-instructions-canary",
        "provider_transport":"websocket", "account":null, "enable_add_numbers":false})
}
fn parse(value: &Value) -> Result<ConfigFile, ConfigError> {
    ConfigFile::parse(&serde_json::to_vec(value).unwrap())
}

#[test]
fn strict_config_required_duplicate_unknown_null_fields_and_options() {
    let temp = tempfile::tempdir().unwrap();
    let value = fixture(temp.path());
    let config = parse(&value).unwrap();
    assert_eq!(config.listen().port(), 0);
    assert_eq!(config.settings().public_origin(), "https://wi.example.test");
    assert_eq!(config.settings().options().transport, Transport::WebSocket);
    assert!(config.account().is_none());
    assert!(!config.data_root().exists());
    assert!(!config.client_token_file().exists());
    assert_eq!(format!("{config:?}"), "ConfigFile([redacted])");
    assert_eq!(
        format!("{:?}", config.settings()),
        "ApiSettings([redacted])"
    );
    for key in value.as_object().unwrap().keys() {
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert!(parse(&missing).is_err(), "missing {key}");
        if key != "account" {
            let mut null = value.clone();
            null[key] = Value::Null;
            assert!(parse(&null).is_err(), "null {key}");
        }
        let duplicate = format!("{{\"{key}\":{},{}", value[key], &value.to_string()[1..]);
        assert!(
            ConfigFile::parse(duplicate.as_bytes()).is_err(),
            "duplicate {key}"
        );
    }
    for (key, bad) in [
        ("schema_version", json!(2)),
        ("extra", json!(true)),
        ("model", json!(" ")),
        ("model", json!("m".repeat(257))),
        ("instructions", json!("\n")),
        ("provider_transport", json!("web_socket")),
        ("account", json!("../private-canary")),
        ("data_root", json!("relative")),
        ("client_token_file", json!("relative")),
        ("global_skills_root", json!("relative")),
        ("workspaces", json!([])),
        ("workspaces", json!(["relative"])),
        ("enable_add_numbers", json!("false")),
    ] {
        let mut invalid = value.clone();
        invalid[key] = bad;
        let error = parse(&invalid).unwrap_err();
        assert!(!format!("{error} {error:?}").contains("private-canary"));
    }
    let mut sse = value;
    sse["provider_transport"] = json!("sse");
    sse["account"] = json!("synthetic-owner");
    assert_eq!(
        parse(&sse).unwrap().settings().options().transport,
        Transport::Sse
    );
}

#[test]
fn origin_and_literal_listener_rules() {
    for value in ["127.0.0.1:0", "127.20.30.40:8787", "[::1]:0"] {
        assert!(validate_listener(value.parse().unwrap()).is_ok());
    }
    for value in [
        "0.0.0.0:8787",
        "[::]:8787",
        "192.0.2.1:8787",
        "[::ffff:127.0.0.1]:8787",
    ] {
        assert_eq!(
            validate_listener(value.parse().unwrap()),
            Err(ConfigError::Listener)
        );
    }
    for (input, expected) in [
        ("https://Wi.Example.Test:443/", "https://wi.example.test"),
        ("http://127.0.0.1:80/", "http://127.0.0.1"),
        ("http://[::1]:8787", "http://[::1]:8787"),
        (
            "https://wi.example.test:8443",
            "https://wi.example.test:8443",
        ),
    ] {
        assert_eq!(origin(input).unwrap(), expected);
    }
    for value in [
        "http://localhost",
        "http://wi.example.test",
        "http://127.1",
        "http://2130706433",
        "http://0x7f000001",
        "http://[::ffff:127.0.0.1]",
        "ftp://127.0.0.1",
        "https://a:b@wi.example.test",
        "https://@wi.example.test",
        "https://wi.example.test/x",
        "https://wi.example.test/x/..",
        "https://wi.example.test?",
        "https://wi.example.test#",
        " https://wi.example.test",
        "https://wi.example.test\n",
        "https://wi.example.test\\",
        "https://",
        "https://wi.example.test:99999",
        "null",
    ] {
        assert!(origin(value).is_err(), "{value}");
    }
    let temp = tempfile::tempdir().unwrap();
    for value in ["localhost:8787", "127.1:8787", "0.0.0.0:8787"] {
        let mut config = fixture(temp.path());
        config["listen"] = json!(value);
        assert!(parse(&config).is_err());
    }
}

#[test]
fn library_settings_reject_comma_authority() {
    let temp = tempfile::tempdir().unwrap();
    for value in [
        "https://wi,example.test",
        "https://wi,example.test:443/",
        "https://wi%2cexample.test",
        "https://wi%2Cexample.test",
    ] {
        assert_eq!(
            ApiSettings::new(
                value,
                vec![temp.path().to_owned()],
                temp.path().join("missing-skills"),
                "synthetic".into(),
                SessionOptions::new("model"),
                false,
            )
            .unwrap_err(),
            ConfigError::Origin,
            "{value}"
        );
    }
}

#[test]
fn config_parse_rejects_comma_authority() {
    let temp = tempfile::tempdir().unwrap();
    for value in [
        "https://wi,example.test",
        "https://wi,example.test:443/",
        "https://wi%2cexample.test",
        "https://wi%2Cexample.test",
    ] {
        let mut config = fixture(temp.path());
        config["public_origin"] = json!(value);
        assert_eq!(parse(&config).unwrap_err(), ConfigError::Origin, "{value}");
    }
}

#[test]
fn config_regular_utf8_bounded_read_and_missing_skill_root() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config");
    let mut bytes = serde_json::to_vec(&fixture(temp.path())).unwrap();
    bytes.resize(MAX_INPUT_BYTES, b' ');
    fs::write(&path, &bytes).unwrap();
    assert!(ConfigFile::load(&path).is_ok());
    bytes.push(b' ');
    fs::write(&path, &bytes).unwrap();
    assert_eq!(ConfigFile::load(&path).unwrap_err(), ConfigError::TooLarge);
    fs::write(&path, [0xff]).unwrap();
    assert_eq!(ConfigFile::load(&path).unwrap_err(), ConfigError::Invalid);
    assert_eq!(
        ConfigFile::load(temp.path()).unwrap_err(),
        ConfigError::File
    );
    assert_eq!(
        ConfigFile::load(Path::new("relative")).unwrap_err(),
        ConfigError::Path
    );
    let mut value = fixture(temp.path());
    value["global_skills_root"] = json!(path);
    assert_eq!(parse(&value).unwrap_err(), ConfigError::Path);
}

#[cfg(unix)]
#[test]
fn canonical_workspaces_deduplicate_and_reject_alias_replacement() {
    use std::os::unix::{ffi::OsStringExt, fs::symlink};
    let temp = tempfile::tempdir().unwrap();
    // Exercise a noncanonical parent even when the platform's temp root has no alias.
    let root_alias = temp.path().join("root-alias");
    symlink(temp.path(), &root_alias).unwrap();
    let workspace = root_alias.join("workspace");
    let other = temp.path().join("other");
    let alias = temp.path().join("alias");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&other).unwrap();
    symlink(&workspace, &alias).unwrap();
    let canonical_workspace = fs::canonicalize(&workspace).unwrap();
    let before = std::env::current_dir().unwrap();
    let mut value = fixture(temp.path());
    value["workspaces"] = json!([workspace, alias, workspace.join(".")]);
    let config = parse(&value).unwrap();
    let settings = config.settings();
    assert_eq!(
        settings.workspaces(),
        &[canonical_workspace.to_str().unwrap()]
    );
    assert!(settings.workspace(workspace.to_str().unwrap()).is_none());
    assert!(settings.workspace(alias.to_str().unwrap()).is_none());
    assert!(
        settings
            .revalidate_workspace("/never-authorized-canary")
            .is_err()
    );
    assert!(
        settings
            .revalidate_workspace(canonical_workspace.to_str().unwrap())
            .is_ok()
    );
    fs::rename(&workspace, temp.path().join("moved")).unwrap();
    symlink(&other, &workspace).unwrap();
    assert!(
        settings
            .revalidate_workspace(canonical_workspace.to_str().unwrap())
            .is_err()
    );
    assert_eq!(before, std::env::current_dir().unwrap());
    let invalid_utf8 = temp.path().join(std::ffi::OsString::from_vec(vec![0xff]));
    if let Err(error) = fs::create_dir(&invalid_utf8) {
        // APFS can reject this name before the configuration code can inspect it.
        if cfg!(target_os = "macos") && error.raw_os_error() == Some(libc::EILSEQ) {
            eprintln!("invalid-UTF8 workspace fixture unavailable: filesystem rejects the name");
            return;
        }
        panic!("creating invalid-UTF8 workspace fixture failed: {error}");
    }
    assert!(
        ApiSettings::new(
            "https://example.test",
            vec![invalid_utf8],
            temp.path().join("missing"),
            "synthetic".into(),
            SessionOptions::new("model"),
            false
        )
        .is_err()
    );
}

#[test]
fn library_settings_reject_tools_and_invalid_options() {
    let temp = tempfile::tempdir().unwrap();
    let mut options = SessionOptions::new("model");
    options.tools.push(crate::ToolDefinition {
        name: "injected".into(),
        description: String::new(),
        parameters: json!({"type":"object"}),
        strict: true,
    });
    assert_eq!(
        ApiSettings::new(
            "https://example.test",
            vec![temp.path().to_owned()],
            temp.path().join("missing"),
            "synthetic".into(),
            options,
            false
        )
        .unwrap_err(),
        ConfigError::Options
    );
}
