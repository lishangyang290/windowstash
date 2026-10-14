#[cfg(all(debug_assertions, feature = "insecure-test-store"))]
use serde::Deserialize;
use serde_json::json;
use std::io;
#[cfg(all(debug_assertions, feature = "insecure-test-store"))]
use std::{
    path::PathBuf,
    sync::mpsc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use windowstash_native_host::{bridge, read_frame, valid_origin, write_frame};
#[cfg(all(debug_assertions, feature = "insecure-test-store"))]
use windowstash_native_host::{random_id, Profile, SignedCommand, Store, VERSION};
#[cfg(all(debug_assertions, feature = "insecure-test-store"))]
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Pair { profile: Profile },
    Command { signed: SignedCommand },
}

fn run() -> windowstash_native_host::Result<()> {
    let origin = std::env::args().nth(1).ok_or("missing_origin")?;
    if !valid_origin(&origin) {
        return Err("invalid_origin");
    }
    #[cfg(all(debug_assertions, feature = "insecure-test-store"))]
    if let Some(directory) = std::env::var_os("WINDOWSTASH_AUTH_TEST_DIR").map(PathBuf::from) {
        // Vulnerable negative control only. The protocol still rejects credentials.
        let backend = windowstash_native_host::storage::InsecureTestStorage(directory.clone());
        return exchange(Store::new(directory, backend), &origin);
    }
    let bytes = read_frame(&mut io::stdin()).map_err(|_| "trusted_bootstrap_unavailable")?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "invalid_request")?;
    if value.get("type").and_then(|v| v.as_str()) == Some("workspace_watch") {
        let root = bridge::directory()?;
        let mut previous = None;
        let mut previous_signal = None;
        let disconnected = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let closed = disconnected.clone();
        std::thread::spawn(move || {
            use std::io::Read;
            let _ = io::stdin().read(&mut [0u8; 1]);
            closed.store(true, std::sync::atomic::Ordering::Release);
        });
        loop {
            if disconnected.load(std::sync::atomic::Ordering::Acquire) { return Ok(()); }
            let signal = std::fs::read(root.join("workspace-library/change.json")).ok();
            if previous.is_none() || previous_signal != signal {
                let request = serde_json::from_value(value.clone()).map_err(|_| "invalid_workspace_request")?;
                let reply = windowstash_native_host::workspaces::sync(&root, &origin, request)?;
                let generation = reply["generation"].as_u64().ok_or("invalid_workspace_request")?;
                if previous != Some(generation) { write_frame(&mut io::stdout(), &reply)?; previous = Some(generation); }
                previous_signal = signal;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
    let response = if value.get("type").and_then(|v| v.as_str()) == Some("workspace_sync") {
        let request = serde_json::from_value(value).map_err(|_| "invalid_workspace_request")?;
        windowstash_native_host::workspaces::sync(&bridge::directory()?, &origin, request)?
    } else if value.get("type").and_then(|v| v.as_str()) == Some("workspace_read") {
        let request = serde_json::from_value(value).map_err(|_| "invalid_workspace_request")?;
        windowstash_native_host::workspaces::read(&bridge::directory()?, &origin, request)?
    } else if value.get("type").and_then(|v| v.as_str()) == Some("workspaces") {
        let request = serde_json::from_value(value).map_err(|_| "invalid_workspace_request")?;
        windowstash_native_host::workspaces::dispatch(&bridge::directory()?, &origin, request)?
    } else if value.get("type").and_then(|v| v.as_str()) == Some("auth") {
        let request = serde_json::from_value(value).map_err(|_| "invalid_auth_request")?;
        windowstash_native_host::auth::dispatch(&bridge::directory()?, &origin, request)?
    } else {
        let request = serde_json::from_value(value).map_err(|_| "invalid_status_request")?;
        serde_json::to_value(bridge::status(&bridge::directory()?, &origin, request)?)
            .map_err(|_| "invalid_status_request")?
    };
    write_frame(&mut io::stdout(), &response)
}

#[cfg(all(debug_assertions, feature = "insecure-test-store"))]
fn exchange<B: windowstash_native_host::storage::StateStorage>(
    store: Store<B>,
    origin: &str,
) -> windowstash_native_host::Result<()> {
    let challenge = random_id();
    let state = store.snapshot()?;
    write_frame(
        &mut io::stdout(),
        &json!({
            "version": VERSION, "challenge": challenge,
            "generation": state.generation, "last_sequence": state.last_sequence,
            "revision": state.revision
        }),
    )?;
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = send.send(read_frame(&mut io::stdin()));
    });
    let bytes = receive
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "request_timeout")??;
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| "invalid_request")?;
    let response = match request {
        Request::Pair { profile } => {
            if profile.origin != origin {
                return Err("wrong_origin");
            }
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "invalid_clock")?
                .as_secs();
            json!({"status": "awaiting_desktop_confirmation", "pairing": store.request_pairing(profile, now)?})
        }
        Request::Command { signed } => {
            json!({"status": "persisted", "state": store.apply(signed, origin, &challenge)?})
        }
    };
    write_frame(&mut io::stdout(), &response)
}

fn main() {
    if let Err(code) = run() {
        // Only fixed error codes are emitted. Never echo request bodies.
        let _ = write_frame(&mut io::stdout(), &json!({"status": "error", "code": code}));
        std::process::exit(1);
    }
}
