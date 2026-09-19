use std::{fmt, io::Read, path::Path};

use ring::{hmac, rand::SystemRandom};
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum TokenError {
    #[error("api.token_file_invalid")]
    File,
    #[error("api.token_format_invalid")]
    Format,
    #[error("api.token_randomness_unavailable")]
    Randomness,
}

/// A process-private verifier. File changes take effect only on the next load.
pub struct OwnerToken {
    key: hmac::Key,
    tag: hmac::Tag,
}

impl fmt::Debug for OwnerToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OwnerToken([redacted])")
    }
}

impl OwnerToken {
    pub fn load(path: &Path) -> Result<Self, TokenError> {
        if !path.is_absolute() {
            return Err(TokenError::File);
        }
        let mut file = super::files::open_regular(path, true).map_err(|_| TokenError::File)?;
        // Fixed storage avoids leaving a secret in an old allocation after a resize.
        let mut bytes = Zeroizing::new([0u8; 66]);
        let mut length = 0;
        while length < bytes.len() {
            let count = file
                .read(&mut bytes[length..])
                .map_err(|_| TokenError::File)?;
            if count == 0 {
                break;
            }
            length += count;
        }
        let secret = match length {
            64 => &bytes[..64],
            65 if bytes[64] == b'\n' => &bytes[..64],
            _ => return Err(TokenError::Format),
        };
        if !canonical(secret) {
            return Err(TokenError::Format);
        }
        let key = hmac::Key::generate(hmac::HMAC_SHA256, &SystemRandom::new())
            .map_err(|_| TokenError::Randomness)?;
        let tag = hmac::sign(&key, secret);
        Ok(Self { key, tag })
    }

    pub fn verify(&self, candidate: &[u8]) -> bool {
        canonical(candidate) && hmac::verify(&self.key, candidate, self.tag.as_ref()).is_ok()
    }
}

fn canonical(bytes: &[u8]) -> bool {
    bytes.len() == 64
        && bytes
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const SYNTHETIC: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    pub(crate) fn write_private(path: &Path, bytes: &[u8]) {
        fs::write(path, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }

    #[test]
    fn hmac_verifier_is_fixed_format_redacted_and_loaded_once() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("synthetic-owner");
        for suffix in ["", "\n"] {
            write_private(&path, format!("{SYNTHETIC}{suffix}").as_bytes());
            let verifier = OwnerToken::load(&path).unwrap();
            assert!(verifier.verify(SYNTHETIC.as_bytes()));
            assert!(!verifier.verify("f".repeat(64).as_bytes()));
            assert!(!verifier.verify(format!("{SYNTHETIC}\n").as_bytes()));
            assert!(!verifier.verify(SYNTHETIC.to_uppercase().as_bytes()));
            assert_eq!(format!("{verifier:?}"), "OwnerToken([redacted])");
            write_private(&path, "f".repeat(64).as_bytes());
            assert!(verifier.verify(SYNTHETIC.as_bytes()));
            assert!(
                !OwnerToken::load(&path)
                    .unwrap()
                    .verify(SYNTHETIC.as_bytes())
            );
        }
    }

    #[test]
    fn rejects_malformed_and_bounded_token_files() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("private-path-canary");
        for text in [
            String::new(),
            "a".repeat(63),
            "a".repeat(66),
            "a".repeat(100_000),
            format!("{SYNTHETIC}\r\n"),
            format!("{SYNTHETIC}\n\n"),
            format!("\u{feff}{SYNTHETIC}"),
            format!(" {SYNTHETIC}"),
            SYNTHETIC.to_uppercase(),
            "g".repeat(64),
        ] {
            write_private(&path, text.as_bytes());
            let error = OwnerToken::load(&path).unwrap_err();
            assert_eq!(error, TokenError::Format);
            assert!(!format!("{error:?} {error}").contains("private-path-canary"));
        }
        assert!(OwnerToken::load(temp.path()).is_err());
        assert!(OwnerToken::load(Path::new("relative")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_links_special_files_and_nonprivate_modes() {
        use std::os::unix::{
            fs::{PermissionsExt, symlink},
            net::UnixListener,
        };
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("owner");
        write_private(&path, SYNTHETIC.as_bytes());
        let link = temp.path().join("link");
        symlink(&path, &link).unwrap();
        assert_eq!(OwnerToken::load(&link).unwrap_err(), TokenError::File);
        for mode in [0o604, 0o640, 0o601, 0o610, 0o660] {
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            assert_eq!(OwnerToken::load(&path).unwrap_err(), TokenError::File);
        }
        let socket = temp.path().join("socket");
        let _listener = UnixListener::bind(&socket).unwrap();
        assert_eq!(OwnerToken::load(&socket).unwrap_err(), TokenError::File);
        #[cfg(target_os = "linux")]
        {
            let fifo = temp.path().join("fifo");
            rustix::fs::mknodat(
                rustix::fs::CWD,
                &fifo,
                rustix::fs::FileType::Fifo,
                rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
                0,
            )
            .unwrap();
            assert_eq!(OwnerToken::load(&fifo).unwrap_err(), TokenError::File);
        }
    }
}
