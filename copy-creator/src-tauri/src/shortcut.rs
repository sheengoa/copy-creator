use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_global_shortcut::Shortcut as GsShortcut;
use enigo::{Enigo, Mouse, Settings};
use std::process::Command;
use std::str::FromStr;

/// Detect whether we are running under Wayland.
fn is_wayland() -> bool {
    std::env::var("WAYLAND_DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

static RADIAL_MENU_ENABLED: AtomicBool = AtomicBool::new(true);

static TOGGLING: AtomicBool = AtomicBool::new(false);

pub static MAIN_SHORTCUT_KEY: Mutex<String> = Mutex::new(String::new());
pub static RADIAL_SHORTCUT_KEY: Mutex<String> = Mutex::new(String::new());

/// RAII guard that ensures TOGGLING is always reset, even on panic.
struct ToggleGuard;

impl Drop for ToggleGuard {
    fn drop(&mut self) {
        TOGGLING.store(false, Ordering::SeqCst);
    }
}

// ---- cursor position ----

pub fn get_cursor_position() -> (i32, i32) {
    // Try enigo first (works on X11 / XWayland)
    match Enigo::new(&Settings::default()) {
        Ok(enigo) => match enigo.location() {
            Ok((x, y)) => return (x, y),
            Err(e) => log::warn!("enigo location() failed: {:?}", e),
        },
        Err(e) => log::warn!("enigo init failed: {:?}", e),
    }

    // CLI fallback for X11 (xdotool)
    if !is_wayland() {
        if let Ok(out) = Command::new("xdotool")
            .args(["getmouselocation", "--shell"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            let mut x: i32 = 0;
            let mut y: i32 = 0;
            for line in s.lines() {
                if let Some(val) = line.strip_prefix("x=") {
                    x = val.parse().unwrap_or(0);
                } else if let Some(val) = line.strip_prefix("y=") {
                    y = val.parse().unwrap_or(0);
                }
            }
            if x != 0 || y != 0 {
                return (x, y);
            }
        }
    }

    log::warn!("Failed to get cursor position, using (0,0)");
    (0, 0)
}

// ---- window toggle ----

pub fn toggle_window(app: &AppHandle) {
    if TOGGLING.swap(true, Ordering::SeqCst) {
        log::info!("[toggle_window] skipped (re-entrant)");
        return;
    }
    let _guard = ToggleGuard;

    crate::paste::remember_paste_target();

    let window = match app.get_webview_window("main") {
        Some(w) => w,
        None => {
            log::warn!("[toggle_window] main window not found");
            return;
        }
    };

    log::info!("[toggle_window] showing + focusing window");
    let was_pinned = window.is_always_on_top().unwrap_or(false);
    let _ = window.set_always_on_top(true);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();

    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        if let Some(w) = handle.get_webview_window("main") {
            if !TOGGLING.load(Ordering::SeqCst) {
                let _ = w.set_always_on_top(was_pinned);
            }
            let _ = w.set_focus();
        }
    });
}

// ---- radial menu ----

pub fn show_radial_menu(app: &AppHandle) {
    crate::paste::remember_paste_target();

    if let Some(radial) = app.get_webview_window("radial-menu") {
        if radial.is_visible().unwrap_or(false) {
            log::info!("[show_radial_menu] already visible, hiding");
            let _ = radial.hide();
            return;
        }

        let (cursor_x, cursor_y) = get_cursor_position();

        // Position window centered near cursor (window is 300x420)
        let px = cursor_x.saturating_sub(150);
        let py = cursor_y.saturating_sub(20);
        let _ = radial.set_position(tauri::PhysicalPosition::new(px.max(0), py.max(0)));

        // Read theme from DB
        let theme = crate::db::get_setting_sync(app, "theme")
            .unwrap_or_else(|| "light".to_string());

        let _ = radial.show();
        let _ = radial.set_focus();

        let _ = app.emit("radial-menu-show", serde_json::json!({
            "theme": theme
        }));

        log::info!("[show_radial_menu] shown at ({}, {}) theme={}", px, py, theme);
    }
}

/// Restore the radial-menu enabled flag from the database and log the
/// platform capabilities.  Linux does not have global mouse hooks, so
/// the radial menu is driven exclusively by the keyboard shortcut.
pub fn init_radial_menu_state(app: &AppHandle) {
    if let Ok(val) = crate::db::get_setting(app.clone(), "radial_menu_enabled".to_string()) {
        RADIAL_MENU_ENABLED.store(val == "1", Ordering::SeqCst);
    }
    log::info!("Mouse hook not available on Linux; radial menu accessible via keyboard shortcuts only");
}

// ---- shortcut registration ----

pub fn register_keyboard_shortcut(
    app: &AppHandle,
    shortcut: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if shortcut.is_empty() {
        return Ok(());
    }
    app.global_shortcut().register(shortcut)?;
    Ok(())
}

pub fn unregister_keyboard_shortcut(
    app: &AppHandle,
    shortcut: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if shortcut.is_empty() {
        return Ok(());
    }
    let _ = app.global_shortcut().unregister(shortcut);
    Ok(())
}

// ---- shortcut matching ----

/// Normalise a shortcut string into the canonical form returned by the
/// global-hotkey crate so that user-facing display strings (e.g. `Ctrl+Shift+A`)
/// can be compared with the strings emitted in shortcut events
/// (e.g. `control+shift+KeyA`).
fn normalize_shortcut(raw: &str) -> Option<String> {
    GsShortcut::from_str(raw).ok().map(|s| s.into_string())
}

pub fn is_main_shortcut(s: &str) -> bool {
    let key = MAIN_SHORTCUT_KEY.lock().unwrap();
    if key.is_empty() {
        return false;
    }
    normalize_shortcut(&key).as_deref() == normalize_shortcut(s).as_deref()
}

pub fn is_radial_shortcut(s: &str) -> bool {
    let key = RADIAL_SHORTCUT_KEY.lock().unwrap();
    if key.is_empty() {
        return false;
    }
    normalize_shortcut(&key).as_deref() == normalize_shortcut(s).as_deref()
}

#[tauri::command]
pub fn update_shortcut(
    app: AppHandle,
    old_shortcut: String,
    new_shortcut: String,
) -> Result<(), String> {
    if !old_shortcut.is_empty() {
        let _ = unregister_keyboard_shortcut(&app, &old_shortcut);
    }
    if !new_shortcut.is_empty() {
        register_keyboard_shortcut(&app, &new_shortcut)
            .map_err(|e| format!("Failed to register shortcut: {}", e))?;
    }
    *MAIN_SHORTCUT_KEY.lock().unwrap() = new_shortcut;
    Ok(())
}

#[tauri::command]
pub fn update_radial_shortcut(
    app: AppHandle,
    old_shortcut: String,
    new_shortcut: String,
) -> Result<(), String> {
    if !old_shortcut.is_empty() {
        let _ = unregister_keyboard_shortcut(&app, &old_shortcut);
    }
    if !new_shortcut.is_empty() {
        register_keyboard_shortcut(&app, &new_shortcut)
            .map_err(|e| format!("Failed to register radial shortcut: {}", e))?;
    }
    *RADIAL_SHORTCUT_KEY.lock().unwrap() = new_shortcut;
    Ok(())
}

#[tauri::command]
pub fn set_radial_menu_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    RADIAL_MENU_ENABLED.store(enabled, Ordering::SeqCst);
    let state = app.state::<crate::db::DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('radial_menu_enabled', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
        rusqlite::params![if enabled { "1" } else { "0" }],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
