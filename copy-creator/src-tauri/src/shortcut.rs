use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_global_shortcut::Shortcut as GsShortcut;

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

pub fn init_radial_menu_state(app: &AppHandle) {
    if let Ok(val) = crate::db::get_setting(app.clone(), "radial_menu_enabled".to_string()) {
        set_radial_menu_enabled_flag(val == "1");
    }
    // 按平台输出能力说明，避免 Linux 专属文案误导其他平台的日志排查。
    // Linux 无全局鼠标钩子，径向菜单只能由快捷键呼出；Windows 同样仅
    // 支持快捷键（含 Win 组合键时经低级键盘钩子拦截）。
    #[cfg(target_os = "linux")]
    log::info!(
        "Mouse hook not available on Linux; radial menu accessible via keyboard shortcuts only"
    );
    #[cfg(not(target_os = "linux"))]
    log::info!("Radial menu enabled; triggered via global keyboard shortcut");
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
    // Windows 上含 Win 修饰键的组合被系统组件用 RegisterHotKey 永久占用
    // (Win+V 剪贴板面板、Win+B 托盘图标),正常注册必然失败;这类组合
    // 由低级键盘钩子接管(见 win_hook),这里直接视为注册成功。
    #[cfg(target_os = "windows")]
    if win_hook::parse_win_combo_vk(shortcut).is_some() {
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
    #[cfg(target_os = "windows")]
    if win_hook::parse_win_combo_vk(shortcut).is_some() {
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
        refresh_win_hook_combos(app);
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

    // Windows 上含 Win 修饰键的组合(如 Win+V/Win+B)被系统组件占用，
    // RegisterHotKey 必然失败；由低级键盘钩子接管，这里直接视为注册成功。
    #[cfg(target_os = "windows")]
    let new_is_win_combo = win_hook::parse_win_combo_vk(new_shortcut).is_some();
    #[cfg(not(target_os = "windows"))]
    let new_is_win_combo = false;

    // 先注册新快捷键，冲突或非法组合不会让用户失去原来可用的快捷键。
    if !new_is_win_combo {
        app.global_shortcut()
            .register(parsed_new)
            .map_err(|e| format!("Failed to register {name} shortcut '{new_shortcut}': {e}"))?;
    }

    if !old_shortcut.is_empty() {
        if let Err(error) = unregister_keyboard_shortcut(app, old_shortcut) {
            let _ = unregister_keyboard_shortcut(app, new_shortcut);
            return Err(format!("Failed to replace {name} shortcut: {error}"));
        }
    }

    *slot.lock().unwrap() = new_shortcut.to_string();
    refresh_win_hook_combos(app);
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
    set_radial_menu_enabled_flag(enabled);
    let state = app.state::<crate::db::DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('radial_menu_enabled', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
        rusqlite::params![if enabled { "1" } else { "0" }],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// 依据当前三组快捷键配置重建 Win 组合拦截表(非 Windows 为空操作)。
/// 拦截表非空时按需安装键盘钩子;用户全部改用普通组合键(如 Alt+V)时
/// 表为空,系统零侵入。组合键更新(设置页修改)后需重新调用以同步。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn refresh_win_hook_combos(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        win_hook::refresh_combos(
            &MAIN_SHORTCUT_KEY.lock().unwrap().clone(),
            &RADIAL_SHORTCUT_KEY.lock().unwrap().clone(),
            &CLIPBOARD_CREATE_SHORTCUT_KEY.lock().unwrap().clone(),
            app,
        );
        if win_hook::has_combos() {
            win_hook::install(app.clone());
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

// ---- Windows low-level keyboard hook ----
//
// Windows 系统组件通过 RegisterHotKey 永久占用 Win+V(剪贴板历史面板)与
// Win+B(托盘"显示隐藏图标")等组合,普通应用的 RegisterHotKey 调用必然
// 失败。低级键盘钩子在系统热键处理之前运行,且后安装的钩子先被调用,因此
// 这里抢先识别含 Win 修饰键的快捷键、吞掉按键并分发给对应窗口,其余按键
// 全部原样放行。Win 键本身按下/抬起均放行;拦截组合键后由分发线程注入
// 一次 Ctrl 点按,避免之后的 Win 抬起被系统当成"裸 Win 按键"弹出开始菜单
// (见 inject_ctrl_tap)。

// ── A2 拆分：窗口域各归其位 ────────────────────────────────
// 径向窗口 / 粘贴创建窗口 / Windows 键盘钩子分别独立成文件；
// 此处再导出保持既有 `shortcut::` 调用点与命令注册路径不变。
pub(crate) use crate::clipboard_create_window::*;
pub(crate) use crate::radial_window::*;
#[cfg(target_os = "windows")]
use crate::win_hook;

