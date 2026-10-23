use super::*;
use serde_json::json;

fn document() -> String {
    json!({"openai-codex":{"type":"oauth","access":"synthetic-token","expires":4102444800000u64,"accountId":"synthetic-account"}}).to_string()
}

#[test]
fn default_locations_ignore_retired_platform_home() {
    const CHILD: &str = "WI_AUTH_LOCATION_TEST";
    if std::env::var_os(CHILD).is_some() {
        let home = std::env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        for source in [AuthSource::Codex, AuthSource::Pi] {
            let expected = match source {
                AuthSource::Codex => std::env::var_os("CODEX_HOME")
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
                    .or_else(|| home.as_ref().map(|path| path.join(".codex")))
                    .map(|path| path.join("auth.json")),
                AuthSource::Pi => home.as_ref().map(|path| path.join(".pi/agent/auth.json")),
            };
            let actual = LocalAuthFile::default_for(source);
            match expected {
                Some(path) => assert_eq!(actual.unwrap().path, path),
                None => assert!(matches!(actual, Err(GatewayError::HomeUnavailable))),
            }
        }
        return;
    }

    // Separate children keep environment changes away from parallel tests. No file is loaded.
    let temp = tempfile::tempdir().unwrap();
    for home in [None, Some(PathBuf::new()), Some(temp.path().join("home"))] {
        for codex in [None, Some(PathBuf::new()), Some(temp.path().join("codex"))] {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "providers::openai_codex::auth::edge_tests::default_locations_ignore_retired_platform_home",
                ])
                .env_clear()
                .env(CHILD, "1")
                .env("USERPROFILE", temp.path().join("retired-home-canary"))
                .current_dir(temp.path());
            if let Some(home) = &home {
                command.env("HOME", home);
            }
            if let Some(codex) = codex {
                command.env("CODEX_HOME", codex);
            }
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
}
#[tokio::test]
async fn auth_bom_and_exact_size_boundary() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let source = LocalAuthFile::new(AuthSource::Pi, file.path());
    let mut bytes = vec![0xef, 0xbb, 0xbf];
    bytes.extend(document().bytes());
    std::fs::write(file.path(), &bytes).unwrap();
    assert!(source.load().await.is_ok());
    bytes.resize(MAX_AUTH_BYTES, b' ');
    std::fs::write(file.path(), &bytes).unwrap();
    assert!(source.load().await.is_ok());
    bytes.push(b' ');
    std::fs::write(file.path(), &bytes).unwrap();
    assert!(matches!(
        source.load().await,
        Err(GatewayError::AuthFileTooLarge)
    ));
}
#[tokio::test]
async fn auth_missing_directory_and_empty_file() {
    let directory = tempfile::tempdir().unwrap();
    assert!(matches!(
        LocalAuthFile::new(AuthSource::Pi, directory.path())
            .load()
            .await,
        Err(GatewayError::AuthFileType)
    ));
    assert!(matches!(
        LocalAuthFile::new(AuthSource::Pi, directory.path().join("missing"))
            .load()
            .await,
        Err(GatewayError::AuthRead(std::io::ErrorKind::NotFound))
    ));
    let file = tempfile::NamedTempFile::new().unwrap();
    assert!(matches!(
        LocalAuthFile::new(AuthSource::Pi, file.path()).load().await,
        Err(GatewayError::InvalidAuth(_))
    ));
}
#[cfg(unix)]
#[tokio::test]
async fn auth_symlink_and_permission_variants() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let directory = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(directory.path()).unwrap();
    std::fs::write(file.path(), document()).unwrap();
    let link = directory.path().join("link");
    symlink(file.path(), &link).unwrap();
    assert!(matches!(
        LocalAuthFile::new(AuthSource::Pi, &link).load().await,
        Err(GatewayError::AuthFileType)
    ));
    let source = LocalAuthFile::new(AuthSource::Pi, file.path());
    for mode in [0o400, 0o600, 0o700] {
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(mode)).unwrap();
        assert!(source.load().await.is_ok());
    }
    for mode in [0o640, 0o604, 0o620, 0o602, 0o610, 0o601, 0o660, 0o777] {
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(mode)).unwrap();
        assert!(matches!(
            source.load().await,
            Err(GatewayError::AuthPermissions)
        ));
    }
}
#[test]
fn pi_missing_and_malformed_records_never_select_another_provider() {
    let base: serde_json::Value = serde_json::from_str(&document()).unwrap();
    for field in ["type", "access", "expires", "accountId"] {
        let mut value = base.clone();
        value["openai-codex"].as_object_mut().unwrap().remove(field);
        value["other-provider"] = base["openai-codex"].clone();
        assert!(matches!(
            parse_credentials(AuthSource::Pi, value.to_string().as_bytes()),
            Err(GatewayError::InvalidAuth(_))
        ));
    }
    for record in [
        serde_json::Value::Null,
        json!([]),
        json!("private-record"),
        json!({}),
        json!({"type":"oauth","access":"private-token","expires":-1}),
    ] {
        let value = json!({"openai-codex":record,"other-provider":base["openai-codex"]});
        let error = parse_credentials(AuthSource::Pi, value.to_string().as_bytes()).unwrap_err();
        assert!(matches!(error, GatewayError::InvalidAuth(_)));
        assert!(!format!("{error:?} {error}").contains("private"));
    }
}

#[test]
fn pi_modes_and_expiry_fail_closed() {
    let base: serde_json::Value = serde_json::from_str(&document()).unwrap();
    for mode in ["api_key", "apikey", "unknown", ""] {
        let mut value = base.clone();
        value["openai-codex"]["type"] = json!(mode);
        assert!(matches!(
            parse_credentials(AuthSource::Pi, value.to_string().as_bytes()),
            Err(GatewayError::InvalidAuth(_))
        ));
    }
    for expires in [0u64, 1, 1000] {
        let mut value = base.clone();
        value["openai-codex"]["expires"] = json!(expires);
        assert!(matches!(
            parse_credentials(AuthSource::Pi, value.to_string().as_bytes()),
            Err(GatewayError::AuthExpired)
        ));
    }
    let mut value = base;
    value["openai-codex"]["access"] = json!(super::tests::jwt(1));
    assert!(matches!(
        parse_credentials(AuthSource::Pi, value.to_string().as_bytes()),
        Err(GatewayError::AuthExpired)
    ));
}
#[tokio::test]
async fn pi_owner_account_update_is_loaded_without_writes() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let source = LocalAuthFile::new(AuthSource::Pi, file.path());
    let first = document();
    std::fs::write(file.path(), &first).unwrap();
    assert_eq!(
        source.load().await.unwrap().account_id(),
        "synthetic-account"
    );
    let mut second: serde_json::Value = serde_json::from_str(&first).unwrap();
    second["openai-codex"]["accountId"] = json!("synthetic-new-account");
    let second = second.to_string();
    std::fs::write(file.path(), &second).unwrap();
    assert_eq!(
        source.load().await.unwrap().account_id(),
        "synthetic-new-account"
    );
    assert_eq!(std::fs::read_to_string(file.path()).unwrap(), second);
}
