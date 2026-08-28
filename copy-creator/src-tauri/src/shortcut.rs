use enigo::{Enigo, Mouse, Settings};
use std::process::Command;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_global_shortcut::Shortcut as GsShortcut;

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
pub static CLIPBOARD_CREATE_SHORTCUT_KEY: Mutex<String> = Mutex::new(String::new());

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

    crate::show_main_window(app, "shortcut", false);
}

// ---- radial menu ----

fn raise_always_on_top(window: &tauri::WebviewWindow) {
    let _ = window.set_always_on_top(false);
    let _ = window.set_always_on_top(true);
    let _ = window.show();
    let _ = window.set_focus();
}

fn refresh_always_on_top_if_visible(window: &tauri::WebviewWindow) {
    if window.is_visible().unwrap_or(false) {
        let _ = window.set_always_on_top(false);
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
    }
}

pub fn show_radial_menu(app: &AppHandle) {
    if let Some(radial) = app.get_webview_window("radial-menu") {
        if radial.is_visible().unwrap_or(false) {
            log::info!("[show_radial_menu] already visible, hiding");
            let _ = radial.hide();
            return;
        }

        let (cursor_x, cursor_y) = get_cursor_position();

        // 每次打开时恢复紧凑尺寸，并将窗口定位在鼠标附近。
        let _ = radial.set_size(tauri::LogicalSize::new(300.0, 420.0));
        let px = cursor_x.saturating_sub(150);
        let py = cursor_y.saturating_sub(20);
        let _ = radial.set_position(tauri::PhysicalPosition::new(px.max(0), py.max(0)));

        // Read theme from DB
        let theme =
            crate::db::get_setting_sync(app, "theme").unwrap_or_else(|| "light".to_string());

        raise_always_on_top(&radial);

        let _ = app.emit(
            "radial-menu-show",
            serde_json::json!({
                "theme": theme
            }),
        );

        let app_handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(60));
            if let Some(radial) = app_handle.get_webview_window("radial-menu") {
                refresh_always_on_top_if_visible(&radial);
            }
        });

        log::info!(
            "[show_radial_menu] shown at ({}, {}) theme={}",
            px,
            py,
            theme
        );
    }
}

// ---- clipboard create dialog ----

const CLIPBOARD_CREATE_DEFAULT_WIDTH: f64 = 560.0;
const CLIPBOARD_CREATE_DEFAULT_HEIGHT: f64 = 520.0;
const CLIPBOARD_CREATE_MIN_WIDTH: f64 = 480.0;
const CLIPBOARD_CREATE_MIN_HEIGHT: f64 = 380.0;

#[derive(Debug, PartialEq)]
struct ClipboardCreateGeometry {
    width: f64,
    height: f64,
    x: i32,
    y: i32,
}

fn saved_dimension(value: Option<String>, fallback: f64) -> f64 {
    value
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn calculate_clipboard_create_geometry(
    cursor_x: i32,
    cursor_y: i32,
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
    scale_factor: f64,
    saved_width: f64,
    saved_height: f64,
) -> ClipboardCreateGeometry {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let max_width = (work_width as f64 / scale).max(CLIPBOARD_CREATE_MIN_WIDTH);
    let max_height = (work_height as f64 / scale).max(CLIPBOARD_CREATE_MIN_HEIGHT);
    let width = saved_width.clamp(CLIPBOARD_CREATE_MIN_WIDTH, max_width);
    let height = saved_height.clamp(CLIPBOARD_CREATE_MIN_HEIGHT, max_height);
    let physical_width = (width * scale).round() as i32;
    let physical_height = (height * scale).round() as i32;
    let max_x = work_x
        .saturating_add(work_width as i32)
        .saturating_sub(physical_width)
        .max(work_x);
    let max_y = work_y
        .saturating_add(work_height as i32)
        .saturating_sub(physical_height)
        .max(work_y);

    ClipboardCreateGeometry {
        width,
        height,
        x: cursor_x
            .saturating_sub(physical_width / 2)
            .clamp(work_x, max_x),
        y: cursor_y.saturating_sub(40).clamp(work_y, max_y),
    }
}

pub fn show_clipboard_create(app: &AppHandle) {
    let window = match app.get_webview_window("clipboard-create") {
        Some(w) => w,
        None => {
            log::warn!("[show_clipboard_create] clipboard-create window not found");
            return;
        }
    };

    // 已显示则隐藏（toggle 行为）
    if window.is_visible().unwrap_or(false) {
        log::info!("[show_clipboard_create] already visible, hiding");
        let _ = window.hide();
        return;
    }

    let (cursor_x, cursor_y) = get_cursor_position();
    let saved_width = saved_dimension(
        crate::db::get_setting_sync(app, "clipboard_create_width"),
        CLIPBOARD_CREATE_DEFAULT_WIDTH,
    );
    let saved_height = saved_dimension(
        crate::db::get_setting_sync(app, "clipboard_create_height"),
        CLIPBOARD_CREATE_DEFAULT_HEIGHT,
    );
    // `get_cursor_position` 返回的是 X11 根窗口的物理坐标。直接从可用屏幕
    // 的物理几何中选择目标屏幕，避免高 DPI 下 `monitor_from_point` 的坐标
    // 语义与鼠标坐标不一致，导致窗口落到旧屏幕或固定位置。
    let monitor = window
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                let cursor_x = i64::from(cursor_x);
                let cursor_y = i64::from(cursor_y);
                let left = i64::from(position.x);
                let top = i64::from(position.y);
                let right = left.saturating_add(i64::from(size.width));
                let bottom = top.saturating_add(i64::from(size.height));
                cursor_x >= left && cursor_x < right && cursor_y >= top && cursor_y < bottom
            })
        })
        .or_else(|| {
            window
                .monitor_from_point(cursor_x as f64, cursor_y as f64)
                .ok()
                .flatten()
        })
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());

    let geometry = monitor.as_ref().map_or(
        ClipboardCreateGeometry {
            width: saved_width.max(CLIPBOARD_CREATE_MIN_WIDTH),
            height: saved_height.max(CLIPBOARD_CREATE_MIN_HEIGHT),
            x: cursor_x
                .saturating_sub((saved_width.max(CLIPBOARD_CREATE_MIN_WIDTH) / 2.0).round() as i32)
                .max(0),
            y: cursor_y.saturating_sub(40).max(0),
        },
        |monitor| {
            let work_area = monitor.work_area();
            calculate_clipboard_create_geometry(
                cursor_x,
                cursor_y,
                work_area.position.x,
                work_area.position.y,
                work_area.size.width,
                work_area.size.height,
                monitor.scale_factor(),
                saved_width,
                saved_height,
            )
        },
    );

    if let Err(error) = window.set_size(tauri::LogicalSize::new(geometry.width, geometry.height)) {
        log::warn!("[show_clipboard_create] set_size failed: {error}");
    }
    if let Err(error) = window.set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y)) {
        log::warn!("[show_clipboard_create] set_position failed: {error}");
    }

    // 读取主题
    let theme = crate::db::get_setting_sync(app, "theme").unwrap_or_else(|| "light".to_string());

    if let Err(error) = window.show() {
        log::warn!("[show_clipboard_create] show failed: {error}");
    }
    if let Err(error) = window.set_focus() {
        log::warn!("[show_clipboard_create] set_focus failed: {error}");
    }

    let _ = app.emit(
        "clipboard-create-show",
        serde_json::json!({
            "theme": theme
        }),
    );

    log::info!(
        "[show_clipboard_create] shown at ({}, {}) theme={}",
        geometry.x,
        geometry.y,
        theme
    );
}

#[cfg(test)]
mod clipboard_create_geometry_tests {
    use super::*;

    #[test]
    fn uses_default_size_near_cursor() {
        assert_eq!(
            calculate_clipboard_create_geometry(
                1000,
                500,
                0,
                0,
                1920,
                1080,
                1.0,
                CLIPBOARD_CREATE_DEFAULT_WIDTH,
                CLIPBOARD_CREATE_DEFAULT_HEIGHT,
            ),
            ClipboardCreateGeometry {
                width: 560.0,
                height: 520.0,
                x: 720,
                y: 460
            }
        );
    }

    #[test]
    fn keeps_saved_size_inside_all_work_area_edges() {
        assert_eq!(
            calculate_clipboard_create_geometry(1800, 1000, 0, 0, 1920, 1080, 1.0, 800.0, 700.0),
            ClipboardCreateGeometry {
                width: 800.0,
                height: 700.0,
                x: 1120,
                y: 380
            }
        );
    }

    #[test]
    fn converts_saved_logical_size_for_scaled_monitor() {
        assert_eq!(
            calculate_clipboard_create_geometry(1280, 720, 0, 0, 2560, 1440, 2.0, 1000.0, 800.0),
            ClipboardCreateGeometry {
                width: 1000.0,
                height: 720.0,
                x: 280,
                y: 0
            }
        );
    }

    #[test]
    fn supports_negative_monitor_coordinates() {
        assert_eq!(
            calculate_clipboard_create_geometry(
                -1800, 100, -1920, 0, 1920, 1080, 1.0, 560.0, 520.0
            ),
            ClipboardCreateGeometry {
                width: 560.0,
                height: 520.0,
                x: -1920,
                y: 60
            }
        );
    }
}

/// Restore the radial-menu enabled flag from the database and log the
/// platform capabilities.  Linux does not have global mouse hooks, so
/// the radial menu is driven exclusively by the keyboard shortcut.
pub fn init_radial_menu_state(app: &AppHandle) {
    if let Ok(val) = crate::db::get_setting(app.clone(), "radial_menu_enabled".to_string()) {
        RADIAL_MENU_ENABLED.store(val == "1", Ordering::SeqCst);
    }
    log::info!(
        "Mouse hook not available on Linux; radial menu accessible via keyboard shortcuts only"
    );
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

pub fn is_clipboard_create_shortcut(s: &str) -> bool {
    let key = CLIPBOARD_CREATE_SHORTCUT_KEY.lock().unwrap();
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
pub fn update_clipboard_create_shortcut(
    app: AppHandle,
    old_shortcut: String,
    new_shortcut: String,
) -> Result<(), String> {
    if !old_shortcut.is_empty() {
        let _ = unregister_keyboard_shortcut(&app, &old_shortcut);
    }
    if !new_shortcut.is_empty() {
        register_keyboard_shortcut(&app, &new_shortcut)
            .map_err(|e| format!("Failed to register clipboard create shortcut: {}", e))?;
    }
    *CLIPBOARD_CREATE_SHORTCUT_KEY.lock().unwrap() = new_shortcut;
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
