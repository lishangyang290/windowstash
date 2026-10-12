//! Browser routing hints only. Chrome files never authorize credential access.
use std::{collections::BTreeSet, fs, path::Path};

pub const AMBIGUOUS: &str = "请选择要使用的 Chrome Profile";

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, serde::Serialize, serde::Deserialize)]
pub struct Target {
    pub profile: String,
    pub extension_id: String,
}

pub fn valid_extension_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

fn valid_profile(value: &str) -> bool {
    value == "Default"
        || value
            .strip_prefix("Profile ")
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

pub fn select(targets: &[Target], saved: Option<&Target>) -> Result<Option<Target>, String> {
    if let Some(saved) = saved {
        return targets
            .iter()
            .find(|target| *target == saved)
            .cloned()
            .map(Some)
            .ok_or_else(|| "原来选择的 Chrome Profile 已不可用，请重新选择".into());
    }
    match targets {
        [] => Ok(None),
        [target] => Ok(Some(target.clone())),
        _ => Err(AMBIGUOUS.into()),
    }
}

fn candidates(preferences: &serde_json::Value, profile: &str) -> Vec<(Target, String)> {
    if !valid_profile(profile) {
        return Vec::new();
    }
    preferences
        .pointer("/extensions/settings")
        .and_then(|v| v.as_object())
        .into_iter()
        .flat_map(|settings| settings.iter())
        .filter_map(|(id, setting)| {
            // Ignore disabled and uninstalled extensions; an Extensions directory
            // left on disk is not evidence that a profile can handle this route.
            let enabled = match setting.get("disable_reasons") {
                Some(serde_json::Value::Array(reasons)) => reasons.is_empty(),
                Some(serde_json::Value::Number(reasons)) => reasons.as_u64() == Some(0),
                None | Some(serde_json::Value::Null) => true,
                _ => false,
            } && match setting.get("state") {
                None | Some(serde_json::Value::Null) => true,
                Some(state) => state.as_u64() == Some(1),
            };
            if !valid_extension_id(id) || !enabled {
                return None;
            }
            let path = setting.get("path")?.as_str()?.to_string();
            Some((
                Target {
                    profile: profile.into(),
                    extension_id: id.clone(),
                },
                path,
            ))
        })
        .collect()
}

fn decode_preferences(bytes: &[u8]) -> Result<serde_json::Value, String> {
    let preferences: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "Chrome Profile 信息损坏，无法确定打开目标")?;
    if !preferences.is_object() {
        return Err("Chrome Profile 信息损坏，无法确定打开目标".into());
    }
    Ok(preferences)
}

pub fn discover(root: &Path) -> Result<Vec<Target>, String> {
    let profiles = fs::read_dir(root).map_err(|_| "无法读取 Chrome Profile 信息")?;
    let mut targets = BTreeSet::new();
    for profile in profiles {
        let profile = profile.map_err(|_| "无法读取 Chrome Profile 信息")?;
        let name = profile.file_name().to_string_lossy().into_owned();
        if !valid_profile(&name) {
            continue;
        }
        for filename in ["Preferences", "Secure Preferences"] {
            let bytes = match fs::read(profile.path().join(filename)) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err("无法读取 Chrome Profile 信息，无法确定打开目标".into()),
            };
            let preferences = decode_preferences(&bytes)?;
            for (target, path) in candidates(&preferences, &name) {
                let path = Path::new(&path);
                let directory = if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    profile.path().join(path)
                };
                let manifest: serde_json::Value =
                    fs::read_to_string(directory.join("manifest.json"))
                        .ok()
                        .and_then(|v| serde_json::from_str(&v).ok())
                        .unwrap_or_default();
                if manifest.get("name").and_then(|v| v.as_str()) == Some("WindowStash") {
                    targets.insert(target);
                }
            }
        }
    }
    Ok(targets.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    fn target(profile: &str) -> Target {
        Target {
            profile: profile.into(),
            extension_id: ID.into(),
        }
    }

    #[test]
    fn same_extension_in_two_profiles_is_ambiguous() {
        assert_eq!(
            select(&[target("Default"), target("Profile 1")], None).unwrap_err(),
            AMBIGUOUS
        );
    }

    #[test]
    fn two_extensions_in_one_profile_are_ambiguous() {
        let mut other = target("Default");
        other.extension_id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into();
        assert!(select(&[target("Default"), other], None).is_err());
    }

    #[test]
    fn duplicate_preferences_are_not_multiple_profiles() {
        assert_eq!(
            select(&[target("Profile 1")], None).unwrap(),
            Some(target("Profile 1"))
        );
        assert_eq!(select(&[], None).unwrap(), None);
    }

    #[test]
    fn selected_profile_survives_other_profiles_and_never_falls_back() {
        let saved = target("Profile 1");
        assert_eq!(
            select(&[target("Default"), saved.clone()], Some(&saved)).unwrap(),
            Some(saved.clone())
        );
        assert!(select(&[target("Default")], Some(&saved)).is_err());
    }

    #[test]
    fn disabled_extensions_and_invalid_profiles_are_ignored() {
        let preferences =
            serde_json::json!({"extensions":{"settings":{ID:{"state":0,"path":"/extension"}}}});
        assert!(candidates(&preferences, "Default").is_empty());
        assert!(!valid_profile("Profile ../../outside"));
        assert!(!valid_profile("Profile "));
        assert!(!valid_extension_id("../../manifest.json"));
    }

    #[test]
    fn enabled_candidate_preserves_its_profile() {
        let preferences =
            serde_json::json!({"extensions":{"settings":{ID:{"state":1,"path":"/extension"}}}});
        assert_eq!(
            candidates(&preferences, "Profile 2"),
            vec![(target("Profile 2"), "/extension".into())]
        );
    }

    #[test]
    fn modern_chrome_without_state_supports_empty_or_missing_disable_reasons() {
        for reasons in [
            serde_json::Value::Null,
            serde_json::json!([]),
            serde_json::json!(0),
        ] {
            let preferences = serde_json::json!({"extensions":{"settings":{ID:{"disable_reasons":reasons,"path":"/extension"}}}});
            assert_eq!(candidates(&preferences, "Profile 2").len(), 1);
        }
        for reasons in [
            serde_json::json!([1]),
            serde_json::json!(1),
            serde_json::json!("unknown"),
        ] {
            let preferences = serde_json::json!({"extensions":{"settings":{ID:{"disable_reasons":reasons,"path":"/extension"}}}});
            assert!(candidates(&preferences, "Profile 2").is_empty());
        }
    }

    #[test]
    fn corrupt_preferences_are_not_treated_as_an_empty_profile() {
        for bytes in [b"broken".as_slice(), b"null", b"[]"] {
            assert!(decode_preferences(bytes).is_err());
        }
        assert!(decode_preferences(b"{}").is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "read-only inspection of the developer's installed Chrome profiles"]
    fn inspect_installed_chrome_profiles() {
        let root = std::path::PathBuf::from(std::env::var_os("HOME").unwrap())
            .join("Library/Application Support/Google/Chrome");
        let result = discover(&root);
        match &result {
            Ok(targets) => {
                assert!(targets.iter().all(|target| valid_profile(&target.profile)
                    && valid_extension_id(&target.extension_id)))
            }
            Err(error) => panic!("{error}"),
        }
        println!(
            "Read-only local Chrome discovery: {result:?}; no account state or credentials read."
        );
    }
}
