use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use enigo::{Enigo, Mouse, Settings};

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
    match Enigo::new(&Settings::default()) {
        Ok(enigo) => match enigo.location() {
            Ok((x, y)) => (x, y),
            Err(e) => {
                log::warn!("Failed to get cursor position via enigo: {:?}, using (0,0)", e);
                (0, 0)
            }
        },
        Err(e) => {
            log::warn!("Failed to create enigo for cursor position: {:?}, using (0,0)", e);
            (0, 0)
        }
    }
}

// ---- window toggle ----

pub fn toggle_window(app: &AppHandle) {
    if TOGGLING.swap(true, Ordering::SeqCst) {
        log::info!("[toggle_window] skipped (re-entrant)");
        return;
    }
    let _guard = ToggleGuard;

    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        log::info!("[toggle_window] visible={}", visible);

        if visible {
            log::info!("[toggle_window] hiding window");
            let _ = window.hide();
        } else {
            log::info!("[toggle_window] showing window");
            let _ = window.show();
            let _ = window.set_focus();
        }
    } else {
        log::warn!("[toggle_window] main window not found");
    }
}

// ---- radial menu ----

pub fn show_radial_menu(app: &AppHandle) {
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

pub fn install_mouse_hook(app: &AppHandle) {
    // Linux: global mouse hooks are not available.
    // The radial menu is accessible via keyboard shortcuts.
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

// ---- shortcut key accessors ----

pub fn get_main_shortcut_key() -> String {
    MAIN_SHORTCUT_KEY.lock().unwrap().clone()
}

pub fn get_radial_shortcut_key() -> String {
    RADIAL_SHORTCUT_KEY.lock().unwrap().clone()
}

pub fn is_main_shortcut(s: &str) -> bool {
    let key = MAIN_SHORTCUT_KEY.lock().unwrap();
    !key.is_empty() && *key == s
}

pub fn is_radial_shortcut(s: &str) -> bool {
    let key = RADIAL_SHORTCUT_KEY.lock().unwrap();
    !key.is_empty() && *key == s
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
