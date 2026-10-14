//! Profile routing and non-secret component status. This is not account pairing.
use crate::chrome::{self, Target};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use windowstash_native_host::bridge::{self, DesktopStatus, Receipt};
#[cfg(target_os = "windows")]
use winreg::{enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, KEY_WOW64_32KEY, KEY_WOW64_64KEY}, RegKey};

#[derive(Clone, Serialize, Deserialize)]
pub struct Selection {
    pub target: Target,
    pub route_id: String,
    pub instance_id: Option<String>,
}
#[derive(Serialize)]
pub struct Connection {
    pub targets: Vec<Target>,
    pub selected: Option<Selection>,
    pub error: Option<String>,
    pub last_received_at: Option<u64>,
    pub host_error: Option<String>,
}

fn write_manifest(path: &Path, executable: &Path, targets: Option<&[Target]>) -> Result<(), String> {
    if !executable.is_file() {
        return Err("本机通信组件缺失，请重新安装 Companion".into());
    }
    let previous = fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let origins: std::collections::BTreeSet<String> = match targets {
        Some(targets) => targets.iter().filter(|target| chrome::valid_extension_id(&target.extension_id))
            .map(|target| format!("chrome-extension://{}/", target.extension_id)).collect(),
        // A temporarily unreadable Profile must not prevent repairing an old executable path.
        // Retain only exact, valid origins; never infer new authorization from a failed scan.
        None => previous.as_ref().and_then(|value| value["allowed_origins"].as_array())
            .into_iter().flatten().filter_map(|value| value.as_str())
            .filter(|origin| origin.strip_prefix("chrome-extension://").and_then(|id| id.strip_suffix('/'))
                .is_some_and(chrome::valid_extension_id)).map(str::to_owned).collect(),
    };
    // No wildcard origins. An unpacked extension's ID is discovered after installation.
    let manifest = serde_json::json!({
            "name": bridge::HOST_NAME, "description": "WindowStash Companion status bridge",
            "path": executable, "type": "stdio", "allowed_origins": origins,
        });
    if previous.as_ref() == Some(&manifest) { return Ok(()); }
    bridge::write_json(path, &manifest)
        .map_err(|_| format!("无法更新本机通信组件注册：{}。请检查目录是否可写，或重新安装 Companion", path.display()))
}

#[cfg(not(target_os = "windows"))]
pub fn register(chrome_root: &Path, executable: &Path, targets: Option<&[Target]>) -> Result<(), String> {
    write_manifest(
        &chrome_root
            .join("NativeMessagingHosts")
            .join(format!("{}.json", bridge::HOST_NAME)),
        executable,
        targets,
    )
}

#[cfg(target_os = "windows")]
fn windows_registry_key() -> String {
    format!(
        r"Software\Google\Chrome\NativeMessagingHosts\{}",
        bridge::HOST_NAME
    )
}

#[cfg(target_os = "windows")]
pub fn register(_chrome_root: &Path, executable: &Path, targets: Option<&[Target]>) -> Result<(), String> {
    let manifest = bridge::directory()
        .map_err(str::to_string)?
        .join("native-messaging")
        .join(format!("{}.json", bridge::HOST_NAME));
    write_manifest(&manifest, executable, targets)?;
    register_windows(&manifest, &windows_registry_key())
}

#[cfg(target_os = "windows")]
fn register_windows(manifest: &Path, subkey: &str) -> Result<(), String> {
    // Chrome checks the 32-bit view first. An old entry there can shadow the new 64-bit entry.
    for view in [KEY_WOW64_32KEY, KEY_WOW64_64KEY] {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey_with_flags(subkey, KEY_READ | KEY_WRITE | view)
            .map_err(|error| format!("无法注册本机通信组件（当前用户注册表视图 {view:#x}）：{error}"))?;
        let path = manifest.to_string_lossy().into_owned();
        if key.get_value::<String, _>("").ok().as_ref() != Some(&path) {
            key.set_value("", &path)
                .map_err(|error| format!("无法更新本机通信组件注册（当前用户注册表视图 {view:#x}）：{error}"))?;
        }
    }
    Ok(())
}

pub fn helper() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .map(|parent| {
            parent.join(if cfg!(target_os = "windows") {
                "windowstash-native-host.exe"
            } else {
                "windowstash-native-host"
            })
        })
        .ok_or_else(|| "无法定位本机通信组件".into())
}

fn saved(root: &Path) -> Result<Option<Selection>, String> {
    match fs::read(root.join("selection.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "Chrome 关联记录损坏，请重新选择".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn choose(root: &Path, targets: &[Target], target: Target) -> Result<Selection, String> {
    if !targets.contains(&target) {
        return Err("此 Chrome Profile 已不可用，请刷新后重试".into());
    }
    let selection = Selection {
        target,
        route_id: bridge::random_id(),
        instance_id: None,
    };
    bridge::write_json(&root.join("selection.json"), &selection).map_err(str::to_string)?;
    Ok(selection)
}

pub fn inspect(chrome_root: &Path, root: &Path, executable: &Path) -> Result<Connection, String> {
    inspect_with(chrome_root, root, |targets| register(chrome_root, executable, targets))
}

fn inspect_with(chrome_root: &Path, root: &Path, register: impl FnOnce(Option<&[Target]>) -> Result<(), String>) -> Result<Connection, String> {
    let discovered = chrome::discover(chrome_root);
    let host_error = register(discovered.as_ref().ok().map(Vec::as_slice)).err()
        .or_else(|| discovered.as_ref().err().cloned());
    bridge::write_json(
        &root.join("desktop.json"),
        &DesktopStatus {
            updated_at: bridge::now(),
        },
    )
    .map_err(str::to_string)?;
    let targets = match discovered {
        Ok(targets) => targets,
        Err(error) => return Ok(Connection { targets: vec![], selected: None, error: Some(error), last_received_at: None, host_error }),
    };
    let selection = saved(root);
    let mut error = selection.as_ref().err().cloned();
    let mut selected = selection.unwrap_or(None);
    match chrome::select(&targets, selected.as_ref().map(|saved| &saved.target)) {
        Ok(Some(target)) if selected.is_none() && error.is_none() => {
            selected = Some(choose(root, &targets, target)?)
        }
        Err(message) => {
            error = Some(message);
            selected = None;
        }
        _ => {}
    }
    let mut last_received_at = None;
    if let Some(selection) = selected.as_mut() {
        let origin = format!("chrome-extension://{}/", selection.target.extension_id);
        let unique_origin = targets
            .iter()
            .filter(|target| target.extension_id == selection.target.extension_id)
            .count()
            == 1;
        let mut receipts: Vec<Receipt> = fs::read_dir(root.join("receipts"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| fs::read(entry.path()).ok())
            .filter_map(|bytes| serde_json::from_slice(&bytes).ok())
            .collect();
        receipts.sort_by_key(|receipt| std::cmp::Reverse(receipt.received_at));
        let matched = receipts.iter().find(|receipt| {
            receipt.origin == origin
                && bridge::valid_id(&receipt.instance_id)
                && (receipt.route_id.as_ref() == Some(&selection.route_id)
                    || match &selection.instance_id {
                        Some(id) => id == &receipt.instance_id,
                        None => unique_origin,
                    })
        });
        if let Some(receipt) = matched {
            selection.instance_id = Some(receipt.instance_id.clone());
            last_received_at = Some(receipt.received_at);
            bridge::write_json(&root.join("selection.json"), selection).map_err(str::to_string)?;
        }
    }
    Ok(Connection {
        targets,
        selected,
        error,
        last_received_at,
        host_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    // Keep regression tests isolated from the production Windows registry.
    fn manifest(chrome: &Path) -> PathBuf {
        chrome.join("NativeMessagingHosts/app.windowstash.companion.json")
    }
    fn inspect(chrome: &Path, root: &Path, executable: &Path) -> Result<Connection, String> {
        inspect_with(chrome, root, |targets| write_manifest(&manifest(chrome), executable, targets))
    }
    fn target(profile: &str) -> Target {
        Target {
            profile: profile.into(),
            extension_id: "a".repeat(32),
        }
    }
    #[test]
    fn fresh_install_update_and_app_move_reregister_without_resetting_saved_data() {
        let temp = tempfile::tempdir().unwrap();
        let chrome = temp.path().join("Chrome");
        let root = temp.path().join("bridge");
        let extension = temp.path().join("extension");
        let preferences = chrome.join("Default/Preferences");
        bridge::write_json(&preferences, &serde_json::json!({})).unwrap();
        let manifest = chrome.join("NativeMessagingHosts/app.windowstash.companion.json");
        let helper = |location: &str| {
            let path = temp
                .path()
                .join(location)
                .join("Contents/MacOS/windowstash-native-host");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "fixture").unwrap();
            path
        };
        let downloaded = helper("Downloads/WindowStash Companion.app");
        let initial = inspect(&chrome, &root, &downloaded).unwrap();
        assert!(initial.selected.is_none());
        assert!(initial.host_error.is_none());
        bridge::write_json(
            &extension.join("manifest.json"),
            &serde_json::json!({"name":"WindowStash"}),
        )
        .unwrap();
        bridge::write_json(&preferences, &serde_json::json!({"extensions":{"settings":{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":{"path":extension,"state":1}}}})).unwrap();
        let selected = inspect(&chrome, &root, &downloaded)
            .unwrap()
            .selected
            .unwrap();
        let account = root.join("accounts/fixture.json");
        bridge::write_json(
            &account,
            &serde_json::json!({"fixture":"preserved-session"}),
        )
        .unwrap();
        let preserved = fs::read(&account).unwrap();
        for location in [
            "Applications/WindowStash Companion.app",
            "Updated/WindowStash Companion.app",
        ] {
            let executable = helper(location);
            let old: serde_json::Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
            fs::remove_dir_all(Path::new(old["path"].as_str().unwrap()).parent().unwrap()).unwrap();
            let connection = inspect(&chrome, &root, &executable).unwrap();
            assert!(connection.host_error.is_none());
            assert_eq!(connection.selected.unwrap().route_id, selected.route_id);
            let registered: serde_json::Value =
                serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
            assert_eq!(registered["path"], executable.to_string_lossy().as_ref());
            assert_eq!(
                registered["allowed_origins"],
                serde_json::json!(["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"])
            );
            assert_eq!(fs::read(&account).unwrap(), preserved);
            fs::remove_file(&executable).unwrap();
            assert!(inspect(&chrome, &root, &executable)
                .unwrap()
                .host_error
                .is_some());
            fs::write(&executable, "replacement").unwrap();
            assert!(inspect(&chrome, &root, &executable)
                .unwrap()
                .host_error
                .is_none());
        }
    }
    #[test]
    fn registration_and_profile_selection_use_only_isolated_files() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("host");
        fs::write(&executable, "fixture").unwrap();
        let targets = vec![target("Default"), target("Profile 1")];
        let other_host = root.path().join("NativeMessagingHosts/app.other.extension.json");
        bridge::write_json(&other_host, &serde_json::json!({"path":"other-host","allowed_origins":["chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/"]})).unwrap();
        let preserved = fs::read(&other_host).unwrap();
        write_manifest(&manifest(root.path()), &executable, Some(&targets)).unwrap();
        assert_eq!(fs::read(&other_host).unwrap(), preserved);
        let manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(
                root.path()
                    .join("NativeMessagingHosts/app.windowstash.companion.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["allowed_origins"].as_array().unwrap().len(), 1);
        choose(root.path(), &targets, target("Profile 1")).unwrap();
        assert_eq!(
            saved(root.path()).unwrap().unwrap().target,
            target("Profile 1")
        );
        assert!(choose(root.path(), &targets, target("Profile 2")).is_err());
    }
    #[test]
    fn corrupt_profile_does_not_block_path_repair_or_expand_origins() {
        let temp = tempfile::tempdir().unwrap();
        let chrome = temp.path().join("Chrome");
        let root = temp.path().join("bridge");
        let executable = temp.path().join("new-host");
        fs::write(&executable, "fixture").unwrap();
        let preferences = chrome.join("Default/Preferences");
        bridge::write_json(&preferences, &serde_json::json!({})).unwrap();
        fs::write(&preferences, "partial Chrome write").unwrap();
        bridge::write_json(&manifest(&chrome), &serde_json::json!({"path":"deleted/old-host","allowed_origins":["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/","chrome-extension://*/","https://example.com/"]})).unwrap();
        let failed = inspect(&chrome, &root, &executable).unwrap();
        assert!(failed.host_error.as_ref().unwrap().contains("损坏"));
        let registered: serde_json::Value = serde_json::from_slice(&fs::read(manifest(&chrome)).unwrap()).unwrap();
        assert_eq!(registered["path"], executable.to_string_lossy().as_ref());
        assert_eq!(registered["allowed_origins"], serde_json::json!(["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"]));
        bridge::write_json(&preferences, &serde_json::json!({})).unwrap();
        assert!(inspect(&chrome, &root, &executable).unwrap().host_error.is_none());
    }
    #[test]
    fn failed_registration_is_visible_and_recovers_without_touching_account_data() {
        let temp = tempfile::tempdir().unwrap();
        let chrome = temp.path().join("Chrome");
        let root = temp.path().join("bridge");
        let executable = temp.path().join("host");
        fs::write(&executable, "fixture").unwrap();
        bridge::write_json(&chrome.join("Default/Preferences"), &serde_json::json!({})).unwrap();
        bridge::write_json(&root.join("accounts/fixture.json"), &serde_json::json!({"session":"preserve"})).unwrap();
        let preserved = fs::read(root.join("accounts/fixture.json")).unwrap();
        fs::write(chrome.join("NativeMessagingHosts"), "blocked directory").unwrap();
        assert!(inspect(&chrome, &root, &executable).unwrap().host_error.unwrap().contains("无法更新"));
        fs::remove_file(chrome.join("NativeMessagingHosts")).unwrap();
        assert!(inspect(&chrome, &root, &executable).unwrap().host_error.is_none());
        assert_eq!(fs::read(root.join("accounts/fixture.json")).unwrap(), preserved);
        let path = manifest(&chrome);
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        inspect(&chrome, &root, &executable).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
    }
    #[test]
    fn first_install_before_chrome_creates_a_safe_registration_and_retries() {
        let temp = tempfile::tempdir().unwrap();
        let chrome = temp.path().join("Chrome");
        let root = temp.path().join("bridge");
        let executable = temp.path().join("host");
        fs::write(&executable, "fixture").unwrap();
        assert!(inspect(&chrome, &root, &executable).unwrap().host_error.is_some());
        let registered: serde_json::Value = serde_json::from_slice(&fs::read(manifest(&chrome)).unwrap()).unwrap();
        assert_eq!(registered["allowed_origins"], serde_json::json!([]));
        assert!(inspect(&chrome, &root, &executable).unwrap().host_error.is_none());
    }
    #[test]
    fn two_profiles_link_only_the_explicitly_selected_instance_and_keep_it_after_restart() {
        let temp = tempfile::tempdir().unwrap();
        let chrome = temp.path().join("Chrome");
        let root = temp.path().join("bridge");
        let extension = temp.path().join("extension");
        fs::create_dir_all(&extension).unwrap();
        bridge::write_json(
            &extension.join("manifest.json"),
            &serde_json::json!({"name":"WindowStash"}),
        )
        .unwrap();
        for profile in ["Default", "Profile 1"] {
            bridge::write_json(&chrome.join(profile).join("Preferences"), &serde_json::json!({"extensions":{"settings":{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":{"path":extension,"state":1}}}})).unwrap();
        }
        let executable = temp.path().join("host");
        fs::write(&executable, "fixture").unwrap();
        assert!(inspect(&chrome, &root, &executable)
            .unwrap()
            .selected
            .is_none());
        let selection = choose(
            &root,
            &chrome::discover(&chrome).unwrap(),
            target("Profile 1"),
        )
        .unwrap();
        let ping = |id: &str, route_id| {
            bridge::status(
                &root,
                "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
                bridge::StatusRequest {
                    version: 1,
                    r#type: "status".into(),
                    instance_id: id.repeat(64),
                    request_id: "c".repeat(64),
                    route_id,
                },
            )
            .unwrap()
        };
        ping("a", None);
        assert!(inspect(&chrome, &root, &executable)
            .unwrap()
            .selected
            .unwrap()
            .instance_id
            .is_none());
        ping("b", Some(selection.route_id));
        let linked = inspect(&chrome, &root, &executable)
            .unwrap()
            .selected
            .unwrap();
        assert_eq!(linked.target.profile, "Profile 1");
        assert_eq!(linked.instance_id, Some("b".repeat(64)));
        assert_eq!(
            inspect(&chrome, &root, &executable)
                .unwrap()
                .selected
                .unwrap()
                .instance_id,
            linked.instance_id
        );
        fs::remove_file(chrome.join("Profile 1/Preferences")).unwrap();
        let unavailable = inspect(&chrome, &root, &executable).unwrap();
        assert!(unavailable.selected.is_none());
        assert!(unavailable.error.is_some());
        assert_eq!(saved(&root).unwrap().unwrap().target.profile, "Profile 1");
        choose(&root, &unavailable.targets, target("Default")).unwrap();
        assert_eq!(
            inspect(&chrome, &root, &executable)
                .unwrap()
                .selected
                .unwrap()
                .target
                .profile,
            "Default"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_upgrade_repairs_both_registry_views_without_the_old_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let subkey = format!(r"Software\WindowStashNativeHostTests-{}", bridge::random_id());
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                for view in [KEY_WOW64_32KEY, KEY_WOW64_64KEY] {
                    if let Ok(software) = RegKey::predef(HKEY_CURRENT_USER)
                        .open_subkey_with_flags("Software", KEY_READ | KEY_WRITE | view) {
                        let _ = software.delete_subkey_all(self.0.strip_prefix(r"Software\").unwrap());
                    }
                }
            }
        }
        let _cleanup = Cleanup(subkey.clone());
        let old = temp.path().join("old.json");
        fs::write(&old, "old installation").unwrap();
        register_windows(&old, &subkey).unwrap();
        fs::remove_file(&old).unwrap();
        let new = temp.path().join("new.json");
        fs::write(&new, "new installation").unwrap();
        register_windows(&new, &subkey).unwrap();
        for view in [KEY_WOW64_32KEY, KEY_WOW64_64KEY] {
            let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(&subkey, KEY_READ | view).unwrap();
            assert_eq!(key.get_value::<String, _>("").unwrap(), new.to_string_lossy());
        }
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_manifest_and_registry_are_current_user_scoped() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("windowstash-native-host.exe");
        fs::write(&executable, "fixture").unwrap();
        let manifest = temp.path().join("host.json");
        write_manifest(&manifest, &executable, Some(&[target("Default")])).unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();
        assert_eq!(value["path"], executable.to_string_lossy().as_ref());
        assert_eq!(
            value["allowed_origins"],
            serde_json::json!(["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"])
        );
        assert_eq!(
            windows_registry_key(),
            r"Software\Google\Chrome\NativeMessagingHosts\app.windowstash.companion"
        );
    }
}
