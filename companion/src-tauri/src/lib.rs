#[cfg(target_os = "windows")]
use std::ffi::OsString;
use std::{env, fs, path::PathBuf, process::Command};
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_positioner::{Position, WindowExt};
#[cfg(not(target_os = "windows"))]
use tauri::menu::{Menu, MenuItem};

const WINDOW_LABEL: &str = "main";
static CONNECTION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

mod chrome;
mod connection;
use chrome::valid_extension_id;

fn chrome_profiles() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    return env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join("Library/Application Support/Google/Chrome"));

    #[cfg(target_os = "windows")]
    return windows_chrome_profiles(env::var_os("LOCALAPPDATA"));

    #[cfg(target_os = "linux")]
    return env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join(".config/google-chrome"));
}

fn inspect_connection() -> Result<connection::Connection, String> {
    connection::inspect(
        &chrome_profiles().ok_or("无法找到 Chrome Profile 目录")?,
        &windowstash_native_host::bridge::directory().map_err(str::to_string)?,
        &connection::helper()?,
    )
}

fn chrome_connection() -> Result<connection::Connection, String> {
    let _guard = CONNECTION_LOCK
        .lock()
        .map_err(|_| "Chrome 关联暂时不可用")?;
    inspect_connection()
}

#[tauri::command]
fn discover_chrome_targets() -> Result<connection::Connection, String> {
    chrome_connection()
}

#[tauri::command]
fn select_chrome_target(
    profile: String,
    extension_id: String,
) -> Result<connection::Connection, String> {
    let _guard = CONNECTION_LOCK
        .lock()
        .map_err(|_| "Chrome 关联暂时不可用")?;
    let targets = chrome::discover(&chrome_profiles().ok_or("无法找到 Chrome Profile 目录")?)?;
    connection::choose(
        &windowstash_native_host::bridge::directory().map_err(str::to_string)?,
        &targets,
        chrome::Target {
            profile,
            extension_id,
        },
    )?;
    inspect_connection()
}

#[tauri::command]
async fn desktop_auth() -> Result<serde_json::Value, String> {
    read_desktop_auth(false).await
}
#[tauri::command]
async fn desktop_cloud_auth() -> Result<serde_json::Value, String> {
    read_desktop_auth(true).await
}
async fn read_desktop_auth(cloud: bool) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = windowstash_native_host::bridge::directory().map_err(str::to_string)?;
        let bytes = match fs::read(root.join("selection.json")) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(serde_json::Value::Null)
            }
            Err(_) => return Err("无法读取浏览器关联，请重试".into()),
        };
        let selected: connection::Selection =
            serde_json::from_slice(&bytes).map_err(|_| "浏览器关联损坏，请重新选择")?;
        (if cloud { windowstash_native_host::auth::desktop(&root, &selected.route_id) }
        else { windowstash_native_host::auth::desktop_local(&root, &selected.route_id) }).map_err(|code| match code
        {
            "network_unavailable" => "暂时无法连接云端，请检查网络后重试".into(),
            "session_refresh_failed" => "云端认证暂时不可用，本机授权和数据已保留".into(),
            "authorization_revoked" => "账号授权已被撤销，请重新登录".into(),
            _ => "无法读取登录状态，请重试".into(),
        })
    })
    .await
    .map_err(|_| "登录查询失败，请重试".to_string())?
}

#[tauri::command]
async fn local_workspaces() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let root = windowstash_native_host::bridge::directory().map_err(str::to_string)?;
        let bytes = match fs::read(root.join("selection.json")) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::Value::Null),
            Err(_) => return Err("无法读取浏览器关联，请重试".into()),
        };
        let selected: connection::Selection = serde_json::from_slice(&bytes).map_err(|_| "浏览器关联损坏，请重新选择".to_string())?;
        windowstash_native_host::workspaces::desktop(&root, &selected.route_id).map_err(|_| "无法读取本机工作区，已有缓存已保留".to_string())
    }).await.map_err(|_| "本机工作区查询失败".to_string())?
}

#[tauri::command]
async fn export_diagnostics(app: tauri::AppHandle, bundle: serde_json::Value) -> Result<String, String> {
    if bundle["schema"] != "windowstash.diagnostics/1" || !bundle["events"].is_array() { return Err("invalid_diagnostic_bundle".into()); }
    let bytes = serde_json::to_vec_pretty(&bundle).map_err(|_| "invalid_diagnostic_bundle")?;
    if bytes.len() > 20*1024*1024 { return Err("diagnostic_bundle_too_large".into()); }
    let directory = app.path().download_dir().map_err(|_| "downloads_unavailable")?;
    let name = format!("windowstash-diagnostics-{}-{}.json", windowstash_native_host::bridge::now(), &windowstash_native_host::bridge::random_id()[..8]);
    let path = directory.join(name);
    use std::io::Write;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_| "diagnostic_export_failed")?;
    file.write_all(&bytes).map_err(|_| "diagnostic_export_failed")?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn diagnostic_records(instance: String, project: String, user: String, entries: Vec<serde_json::Value>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = windowstash_native_host::bridge::directory().map_err(str::to_string)?;
        let bytes = fs::read(root.join("selection.json")).map_err(|_| "浏览器关联不可用".to_string())?;
        let selected: connection::Selection = serde_json::from_slice(&bytes).map_err(|_| "浏览器关联不可用".to_string())?;
        windowstash_native_host::workspaces::desktop_diagnostics(&root, &selected.route_id, &instance, &project, &user, entries).map_err(str::to_string)
    }).await.map_err(|_| "diagnostic_worker_failed".to_string())?
}

#[tauri::command]
async fn open_diagnostics(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("diagnostics") { let _ = window.show(); let _ = window.set_focus(); return; }
    let _ = tauri::WebviewWindowBuilder::new(&app, "diagnostics", tauri::WebviewUrl::App("index.html#diagnostics".into()))
        .title("诊断中心 · WindowStash").inner_size(1120.0, 820.0).min_inner_size(640.0, 500.0).build();
}

#[tauri::command]
fn hide_tray_menu(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("tray-menu") { let _ = window.hide(); }
}

#[cfg(target_os = "windows")]
fn display_tray_menu(app: &tauri::AppHandle) {
    let window = app.get_webview_window("tray-menu").or_else(|| {
        tauri::WebviewWindowBuilder::new(app, "tray-menu", tauri::WebviewUrl::App("index.html#tray-menu".into()))
            .title("WindowStash").inner_size(172.0, 94.0).decorations(false).transparent(true)
            .resizable(false).always_on_top(true).skip_taskbar(true).visible(false).build().ok()
    });
    if let Some(window) = window {
        let _ = window.move_window(Position::TrayCenter);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
async fn workspace_sync(instance: String, project: String, user: String, action: String, payload: serde_json::Value) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = windowstash_native_host::bridge::directory().map_err(str::to_string)?;
        let bytes = fs::read(root.join("selection.json")).map_err(|_| "浏览器关联不可用".to_string())?;
        let selected: connection::Selection = serde_json::from_slice(&bytes).map_err(|_| "浏览器关联不可用".to_string())?;
        windowstash_native_host::workspaces::desktop_sync(&root, &selected.route_id, &instance, &project, &user, &action, payload).map_err(str::to_string)
    }).await.map_err(|_| "本机同步通道不可用".to_string())?
}

#[tauri::command]
async fn confirm_browser_login(
    instance_id: String,
    revision: u64,
    request: String,
    completed: bool,
) -> Result<(), String> {
    let current = desktop_auth().await?;
    if current["instance_id"] != instance_id
        || current["revision"] != revision
        || current["login_request"] != request
    {
        return Err("账号已变化，请重新确认登录".into());
    }
    let root = windowstash_native_host::bridge::directory().map_err(str::to_string)?;
    windowstash_native_host::bridge::write_json(
        &root.join("login-completion.json"),
        &serde_json::json!({
            "instance_id":instance_id,"revision":revision,"request":request,"completed":completed,
            "failure":if completed { None } else { Some("workspace_unavailable") }
        }),
    )
    .map_err(str::to_string)?;
    Ok(())
}

#[tauri::command]
fn begin_browser_login() -> Result<(), String> {
    let status = chrome_connection()?;
    if let Some(error) = status.host_error {
        return Err(error);
    }
    let selected = status.selected.ok_or("请选择用于登录的 Chrome 用户")?;
    let root = windowstash_native_host::bridge::directory().map_err(str::to_string)?;
    let request = windowstash_native_host::auth::LoginRequest {
        id: windowstash_native_host::bridge::random_id(),
        route_id: selected.route_id,
        origin: format!("chrome-extension://{}/", selected.target.extension_id),
        expires_at: windowstash_native_host::bridge::now() + 900,
    };
    windowstash_native_host::bridge::write_json(&root.join("login-request.json"), &request)
        .map_err(str::to_string)?;
    launch_options(
        &selected.target,
        &format!(
            "?companionLogin={}&companionRoute={}",
            request.id, request.route_id
        ),
    )
}

fn spawn_browser(mut command: Command) -> Result<std::process::Child, String> {
    command
        .spawn()
        .map_err(|_| "无法打开 Chrome，请确认已安装".into())
}

fn launch_options(target: &chrome::Target, query: &str) -> Result<(), String> {
    let url = format!(
        "chrome-extension://{}/{}{}",
        target.extension_id,
        if query.contains("companionLogin=") {
            "authorize.html"
        } else {
            "options.html"
        },
        query
    );
    let profile = format!("--profile-directory={}", target.profile);
    #[cfg(target_os = "macos")]
    let command = {
        let mut command = Command::new("open");
        command.args(["-na", "Google Chrome", "--args", &profile, &url]);
        command
    };
    #[cfg(target_os = "windows")]
    let command = windows_chrome(&[&profile, &url]);
    #[cfg(target_os = "linux")]
    let command = {
        let mut command = Command::new("google-chrome");
        command.args([&profile, &url]);
        command
    };
    spawn_browser(command).map(|_| ())
}

#[cfg(target_os = "windows")]
fn windows_chrome_profiles(local_app_data: Option<OsString>) -> Option<PathBuf> {
    local_app_data
        .map(PathBuf::from)
        .map(|path| path.join("Google/Chrome/User Data"))
}

#[cfg(target_os = "windows")]
fn windows_chrome_install_paths(mut get_var: impl FnMut(&str) -> Option<OsString>) -> Vec<PathBuf> {
    ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]
        .into_iter()
        .filter_map(|name| get_var(name))
        .map(PathBuf::from)
        .map(|path| path.join("Google/Chrome/Application/chrome.exe"))
        .collect()
}

#[cfg(target_os = "windows")]
fn windows_chrome_command(arguments: &[&str], executable: Option<PathBuf>) -> Command {
    if let Some(executable) = executable {
        let mut command = Command::new(executable);
        command.args(arguments);
        command
    } else {
        let mut command = Command::new("chrome");
        command.args(arguments);
        command
    }
}

#[cfg(target_os = "windows")]
fn windows_chrome(arguments: &[&str]) -> Command {
    let executable = windows_chrome_install_paths(|name| env::var_os(name))
        .into_iter()
        .find(|path| path.is_file());
    windows_chrome_command(arguments, executable)
}

#[tauri::command]
fn open_chrome_page(
    extension_id: String,
    profile: String,
    page: String,
    workspace_id: Option<String>,
) -> Result<(), String> {
    let _guard = CONNECTION_LOCK
        .lock()
        .map_err(|_| "Chrome 关联暂时不可用")?;
    if !valid_extension_id(&extension_id) {
        return Err("Invalid extension ID".into());
    }
    let path = match page.as_str() {
        "options" => "options.html".to_string(),
        "launcher" => {
            let id = workspace_id
                .filter(|value| {
                    !value.is_empty()
                        && value.len() <= 128
                        && value
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                })
                .ok_or("Invalid workspace ID")?;
            format!("launcher.html?workspaceId={id}")
        }
        _ => return Err("Unsupported Chrome page".into()),
    };
    let status = inspect_connection()?;
    let selected = status.selected.ok_or_else(|| {
        status
            .error
            .unwrap_or_else(|| "请选择 Chrome Profile".into())
    })?;
    let target = selected.target;
    if target.extension_id != extension_id || target.profile != profile {
        return Err("Chrome 关联已变化，请重新选择后重试".into());
    }
    let profile_argument = format!("--profile-directory={}", target.profile);
    let route_query = if page == "options" {
        format!("?companionRoute={}", selected.route_id)
    } else {
        String::new()
    };
    let url = format!("chrome-extension://{extension_id}/{path}{route_query}");

    #[cfg(target_os = "macos")]
    let result = Command::new("/usr/bin/open")
        .args([
            "-n",
            "-a",
            "Google Chrome",
            "--args",
            &profile_argument,
            &url,
        ])
        .spawn();
    #[cfg(target_os = "windows")]
    let result = windows_chrome(&[&profile_argument, &url]).spawn();
    #[cfg(target_os = "linux")]
    let result = Command::new("google-chrome")
        .args([&profile_argument, &url])
        .spawn();

    result.map(|_| ()).map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_popover(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
    }
}

#[tauri::command]
fn show_popover(app: tauri::AppHandle) {
    display_popover(&app);
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn tray_icon() -> Image<'static> {
    let mut rgba = vec![0_u8; 18 * 18 * 4];
    let mut pixel = |x: usize, y: usize| {
        let offset = (y * 18 + x) * 4;
        rgba[offset..offset + 4].copy_from_slice(&[255, 255, 255, 255]);
    };
    for x in 3..15 {
        pixel(x, 4);
        pixel(x, 13);
    }
    for y in 4..14 {
        pixel(3, y);
        pixel(14, y);
    }
    for x in 6..13 {
        pixel(x, 7);
        pixel(x, 10);
    }
    for y in 7..11 {
        pixel(6, y);
        pixel(12, y);
    }
    Image::new_owned(rgba, 18, 18)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            discover_chrome_targets,
            select_chrome_target,
            open_chrome_page,
            begin_browser_login,
            confirm_browser_login,
            desktop_auth,
            desktop_cloud_auth,
            local_workspaces,
            workspace_sync,
            diagnostic_records,
            export_diagnostics,
            open_diagnostics,
            hide_tray_menu,
            hide_popover,
            show_popover,
            quit_app
        ])
        .setup(|app| {
            // Register the bundled helper at user level; credentials are never accepted.
            let host_error = match chrome_connection() {
                Ok(connection) => connection.host_error,
                Err(error) => Some(error),
            };
            if let Some(error) = &host_error {
                eprintln!("Native Host registration failed: {error}");
            }
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                app.set_dock_visibility(false);
            }

            if let Ok(directory) = app.path().app_config_dir() {
                let marker = directory.join("autostart-initialized");
                if !marker.exists()
                    && (app.autolaunch().is_enabled().unwrap_or(false)
                        || app.autolaunch().enable().is_ok())
                {
                    let _ = fs::create_dir_all(directory);
                    let _ = fs::write(marker, []);
                }
            }

            #[cfg(not(target_os = "windows"))]
            let menu = Menu::with_items(app, &[
                &MenuItem::with_id(app, "open", "打开 WindowStash", true, None::<&str>)?,
                &MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
            ])?;
            #[cfg(target_os = "windows")]
            let icon: Image<'static> =
                Image::from_app_icon_resource(32).unwrap_or_else(|_| tray_icon());
            #[cfg(not(target_os = "windows"))]
            let icon = tray_icon();

            let tray = TrayIconBuilder::with_id("windowstash").icon(icon);
            #[cfg(target_os = "macos")]
            let tray = tray.icon_as_template(true);

            #[cfg(not(target_os = "windows"))]
            let tray = tray.menu(&menu);
            tray
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => display_popover(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
                    #[cfg(target_os = "windows")]
                    if let TrayIconEvent::Click { button: MouseButton::Right, button_state: MouseButtonState::Up, .. } = event {
                        // WebView2 window creation must run outside synchronous event handlers.
                        let app = tray.app_handle().clone();
                        std::thread::spawn(move || display_tray_menu(&app));
                        return;
                    }
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                display_popover(app);
                            }
                        }
                    }
                })
                .build(app)?;
            if host_error.is_some() {
                display_popover(app.handle());
            }
            // Native timers keep working when macOS suspends the hidden WebView.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(10));
                let error = match chrome_connection() {
                    Ok(connection) => connection.host_error,
                    Err(error) => Some(error),
                };
                let _ = handle.emit("native-host-status", error);
            });
            // Local revision notifications do not depend on Chrome, Supabase or WebView timers.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let Ok(root) = windowstash_native_host::bridge::directory() else { return; };
                let path = root.join("workspace-library/change.json");
                let mut previous = None;
                let mut observed_at = windowstash_native_host::bridge::now();
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let now = windowstash_native_host::bridge::now();
                    if now.saturating_sub(observed_at) > 30 { let _ = handle.emit("system-resumed", ()); }
                    observed_at = now;
                    let current = fs::read(&path).ok();
                    if current != previous {
                        previous = current;
                        let _ = handle.emit("local-workspaces-changed", ());
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != WINDOW_LABEL && window.label() != "tray-menu" { return; }
            match event {
            tauri::WindowEvent::Focused(false) => {
                let _ = window.hide();
            }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            _ => {}
        }})
        .run(tauri::generate_context!())
        .expect("failed to run WindowStash Companion");
}

fn display_popover(app: &tauri::AppHandle) {
    if let Some(menu) = app.get_webview_window("tray-menu") { let _ = menu.hide(); }
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.move_window(Position::TrayCenter);
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("popover-opened", ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_launch_returns_while_the_child_is_still_running() {
        #[cfg(target_os = "windows")]
        let command = {
            use std::os::windows::process::CommandExt;
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]);
            command.creation_flags(0x08000000);
            command
        };
        #[cfg(not(target_os = "windows"))]
        let command = {
            let mut command = Command::new("sleep");
            command.arg("30");
            command
        };
        let mut child = spawn_browser(command).unwrap();
        let running = child.try_wait().unwrap().is_none();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(running);
    }

    #[test]
    fn browser_launch_failure_is_reported() {
        assert!(spawn_browser(Command::new("windowstash-missing-browser-fixture")).is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolves_windows_chrome_profile_path() {
        assert_eq!(
            windows_chrome_profiles(Some(OsString::from(r"C:\Users\test\AppData\Local"))),
            Some(PathBuf::from(
                r"C:\Users\test\AppData\Local\Google\Chrome\User Data"
            ))
        );
        assert_eq!(windows_chrome_profiles(None), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn checks_standard_windows_chrome_install_paths_in_order() {
        let paths = windows_chrome_install_paths(|name| match name {
            "PROGRAMFILES" => Some(OsString::from(r"C:\Program Files")),
            "PROGRAMFILES(X86)" => Some(OsString::from(r"C:\Program Files (x86)")),
            "LOCALAPPDATA" => Some(OsString::from(r"C:\Users\test\AppData\Local")),
            _ => None,
        });

        assert_eq!(
            paths,
            [
                r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                r"C:\Users\test\AppData\Local\Google\Chrome\Application\chrome.exe",
            ]
            .map(PathBuf::from)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn launches_chrome_directly_when_found() {
        let executable = PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe");
        let command = windows_chrome_command(
            &[
                "--profile-directory=Profile 1",
                "chrome-extension://example/options.html",
            ],
            Some(executable.clone()),
        );

        assert_eq!(command.get_program(), executable.as_os_str());
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "--profile-directory=Profile 1",
                "chrome-extension://example/options.html"
            ]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn falls_back_to_chrome_on_path_when_standard_install_is_not_found() {
        let command = windows_chrome_command(
            &[
                "--profile-directory=Default",
                "chrome-extension://example/options.html",
            ],
            None,
        );

        assert_eq!(command.get_program(), "chrome");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "--profile-directory=Default",
                "chrome-extension://example/options.html"
            ]
        );
    }
}
