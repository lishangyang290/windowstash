//! Durable, account-scoped local projection. No network and no credentials in replies.
use crate::{auth::{self, Grant}, bridge, hex, Result};
use crate::diagnostics;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs::{self}, path::{Path, PathBuf}};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const CHUNK_BYTES: usize = 16_384;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    version: u8, r#type: String, instance_id: String, capability: String,
    project_url: String, user_id: String, revision: u64, chunks: usize, index: usize, part: String,
    #[serde(default)] diagnostic: Value,
    #[serde(default)] diagnostic_operations: BTreeMap<String, Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadRequest {
    version: u8, r#type: String, instance_id: String, capability: String,
    project_url: String, user_id: String, id: String, index: usize, revision: Option<u64>,
    #[serde(default)] generation: Option<u64>,
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
struct Snapshot { records: Vec<Record>, deleted: Vec<String>, #[serde(default)] conflicts: BTreeMap<String, Vec<Record>> }
#[derive(Deserialize, Serialize, Default)]
#[serde(deny_unknown_fields)]
struct Library {
    revision: u64, digest: String, records: BTreeMap<String, Record>, deleted: BTreeSet<String>,
    #[serde(default)] generation: u64,
    #[serde(default)] remote_deleted: BTreeMap<String, String>,
    #[serde(default)] delete_ack: BTreeSet<String>,
    #[serde(default)] conflicts: BTreeMap<String, Vec<Record>>,
    #[serde(default, skip_serializing_if="BTreeMap::is_empty")] diagnostics: BTreeMap<String, Value>,
}
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
fn valid_record(record: &Record) -> bool {
    valid_workspace_id(&record.content.id) && record.content.name.chars().count() <= 200
        && ["active", "review", "revision", "archived"].contains(&record.content.status.as_str())
        && ["synced", "pending", "failed", "conflict"].contains(&record.sync.sync_status.as_str())
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
        let _lock = diagnostics::ObservedLock::acquire(&directory, &request.diagnostic)?;
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
        for (id, records) in &snapshot.conflicts {
            if !valid_workspace_id(id) || records.iter().any(|record| record.content.id != *id || !valid_record(record)) { return Err("invalid_workspace_snapshot"); }
            for record in records { remember_conflict(&mut library.conflicts, id, record)?; }
        }
        let received_deleted: BTreeSet<String> = snapshot.deleted.iter().cloned().collect();
        let remote_conflict = snapshot.records.iter().any(|record| library.remote_deleted.contains_key(&record.content.id) && !received_deleted.contains(&record.content.id));
        library.deleted.extend(snapshot.deleted);
        for mut record in snapshot.records {
            if !library.deleted.contains(&record.content.id) {
                let id = record.content.id.clone();
                if let Some(current) = library.records.get(&id) {
                    // A Chrome cache predating a cloud download cannot replace the native copy.
                    if current.sync.last_synced_cloud_updated_at != record.sync.last_synced_cloud_updated_at {
                        if record.sync.sync_status != "synced" && serde_json::to_value(&current.content).ok() != serde_json::to_value(&record.content).ok() {
                            remember_conflict(&mut library.conflicts, &id, current)?;
                            record.sync.sync_status = "conflict".into();
                            record.sync.last_sync_error = Some("本机与云端均有更新，已保留两个版本".into());
                            library.records.insert(id, record);
                        }
                        continue;
                    }
                }
                library.records.insert(id, record);
            } else if record.sync.sync_status != "synced" {
                remember_conflict(&mut library.conflicts, &record.content.id, &record)?;
            }
        }
        library.records.retain(|id, _| !library.deleted.contains(id));
        for (id, trace) in &request.diagnostic_operations {
            if valid_workspace_id(id) && diagnostics::valid_id(trace["operationId"].as_str().unwrap_or("")) && request.diagnostic_operations.len() <= 64 {
                library.diagnostics.insert(id.clone(), json!({"operationId":trace["operationId"], "parentEventId":trace["parentEventId"], "trigger":"native-change"}));
            }
        }
        while library.diagnostics.len() > 1024 { library.diagnostics.pop_first(); }
        library.revision = request.revision;
        library.digest = digest;
        library.generation = library.generation.checked_add(1).filter(|g| *g <= 9_007_199_254_740_991).ok_or("workspace_revision_exhausted")?;
        if serde_json::to_vec(&library).map_err(|_| "local_store_unavailable")?.len() > MAX_BYTES * 2 { return Err("local_store_full"); }
        write(&directory.join("library.json"), &library)?;
        diagnostics::append(&directory, &diagnostics::event("native.persisted", &request.diagnostic, "success", None, json!({"revision":library.revision,"generation":library.generation})));
        write(&root.join("workspace-library").join("change.json"), &bridge::random_id())?;
        // Staging is disposable; failure to remove it does not undo the committed library.
        let _ = fs::remove_file(stage_path);
        if remote_conflict { return Err("workspace_deleted"); }
        Ok(json!({"status":"persisted", "revision":request.revision}))
    })
}

pub fn desktop(root: &Path, route: &str) -> Result<Value> {
    let _context = diagnostics::desktop_context();
    auth::with_local_desktop(root, route, |grant| {
        let Some(grant) = grant else { return Ok(Value::Null); };
        let library = read_library(&location(root, grant)?)?;
        if library.revision == 0 && library.generation == 0 { return Ok(Value::Null); }
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
        if request.generation.is_some_and(|generation| generation != library.generation) { return Err("stale_workspace_revision"); }
        let Some(record) = library.records.get(&request.id) else { return Ok(json!({"status":"missing","deleted":library.deleted.contains(&request.id)})); };
        let bytes = serde_json::to_vec(record).map_err(|_| "local_store_corrupt")?;
        let chunks = bytes.len().div_ceil(CHUNK_BYTES);
        if request.index >= chunks { return Err("invalid_workspace_chunk"); }
        let start = request.index * CHUNK_BYTES;
        Ok(json!({"status":"read","id":request.id,"revision":library.revision,"generation":library.generation,"chunks":chunks,"index":request.index,
            "part":hex(&bytes[start..bytes.len().min(start + CHUNK_BYTES)])}))
    })
}

fn remember_conflict(items: &mut BTreeMap<String, Vec<Record>>, id: &str, record: &Record) -> Result<()> {
    let versions = items.entry(id.into()).or_default();
    let value = serde_json::to_value(record).map_err(|_| "local_store_corrupt")?;
    if !versions.iter().any(|item| serde_json::to_value(item).ok().as_ref() == Some(&value)) { versions.push(record.clone()); }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncRequest {
    version: u8, r#type: String, instance_id: String, capability: String,
    project_url: String, user_id: String, action: String,
    #[serde(default)] token: String,
    #[serde(default)] generation: Option<u64>,
    #[serde(default)] index: usize,
    #[serde(default)] chunks: usize,
    #[serde(default)] part: String,
    #[serde(default)] diagnostic: Value,
}
#[derive(Serialize, Deserialize)]
struct Lease { token: String, login_request: String, expires_at: u64 }

pub fn sync(root: &Path, origin: &str, request: SyncRequest) -> Result<Value> {
    if request.version != 1 || !["workspace_sync", "workspace_watch"].contains(&request.r#type.as_str())
        || (request.r#type == "workspace_watch" && request.action != "signal") { return Err("invalid_workspace_request"); }
    auth::with_local_grant(root, origin, &request.instance_id, &request.capability, |grant| {
        if request.project_url != grant.config.url || request.user_id != user_id(grant)? { return Err("wrong_account"); }
        sync_action(root, grant, &request.action, json!({"token":request.token,"generation":request.generation,"index":request.index,"chunks":request.chunks,"part":request.part,"diagnostic":request.diagnostic}))
    })
}

pub fn desktop_sync(root: &Path, route: &str, instance: &str, project: &str, user: &str, action: &str, payload: Value) -> Result<Value> {
    let _context = diagnostics::desktop_context();
    auth::with_local_desktop(root, route, |grant| {
        let grant = grant.ok_or("authorization_required")?;
        if grant.instance_id != instance || grant.config.url != project || user_id(grant)? != user { return Err("wrong_account"); }
        sync_action(root, grant, action, payload)
    })
}

pub fn desktop_diagnostics(root: &Path, route: &str, instance: &str, project: &str, user: &str, entries: Vec<Value>) -> Result<Value> {
    auth::with_local_desktop(root, route, |grant| {
        let grant = grant.ok_or("authorization_required")?;
        if grant.instance_id != instance || grant.config.url != project || user_id(grant)? != user { return Err("wrong_account"); }
        let directory = location(root, grant)?;
        private_directory(&root.join("workspace-library"))?; private_directory(&directory)?;
        let reading = entries.is_empty();
        let mut dropped = 0;
        if entries.len() > 128 { return Err("invalid_workspace_request"); }
        for entry in entries {
            if let Some(safe) = diagnostics::sanitize_frontend(entry) { if !diagnostics::append(&directory, &safe) { dropped += 1; } }
            else { dropped += 1; }
        }
        Ok(json!({"events":if reading {diagnostics::read(&directory)?} else {Vec::new()}, "dropped":dropped, "nativeDropped":diagnostics::dropped()}))
    })
}

fn sync_action(root: &Path, grant: &Grant, action: &str, payload: Value) -> Result<Value> {
    let directory = location(root, grant)?;
    private_directory(&root.join("workspace-library"))?;
    private_directory(&directory)?;
    if action == "diagnostics" {
        let events = diagnostics::read(&directory)?;
        let index = payload["index"].as_u64().unwrap_or(0) as usize;
        // Respect the Host's frame limit, including the response envelope and JSON separators.
        let budget = crate::MAX_FRAME - 128;
        let mut pages = vec![Vec::new()];
        let mut used = 0;
        for event in events {
            let size = serde_json::to_vec(&event).map_err(|_| "invalid_response")?.len() + 1;
            if size > budget { return Err("oversized_response"); }
            if used + size > budget { pages.push(Vec::new()); used = 0; }
            pages.last_mut().unwrap().push(event);
            used += size;
        }
        let chunks = pages.len();
        let page = pages.into_iter().nth(index).ok_or("invalid_workspace_request")?;
        return Ok(json!({"status":"diagnostics","index":index,"chunks":chunks,"events":page}));
    }
    let trace = payload["diagnostic"].clone();
    let _lock = diagnostics::ObservedLock::acquire(&directory, &trace)?;
    let mut library = read_library(&directory)?;
    if action == "signal" { return Ok(json!({"status":"changed","generation":library.generation})); }
    if action == "read" {
        if payload["generation"].as_u64().is_some_and(|g| g != library.generation) { return Err("stale_workspace_revision"); }
        let bytes = serde_json::to_vec(&library).map_err(|_| "local_store_corrupt")?;
        let chunks = bytes.len().div_ceil(CHUNK_BYTES);
        let index = payload["index"].as_u64().unwrap_or(0) as usize;
        if index >= chunks { return Err("invalid_workspace_chunk"); }
        let start = index * CHUNK_BYTES;
        return Ok(json!({"status":"read","generation":library.generation,"chunks":chunks,"index":index,"part":hex(&bytes[start..bytes.len().min(start+CHUNK_BYTES)])}));
    }
    let lease_path = directory.join("sync-lease.json");
    let mut lease = fs::read(&lease_path).ok().and_then(|b| serde_json::from_slice::<Lease>(&b).ok());
    let token = payload["token"].as_str().unwrap_or("");
    let current = lease.as_ref().is_some_and(|l| l.expires_at > bridge::now() && l.login_request == grant.login_request);
    if action == "acquire" {
        if current {
            diagnostics::append(&directory, &diagnostics::event("lease.busy", &trace, "waiting", None, json!({"leaseRemainingMs":lease.as_ref().map(|l|l.expires_at.saturating_sub(bridge::now())*1000)})));
            return Ok(json!({"status":"busy"}));
        }
        diagnostics::append(&directory, &diagnostics::event("lease.acquired", &trace, "success", None, json!({"reason":if lease.is_some() {"retry"} else {"startup"}})));
        let next = Lease { token: bridge::random_id(), login_request: grant.login_request.clone(), expires_at: bridge::now()+60 };
        write(&lease_path, &next)?;
        return Ok(json!({"status":"acquired","token":next.token}));
    }
    if !current || lease.as_ref().is_none_or(|l| l.token != token) { return Err("sync_lease_expired"); }
    if action == "release" { fs::remove_file(lease_path).map_err(|_| "local_store_unavailable")?; diagnostics::append(&directory, &diagnostics::event("lease.released", &trace, "success", None, json!({}))); return Ok(json!({"status":"released"})); }
    if action == "renew" {
        let active = lease.as_mut().ok_or("sync_lease_expired")?;
        active.expires_at = bridge::now()+60; write(&lease_path, active)?;
        return Ok(json!({"status":"renewed"}));
    }
    if action != "apply" { return Err("invalid_workspace_request"); }
    if payload["generation"].as_u64() != Some(library.generation) { return Err("stale_workspace_revision"); }
    let chunks = payload["chunks"].as_u64().unwrap_or(0) as usize;
    let index = payload["index"].as_u64().unwrap_or(u64::MAX) as usize;
    if chunks == 0 || chunks > MAX_BYTES * 2 / CHUNK_BYTES || index >= chunks { return Err("invalid_workspace_chunk"); }
    let part = payload["part"].as_str().ok_or("invalid_workspace_chunk")?;
    let decoded = decode(part)?;
    if index+1 < chunks && decoded.len() != CHUNK_BYTES { return Err("invalid_workspace_chunk"); }
    let stage_path = directory.join("sync-stage.json");
    let mut stage = if index == 0 { Stage { revision:library.generation, chunks, received_at:bridge::now(), parts:Vec::new() } }
        else { serde_json::from_slice::<Stage>(&fs::read(&stage_path).map_err(|_| "missing_workspace_chunk")?).map_err(|_| "invalid_workspace_chunk")? };
    if stage.revision != library.generation || stage.chunks != chunks || stage.parts.len() != index || bridge::now().saturating_sub(stage.received_at) > 60 { return Err("invalid_workspace_chunk"); }
    stage.parts.push(part.into());
    if index+1 < chunks { write(&stage_path, &stage)?; return Ok(json!({"status":"staged"})); }
    let bytes = stage.parts.iter().map(|p| decode(p)).collect::<Result<Vec<_>>>()?.concat();
    if bytes.len() > MAX_BYTES*2 { return Err("local_store_full"); }
    let mut next: Library = serde_json::from_slice(&bytes).map_err(|_| "invalid_workspace_snapshot")?;
    if next.generation != library.generation || next.revision != library.revision || next.digest != library.digest
        || !library.deleted.is_subset(&next.deleted) || !library.delete_ack.is_subset(&next.delete_ack)
        || library.remote_deleted.iter().any(|(id, stamp)| next.remote_deleted.get(id) != Some(stamp))
        || next.records.iter().any(|(id, record)| id != &record.content.id || !valid_record(record) || next.deleted.contains(id))
        || next.conflicts.iter().any(|(id, records)| !valid_workspace_id(id) || records.iter().any(|r| &r.content.id != id || !valid_record(r)))
        || next.deleted.iter().any(|id| !valid_workspace_id(id))
        || next.remote_deleted.keys().any(|id| !next.deleted.contains(id)) || !next.delete_ack.is_subset(&next.deleted) {
        return Err("invalid_workspace_snapshot");
    }
    next.diagnostics = library.diagnostics.clone();
    // Preserve conflict versions even if a caller forgot them, and back up unsent remote deletions.
    for (id, records) in &library.conflicts { for record in records { remember_conflict(&mut next.conflicts, id, record)?; } }
    for (id, record) in &library.records {
        if next.remote_deleted.contains_key(id) && record.sync.sync_status != "synced" { remember_conflict(&mut next.conflicts, id, record)?; }
    }
    next.generation = next.generation.checked_add(1).filter(|g| *g <= 9_007_199_254_740_991).ok_or("workspace_revision_exhausted")?;
    if serde_json::to_vec(&next).map_err(|_| "local_store_unavailable")?.len() > MAX_BYTES*2 { return Err("local_store_full"); }
    std::mem::swap(&mut library, &mut next);
    write(&directory.join("library.json"), &library)?;
    diagnostics::append(&directory, &diagnostics::event("native.persisted", &trace, "success", None, json!({"revision":library.revision,"generation":library.generation})));
    write(&root.join("workspace-library").join("change.json"), &bridge::random_id())?;
    let _ = fs::remove_file(stage_path);
    Ok(json!({"status":"persisted","generation":library.generation}))
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
            project_url: "https://fixture.supabase.co".into(), user_id: "user-A".into(), revision, chunks, index, part: hex(part), diagnostic:Value::Null, diagnostic_operations:BTreeMap::new(),
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
        let request = |revision| ReadRequest { version: 1, r#type: "workspace_read".into(), instance_id: "a".repeat(64), capability: "c".repeat(64), project_url: "https://fixture.supabase.co".into(), user_id: "user-A".into(), id: ID.into(), index: 0, revision, generation: None };
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
    fn local_action(root: &Path, action: &str, payload: Value) -> Result<Value> {
        desktop_sync(root, &"b".repeat(64), &"a".repeat(64), "https://fixture.supabase.co", "user-A", action, payload)
    }
    #[test]
    fn diagnostic_pages_are_complete_and_compatible_with_existing_clients() {
        let root = setup();
        auth::with_local_desktop(root.path(), &"b".repeat(64), |grant| {
            let directory = location(root.path(), grant.unwrap())?;
            private_directory(&directory)?;
            let entries: String = (0..4000).map(|id| format!("{{\"timestamp\":{},\"id\":{}}}\n", bridge::now()*1000, id)).collect();
            fs::write(directory.join("diagnostics.jsonl"), entries).unwrap();
            Ok(())
        }).unwrap();
        let mut ids = Vec::new();
        let mut chunks = 1;
        let mut index = 0;
        while index < chunks {
            let page = local_action(root.path(), "diagnostics", json!({"index":index})).unwrap();
            let mut frame = Vec::new();
            crate::write_frame(&mut frame, &page).unwrap();
            chunks = page["chunks"].as_u64().unwrap();
            ids.extend(page["events"].as_array().unwrap().iter().map(|e|e["id"].as_u64().unwrap()));
            index += 1;
        }
        assert!(chunks > 1 && chunks < 500);
        assert_eq!(ids, (0..4000).collect::<Vec<_>>());
        assert!(local_action(root.path(), "diagnostics", json!({"index":chunks})).is_err());
    }
    #[test]
    fn diagnostic_pages_fit_the_host_frame_limit_with_large_entries() {
        let root = setup();
        auth::with_local_desktop(root.path(), &"b".repeat(64), |grant| {
            let directory = location(root.path(), grant.unwrap())?;
            private_directory(&directory)?;
            let entries: String = (0..128).map(|id| {
                let entry = json!({"timestamp":bridge::now()*1000,"id":id,"padding":"x".repeat(3800)});
                assert!(serde_json::to_vec(&entry).unwrap().len() <= 4096);
                format!("{entry}\n")
            }).collect();
            fs::write(directory.join("diagnostics.jsonl"), entries).unwrap();
            Ok(())
        }).unwrap();
        let mut ids = Vec::new();
        let mut chunks = 1;
        let mut index = 0;
        while index < chunks {
            let page = local_action(root.path(), "diagnostics", json!({"index":index})).unwrap();
            let mut frame = Vec::new();
            crate::write_frame(&mut frame, &page).unwrap();
            let decoded: Value = serde_json::from_slice(&crate::read_frame(&mut frame.as_slice()).unwrap()).unwrap();
            assert_eq!(decoded, page);
            ids.extend(page["events"].as_array().unwrap().iter().map(|e|e["id"].as_u64().unwrap()));
            chunks = page["chunks"].as_u64().unwrap();
            index += 1;
        }
        assert_eq!(ids, (0..128).collect::<Vec<_>>());
    }
    #[test]
    fn diagnostics_export_works_without_chrome_and_remains_account_authorized() {
        let root = setup();
        publish(root.path(), json!({"records":[record("PRIVATE CONTENT")],"deleted":[]}), 1).unwrap();
        let read = || desktop_diagnostics(root.path(), &"b".repeat(64), &"a".repeat(64), "https://fixture.supabase.co", "user-A", vec![]);
        let exported = read().unwrap();
        assert!(!exported["events"].as_array().unwrap().is_empty());
        assert!(!exported.to_string().contains("PRIVATE CONTENT"));
        assert!(desktop_diagnostics(root.path(), &"b".repeat(64), &"a".repeat(64), "https://fixture.supabase.co", "user-B", vec![]).is_err());
        let path = root.path().join("accounts").join(format!("{}.json", "a".repeat(64)));
        let mut grant: Grant = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap(); grant.session = Value::Null;
        bridge::write_json(&path, &grant).unwrap(); assert!(read().is_err());
    }
    #[test]
    fn abandoned_process_lease_recovery_is_observed_without_losing_pending_deletion() {
        let root = setup();
        publish(root.path(), json!({"records":[],"deleted":[ID]}), 1).unwrap();
        local_action(root.path(), "acquire", json!({})).unwrap();
        // Simulate a process dying without release, then lease expiry in the isolated fixture.
        auth::with_local_desktop(root.path(), &"b".repeat(64), |grant| {
            let directory = location(root.path(), grant.unwrap())?;
            let path = directory.join("sync-lease.json");
            let mut lease: Lease = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap(); lease.expires_at = 0;
            write(&path, &lease)
        }).unwrap();
        assert_eq!(local_action(root.path(), "acquire", json!({})).unwrap()["status"], "acquired");
        assert_eq!(full_library(root.path())["deleted"], json!([ID]));
        let result = desktop_diagnostics(root.path(), &"b".repeat(64), &"a".repeat(64), "https://fixture.supabase.co", "user-A", vec![]).unwrap();
        assert!(result["events"].as_array().unwrap().iter().any(|e|e["event"]=="lease.acquired" && e["state"]["reason"]=="retry"));
    }
    fn full_library(root: &Path) -> Value {
        let reply = local_action(root, "read", json!({"index":0})).unwrap();
        serde_json::from_slice(&decode(reply["part"].as_str().unwrap()).unwrap()).unwrap()
    }
    fn commit(root: &Path, value: Value, token: &str) -> Result<Value> {
        let bytes = serde_json::to_vec(&value).unwrap();
        local_action(root, "apply", json!({"token":token,"generation":value["generation"],"index":0,"chunks":1,"part":hex(&bytes)}))
    }
    #[test]
    fn desktop_and_extension_share_a_durable_exclusive_upload_lease() {
        let root = setup();
        publish(root.path(), json!({"records":[record("Before")],"deleted":[]}), 1).unwrap();
        let lease = local_action(root.path(), "acquire", json!({})).unwrap();
        assert_eq!(local_action(root.path(), "acquire", json!({})).unwrap()["status"], "busy");
        let token = lease["token"].as_str().unwrap();
        let mut state = full_library(root.path());
        state["records"][ID]["content"]["name"] = json!("Cloud download");
        commit(root.path(), state, token).unwrap();
        assert_eq!(list(root.path())["items"][0]["name"], "Cloud download");
        let request: ReadRequest = serde_json::from_value(json!({"version":1,"type":"workspace_read","instance_id":"a".repeat(64),"capability":"c".repeat(64),"project_url":"https://fixture.supabase.co","user_id":"user-A","id":ID,"index":0,"revision":1,"generation":1})).unwrap();
        assert_eq!(read(root.path(), ORIGIN, request).unwrap_err(), "stale_workspace_revision");
        assert_eq!(local_action(root.path(), "renew", json!({"token":"wrong"})).unwrap_err(), "sync_lease_expired");
        local_action(root.path(), "release", json!({"token":token})).unwrap();
        assert_eq!(local_action(root.path(), "acquire", json!({})).unwrap()["status"], "acquired");
    }
    #[test]
    fn conditional_cloud_commit_cannot_replace_a_new_local_save() {
        let root = setup();
        publish(root.path(), json!({"records":[record("Before")],"deleted":[]}), 1).unwrap();
        let lease = local_action(root.path(), "acquire", json!({})).unwrap();
        let old = full_library(root.path());
        publish(root.path(), json!({"records":[record("Newer")],"deleted":[]}), 2).unwrap();
        assert_eq!(commit(root.path(), old, lease["token"].as_str().unwrap()).unwrap_err(), "stale_workspace_revision");
        assert_eq!(list(root.path())["items"][0]["name"], "Newer");
    }
    #[test]
    fn remote_deletion_retains_unsent_content_and_rejects_unaware_save_acknowledgement() {
        let root = setup();
        publish(root.path(), json!({"records":[record("Offline edits")],"deleted":[]}), 1).unwrap();
        let lease = local_action(root.path(), "acquire", json!({})).unwrap();
        let mut state = full_library(root.path());
        state["records"] = json!({}); state["deleted"] = json!([ID]); state["delete_ack"] = json!([ID]);
        state["remote_deleted"] = json!({ID:"2026-10-14T01:00:00Z"});
        commit(root.path(), state, lease["token"].as_str().unwrap()).unwrap();
        assert_eq!(full_library(root.path())["conflicts"][ID][0]["content"]["name"], "Offline edits");
        assert_eq!(publish(root.path(), json!({"records":[record("Late save")],"deleted":[]}), 2).unwrap_err(), "workspace_deleted");
        assert_eq!(list(root.path())["items"], json!([]));
        assert_eq!(full_library(root.path())["conflicts"][ID].as_array().unwrap().len(), 2);
    }
    #[test]
    fn logout_or_another_login_invalidates_outstanding_cloud_leases() {
        let root = setup();
        let lease = local_action(root.path(), "acquire", json!({})).unwrap();
        let path = root.path().join("accounts").join(format!("{}.json", "a".repeat(64)));
        let mut grant: Grant = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        grant.login_request = "e".repeat(64); bridge::write_json(&path, &grant).unwrap();
        assert_eq!(local_action(root.path(), "renew", json!({"token":lease["token"]})).unwrap_err(), "sync_lease_expired");
        grant.session = Value::Null; bridge::write_json(&path, &grant).unwrap();
        assert!(local_action(root.path(), "read", json!({})).is_err());
    }
    #[test]
    fn stale_chrome_edit_preserves_both_versions_and_cannot_silently_replace_a_cloud_download() {
        let root = setup();
        let mut before = record("Before"); before["sync"]["lastSyncedCloudUpdatedAt"] = json!("2026-10-13T00:00:00Z");
        publish(root.path(), json!({"records":[before.clone()],"deleted":[]}), 1).unwrap();
        let lease = local_action(root.path(), "acquire", json!({})).unwrap();
        let mut cloud = full_library(root.path());
        cloud["records"][ID]["content"]["name"] = json!("Remote update");
        cloud["records"][ID]["sync"]["syncStatus"] = json!("synced");
        cloud["records"][ID]["sync"]["lastSyncedCloudUpdatedAt"] = json!("2026-10-14T00:00:00Z");
        commit(root.path(), cloud, lease["token"].as_str().unwrap()).unwrap();
        before["content"]["name"] = json!("Local edit");
        publish(root.path(), json!({"records":[before],"deleted":[]}), 2).unwrap();
        let state = full_library(root.path());
        assert_eq!(state["records"][ID]["content"]["name"], "Local edit");
        assert_eq!(state["records"][ID]["sync"]["syncStatus"], "conflict");
        assert_eq!(state["conflicts"][ID][0]["content"]["name"], "Remote update");
    }
}
