//! Fixed-path, account-authorized diagnostics. No arbitrary paths or credentials on the wire.
use crate::{bridge, Result};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{fs::{self, OpenOptions}, io::{BufRead, BufReader, Write}, path::Path, time::Instant};

thread_local! { static COMPONENT: std::cell::Cell<&'static str> = const { std::cell::Cell::new("native-host") }; }
pub struct DesktopContext(&'static str);
pub fn desktop_context() -> DesktopContext { DesktopContext(COMPONENT.with(|c| c.replace("companion-rust"))) }
impl Drop for DesktopContext { fn drop(&mut self) { COMPONENT.with(|c| c.set(self.0)); } }
const LIMIT: u64 = 1024 * 1024 - 4096;
enum WriteTask { Entry(std::path::PathBuf, Value), Flush(std::sync::mpsc::Sender<()>) }
static DROPPED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn writer() -> &'static std::sync::mpsc::SyncSender<WriteTask> {
    static WRITER: std::sync::OnceLock<std::sync::mpsc::SyncSender<WriteTask>> = std::sync::OnceLock::new();
    WRITER.get_or_init(|| {
        let (send, receive) = std::sync::mpsc::sync_channel(128);
        std::thread::spawn(move || { for task in receive {
            match task {
                WriteTask::Entry(path, entry) => { if !append_file(&path, &entry) { DROPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed); } }
                WriteTask::Flush(done) => { let _ = done.send(()); }
            }
        } });
        send
    })
}
pub fn dropped() -> u64 { DROPPED.load(std::sync::atomic::Ordering::Relaxed) }
pub fn flush() {
    let (send, receive) = std::sync::mpsc::channel();
    if writer().send(WriteTask::Flush(send)).is_ok() { let _ = receive.recv_timeout(std::time::Duration::from_secs(2)); }
}
pub fn append(directory: &Path, entry: &Value) -> bool {
    if writer().try_send(WriteTask::Entry(directory.into(), entry.clone())).is_err() {
        DROPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed); return false;
    }
    true
}
fn identifier() -> String {
    let raw = bridge::random_id();
    format!("{}-{}-{}-{}-{}", &raw[..8], &raw[8..12], &raw[12..16], &raw[16..20], &raw[20..32])
}
pub fn valid_id(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(i, b)| if [8,13,18,23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() })
}
pub fn event(event: &str, trace: &Value, result: &str, duration: Option<u128>, state: Value) -> Value {
    static PROCESS: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let operation = trace["operationId"].as_str().filter(|id| valid_id(id)).map(str::to_string).unwrap_or_else(identifier);
    let parent = trace["parentEventId"].as_str().filter(|id| valid_id(id));
    let platform = if cfg!(target_os="windows") { "windows" } else if cfg!(target_os="macos") { "macos" } else { "unknown" };
    json!({"id":identifier(), "timestamp":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(),
        "level":if result == "failed" { "ERROR" } else { "INFO" }, "component":COMPONENT.with(|c|c.get()), "event":event,
        "operationId":operation, "parentEventId":parent, "result":result, "durationMs":duration,
        "devicePlatform":platform, "deviceId":"unknown", "processId":PROCESS.get_or_init(identifier), "buildId":option_env!("WINDOWSTASH_BUILD_ID").unwrap_or(env!("CARGO_PKG_VERSION")),
        "source":if event.starts_with("lock.") {"companion/native-host/src/diagnostics.rs:ObservedLock"} else if event.starts_with("lease.") {"companion/native-host/src/workspaces.rs:sync_action"} else {"companion/native-host/src/workspaces.rs"}, "state":state})
}
fn safe_path(path: &Path) -> bool {
    fs::symlink_metadata(path).map_or(true, |m| {
        if m.file_type().is_symlink() { return false; }
        #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if m.file_attributes() & 0x400 != 0 { return false; } }
        true
    })
}
fn purge_expired(path: &Path) -> Option<()> {
    let file = match fs::File::open(path) { Ok(file) => file, Err(e) if e.kind()==std::io::ErrorKind::NotFound => return Some(()), Err(_) => return None };
    use std::io::Read;
    let mut first = String::new();
    BufReader::new(file.take(4096)).read_line(&mut first).ok()?;
    let cutoff = bridge::now().saturating_sub(7*86400)*1000;
    let expired = serde_json::from_str::<Value>(&first).ok().and_then(|e|e["timestamp"].as_u64()).is_some_and(|at|at < cutoff);
    if !expired { return Some(()); }
    let file = fs::File::open(path).ok()?;
    let mut kept = Vec::new();
    for line in BufReader::new(file.take(LIMIT+4096)).lines().map_while(std::result::Result::ok) {
        if serde_json::from_str::<Value>(&line).ok().and_then(|e|e["timestamp"].as_u64()).is_some_and(|at|at >= cutoff) { kept.extend(line.as_bytes()); kept.push(b'\n'); }
    }
    // Only a diagnostic segment is rewritten, under the separate diagnostic lock.
    OpenOptions::new().write(true).truncate(true).open(path).ok()?.write_all(&kept).ok()?;
    Some(())
}
/** Try-lock only; a busy diagnostic writer never delays workspace or lease ownership. */
fn append_file(directory: &Path, entry: &Value) -> bool {
    let save = || -> Option<()> {
        if !safe_path(directory) { return None; }
        if !directory.is_dir() { return None; }
        let path = directory.join("diagnostics.jsonl");
        let old = directory.join("diagnostics.previous.jsonl");
        let lock_path = directory.join("diagnostics.lock");
        if !safe_path(&path) || !safe_path(&old) || !safe_path(&lock_path) { return None; }
        let lock = OpenOptions::new().create(true).truncate(false).write(true).open(lock_path).ok()?;
        lock.try_lock_exclusive().ok()?;
        purge_expired(&path)?; purge_expired(&old)?;
        if fs::metadata(&path).is_ok_and(|m| m.len() >= LIMIT) { let _ = fs::remove_file(&old); fs::rename(&path, &old).ok()?; }
        let mut options = OpenOptions::new(); options.create(true).append(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(path).ok()?;
        let mut entry = entry.clone();
        let device_directory = directory.parent().filter(|p|p.file_name().is_some_and(|name|name=="workspace-library")).unwrap_or(directory);
        if !safe_path(device_directory) { return None; }
        let device_path = device_directory.join("diagnostics-device");
        if !safe_path(&device_path) { return None; }
        let device = match fs::read_to_string(&device_path) {
            Ok(value) if value.len()==64 && value.bytes().all(|b|b.is_ascii_hexdigit()) => value,
            _ => { let value = bridge::random_id(); let mut device_file = OpenOptions::new().create_new(true).write(true).open(&device_path).ok()?; device_file.write_all(value.as_bytes()).ok()?; value }
        };
        entry["deviceId"] = json!(device); entry["deviceSource"] = json!("native");
        let bytes = serde_json::to_vec(&entry).ok()?;
        if bytes.len() > 4096 { return None; }
        file.write_all(&bytes).ok()?; file.write_all(b"\n").ok()?;
        Some(())
    };
    save().is_some()
}
pub fn read(directory: &Path) -> Result<Vec<Value>> {
    flush();
    let mut events = Vec::new();
    for name in ["diagnostics.previous.jsonl", "diagnostics.jsonl"] {
        let path = directory.join(name);
        if !safe_path(directory) || !safe_path(&path) { return Err("local_store_unavailable"); }
        let file = match fs::File::open(path) { Ok(f) => f, Err(e) if e.kind()==std::io::ErrorKind::NotFound => continue, Err(_) => return Err("local_store_unavailable") };
        use std::io::Read;
        for line in BufReader::new(file.take(LIMIT + 4096)).lines().map_while(std::result::Result::ok) {
            if let Ok(entry) = serde_json::from_str::<Value>(&line) {
                // Native entries use epoch ms; frontend entries also carry epoch ms on disk.
                let at = entry["timestamp"].as_u64().unwrap_or(0);
                if at / 1000 + 7*86400 >= bridge::now() { events.push(entry); }
            }
        }
    }
    Ok(events.into_iter().rev().take(4000).collect::<Vec<_>>().into_iter().rev().collect())
}

pub fn sanitize_frontend(entry: Value) -> Option<Value> {
    if !valid_id(entry["id"].as_str()?) || !valid_id(entry["operationId"].as_str()?) { return None; }
    let name = entry["event"].as_str()?;
    if !["sync.skipped","operation.done","native.publish.queued","sync.coalesced","operation.start","local.persisted","local.deleted","native.publish.start","native.publish.persisted","native.publish.failed","native.publish.skipped","native.changed","native.import.start","native.import.done","native.import.failed","lease.start","lease.acquired","lease.busy","lease.released","lease.release.failed","lock.start","lock.acquired","lock.released","lock.failed","native.read","native.applied","native.persisted","sync.request","sync.start","sync.done","sync.failed","sync.retry","sync.stop","queue.snapshot","queue.upload","queue.delete","cloud.start","cloud.done","cloud.failed","cloud.version","cloud.received","conflict.detected","realtime.start","realtime.status","realtime.database","realtime.event","realtime.stop","ui.refresh.start","ui.refresh.done","ui.refresh.failed","ui.committed","lifecycle.start","lifecycle.account","lifecycle.online","lifecycle.resume","lifecycle.open"].contains(&name) { return None; }
    let mut safe = serde_json::Map::new();
    for key in ["id", "operationId", "parentEventId", "processId", "blockedByOperationId"] {
        if let Some(value) = entry[key].as_str().filter(|s| valid_id(s)) { safe.insert(key.into(), json!(value)); }
    }
    for key in ["deviceId", "workspaceRef", "correlationId", "targetRef"] {
        if let Some(value) = entry[key].as_str().filter(|s| s.len()==64 && s.bytes().all(|b|b.is_ascii_hexdigit())) { safe.insert(key.into(), json!(value)); }
    }
    for (key, values) in [
        ("level", vec!["INFO","WARN","ERROR"]), ("component", vec!["companion", "companion-rust"]),
        ("result", vec!["started","success","failed","cancelled","observed","waiting"]),
        ("devicePlatform", vec!["windows","macos","linux","unknown"]),
        ("trigger", vec!["startup","retry","realtime","ready","manual","native-change","account-changed","stop"]),
    ] {
        if let Some(value) = entry[key].as_str().filter(|v|values.contains(v)) { safe.insert(key.into(), json!(value)); }
    }
    safe.insert("event".into(), json!(name));
    // Source is fixed per producer, never accepts a path from a wire request.
    safe.insert("source".into(), json!(if name.starts_with("ui.") {"companion/src/App.tsx"} else if name.starts_with("cloud.") {"shared/syncCloud.ts:rpc"} else if name.starts_with("realtime.") {"shared/workspaceRealtime.ts:subscribeWorkspaceChanges"} else if name.starts_with("lease.") || name.starts_with("queue.") || name == "native.applied" || name == "native.read" || name == "conflict.detected" {"shared/workspaceSync.ts:synchronize"} else {"shared/realtimeSync.ts:RealtimeSync"}));
    let build = entry["buildId"].as_str().filter(|s| (s.len()>=7 && s.len()<=40 && s.bytes().all(|b|b.is_ascii_hexdigit())) || *s == "development").unwrap_or(env!("CARGO_PKG_VERSION"));
    safe.insert("buildId".into(), json!(build));
    for key in ["timestamp", "durationMs", "retryAttempt"] { if let Some(value) = entry[key].as_u64() { safe.insert(key.into(), json!(value)); } }
    if let Some(stamp) = entry["cloudVersion"].as_str().filter(|s|s.len()<=40 && s.bytes().all(|b|b.is_ascii_digit() || b"-T:.+Z".contains(&b))) { safe.insert("cloudVersion".into(), json!(stamp)); }
    if let Some(code) = entry["errorCode"].as_str().filter(|s|["lease-busy","lease-expired","stale-revision","validation","other","timeout","account-changed","sync_lease_expired","local_store_corrupt","local_store_full","local_store_unavailable"].contains(s) || (s.len()==5 && s.bytes().all(|b|b.is_ascii_uppercase() || b.is_ascii_digit()))) { safe.insert("errorCode".into(), json!(code)); }
    let mut state = serde_json::Map::new();
    for key in ["run","revision","generation","count","deleted","conflicts","retryMs","pending","queueDepth","httpStatus","leaseRemainingMs","before","after"] { if let Some(v)=entry["state"][key].as_u64() { state.insert(key.into(),json!(v)); } }
    for key in ["changed","queued"] { if let Some(v)=entry["state"][key].as_bool() { state.insert(key.into(),json!(v)); } }
    for key in ["action","status","failure","reason","context"] {
        if let Some(v)=entry["state"][key].as_str().filter(|v|["popup","manager","background","diagnostics","companion","save","save-close","update","delete","snapshot","put","remove","acquire","read","renew","apply","release","SUBSCRIBED","CHANNEL_ERROR","TIMED_OUT","CLOSED","ok","error","other","busy","lease-busy","lease-expired","stale-revision","validation","retry","startup"].contains(v)) { state.insert(key.into(),json!(v)); }
    }
    safe.insert("state".into(), Value::Object(state));
    Some(Value::Object(safe))
}

pub struct ObservedLock { file: fs::File, directory: std::path::PathBuf, trace: Value, started: Instant }
impl ObservedLock {
    pub fn acquire(directory: &Path, trace: &Value) -> Result<Self> {
        let started = Instant::now();
        let start = event("lock.start", trace, "started", None, json!({}));
        let trace = json!({"operationId":start["operationId"],"parentEventId":start["id"]});
        append(directory, &start);
        let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(directory.join("lock")).map_err(|_| "local_store_unavailable")?;
        if file.lock_exclusive().is_err() { append(directory, &event("lock.failed", &trace, "failed", Some(started.elapsed().as_millis()), json!({}))); return Err("local_store_unavailable"); }
        append(directory, &event("lock.acquired", &trace, "success", Some(started.elapsed().as_millis()), json!({})));
        Ok(Self { file, directory:directory.into(), trace, started:Instant::now() })
    }
}
impl Drop for ObservedLock {
    fn drop(&mut self) {
        let result = FileExt::unlock(&self.file);
        append(&self.directory, &event("lock.released", &self.trace, if result.is_ok() {"success"} else {"failed"}, Some(self.started.elapsed().as_millis()), json!({})));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captures_real_lock_wait_before_acquire_and_release() {
        flush();
        let root = tempfile::tempdir().unwrap();
        let file = OpenOptions::new().create(true).truncate(false).write(true).open(root.path().join("lock")).unwrap();
        file.lock_exclusive().unwrap();
        let path = root.path().to_path_buf();
        let thread = std::thread::spawn(move || { let _held = ObservedLock::acquire(&path, &json!({})).unwrap(); });
        let mut waiting = false;
        for _ in 0..20 {
            let events = read(root.path()).unwrap();
            if events.iter().any(|e| e["event"] == "lock.start") { waiting = true; assert!(!events.iter().any(|e| e["event"] == "lock.acquired")); break; }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(waiting, "the start evidence must be durable while the business lock is still held");
        std::thread::sleep(std::time::Duration::from_millis(2050));
        FileExt::unlock(&file).unwrap(); thread.join().unwrap();
        let events = read(root.path()).unwrap();
        let acquired = events.iter().find(|e| e["event"] == "lock.acquired").unwrap();
        assert!(acquired["durationMs"].as_u64().unwrap() >= 2000);
        assert!(events.iter().any(|e| e["event"] == "lock.released"));
    }
    #[test]
    fn failed_or_busy_diagnostic_writes_do_not_take_the_business_lock() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("diagnostics.jsonl")).unwrap();
        let before = dropped();
        append(root.path(), &event("sync.start", &json!({}), "started", None, json!({})));
        flush(); assert!(dropped() > before);
        let _held = ObservedLock::acquire(root.path(), &json!({})).unwrap();
    }
    #[test]
    fn fixed_file_rotation_is_bounded_and_export_omits_expired_events() {
        flush(); let root = tempfile::tempdir().unwrap();
        // Pre-fill one fixture segment rather than issuing thousands of writes.
        fs::write(root.path().join("diagnostics.jsonl"), vec![b' '; LIMIT as usize]).unwrap();
        let mut expired = event("sync.done", &json!({}), "success", None, json!({})); expired["timestamp"] = json!(1);
        append(root.path(), &expired); append(root.path(), &event("sync.done", &json!({}), "success", None, json!({})));
        let events = read(root.path()).unwrap();
        assert_eq!(events.len(), 1);
        assert!(fs::metadata(root.path().join("diagnostics.previous.jsonl")).unwrap().len() <= LIMIT + 4096);
        assert!(fs::metadata(root.path().join("diagnostics.jsonl")).unwrap().len() <= LIMIT + 4096);
    }
    #[test]
    fn frontend_wire_is_allowlisted_instead_of_serializing_errors_or_identity() {
        let mut raw = event("sync.failed", &json!({}), "failed", None, json!({"count":1,"conflicts":2,"token":"PRIVATE","email":"PRIVATE"}));
        raw["component"] = json!("companion"); raw["password"] = json!("PRIVATE"); raw["errorCode"] = json!("PRIVATE");
        raw["targetRef"] = json!("a".repeat(64));
        let safe = sanitize_frontend(raw).unwrap();
        assert!(!safe.to_string().contains("PRIVATE")); assert_eq!(safe["state"]["count"],1);
        assert_eq!(safe["state"]["conflicts"],2); assert_eq!(safe["targetRef"],"a".repeat(64));
        let mut invalid = safe; invalid["targetRef"] = json!("PRIVATE"); invalid["errorCode"] = json!("local_store_corrupt");
        let checked = sanitize_frontend(invalid).unwrap();
        assert!(checked.get("targetRef").is_none()); assert_eq!(checked["errorCode"],"local_store_corrupt");
    }
}
