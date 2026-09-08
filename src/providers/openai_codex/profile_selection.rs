//! Session-local selection uses metadata only, never credentials or provider probes.
use crate::{GatewayError, Result};

#[derive(Clone, Debug, serde::Serialize)]
pub struct ProfileMetadata {
    pub name: String,
    pub enabled: bool,
    pub logged_in: bool,
    pub requires_reauthentication: bool,
    pub expires_at_unix: u64,
}

pub fn validate_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(GatewayError::InvalidAuth("invalid local profile name"));
    }
    Ok(())
}

/// The caller supplies unbiased random words. Rejection avoids modulo bias.
pub fn select_profile(
    profiles: &[ProfileMetadata],
    explicit: Option<&str>,
    mut random: impl FnMut() -> Result<u64>,
) -> Result<String> {
    for profile in profiles {
        validate_name(&profile.name)?;
    }
    let eligible = |p: &&ProfileMetadata| p.enabled && p.logged_in && !p.requires_reauthentication;
    if let Some(name) = explicit {
        validate_name(name)?;
        return profiles
            .iter()
            .filter(eligible)
            .find(|p| p.name == name)
            .map(|p| p.name.clone())
            .ok_or(GatewayError::InvalidAuth(
                "selected profile is unavailable; login or select another profile",
            ));
    }
    let candidates: Vec<_> = profiles.iter().filter(eligible).collect();
    if candidates.is_empty() {
        return Err(GatewayError::InvalidAuth(
            "no eligible Wi profiles; login first",
        ));
    }
    let count = candidates.len() as u64;
    let threshold = count.wrapping_neg() % count;
    loop {
        let value = random()?;
        if value >= threshold {
            return Ok(candidates[(value % count) as usize].name.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile(name: &str) -> ProfileMetadata {
        ProfileMetadata {
            name: name.into(),
            enabled: true,
            logged_in: true,
            requires_reauthentication: false,
            expires_at_unix: 1,
        }
    }
    #[test]
    fn managed_selector_exact_eligibility_and_empty() {
        let mut profiles = vec![profile("a"), profile("b"), profile("c")];
        profiles[1].enabled = false;
        profiles[2].requires_reauthentication = true;
        assert_eq!(
            select_profile(&profiles, Some("a"), || panic!()).unwrap(),
            "a"
        );
        for name in ["b", "c", "missing", "../a"] {
            assert!(select_profile(&profiles, Some(name), || panic!()).is_err());
        }
        assert!(select_profile(&[], None, || panic!()).is_err());
        assert_eq!(select_profile(&profiles, None, || Ok(0)).unwrap(), "a");
    }
    #[test]
    fn managed_selector_rejects_biased_range() {
        let profiles = vec![profile("a"), profile("b"), profile("c")];
        let mut words = [0, 2].into_iter();
        assert_eq!(
            select_profile(&profiles, None, || Ok(words.next().unwrap())).unwrap(),
            "c"
        );
        assert_eq!(select_profile(&profiles, None, || Ok(1)).unwrap(), "b");
        assert_eq!(select_profile(&profiles, None, || Ok(3)).unwrap(), "a");
    }
}
