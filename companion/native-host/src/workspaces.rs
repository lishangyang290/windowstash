//! Durable, account-scoped local projection. No network and no credentials in replies.
use crate::{auth::{self, Grant}, bridge, hex, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs::{self, OpenOptions}, path::{Path, PathBuf}};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const CHUNK_BYTES: usize = 16_384;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    version: u8, r#type: String, instance_id: String, capability: String,
    project_url: String, user_id: String, revision: u64, chunks: usize, index: usize, part: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadRequest {
    version: u8, r#type: String, instance_id: String, capability: String,
    project_url: String, user_id: String, id: String, index: usize, revision: Option<u64>,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Tab {
    title: String, url: String, position: usize, pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fav_icon_url: Option<String>,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Content { id: String, name: String, status: String, tabs: Vec<Tab>, active_tab_index: usize, created_at: String, updated_at: String }
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Sync {
    sync_status: String, last_synced_at: Option<String>, last_synced_hash: Option<String>,
    last_synced_cloud_updated_at: Option<String>, local_expires_at: String, last_sync_error: Option<String>,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
struct Record { content: Content, sync: Sync }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot { records: Vec<Record>, deleted: Vec<String> }
#[derive(Deserialize, Serialize, Default)]
#[serde(deny_unknown_fields)]
struct Library { revision: u64, digest: String, records: BTreeMap<String, Record>, deleted: BTreeSet<String> }
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Stage { revision: u64, chunks: usize, received_at: u64, parts: Vec<String> }

fn private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|_| "local_store_unavailable")?;
    let metadata = fs::symlink_metadata(path).map_err(|_| "local_store_unavailable")?;
    if metadata.file_type().is_symlink() { return Err("local_store_unavailable"); }
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| "local_store_unavailable")?;
    }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return Err("local_store_unavailable"); }
        // Inherit the current user's LocalAppData ACL, as the existing account store does.
    }
    Ok(())
}

fn write(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().ok_or("local_store_unavailable")?;
    private_directory(parent)?;
    let file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "local_store_unavailable")?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        file.as_file().set_permissions(fs::Permissions::from_mode(0o600)).map_err(|_| "local_store_unavailable")?;
    }
    serde_json::to_writer(file.as_file(), value).map_err(|_| "local_store_unavailable")?;
    file.as_file().sync_all().map_err(|_| "local_store_unavailable")?;
    file.persist(path).map_err(|_| "local_store_unavailable")?;
    #[cfg(unix)] fs::File::open(parent).and_then(|f| f.sync_all()).map_err(|_| "local_store_unavailable")?;
    Ok(())
}

fn user_id(grant: &Grant) -> Result<&str> { grant.session["user"]["id"].as_str().ok_or("invalid_session") }
fn location(root: &Path, grant: &Grant) -> Result<PathBuf> {
    let scope = serde_json::to_vec(&(&grant.instance_id, &grant.config.url, user_id(grant)?)).map_err(|_| "invalid_session")?;
    Ok(root.join("workspace-library").join(hex(&Sha256::digest(scope))))
}
fn read_library(path: &Path) -> Result<Library> {
    match fs::read(path.join("library.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "local_store_corrupt"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Library::default()),
        Err(_) => Err("local_store_unavailable"),
    }
}
fn valid_workspace_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, b)| if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() })
}
fn decode(part: &str) -> Result<Vec<u8>> {
    if part.len() > CHUNK_BYTES * 2 || part.len() % 2 != 0 { return Err("invalid_workspace_chunk"); }
    part.as_bytes().chunks_exact(2).map(|pair| {
        let a = (pair[0] as char).to_digit(16).ok_or("invalid_workspace_chunk")?;
        let b = (pair[1] as char).to_digit(16).ok_or("invalid_workspace_chunk")?;
        Ok((a * 16 + b) as u8)
    }).collect()
}

pub fn dispatch(root: &Path, origin: &str, request: Request) -> Result<Value> {
    if request.version != 1 || request.r#type != "workspaces" || request.revision == 0
        || request.chunks == 0 || request.chunks > MAX_BYTES / CHUNK_BYTES || request.index >= request.chunks {
        return Err("invalid_workspace_request");
    }
    let part = decode(&request.part)?;
    if request.index + 1 < request.chunks && part.len() != CHUNK_BYTES { return Err("invalid_workspace_chunk"); }
    auth::with_local_grant(root, origin, &request.instance_id, &request.capability, |grant| {
        if request.project_url != grant.config.url || request.user_id != user_id(grant)? { return Err("wrong_account"); }
        let directory = location(root, grant)?;
        private_directory(&root.join("workspace-library"))?;
        private_directory(&directory)?;
        let lock = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(directory.join("lock")).map_err(|_| "local_store_unavailable")?;
        lock.lock_exclusive().map_err(|_| "local_store_unavailable")?;
        let mut library = read_library(&directory)?;
        if request.revision < library.revision { return Err("stale_workspace_revision"); }
        let stage_path = directory.join("stage.json");
        let previous = fs::read(&stage_path).ok().and_then(|bytes| serde_json::from_slice::<Stage>(&bytes).ok());
        if previous.as_ref().is_some_and(|s| s.revision > request.revision && bridge::now().saturating_sub(s.received_at) < 300) { return Err("stale_workspace_revision"); }
        let mut stage = if request.index == 0 {
            Stage { revision: request.revision, chunks: request.chunks, received_at: bridge::now(), parts: Vec::new() }
        } else { previous.ok_or("missing_workspace_chunk")? };
        if stage.revision != request.revision || stage.chunks != request.chunks || bridge::now().saturating_sub(stage.received_at) > 300 { return Err("invalid_workspace_chunk"); }
        if request.index < stage.parts.len() {
            if stage.parts[request.index] != request.part { return Err("workspace_revision_conflict"); }
        } else if request.index == stage.parts.len() { stage.parts.push(request.part.clone()); }
        else { return Err("missing_workspace_chunk"); }
        if request.index + 1 < request.chunks {
            write(&stage_path, &stage)?;
            return Ok(json!({"status":"staged", "revision":request.revision}));
        }
        let bytes: Vec<u8> = stage.parts.iter().map(|p| decode(p)).collect::<Result<Vec<_>>>()?.into_iter().flatten().collect();
        if bytes.len() > MAX_BYTES { return Err("invalid_workspace_chunk"); }
        let digest = hex(&Sha256::digest(&bytes));
        if request.revision == library.revision && digest != library.digest { return Err("workspace_revision_conflict"); }
        if request.revision == library.revision {
            let _ = fs::remove_file(stage_path);
            return Ok(json!({"status":"persisted", "revision":request.revision}));
        }
        let snapshot: Snapshot = serde_json::from_slice(&bytes).map_err(|_| "invalid_workspace_snapshot")?;
        let mut ids = BTreeSet::new();
        for record in &snapshot.records {
            let content = &record.content;
            if !valid_workspace_id(&content.id) || !ids.insert(&content.id) || content.name.chars().count() > 200
                || !["active", "review", "revision", "archived"].contains(&content.status.as_str())
                || !["synced", "pending", "failed", "conflict"].contains(&record.sync.sync_status.as_str()) {
                return Err("invalid_workspace_snapshot");
            }
        }
        if snapshot.deleted.iter().any(|id| !valid_workspace_id(id)) { return Err("invalid_workspace_snapshot"); }
        library.deleted.extend(snapshot.deleted);
        for record in snapshot.records {
            if !library.deleted.contains(&record.content.id) { library.records.insert(record.content.id.clone(), record); }
        }
        library.records.retain(|id, _| !library.deleted.contains(id));
        library.revision = request.revision;
        library.digest = digest;
        if serde_json::to_vec(&library).map_err(|_| "local_store_unavailable")?.len() > MAX_BYTES * 2 { return Err("local_store_full"); }
        write(&directory.join("library.json"), &library)?;
        write(&root.join("workspace-library").join("change.json"), &bridge::random_id())?;
        // Staging is disposable; failure to remove it does not undo the committed library.
        let _ = fs::remove_file(stage_path);
        Ok(json!({"status":"persisted", "revision":request.revision}))
    })
}

pub fn desktop(root: &Path, route: &str) -> Result<Value> {
    auth::with_local_desktop(root, route, |grant| {
        let Some(grant) = grant else { return Ok(Value::Null); };
        let library = read_library(&location(root, grant)?)?;
        if library.revision == 0 { return Ok(Value::Null); }
        let items: Vec<Value> = library.records.values().filter(|r| r.content.status != "archived").map(|r| json!({
            "id":r.content.id, "name":r.content.name, "tabCount":r.content.tabs.len(), "updatedAt":r.content.updated_at
        })).collect();
        Ok(json!({"instance_id":grant.instance_id, "project_url":grant.config.url, "user_id":user_id(grant)?, "revision":library.revision, "items":items}))
    })
}

pub fn read(root: &Path, origin: &str, request: ReadRequest) -> Result<Value> {
    if request.version != 1 || request.r#type != "workspace_read" || !valid_workspace_id(&request.id) { return Err("invalid_workspace_request"); }
    auth::with_local_grant(root, origin, &request.instance_id, &request.capability, |grant| {
        if request.project_url != grant.config.url || request.user_id != user_id(grant)? { return Err("wrong_account"); }
        let library = read_library(&location(root, grant)?)?;
        if request.revision.is_some_and(|revision| revision != library.revision) { return Err("stale_workspace_revision"); }
        let Some(record) = library.records.get(&request.id) else { return Ok(json!({"status":"missing"})); };
        let bytes = serde_json::to_vec(record).map_err(|_| "local_store_corrupt")?;
        let chunks = bytes.len().div_ceil(CHUNK_BYTES);
        if request.index >= chunks { return Err("invalid_workspace_chunk"); }
        let start = request.index * CHUNK_BYTES;
        Ok(json!({"status":"read","id":request.id,"revision":library.revision,"chunks":chunks,"index":request.index,
            "part":hex(&bytes[start..bytes.len().min(start + CHUNK_BYTES)])}))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const ORIGIN: &str = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
    const ID: &str = "11111111-1111-4111-8111-111111111111";
    fn setup() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let grant = Grant {
            instance_id: "a".repeat(64), origin: ORIGIN.into(), route_id: "b".repeat(64), capability: "c".repeat(64), login_request: "d".repeat(64),
            config: auth::Config { url: "https://fixture.supabase.co".into(), publishable_key: "fixture".into() },
            // Expired credentials deliberately demonstrate that local access does not refresh.
            session: json!({"user":{"id":"user-A"},"expires_at":0}), revision: 1,
        };
        bridge::write_json(&root.path().join("accounts").join(format!("{}.json", grant.instance_id)), &grant).unwrap();
        root
    }
    fn record(name: &str) -> Value {
        json!({"content":{"id":ID,"name":name,"status":"active","tabs":[{"title":"Tab","url":"https://example.invalid","position":0,"pinned":false}],"activeTabIndex":0,"createdAt":"2026-10-14","updatedAt":"2026-10-14"},
            "sync":{"syncStatus":"pending","lastSyncedAt":null,"lastSyncedHash":null,"lastSyncedCloudUpdatedAt":null,"localExpiresAt":"2026-11-14","lastSyncError":null}})
    }
    fn requests(snapshot: Value, revision: u64) -> Vec<Request> {
        let bytes = serde_json::to_vec(&snapshot).unwrap();
        let chunks = bytes.len().div_ceil(CHUNK_BYTES);
        bytes.chunks(CHUNK_BYTES).enumerate().map(|(index, part)| Request {
            version: 1, r#type: "workspaces".into(), instance_id: "a".repeat(64), capability: "c".repeat(64),
            project_url: "https://fixture.supabase.co".into(), user_id: "user-A".into(), revision, chunks, index, part: hex(part),
        }).collect()
    }
    fn publish(root: &Path, snapshot: Value, revision: u64) -> Result<Value> {
        let mut reply = Value::Null;
        for request in requests(snapshot, revision) { reply = dispatch(root, ORIGIN, request)?; }
        Ok(reply)
    }
    fn list(root: &Path) -> Value { desktop(root, &"b".repeat(64)).unwrap() }
    #[test]
    fn survives_chrome_and_companion_shutdown_without_network() {
        let root = setup();
        assert!(list(root.path()).is_null());
        let snapshot = json!({"records":[record("Offline")],"deleted":[]});
        assert_eq!(publish(root.path(), snapshot.clone(), 1).unwrap()["status"], "persisted");
        // A new reader uses only the filesystem; no process or fresh access token is required.
        assert_eq!(list(root.path())["items"][0]["name"], "Offline");
        let notification = fs::read(root.path().join("workspace-library/change.json")).unwrap();
        assert_eq!(publish(root.path(), snapshot, 1).unwrap()["status"], "persisted");
        assert_eq!(fs::read(root.path().join("workspace-library/change.json")).unwrap(), notification);
        assert_eq!(list(root.path())["items"].as_array().unwrap().len(), 1);
        assert!(!list(root.path()).to_string().contains("capability"));
    }
    #[test]
    fn preserves_existing_favicon_fields_and_accepts_tabs_without_them() {
        let root = setup();
        let mut old = record("Existing workspace");
        old["content"]["tabs"][0]["favIconUrl"] = json!("https://example.invalid/favicon.ico");
        publish(root.path(), json!({"records":[old],"deleted":[]}), 1).unwrap();
        let grant: Grant = serde_json::from_slice(&fs::read(root.path().join("accounts").join(format!("{}.json", "a".repeat(64)))).unwrap()).unwrap();
        let stored = read_library(&location(root.path(), &grant).unwrap()).unwrap();
        assert_eq!(stored.records[ID].content.tabs[0].fav_icon_url.as_deref(), Some("https://example.invalid/favicon.ico"));
        assert_eq!(list(root.path())["items"][0]["name"], "Existing workspace");
        publish(root.path(), json!({"records":[record("Without favicon")],"deleted":[]}), 2).unwrap();
        assert_eq!(list(root.path())["items"][0]["name"], "Without favicon");
    }
    #[test]
    fn reads_complete_offline_restore_data_and_rejects_changed_versions() {
        let root = setup();
        publish(root.path(), json!({"records":[record("Offline restore")],"deleted":[]}), 1).unwrap();
        let request = |revision| ReadRequest { version: 1, r#type: "workspace_read".into(), instance_id: "a".repeat(64), capability: "c".repeat(64), project_url: "https://fixture.supabase.co".into(), user_id: "user-A".into(), id: ID.into(), index: 0, revision };
        let reply = read(root.path(), ORIGIN, request(None)).unwrap();
        let restored: Record = serde_json::from_slice(&decode(reply["part"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!(restored.content.tabs[0].url, "https://example.invalid");
        assert_eq!(reply["revision"], 1);
        publish(root.path(), json!({"records":[],"deleted":[ID]}), 2).unwrap();
        assert_eq!(read(root.path(), ORIGIN, request(Some(1))).unwrap_err(), "stale_workspace_revision");
        assert_eq!(read(root.path(), ORIGIN, request(None)).unwrap()["status"], "missing");
    }
    #[test]
    fn stale_and_conflicting_versions_cannot_overwrite_new_data() {
        let root = setup();
        publish(root.path(), json!({"records":[record("New")],"deleted":[]}), 2).unwrap();
        assert_eq!(publish(root.path(), json!({"records":[record("Old")],"deleted":[]}), 1).unwrap_err(), "stale_workspace_revision");
        assert_eq!(publish(root.path(), json!({"records":[record("Different")],"deleted":[]}), 2).unwrap_err(), "workspace_revision_conflict");
        assert_eq!(list(root.path())["items"][0]["name"], "New");
    }
    #[test]
    fn missing_records_are_not_deletions_but_explicit_tombstones_prevent_resurrection() {
        let root = setup();
        publish(root.path(), json!({"records":[record("Keep")],"deleted":[]}), 1).unwrap();
        publish(root.path(), json!({"records":[],"deleted":[]}), 2).unwrap();
        assert_eq!(list(root.path())["items"].as_array().unwrap().len(), 1);
        publish(root.path(), json!({"records":[],"deleted":[ID]}), 3).unwrap();
        publish(root.path(), json!({"records":[record("Stale cache")],"deleted":[]}), 4).unwrap();
        assert_eq!(list(root.path())["items"], json!([]));
    }
    #[test]
    fn partial_chunk_transfer_is_invisible_until_complete_and_can_be_retried() {
        let root = setup();
        publish(root.path(), json!({"records":[record("Before")],"deleted":[]}), 1).unwrap();
        let mut large = record("After"); large["content"]["tabs"][0]["title"] = json!("标签".repeat(8_000));
        let snapshot = json!({"records":[large],"deleted":[]});
        let mut messages = requests(snapshot.clone(), 2).into_iter();
        assert_eq!(dispatch(root.path(), ORIGIN, messages.next().unwrap()).unwrap()["status"], "staged");
        assert_eq!(list(root.path())["items"][0]["name"], "Before");
        // Retry from chunk zero simulates a restarted Host / terminated extension sender.
        publish(root.path(), snapshot, 2).unwrap();
        assert_eq!(list(root.path())["items"][0]["name"], "After");
    }
    #[test]
    fn rejects_wrong_account_capability_origin_and_revoked_grant() {
        let root = setup();
        let snapshot = json!({"records":[record("Private")],"deleted":[]});
        let mut request = requests(snapshot.clone(), 1).pop().unwrap(); request.user_id = "user-B".into();
        assert_eq!(dispatch(root.path(), ORIGIN, request).unwrap_err(), "wrong_account");
        let mut request = requests(snapshot.clone(), 1).pop().unwrap(); request.capability = "e".repeat(64);
        assert_eq!(dispatch(root.path(), ORIGIN, request).unwrap_err(), "unauthorized_instance");
        let request = requests(snapshot.clone(), 1).pop().unwrap();
        assert_eq!(dispatch(root.path(), "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/", request).unwrap_err(), "unauthorized_instance");
        let path = root.path().join("accounts").join(format!("{}.json", "a".repeat(64)));
        let mut grant: Grant = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap(); grant.session = Value::Null;
        bridge::write_json(&path, &grant).unwrap();
        assert_eq!(publish(root.path(), snapshot, 1).unwrap_err(), "unauthorized_instance");
        assert!(list(root.path()).is_null());
    }
    #[test]
    fn malformed_or_oversized_messages_cannot_clear_existing_data() {
        let root = setup();
        publish(root.path(), json!({"records":[record("Keep")],"deleted":[]}), 1).unwrap();
        assert_eq!(publish(root.path(), json!({"records":[],"deleted":["not-a-uuid"]}), 2).unwrap_err(), "invalid_workspace_snapshot");
        let mut request = requests(json!({"records":[],"deleted":[]}), 2).pop().unwrap(); request.part = "0".repeat(CHUNK_BYTES * 2 + 2);
        assert_eq!(dispatch(root.path(), ORIGIN, request).unwrap_err(), "invalid_workspace_chunk");
        assert!(serde_json::from_value::<Request>(json!({"version":1,"type":"workspaces","path":"outside","refresh_token":"secret"})).is_err());
        assert_eq!(list(root.path())["items"][0]["name"], "Keep");
    }
}
