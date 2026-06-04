use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

static RADIAL_MENU_ENABLED: AtomicBool = AtomicBool::new(true);

static TOGGLING: AtomicBool = AtomicBool::new(false);

/// RAII guard that ensures TOGGLING is always reset, even on panic.
struct ToggleGuard;

impl Drop for ToggleGuard {
    fn drop(&mut self) {
        TOGGLING.store(false, Ordering::SeqCst);
    }
}

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

pub fn install_mouse_hook(app: &AppHandle) {
    // Linux: global mouse hooks are not available.
    // The radial menu is accessible via keyboard shortcuts (Ctrl+Shift toggles window).
    if let Ok(val) = crate::db::get_setting(app.clone(), "radial_menu_enabled".to_string()) {
        RADIAL_MENU_ENABLED.store(val == "1", Ordering::SeqCst);
    }
    log::info!("Mouse hook not available on Linux; radial menu accessible via keyboard shortcuts only");
}

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
