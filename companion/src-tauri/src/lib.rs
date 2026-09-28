use std::{env, fs, path::PathBuf, process::Command};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_positioner::{Position, WindowExt};

const WINDOW_LABEL: &str = "main";

fn valid_extension_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

fn chrome_profiles() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    return env::var_os("HOME").map(PathBuf::from).map(|path| {
        path.join("Library/Application Support/Google/Chrome")
    });

    #[cfg(target_os = "windows")]
    return env::var_os("LOCALAPPDATA").map(PathBuf::from).map(|path| {
        path.join("Google/Chrome/User Data")
    });

    #[cfg(target_os = "linux")]
    return env::var_os("HOME").map(PathBuf::from).map(|path| {
        path.join(".config/google-chrome")
    });
}

#[tauri::command]
fn discover_extension_id() -> Option<String> {
    let profiles = fs::read_dir(chrome_profiles()?).ok()?;
    for profile in profiles.flatten() {
        let name = profile.file_name();
        let name = name.to_string_lossy();
        if name != "Default" && !name.starts_with("Profile ") {
            continue;
        }
        for preferences in ["Preferences", "Secure Preferences"] {
            let value: serde_json::Value = fs::read_to_string(profile.path().join(preferences))
                .ok()
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or_default();
            if let Some(settings) = value.pointer("/extensions/settings").and_then(|value| value.as_object()) {
                for (id, setting) in settings {
                    let path = setting.get("path").and_then(|value| value.as_str());
                    if valid_extension_id(id) && path.is_some_and(|path| is_windowstash_manifest(PathBuf::from(path).join("manifest.json"))) {
                        return Some(id.clone());
                    }
                }
            }
        }
        let extensions = match fs::read_dir(profile.path().join("Extensions")) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for extension in extensions.flatten() {
            let id = extension.file_name().to_string_lossy().into_owned();
            if !valid_extension_id(&id) {
                continue;
            }
            let versions = match fs::read_dir(extension.path()) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for version in versions.flatten() {
                if is_windowstash_manifest(version.path().join("manifest.json")) {
                    return Some(id);
                }
            }
        }
    }
    None
}

fn is_windowstash_manifest(path: PathBuf) -> bool {
    let manifest: serde_json::Value = fs::read_to_string(path)
        .ok()
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default();
    manifest.get("name").and_then(|value| value.as_str()) == Some("WindowStash")
        || manifest.pointer("/action/default_title").and_then(|value| value.as_str()) == Some("WindowStash")
}

#[tauri::command]
fn open_chrome_page(
    extension_id: String,
    page: String,
    workspace_id: Option<String>,
) -> Result<(), String> {
    if !valid_extension_id(&extension_id) {
        return Err("Invalid extension ID".into());
    }
    let path = match page.as_str() {
        "options" => "options.html".to_string(),
        "launcher" => {
            let id = workspace_id.filter(|value| {
                !value.is_empty()
                    && value.len() <= 128
                    && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            }).ok_or("Invalid workspace ID")?;
            format!("launcher.html?workspaceId={id}")
        }
        _ => return Err("Unsupported Chrome page".into()),
    };
    let url = format!("chrome-extension://{extension_id}/{path}");

    #[cfg(target_os = "macos")]
    let result = Command::new("/usr/bin/open").args(["-a", "Google Chrome", &url]).spawn();
    #[cfg(target_os = "windows")]
    let result = Command::new("cmd").args(["/C", "start", "", "chrome", &url]).spawn();
    #[cfg(target_os = "linux")]
    let result = Command::new("google-chrome").arg(&url).spawn();

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
            discover_extension_id,
            open_chrome_page,
            hide_popover,
            show_popover,
            quit_app
        ])
        .setup(|app| {
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

            let open = MenuItem::with_id(app, "open", "打开 WindowStash", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::with_id("windowstash")
                .icon(tray_icon())
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => display_popover(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
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
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Focused(false) => { let _ = window.hide(); }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("failed to run WindowStash Companion");
}

fn display_popover(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.move_window(Position::TrayCenter);
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("popover-opened", ());
    }
}
