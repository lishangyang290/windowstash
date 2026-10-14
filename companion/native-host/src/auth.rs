//! Single refresh owner. Local same-user tampering is an accepted deployment risk.
//! Files are private; capabilities are sent only over Native Messaging, never URLs.
use crate::bridge::{self, valid_id};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub url: String,
    pub publishable_key: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Grant {
    pub instance_id: String,
    pub origin: String,
    pub route_id: String,
    pub capability: String,
    pub login_request: String,
    pub config: Config,
    pub session: Value,
    pub revision: u64,
}
#[derive(Serialize, Deserialize)]
pub struct LoginRequest {
    pub id: String,
    pub route_id: String,
    pub origin: String,
    pub expires_at: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u8,
    pub r#type: String,
    pub action: String,
    pub instance_id: String,
    pub capability: Option<String>,
    pub login_request: Option<String>,
    pub route_id: Option<String>,
    pub config: Option<Config>,
    pub session: Option<Value>,
}
fn config_valid(config: &Config) -> bool {
    let url = &config.url;
    (url.starts_with("https://")
        || url.starts_with("http://localhost:")
        || url.starts_with("http://127.0.0.1:"))
        && !url.contains(['\n', '\r', '?', '#', '@'])
        && !config.publishable_key.is_empty()
        && !config.publishable_key.starts_with("sb_secret_")
}
fn network(
    config: &Config,
    path: &str,
    token: Option<&str>,
    data: Option<Value>,
) -> Result<Value, &'static str> {
    if !config_valid(config) {
        return Err("invalid_project_config");
    }
    // curl receives ALL credentials on stdin, not process arguments or environment.
    let mut input = format!(
        "url = {}\nheader = {}\n",
        json!(format!("{}{}", config.url.trim_end_matches('/'), path)),
        json!(format!("apikey: {}", config.publishable_key))
    );
    if let Some(token) = token {
        input.push_str(&format!(
            "header = {}\n",
            json!(format!("Authorization: Bearer {token}"))
        ));
    }
    if let Some(data) = data {
        input.push_str(&format!(
            "header = \"Content-Type: application/json\"\ndata = {}\n",
            json!(data.to_string())
        ));
    }
    let mut child = Command::new("curl")
        .args([
            "--disable",
            "--silent",
            "--show-error",
            "--max-time",
            "20",
            "--max-filesize",
            "1048576",
            "--config",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "network_unavailable")?;
    child
        .stdin
        .take()
        .ok_or("network_unavailable")?
        .write_all(input.as_bytes())
        .map_err(|_| "network_unavailable")?;
    let output = child
        .wait_with_output()
        .map_err(|_| "network_unavailable")?;
    if !output.status.success() {
        return Err("network_unavailable");
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "invalid_server_response")
}
fn user_id(session: &Value) -> Option<&str> {
    session.pointer("/user/id").and_then(Value::as_str)
}
fn validate(config: &Config, session: &Value) -> Result<(), &'static str> {
    let token = session
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or("invalid_session")?;
    if session
        .get("refresh_token")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err("invalid_session");
    }
    let user = network(config, "/auth/v1/user", Some(token), None)?;
    if user.get("id").and_then(Value::as_str).is_none()
        || user.get("id").and_then(Value::as_str) != user_id(session)
    {
        return Err("invalid_session");
    }
    Ok(())
}
fn path(root: &Path, instance: &str) -> std::path::PathBuf {
    root.join("accounts").join(format!("{instance}.json"))
}
fn load(root: &Path, instance: &str) -> Result<Option<Grant>, &'static str> {
    match fs::read(path(root, instance)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "auth_store_corrupt"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("auth_store_unavailable"),
    }
}
/// Local data authorization never refreshes a token or contacts Supabase.
pub fn with_local_grant<T>(root: &Path, origin: &str, instance: &str, capability: &str, task: impl FnOnce(&Grant) -> Result<T, &'static str>) -> Result<T, &'static str> {
    if !valid_id(instance) || !crate::valid_origin(origin) { return Err("unauthorized_instance"); }
    locked(root, || {
        let grant = load(root, instance)?.ok_or("not_linked")?;
        if grant.origin != origin || grant.capability != capability || grant.session.is_null() { return Err("unauthorized_instance"); }
        task(&grant)
    })
}

pub fn with_local_desktop<T>(root: &Path, route: &str, task: impl FnOnce(Option<&Grant>) -> Result<T, &'static str>) -> Result<T, &'static str> {
    if !valid_id(route) { return Err("unauthorized_instance"); }
    locked(root, || {
        let mut selected = None;
        for entry in fs::read_dir(root.join("accounts")).map_err(|_| "auth_store_unavailable")? {
            let entry = entry.map_err(|_| "auth_store_unavailable")?;
            if entry.path().extension().and_then(|e| e.to_str()) != Some("json") { continue; }
            let grant: Grant = serde_json::from_slice(&fs::read(entry.path()).map_err(|_| "auth_store_unavailable")?).map_err(|_| "auth_store_corrupt")?;
            if grant.route_id == route {
                if selected.is_some() { return Err("ambiguous_account"); }
                selected = Some(grant);
            }
        }
        task(selected.as_ref().filter(|grant| !grant.session.is_null()))
    })
}
fn locked<T>(
    root: &Path,
    task: impl FnOnce() -> Result<T, &'static str>,
) -> Result<T, &'static str> {
    let directory = root.join("accounts");
    fs::create_dir_all(&directory).map_err(|_| "auth_store_unavailable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "auth_store_unavailable")?;
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options
        .open(directory.join("lock"))
        .map_err(|_| "auth_store_unavailable")?;
    lock.lock_exclusive()
        .map_err(|_| "auth_store_unavailable")?;
    task()
}
fn ensure_fresh(root: &Path, mut grant: Grant) -> Result<Grant, &'static str> {
    let expiry = grant
        .session
        .get("expires_at")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if expiry > bridge::now() + 60 {
        return Ok(grant);
    }
    let token = grant
        .session
        .get("refresh_token")
        .and_then(Value::as_str)
        .ok_or("invalid_session")?;
    let mut session = network(
        &grant.config,
        "/auth/v1/token?grant_type=refresh_token",
        None,
        Some(json!({"refresh_token": token})),
    )?;
    if session
        .get("access_token")
        .and_then(Value::as_str)
        .is_none()
    {
        // A revoked token requires a new browser authorization; transient errors preserve it.
        if [
            "refresh_token_not_found",
            "refresh_token_already_used",
            "session_not_found",
        ]
        .contains(
            &session
                .get("error_code")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ) {
            grant.session = Value::Null;
            grant.revision += 1;
            bridge::write_json(&path(root, &grant.instance_id), &grant)?;
        }
        return Err("session_refresh_failed");
    }
    if user_id(&session) != user_id(&grant.session) {
        return Err("account_mismatch");
    }
    if session.get("expires_at").is_none() {
        session["expires_at"] = json!(
            bridge::now()
                + session
                    .get("expires_in")
                    .and_then(Value::as_u64)
                    .unwrap_or(3600)
        );
    }
    grant.session = session;
    grant.revision += 1;
    bridge::write_json(&path(root, &grant.instance_id), &grant)?;
    Ok(grant)
}
pub fn dispatch(root: &Path, origin: &str, request: Request) -> Result<Value, &'static str> {
    if request.version != 1
        || request.r#type != "auth"
        || !valid_id(&request.instance_id)
        || !crate::valid_origin(origin)
    {
        return Err("invalid_auth_request");
    }
    locked(root, || {
        let mut grant = load(root, &request.instance_id)?;
        if request.action == "bootstrap" {
            if let Some(current) = grant.as_ref() {
                if current.origin == origin
                    && request.capability.as_deref() == Some(&current.capability)
                    && request.login_request.as_deref() == Some(&current.login_request)
                {
                    let current = if current.session.is_null() {
                        current.clone()
                    } else {
                        ensure_fresh(root, current.clone())?
                    };
                    // A retry repeats desktop verification, rather than replaying a failed receipt.
                    let receipt_path = root.join("login-completion.json");
                    if fs::read(&receipt_path)
                        .ok()
                        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                        .is_some_and(|r| {
                            r["request"] == current.login_request && r["completed"] == false
                        })
                    {
                        fs::remove_file(receipt_path).map_err(|_| "auth_store_unavailable")?;
                    }
                    return Ok(
                        json!({"session":current.session,"config":current.config,"capability":current.capability}),
                    );
                }
            }
            let pending: LoginRequest = serde_json::from_slice(
                &fs::read(root.join("login-request.json")).map_err(|_| "login_request_missing")?,
            )
            .map_err(|_| "login_request_missing")?;
            if pending.expires_at < bridge::now()
                || request.login_request.as_deref() != Some(&pending.id)
                || request.route_id.as_deref() != Some(&pending.route_id)
                || pending.origin != origin
            {
                return Err("login_request_expired");
            }
            let config = request.config.ok_or("invalid_project_config")?;
            let session = request.session.ok_or("invalid_session")?;
            validate(&config, &session)?;
            let next = Grant {
                instance_id: request.instance_id.clone(),
                origin: origin.into(),
                route_id: pending.route_id,
                capability: bridge::random_id(),
                login_request: pending.id,
                config,
                session,
                revision: grant.as_ref().map_or(1, |g| g.revision + 1),
            };
            // Reinstalling an extension creates a new instance. Retire the old route
            // instead of leaving two accounts eligible for the same desktop selection.
            for entry in fs::read_dir(root.join("accounts"))
                .map_err(|_| "auth_store_unavailable")?
                .flatten()
            {
                if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let mut old: Grant = serde_json::from_slice(
                    &fs::read(entry.path()).map_err(|_| "auth_store_unavailable")?,
                )
                .map_err(|_| "auth_store_corrupt")?;
                if old.route_id == next.route_id && old.instance_id != next.instance_id {
                    old.route_id = bridge::random_id();
                    old.session = Value::Null;
                    old.revision += 1;
                    bridge::write_json(&entry.path(), &old)?;
                }
            }
            bridge::write_json(&path(root, &request.instance_id), &next)?;
            fs::remove_file(root.join("login-request.json"))
                .map_err(|_| "auth_store_unavailable")?;
            grant = Some(next);
        } else {
            let current = grant.as_ref().ok_or("not_linked")?;
            if current.origin != origin
                || request.capability.as_deref() != Some(&current.capability)
            {
                return Err("unauthorized_instance");
            }
            match request.action.as_str() {
                "completion" => {
                    if current.session.is_null()
                        || request.login_request.as_deref() != Some(&current.login_request)
                    {
                        return Err("login_request_expired");
                    }
                    let receipt = fs::read(root.join("login-completion.json"))
                        .ok()
                        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
                    let matched = receipt.as_ref().filter(|r| {
                        r["request"] == current.login_request
                            && r["instance_id"] == current.instance_id
                            && r["revision"] == current.revision
                    });
                    return Ok(json!({"session":null,"capability":current.capability,
                        "completed":matched.is_some_and(|r| r["completed"] == true),
                        "failure":matched.and_then(|r| r["failure"].as_str())}));
                }
                "read" | "refresh" => {}
                "replace" => {
                    let config = request.config.ok_or("invalid_project_config")?;
                    let session = request.session.ok_or("invalid_session")?;
                    validate(&config, &session)?;
                    let mut next = current.clone();
                    next.config = config;
                    next.session = session;
                    next.revision += 1;
                    bridge::write_json(&path(root, &request.instance_id), &next)?;
                    grant = Some(next);
                }
                "clear" => {
                    // Keep linkage so a later browser login can update the SAME route.
                    let mut next = current.clone();
                    next.session = Value::Null;
                    next.revision += 1;
                    bridge::write_json(&path(root, &request.instance_id), &next)?;
                    return Ok(json!({"session": null, "capability": next.capability}));
                }
                _ => return Err("invalid_auth_action"),
            }
        }
        let next = grant.ok_or("not_linked")?;
        let next = if next.session.is_null() {
            next
        } else {
            ensure_fresh(root, next)?
        };
        Ok(json!({"session":next.session,"config":next.config,"capability":next.capability}))
    })
}
/// Desktop never exposes refresh tokens or bridge capabilities to its WebView.
pub fn desktop(root: &Path, route: &str) -> Result<Value, &'static str> {
    locked(root, || {
        let mut grants = Vec::new();
        for entry in fs::read_dir(root.join("accounts"))
            .map_err(|_| "auth_store_unavailable")?
            .flatten()
        {
            if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let grant: Grant = serde_json::from_slice(
                &fs::read(entry.path()).map_err(|_| "auth_store_unavailable")?,
            )
            .map_err(|_| "auth_store_corrupt")?;
            if grant.route_id == route {
                grants.push(grant);
            }
        }
        // A route has a single account owner; never choose among duplicate identities.
        if grants.len() > 1 {
            return Err("ambiguous_account");
        }
        let Some(grant) = grants.pop() else {
            return Ok(Value::Null);
        };
        if grant.session.is_null() {
            return Ok(Value::Null);
        }
        let grant = ensure_fresh(root, grant)?;
        Ok(
            json!({"login_request":grant.login_request, "config": grant.config, "session": {"access_token": grant.session["access_token"], "expires_at":grant.session["expires_at"], "user":grant.session["user"]}, "instance_id":grant.instance_id,"revision":grant.revision}),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn grant() -> Grant {
        Grant {
            instance_id: "a".repeat(64),
            origin: format!("chrome-extension://{}/", "b".repeat(32)),
            route_id: "c".repeat(64),
            capability: "d".repeat(64),
            login_request: "e".repeat(64),
            config: Config {
                url: "https://example.supabase.co".into(),
                publishable_key: "fixture-key".into(),
            },
            session: json!({"access_token":"fixture-access","refresh_token":"fixture-refresh","expires_at":bridge::now()+3600,"user":{"id":"user-A"}}),
            revision: 1,
        }
    }
    #[test]
    fn desktop_receives_access_only_and_stays_bound_to_its_route() {
        let root = tempfile::tempdir().unwrap();
        let grant = grant();
        bridge::write_json(&path(root.path(), &grant.instance_id), &grant).unwrap();
        let result = desktop(root.path(), &grant.route_id).unwrap();
        assert_eq!(result["session"]["user"]["id"], "user-A");
        assert!(result["session"].get("refresh_token").is_none());
        assert!(result.get("capability").is_none());
        assert!(desktop(root.path(), &"f".repeat(64)).unwrap().is_null());
    }
    #[test]
    fn logout_retains_pairing_but_not_session_after_restart() {
        let root = tempfile::tempdir().unwrap();
        let grant = grant();
        bridge::write_json(&path(root.path(), &grant.instance_id), &grant).unwrap();
        let request = serde_json::from_value(json!({"version":1,"type":"auth","action":"clear","instance_id":grant.instance_id,"capability":grant.capability})).unwrap();
        dispatch(root.path(), &grant.origin, request).unwrap();
        assert!(desktop(root.path(), &grant.route_id).unwrap().is_null());
        assert!(load(root.path(), &grant.instance_id)
            .unwrap()
            .unwrap()
            .session
            .is_null());
    }
    #[test]
    fn duplicate_route_fails_instead_of_picking_an_account() {
        let root = tempfile::tempdir().unwrap();
        let mut grant = grant();
        bridge::write_json(&path(root.path(), &grant.instance_id), &grant).unwrap();
        grant.instance_id = "f".repeat(64);
        bridge::write_json(&path(root.path(), &grant.instance_id), &grant).unwrap();
        assert_eq!(
            desktop(root.path(), &grant.route_id).unwrap_err(),
            "ambiguous_account"
        );
    }
    #[test]
    fn missing_expired_or_wrong_origin_requests_cannot_import_credentials() {
        let root = tempfile::tempdir().unwrap();
        let grant = grant();
        let request = || {
            serde_json::from_value(json!({"version":1,"type":"auth","action":"bootstrap","instance_id":grant.instance_id,"login_request":grant.login_request,"route_id":grant.route_id,"config":grant.config,"session":grant.session})).unwrap()
        };
        assert_eq!(
            dispatch(root.path(), &grant.origin, request()).unwrap_err(),
            "login_request_missing"
        );
        bridge::write_json(
            &root.path().join("login-request.json"),
            &LoginRequest {
                id: grant.login_request.clone(),
                route_id: grant.route_id.clone(),
                origin: grant.origin.clone(),
                expires_at: 0,
            },
        )
        .unwrap();
        assert_eq!(
            dispatch(root.path(), &grant.origin, request()).unwrap_err(),
            "login_request_expired"
        );
        bridge::write_json(
            &root.path().join("login-request.json"),
            &LoginRequest {
                id: grant.login_request.clone(),
                route_id: grant.route_id.clone(),
                origin: grant.origin.clone(),
                expires_at: bridge::now() + 900,
            },
        )
        .unwrap();
        assert_eq!(
            dispatch(
                root.path(),
                &format!("chrome-extension://{}/", "f".repeat(32)),
                request()
            )
            .unwrap_err(),
            "login_request_expired"
        );
        assert!(load(root.path(), &grant.instance_id).unwrap().is_none());
    }
}
