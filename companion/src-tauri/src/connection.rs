//! Profile routing and non-secret component status. This is not account pairing.
use crate::chrome::{self, Target};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use windowstash_native_host::bridge::{self, DesktopStatus, Receipt};

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

pub fn register(chrome_root: &Path, executable: &Path, targets: &[Target]) -> Result<(), String> {
    if !executable.is_file() {
        return Err("本机通信组件缺失，请重新安装 Companion".into());
    }
    let origins: std::collections::BTreeSet<_> = targets
        .iter()
        .map(|target| format!("chrome-extension://{}/", target.extension_id))
        .collect();
    // No wildcard origins. An unpacked extension's ID is discovered after installation.
    bridge::write_json(
        &chrome_root
            .join("NativeMessagingHosts")
            .join(format!("{}.json", bridge::HOST_NAME)),
        &serde_json::json!({
            "name": bridge::HOST_NAME, "description": "WindowStash Companion status bridge",
            "path": executable, "type": "stdio", "allowed_origins": origins,
        }),
    )
    .map_err(|_| "无法注册本机组件，请检查 Chrome 目录权限".into())
}

pub fn helper() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .map(|parent| parent.join("windowstash-native-host"))
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
    let targets = chrome::discover(chrome_root)?;
    let host_error = register(chrome_root, executable, &targets).err();
    bridge::write_json(
        &root.join("desktop.json"),
        &DesktopStatus {
            updated_at: bridge::now(),
        },
    )
    .map_err(str::to_string)?;
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
            let path = temp.path().join(location).join("Contents/MacOS/windowstash-native-host");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "fixture").unwrap();
            path
        };
        let downloaded = helper("Downloads/WindowStash Companion.app");
        let initial = inspect(&chrome, &root, &downloaded).unwrap();
        assert!(initial.selected.is_none());
        assert!(initial.host_error.is_none());
        bridge::write_json(&extension.join("manifest.json"), &serde_json::json!({"name":"WindowStash"})).unwrap();
        bridge::write_json(&preferences, &serde_json::json!({"extensions":{"settings":{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":{"path":extension,"state":1}}}})).unwrap();
        let selected = inspect(&chrome, &root, &downloaded).unwrap().selected.unwrap();
        let account = root.join("accounts/fixture.json");
        bridge::write_json(&account, &serde_json::json!({"fixture":"preserved-session"})).unwrap();
        let preserved = fs::read(&account).unwrap();
        for location in ["Applications/WindowStash Companion.app", "Updated/WindowStash Companion.app"] {
            let executable = helper(location);
            let connection = inspect(&chrome, &root, &executable).unwrap();
            assert!(connection.host_error.is_none());
            assert_eq!(connection.selected.unwrap().route_id, selected.route_id);
            let registered: serde_json::Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
            assert_eq!(registered["path"], executable.to_string_lossy().as_ref());
            assert_eq!(registered["allowed_origins"], serde_json::json!(["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"]));
            assert_eq!(fs::read(&account).unwrap(), preserved);
            fs::remove_file(&executable).unwrap();
            assert!(inspect(&chrome, &root, &executable).unwrap().host_error.is_some());
            fs::write(&executable, "replacement").unwrap();
            assert!(inspect(&chrome, &root, &executable).unwrap().host_error.is_none());
        }
    }
    #[test]
    fn registration_and_profile_selection_use_only_isolated_files() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("host");
        fs::write(&executable, "fixture").unwrap();
        let targets = vec![target("Default"), target("Profile 1")];
        register(root.path(), &executable, &targets).unwrap();
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
}
