//! Non-credential product transport. None of these records authorize Session access.
use crate::{hex, valid_origin, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const HOST_NAME: &str = "app.windowstash.companion";

pub fn directory() -> Result<PathBuf> {
    // Isolated test roots contain the entire bridge, including its private auth store.
    if let Some(path) = std::env::var_os("WINDOWSTASH_BRIDGE_DIR") {
        return Ok(path.into());
    }
    let home = std::env::var_os("HOME").ok_or("home_unavailable")?;
    #[cfg(target_os = "macos")]
    return Ok(
        PathBuf::from(home).join("Library/Application Support/app.windowstash.companion/bridge")
    );
    #[cfg(not(target_os = "macos"))]
    Ok(PathBuf::from(home).join(".config/app.windowstash.companion/bridge"))
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn valid_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().ok_or("storage_unavailable")?;
    fs::create_dir_all(parent).map_err(|_| "storage_unavailable")?;
    let file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "storage_unavailable")?;
    serde_json::to_writer(file.as_file(), value).map_err(|_| "storage_unavailable")?;
    file.persist(path).map_err(|_| "storage_unavailable")?;
    Ok(())
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StatusRequest {
    pub version: u8,
    pub r#type: String,
    pub instance_id: String,
    pub request_id: String,
    pub route_id: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub instance_id: String,
    pub origin: String,
    pub request_id: String,
    pub route_id: Option<String>,
    pub received_at: u64,
}

#[derive(Deserialize, Serialize)]
pub struct DesktopStatus {
    pub updated_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusResponse {
    pub version: u8,
    pub r#type: String,
    pub instance_id: String,
    pub request_id: String,
    pub companion_running: bool,
    pub shared_auth: bool,
}

pub fn status(root: &Path, origin: &str, request: StatusRequest) -> Result<StatusResponse> {
    if !valid_origin(origin)
        || request.version != 1
        || request.r#type != "status"
        || !valid_id(&request.instance_id)
        || !valid_id(&request.request_id)
        || request.route_id.as_ref().is_some_and(|id| !valid_id(id))
    {
        return Err("invalid_status_request");
    }
    let received_at = now();
    let desktop = fs::read(root.join("desktop.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<DesktopStatus>(&bytes).ok());
    let companion_running = desktop.is_some_and(|status| {
        status.updated_at <= received_at && received_at - status.updated_at <= 30
    });
    let receipt = Receipt {
        instance_id: request.instance_id.clone(),
        origin: origin.into(),
        request_id: request.request_id.clone(),
        route_id: request.route_id,
        received_at,
    };
    write_json(
        &root
            .join("receipts")
            .join(format!("{}.json", receipt.instance_id)),
        &receipt,
    )?;
    Ok(StatusResponse {
        version: 1,
        r#type: "status".into(),
        instance_id: request.instance_id,
        request_id: request.request_id,
        companion_running,
        shared_auth: false,
    })
}

pub fn random_id() -> String {
    use rand_core::{OsRng, RngCore};
    let mut bytes = [0; 32];
    OsRng.fill_bytes(&mut bytes);
    hex(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn status_records_a_real_receipt_and_checks_desktop_freshness() {
        let root = tempfile::tempdir().unwrap();
        write_json(
            &root.path().join("desktop.json"),
            &DesktopStatus { updated_at: now() },
        )
        .unwrap();
        let reply = status(
            root.path(),
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
            StatusRequest {
                version: 1,
                r#type: "status".into(),
                instance_id: "a".repeat(64),
                request_id: "b".repeat(64),
                route_id: None,
            },
        )
        .unwrap();
        assert!(reply.companion_running);
        assert!(!reply.shared_auth);
        assert!(root
            .path()
            .join("receipts")
            .join(format!("{}.json", "a".repeat(64)))
            .exists());
    }
    #[test]
    fn status_never_accepts_credentials_or_paths() {
        assert!(serde_json::from_value::<StatusRequest>(serde_json::json!({"version":1,"type":"status","instance_id":"a".repeat(64),"request_id":"b".repeat(64),"refresh_token":"secret"})).is_err());
        assert!(!valid_id("../../outside"));
    }
}
