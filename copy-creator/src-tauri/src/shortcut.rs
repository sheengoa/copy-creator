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

    let Some(window) = app.get_webview_window("main") else {
        log::warn!("[toggle_window] main window not found");
        return;
    };

    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    log::info!("[toggle_window] visible={visible}, minimized={minimized}");

    if visible && !minimized {
        if let Err(error) = window.hide() {
            log::warn!("[toggle_window] hide failed: {error}");
        }
    } else {
        crate::show_main_window(app, "shortcut", false);
    }
}

// ---- radial menu ----

// ---- 窗口层级约定（最终定论，后续不得再更改窗口层级关系）----
//
// 本应用自有窗口的堆叠顺序自上而下固定为：
//   1. 径向菜单（radial-menu）
//   2. 编辑/新建窗口（clipboard-create）
//   3. 主窗口（main）
//
// 实现约束（与层级约定绑定，一并冻结）：
// * always_on_top 必须在窗口 show() 映射之后再设置。部分 Linux 窗口管理器
//   （如 GNOME）对未映射（隐藏）窗口的置顶设置不生效，径向菜单会因此掉到
//   普通层，被主窗口/编辑窗口完全遮住。
// * keep-above 状态的切换在 mutter 上只改变层归属，不会在置顶层内部重新
//   排序；窗口间（如径向菜单 vs 编辑窗口）的先后必须靠显式抬升
//   （gdk_window_raise）决定，抬升顺序 = 堆叠顺序。
// * mutter 还有"焦点窗口压制未聚焦窗口抬升"的堆叠约束：用户点击过编辑/
//   主窗口后它持有焦点，径向菜单的常规抬升与 set_focus（防抢占策略拒绝）
//   都会被压到焦点窗口之下。因此径向菜单显示时必须以 pager 来源发送
//   _NET_ACTIVE_WINDOW 激活消息（mutter 对 pager 来源不做防抢占拦截），
//   确定性获得焦点与置顶。粘贴流程不受影响：径向菜单隐藏后焦点自动
//   落回先前窗口，合成 Ctrl+V 仍到达原窗口。
// * raise_visible_popup_windows 的抬升顺序必须保持"先编辑窗口、后径向菜单"。

#[cfg(target_os = "linux")]
fn raise_gdk_window(window: &tauri::WebviewWindow) {
    use gtk::prelude::*;
    // GTK 调用必须落在主线程；gdk_window_raise 在 X11 下即 XRaiseWindow，
    // 确定性把窗口顶到所在层最上面。
    let window = window.clone();
    let emitter = window.clone();
    let _ = emitter.run_on_main_thread(move || {
        if let Ok(gtk_window) = window.gtk_window() {
            if let Some(gdk_window) = gtk_window.window() {
                gdk_window.raise();
            }
        }
    });
}

fn raise_always_on_top_without_focus(window: &tauri::WebviewWindow) {
    if !window.is_visible().unwrap_or(false) {
        let _ = window.show();
    }
    // 窗口已处于映射状态，重新应用置顶以确保层级生效。
    let _ = window.set_always_on_top(false);
    let _ = window.set_always_on_top(true);
    #[cfg(target_os = "linux")]
    raise_gdk_window(window);
}

/// 以 pager 来源发送 _NET_ACTIVE_WINDOW 激活消息（仅 X11；Wayland 下无
/// DISPLAY 时静默跳过，保持原有 set_focus 行为）。见顶部层级约定注释。
#[cfg(target_os = "linux")]
fn activate_window_via_x11(window: &tauri::WebviewWindow) {
    use gtk::prelude::*;
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_long, c_ulong, c_void};

    #[link(name = "X11")]
    extern "C" {
        fn XOpenDisplay(name: *const c_char) -> *mut c_void;
        fn XCloseDisplay(display: *mut c_void);
        fn XInternAtom(display: *mut c_void, name: *const c_char, only_if_exists: c_int) -> c_ulong;
        fn XSendEvent(
            display: *mut c_void,
            w: c_long,
            propagate: c_int,
            event_mask: c_long,
            event: *mut [c_long; 24],
        ) -> c_int;
        fn XFlush(display: *mut c_void);
        fn XDefaultRootWindow(display: *mut c_void) -> c_ulong;
    }
    #[link(name = "gdk-3")]
    extern "C" {
        fn gdk_x11_window_get_xid(window: *mut c_void) -> c_ulong;
    }

    // 取 X 窗口 id 必须在主线程访问 GTK 对象。
    let window = window.clone();
    let emitter = window.clone();
    let _ = emitter.run_on_main_thread(move || {
        let Ok(gtk_window) = window.gtk_window() else {
            return;
        };
        let Some(gdk_window) = gtk_window.window() else {
            return;
        };
        let stash = <gtk::gdk::Window as gtk::glib::translate::ToGlibPtr<'_, *mut gtk::gdk::ffi::GdkWindow>>::to_glib_none(&gdk_window);
        let xid = unsafe { gdk_x11_window_get_xid(stash.0 as *mut c_void) };
        if xid == 0 {
            return;
        }
        unsafe {
            let display = XOpenDisplay(std::ptr::null());
            if display.is_null() {
                return;
            }
            let atom_active = CString::new("_NET_ACTIVE_WINDOW").unwrap();
            let message_type = XInternAtom(display, atom_active.as_ptr(), 0);
            // XEvent 按平台长字长度铺开；ClientMessage 字段依次为
            // type/serial/send_event/display/window/message_type/format/data.l[5]。
            let mut event: [c_long; 24] = [0; 24];
            event[0] = 33; // ClientMessage
            event[4] = xid as c_long;
            event[5] = message_type as c_long;
            event[6] = 32; // format
            event[7] = 1; // source indication: pager
            event[8] = 0; // timestamp: CurrentTime
            event[9] = 0; // requestor's active window
            const SUBSTRUCTURE_REDIRECT: c_long = 1 << 20;
            const SUBSTRUCTURE_NOTIFY: c_long = 1 << 19;
            XSendEvent(
                display,
                XDefaultRootWindow(display) as c_long,
                0,
                SUBSTRUCTURE_REDIRECT | SUBSTRUCTURE_NOTIFY,
                &mut event,
            );
            XFlush(display);
            XCloseDisplay(display);
        }
    });
}

fn raise_always_on_top(window: &tauri::WebviewWindow) {
    raise_always_on_top_without_focus(window);
    let _ = window.set_focus();
    // X11 下 set_focus 会被 mutter 防抢占策略拒绝（焦点窗口压制约束），
    // 改以 pager 激活消息确保焦点与置顶同时生效。
    #[cfg(target_os = "linux")]
    activate_window_via_x11(window);
}

pub(crate) fn has_visible_popup_window(app: &AppHandle) -> bool {
    ["clipboard-create", "radial-menu"].iter().any(|label| {
        app.get_webview_window(label)
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false)
    })
}

pub(crate) fn raise_visible_popup_windows(app: &AppHandle) {
    // 窗口层级约定（勿改）：两个弹窗均为 always-on-top，按"先编辑窗口、
    // 后径向菜单"的顺序激活。激活是 X11 上唯一可靠的堆叠原语（mutter 会
    // 用焦点约束压制未聚焦窗口的普通抬升），后激活者位于最上层，因此
    // 焦点最终落在径向菜单。
    if let Some(create) = app.get_webview_window("clipboard-create") {
        if create.is_visible().unwrap_or(false) {
            raise_always_on_top(&create);
        }
    }
    if let Some(radial) = app.get_webview_window("radial-menu") {
        if radial.is_visible().unwrap_or(false) {
            raise_always_on_top(&radial);
        }
    }
}

pub fn show_radial_menu(app: &AppHandle) {
    if let Some(radial) = app.get_webview_window("radial-menu") {
        if radial.is_visible().unwrap_or(false) {
            log::info!("[show_radial_menu] already visible, hiding");
            let _ = radial.hide();
            let _ = app.emit("radial-menu-hide", ());
            return;
        }

        let (cursor_x, cursor_y) = get_cursor_position();

        // 每次打开时恢复标准尺寸，并将窗口定位在鼠标附近。
        let _ = radial.set_size(tauri::LogicalSize::new(420.0, 650.0));
        let px = cursor_x.saturating_sub(210);
        let py = cursor_y.saturating_sub(24);
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

pub fn show_clipboard_create(
    app: &AppHandle,
    group_name: Option<String>,
    storage_mode: Option<String>,
) {
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

    // 抬升并激活（含 X11 pager 激活），确保新建窗口位于主窗口之上；
    // 主窗口持有焦点时普通抬升会被 mutter 焦点约束压制。
    raise_always_on_top(&window);
    // 新建窗口打开时可能抢到置顶窗口的堆叠顺序，恢复两个弹窗的固定顺序。
    raise_visible_popup_windows(app);

    let _ = app.emit(
        "clipboard-create-show",
        serde_json::json!({
            "theme": theme,
            "group_name": group_name,
            "storage_mode": storage_mode,
        }),
    );

    log::info!(
        "[show_clipboard_create] shown at ({}, {}) theme={}",
        geometry.x,
        geometry.y,
        theme
    );
}

#[tauri::command]
pub fn open_clipboard_create(
    app: AppHandle,
    group_name: Option<String>,
    storage_mode: Option<String>,
) -> Result<(), String> {
    show_clipboard_create(&app, group_name, storage_mode);
    Ok(())
}

#[cfg(test)]
mod shortcut_matching_tests {
    use super::*;

    #[test]
    fn matches_configured_shortcut_by_parsed_hotkey() {
        let event = GsShortcut::from_str("shift+control+KeyA").unwrap();

        assert!(matches_configured_shortcut("Ctrl+Shift+A", &event));
        assert!(matches_configured_shortcut("control+shift+KeyA", &event));
    }

    #[test]
    fn rejects_different_or_invalid_shortcuts() {
        let event = GsShortcut::from_str("shift+control+KeyA").unwrap();

        assert!(!matches_configured_shortcut("Ctrl+Shift+B", &event));
        assert!(!matches_configured_shortcut("Ctrl+Shift+NotAKey", &event));
    }
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
    let shortcut = shortcut.trim();
    if shortcut.is_empty() {
        return Ok(());
    }
    let parsed = GsShortcut::from_str(shortcut)?;
    app.global_shortcut().register(parsed)?;
    Ok(())
}

pub fn unregister_keyboard_shortcut(
    app: &AppHandle,
    shortcut: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let shortcut = shortcut.trim();
    if shortcut.is_empty() {
        return Ok(());
    }
    let parsed = GsShortcut::from_str(shortcut)?;
    if !app.global_shortcut().is_registered(parsed) {
        return Ok(());
    }
    app.global_shortcut().unregister(parsed)?;
    Ok(())
}

// ---- shortcut matching ----

/// 直接比较 global-hotkey 插件提供的快捷键对象。
/// 展示字符串可能因平台不同而变化，解析后的快捷键和 ID 在各平台一致。
fn matches_configured_shortcut(configured: &str, shortcut: &GsShortcut) -> bool {
    !configured.trim().is_empty()
        && GsShortcut::from_str(configured)
            .map(|configured| configured == *shortcut)
            .unwrap_or(false)
}

pub fn is_main_shortcut(shortcut: &GsShortcut) -> bool {
    let configured = MAIN_SHORTCUT_KEY.lock().unwrap();
    matches_configured_shortcut(&configured, shortcut)
}

pub fn is_radial_shortcut(shortcut: &GsShortcut) -> bool {
    let configured = RADIAL_SHORTCUT_KEY.lock().unwrap();
    matches_configured_shortcut(&configured, shortcut)
}

pub fn is_clipboard_create_shortcut(shortcut: &GsShortcut) -> bool {
    let configured = CLIPBOARD_CREATE_SHORTCUT_KEY.lock().unwrap();
    matches_configured_shortcut(&configured, shortcut)
}

fn replace_shortcut(
    app: &AppHandle,
    slot: &Mutex<String>,
    old_shortcut: String,
    new_shortcut: String,
    name: &str,
) -> Result<(), String> {
    let old_shortcut = old_shortcut.trim();
    let new_shortcut = new_shortcut.trim();

    if old_shortcut == new_shortcut {
        *slot.lock().unwrap() = new_shortcut.to_string();
        return Ok(());
    }

    if new_shortcut.is_empty() {
        if !old_shortcut.is_empty() {
            unregister_keyboard_shortcut(app, old_shortcut)
                .map_err(|e| format!("Failed to unregister {name} shortcut: {e}"))?;
        }
        *slot.lock().unwrap() = String::new();
        return Ok(());
    }

    let parsed_new = GsShortcut::from_str(new_shortcut)
        .map_err(|e| format!("Failed to parse {name} shortcut '{new_shortcut}': {e}"))?;

    // Ctrl+A 和 control+KeyA 是同一个原生快捷键，只更新展示字符串即可。
    if GsShortcut::from_str(old_shortcut)
        .map(|parsed_old| parsed_old == parsed_new)
        .unwrap_or(false)
    {
        *slot.lock().unwrap() = new_shortcut.to_string();
        return Ok(());
    }

    // 先注册新快捷键，冲突或非法组合不会让用户失去原来可用的快捷键。
    app.global_shortcut()
        .register(parsed_new)
        .map_err(|e| format!("Failed to register {name} shortcut '{new_shortcut}': {e}"))?;

    if !old_shortcut.is_empty() {
        if let Err(error) = unregister_keyboard_shortcut(app, old_shortcut) {
            let _ = unregister_keyboard_shortcut(app, new_shortcut);
            return Err(format!("Failed to replace {name} shortcut: {error}"));
        }
    }

    *slot.lock().unwrap() = new_shortcut.to_string();
    Ok(())
}

#[tauri::command]
pub fn update_shortcut(
    app: AppHandle,
    old_shortcut: String,
    new_shortcut: String,
) -> Result<(), String> {
    replace_shortcut(
        &app,
        &MAIN_SHORTCUT_KEY,
        old_shortcut,
        new_shortcut,
        "main window",
    )
}

#[tauri::command]
pub fn update_radial_shortcut(
    app: AppHandle,
    old_shortcut: String,
    new_shortcut: String,
) -> Result<(), String> {
    replace_shortcut(
        &app,
        &RADIAL_SHORTCUT_KEY,
        old_shortcut,
        new_shortcut,
        "radial menu",
    )
}

#[tauri::command]
pub fn update_clipboard_create_shortcut(
    app: AppHandle,
    old_shortcut: String,
    new_shortcut: String,
) -> Result<(), String> {
    replace_shortcut(
        &app,
        &CLIPBOARD_CREATE_SHORTCUT_KEY,
        old_shortcut,
        new_shortcut,
        "clipboard create",
    )
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
