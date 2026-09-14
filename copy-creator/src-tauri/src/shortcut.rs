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

/// 径向窗口预留条带几何（物理像素）：方向、条带宽、窗口总宽/高，以及
/// 面板锚点 (px, py)，在 show_radial_menu 打开窗口时一次性决定。
///
/// 展开/收起的几何策略分平台：
/// - Linux：窗口按"面板 + 条带"全尺寸常驻，展开/收起只切换 X11 输入
///   区域，绝不 resize/move——X11 上任何 resize/move 都会被合成器画出
///   一帧"旧内容按左上锚定 + 新区域未绘制"（实机采集帧证据），即扩展
///   闪烁的物理根源，只能靠几何不变来根除；
/// - Windows：DWM 合成器没有上述残影问题，收起态窗口即面板大小（隐形
///   条带不进窗口、不会拦截点击），展开/收起由 set_radial_hit_area 以
///   (px, py) 为锚做 resize+move，双端用户可见行为一致。
static RADIAL_STRIP: Mutex<(bool, i32, i32, i32, i32, i32)> =
    Mutex::new((false, 0, 0, 0, 0, 0));

/// 切换径向窗口预览区的展开/收起（双平台策略见 RADIAL_STRIP 注释）：
/// Linux 切 X11 输入区域（收起态条带穿透到下层应用）；Windows 直接
/// resize+move（收起态窗口即面板大小）。用户可见行为双端一致：收起态
/// 预留条带不拦截任何点击，展开态预览铺满条带。空条带（无空间）时不做。
fn apply_radial_input_shape(window: &tauri::WebviewWindow<tauri::Wry>, expanded: bool) {
    #[cfg(target_os = "linux")]
    {
        let (strip_left, strip_w, win_w, win_h, _px, _py) = *RADIAL_STRIP
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if strip_w <= 0 || win_w <= 0 || win_h <= 0 {
            return;
        }
        let task_window = window.clone();
        // 输入区域是 GTK 调用，必须落在主线程；调用方可能在 IPC 线程。
        let apply = move || {
            use gtk::prelude::*;
            let Ok(gtk_window) = task_window.gtk_window() else {
                return;
            };
            let Some(gdk_window) = gtk_window.window() else {
                return;
            };
            let region = if expanded {
                gtk::cairo::Region::create_rectangle(&gtk::cairo::RectangleInt::new(
                    0, 0, win_w, win_h,
                ))
            } else {
                let x = if strip_left { strip_w } else { 0 };
                gtk::cairo::Region::create_rectangle(&gtk::cairo::RectangleInt::new(
                    x,
                    0,
                    win_w - strip_w,
                    win_h,
                ))
            };
            gdk_window.input_shape_combine_region(&region, 0, 0);
        };
        window.run_on_main_thread(apply).ok();
    }
    #[cfg(not(target_os = "linux"))]
    {
        // Windows：窗口收起态即面板大小（条带不在窗口内，点击天然落到
        // 下层应用），展开/收起以面板锚点为准做 resize+move。DWM 合成
        // 没有 X11 的残影帧问题，尺寸变化是安全的。
        let (strip_left, strip_w, win_w_total, win_h, px, py) = *RADIAL_STRIP
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if strip_w <= 0 {
            return;
        }
        let (width, x) = if expanded {
            (win_w_total, if strip_left { px - strip_w } else { px })
        } else {
            (win_w_total - strip_w, px)
        };
        let _ = window.set_size(tauri::PhysicalSize::new(width, win_h));
        let _ = window.set_position(tauri::PhysicalPosition::new(x, py));
    }
}

/// 展开/收起径向菜单预览时切换输入区域；窗口几何自打开起固定不变
/// （条带已在打开时预留，见 RADIAL_STRIP 注释）。
#[tauri::command]
pub fn set_radial_hit_area(
    window: tauri::WebviewWindow<tauri::Wry>,
    expanded: bool,
) -> Result<(), String> {
    apply_radial_input_shape(&window, expanded);
    Ok(())
}

static RADIAL_MENU_ENABLED: AtomicBool = AtomicBool::new(true);

/// Linux 常驻窗口模型的显示状态事实源。径向窗口启动即映射，此后显示/
/// 隐藏只切换"web 内容可见性 + 输入区域 + 焦点"，几何从不改变——
/// - 窗管对映射窗口的移屏外请求会钳制回工作区（实测请求
///   (-20000,-20000) 被落成 (0,-32)，肉眼可见"另一个菜单"闪现左上角）；
/// - unmap 会触发窗管退场动画，它作用于"面板+条带"偏心大矩形、中心
///   落在隐形条带里（逐帧采集证据：可见内容朝条带方向收回）；
/// 因此停泊 = 清空输入区域 + 焦点归还，内容不可见由 web 层负责
/// （前端 visible=false 经 .radial-menu-hidden 规则整面透明，逐帧采集
/// 证实停泊后屏幕与背景零差异）。窗口常驻映射后 is_visible() 恒为
/// true，显示判定只能查本标志。
static RADIAL_MENU_SHOWN: AtomicBool = AtomicBool::new(false);

/// 呼出前持有焦点的 X 窗口 id（0 = 未知）。收仓时若焦点仍在径向窗口
/// （快捷键二次按压/Escape），把焦点还给呼出前的窗口；用户已点击其他
/// 窗口（失焦自隐藏）则不抢回。径向窗口自身 xid 不做快照——pager 激活
/// 是异步的，激活后立即采集会误采到上一个窗口（实测导致归还永远跳过、
/// 粘贴击键落进不可见菜单），改为停泊时直接从 GDK 读取。
static RADIAL_PREV_FOCUS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// 当前焦点所在的**窗管托管顶层**窗口 id。键盘焦点常悬在应用内部的
/// input-only 子窗口上（如 WebKitGTK 的 0xa00004），_NET_ACTIVE_WINDOW
/// 激活请求对这类非托管窗口会被 mutter 静默忽略，必须上溯到根窗口的
/// 直接子窗口。焦点在根/无效时返回 0。
#[cfg(target_os = "linux")]
fn x11_focus_toplevel_xid() -> u32 {
    use std::os::raw::{c_char, c_int, c_ulong, c_void};
    #[link(name = "X11")]
    extern "C" {
        fn XOpenDisplay(name: *const c_char) -> *mut c_void;
        fn XCloseDisplay(display: *mut c_void);
        fn XGetInputFocus(
            display: *mut c_void,
            focus_return: *mut c_ulong,
            revert_to_return: *mut c_int,
        );
        fn XQueryTree(
            display: *mut c_void,
            w: c_ulong,
            root_return: *mut c_ulong,
            parent_return: *mut c_ulong,
            children_return: *mut *mut c_ulong,
            nchildren_return: *mut c_int,
        ) -> c_int;
        fn XFree(data: *mut c_void) -> c_int;
        fn XDefaultRootWindow(display: *mut c_void) -> c_ulong;
    }
    unsafe {
        let display = XOpenDisplay(std::ptr::null());
        if display.is_null() {
            return 0;
        }
        let mut focus: c_ulong = 0;
        let mut revert: c_int = 0;
        XGetInputFocus(display, &mut focus, &mut revert);
        let root = XDefaultRootWindow(display);
        let mut cur = focus;
        let result = loop {
            if cur == 0 || cur <= 1 || cur == root {
                break 0;
            }
            let (mut tree_root, mut parent): (c_ulong, c_ulong) = (0, 0);
            let mut children: *mut c_ulong = std::ptr::null_mut();
            let mut n = 0;
            if XQueryTree(display, cur, &mut tree_root, &mut parent, &mut children, &mut n) == 0 {
                break 0;
            }
            if !children.is_null() {
                XFree(children as *mut c_void);
            }
            if parent == root {
                break cur;
            }
            cur = parent;
        };
        XCloseDisplay(display);
        result as u32
    }
}

/// 以 pager 来源向根窗口发送 _NET_ACTIVE_WINDOW，请求激活任意 X 窗口。
/// 目标窗口已销毁时 mutter 直接忽略该消息，不会产生 X 错误。
#[cfg(target_os = "linux")]
fn x11_activate_window(xid: u32) {
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
}

/// 清空径向窗口输入区域（停泊态所有点击穿透到下层应用）。GTK 调用，
/// 须回主线程。
#[cfg(target_os = "linux")]
pub(crate) fn clear_radial_input(window: &tauri::WebviewWindow<tauri::Wry>) {
    let task_window = window.clone();
    let _ = window.run_on_main_thread(move || {
        use gtk::prelude::*;
        let Ok(gtk_window) = task_window.gtk_window() else {
            return;
        };
        let Some(gdk_window) = gtk_window.window() else {
            return;
        };
        gdk_window.input_shape_combine_region(
            &gtk::cairo::Region::create_rectangle(&gtk::cairo::RectangleInt::new(0, 0, 0, 0)),
            0,
            0,
        );
    });
}

/// 收起径向菜单（所有隐藏路径的唯一出口）：Linux 原地停泊（清输入 +
/// 焦点归还，内容不可见由 web 层负责，理由见 RADIAL_MENU_SHOWN 注释），
/// 非 Linux 直接 hide()（DWM 没有偏心退场动画问题，保持原有行为）。
pub(crate) fn park_radial_window(app: &AppHandle) {
    RADIAL_MENU_SHOWN.store(false, Ordering::SeqCst);
    let Some(radial) = app.get_webview_window("radial-menu") else {
        return;
    };
    #[cfg(target_os = "linux")]
    {
        let prev = RADIAL_PREV_FOCUS.load(Ordering::SeqCst);
        let task = radial.clone();
        // 顺序收进一个主线程闭包：先穿透输入，再归还焦点。
        let _ = radial.run_on_main_thread(move || {
            use gtk::prelude::*;
            let Ok(gtk_window) = task.gtk_window() else {
                return;
            };
            if let Some(gdk_window) = gtk_window.window() {
                gdk_window.input_shape_combine_region(
                    &gtk::cairo::Region::create_rectangle(&gtk::cairo::RectangleInt::new(
                        0, 0, 0, 0,
                    )),
                    0,
                    0,
                );
            }
            // 焦点判定必须用 GTK 的 is_active：WebKitGTK 持有键盘焦点
            // 的是其 input-only 子窗口而非顶层（XGetInputFocus 实测返回
            // 0xa00004 子窗口、顶层是 0xa00003），按顶层 xid 比较永远
            // 不匹配，归还曾被永久跳过。用户已点击其他应用（失焦自
            // 隐藏）时 is_active 为 false，自然不抢回焦点。
            if gtk_window.is_active() && prev != 0 {
                x11_activate_window(prev);
                log::info!("[park_radial] focus restored to #{prev:x}");
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = radial.hide();
    }
}

/// 前端请求隐藏径向菜单（Escape / 失焦自隐藏）。立即停泊、不播退场
/// 动画——与旧 `getCurrentWindow().hide()` 的即时消失行为一致，但焦点
/// 归还只有后端能做，且常驻模型下前端不得直接 unmap 窗口。
#[tauri::command]
pub fn hide_radial_menu(app: AppHandle) {
    park_radial_window(&app);
}

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
        // Linux 常驻模型下 is_visible 恒为 true（停泊屏幕外也算可见），
        // 必须查显示状态标志，否则会把屏幕外的停泊窗口抬升并抢焦点。
        #[cfg(target_os = "linux")]
        let radial_shown = RADIAL_MENU_SHOWN.load(Ordering::SeqCst);
        #[cfg(not(target_os = "linux"))]
        let radial_shown = radial.is_visible().unwrap_or(false);
        if radial_shown {
            raise_always_on_top(&radial);
        }
    }
}

/// 径向菜单 UI 缩放比：设置键 `radial_menu_scale` 存百分比（50–200），
/// 默认 100（即 420×650 的设计尺寸）。解析失败或越界一律回退到范围内
/// 的合法值，保证窗口与前端 zoom 始终使用同一个系数。
pub(crate) fn radial_ui_scale(app: &AppHandle) -> f32 {
    let percent = crate::db::get_setting_sync(app, "radial_menu_scale")
        .and_then(|raw| raw.trim().parse::<f32>().ok())
        .unwrap_or(100.0);
    (percent / 100.0).clamp(0.5, 2.0)
}

/// 光标所在显示器的 (缩放比, 工作区 x/y/宽/高)，工作区为排除任务栏等
/// 的物理像素区域。多屏坐标可能为负，全部按物理像素比较。找不到所在
/// 显示器（API 失败或坐标异常）时返回 None，调用方退化为不钳制。
fn cursor_monitor_info(
    app: &AppHandle,
    cursor_x: i32,
    cursor_y: i32,
) -> Option<(f64, i32, i32, i32, i32)> {
    let monitor = app
        .available_monitors()
        .ok()?
        .into_iter()
        .find(|monitor| {
            let pos = monitor.position();
            let size = monitor.size();
            cursor_x >= pos.x
                && cursor_x < pos.x + size.width as i32
                && cursor_y >= pos.y
                && cursor_y < pos.y + size.height as i32
        })?;
    let area = monitor.work_area();
    Some((
        monitor.scale_factor(),
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
    ))
}

/// 把期望的窗口左上角钳制进工作区，保证菜单完整可见；窗口本身比工作区
/// 还大时（极端缩放组合）贴工作区原点，允许溢出。
fn clamp_position_into_work_area(
    preferred: (i32, i32),
    window_size: (i32, i32),
    work_area: (i32, i32, i32, i32),
) -> (i32, i32) {
    let (px, py) = preferred;
    let (ww, wh) = window_size;
    let (ax, ay, aw, ah) = work_area;
    let max_x = ax + aw - ww;
    let max_y = ay + ah - wh;
    let x = if max_x >= ax { px.clamp(ax, max_x) } else { ax };
    let y = if max_y >= ay { py.clamp(ay, max_y) } else { ay };
    (x, y)
}

/// 径向扩展条带的方向与宽度判定（纯函数，该几何规则的唯一事实源）：
/// 右侧剩余空间放得下最小条带（260）、或不小于左侧空间时向右扩展，
/// 否则向左；条带宽度取期望宽度（440 × uiScale × dpi）与该侧可用空间
/// 的较小值。前端旧副本已随 utils/radialPreview.ts 删除（架构守卫规则
/// 15 防回潮），行为回归由 radial_strip_tests 锚定。
fn decide_radial_strip(
    px: i32,
    win_w: i32,
    monitor: Option<(f64, i32, i32, i32, i32)>,
    ui_scale: f32,
    dpi: f64,
) -> (bool, i32) {
    let preferred_strip = (440.0 * ui_scale as f64 * dpi).round() as i32;
    let min_strip = (260.0 * ui_scale as f64 * dpi).round() as i32;
    match monitor {
        // 条带只在水平方向分配，工作区的纵向分量（y/height）与 dpi 用不到。
        Some((_, ax, _, aw, _)) => {
            let right_space = ax + aw - (px + win_w);
            let left_space = px - ax;
            if right_space >= min_strip || right_space >= left_space {
                (false, preferred_strip.min(right_space.max(0)))
            } else {
                (true, preferred_strip.min(left_space.max(0)))
            }
        }
        None => (false, preferred_strip),
    }
}

pub fn show_radial_menu(app: &AppHandle) {
    if let Some(radial) = app.get_webview_window("radial-menu") {
        // Linux：窗口常驻映射，显示状态以标志为准（is_visible 恒 true）。
        #[cfg(target_os = "linux")]
        let visible_now = RADIAL_MENU_SHOWN.load(Ordering::SeqCst);
        #[cfg(not(target_os = "linux"))]
        let visible_now = radial.is_visible().unwrap_or(false);
        if visible_now {
            log::info!("[show_radial_menu] already visible, hiding");
            // Linux：先让前端播居中缩小退场动画（radial-menu-hide 事件），
            // 动画播完后停泊窗口。绝不 unmap——窗管的退场动画作用于
            // "面板+条带"大矩形，中心落在隐形条带里，可见内容会朝条带
            // 方向偏心收回（逐帧采集证据：左缘 97→155 右移、右缘不动）。
            #[cfg(target_os = "linux")]
            {
                let _ = app.emit("radial-menu-hide", ());
                let task = app.clone();
                std::thread::spawn(move || {
                    // 170ms = 退场动画 110ms + 余量：停泊必须在动画播完
                    // 之后，否则最后一帧停在半途被截断（实测 140ms 时收
                    // 到 89% 尺寸半透明即消失，观感生硬）。
                    std::thread::sleep(std::time::Duration::from_millis(170));
                    park_radial_window(&task);
                });
            }
            #[cfg(not(target_os = "linux"))]
            {
                let _ = radial.hide();
                let _ = app.emit("radial-menu-hide", ());
            }
            return;
        }

        // 记录呼出前焦点是否在本应用窗口（主窗口 / 新建弹窗）：径向菜单
        // 粘贴时据此判断目标是自家编辑器还是外部应用（见 paste.rs 的
        // defocus_windows），必须在径向窗口抢焦点之前判定。
        let own_focus = ["main", "clipboard-create"].iter().any(|label| {
            app.get_webview_window(label)
                .map(|window| window.is_focused().unwrap_or(false))
                .unwrap_or(false)
        });
        crate::paste::set_radial_origin_own_window(own_focus);

        let (cursor_x, cursor_y) = get_cursor_position();

        let scale = radial_ui_scale(app);
        let margin = crate::WINDOW_SHADOW_MARGIN as f32;

        // 每次打开时按面板尺寸钳制进光标所在显示器工作区（排除任务栏），
        // 再在空间更充裕的一侧一次性预留透明扩展条带（判定口径见
        // decide_radial_strip，唯一事实源）。此后窗口几何在整场交互中
        // 不再变化：展开/收起只切换前端面板挂载与输入区域
        // （set_radial_hit_area），从根源上消除 X11 resize 引起的闪烁帧。
        let monitor = cursor_monitor_info(app, cursor_x, cursor_y);
        let dpi = monitor.map(|(dpi, ..)| dpi).unwrap_or(1.0);
        let win_w =
            ((420.0 + 2.0 * crate::WINDOW_SHADOW_MARGIN) * scale as f64 * dpi).round() as i32;
        let win_h =
            ((650.0 + 2.0 * crate::WINDOW_SHADOW_MARGIN) * scale as f64 * dpi).round() as i32;
        let px = cursor_x - (((210.0 + margin) * scale * dpi as f32) as i32);
        let py = cursor_y - (((24.0 + margin) * scale * dpi as f32) as i32);
        let (px, py) = match monitor {
            Some((_, ax, ay, aw, ah)) => {
                clamp_position_into_work_area((px, py), (win_w, win_h), (ax, ay, aw, ah))
            }
            // 找不到所在显示器时保持旧行为：仅防负坐标。
            None => (px.max(0), py.max(0)),
        };
        let (strip_left, strip_w) = decide_radial_strip(px, win_w, monitor, scale, dpi);
        let win_w_total = win_w + strip_w;

        if let Ok(mut slot) = RADIAL_STRIP.lock() {
            *slot = (strip_left, strip_w, win_w_total, win_h, px, py);
        }

        #[cfg(target_os = "linux")]
        {
            // Linux：窗口按全尺寸常驻，展开/收起只切输入区域（见
            // RADIAL_STRIP 注释）。
            let px_total = if strip_left { px - strip_w } else { px };
            let _ = radial.set_size(tauri::PhysicalSize::new(win_w_total, win_h));
            let _ = radial.set_position(tauri::PhysicalPosition::new(px_total, py));
        }
        #[cfg(not(target_os = "linux"))]
        {
            // Windows：收起态窗口即面板大小，条带不进窗口；展开/收起
            // 由 set_radial_hit_area 以 (px, py) 为锚 resize+move。
            let _ = radial.set_size(tauri::PhysicalSize::new(win_w, win_h));
            let _ = radial.set_position(tauri::PhysicalPosition::new(px, py));
        }
        // 打开即重置为收起形态的输入区域（条带穿透）。
        apply_radial_input_shape(&radial, false);

        // Read theme from DB
        let theme =
            crate::db::get_setting_sync(app, "theme").unwrap_or_else(|| "light".to_string());

        // 呼出前记录焦点所在的托管顶层窗口：收仓时据此把焦点还给呼出
        // 前的应用。必须在抢焦点（raise + pager 激活）之前读取。
        #[cfg(target_os = "linux")]
        RADIAL_PREV_FOCUS.store(x11_focus_toplevel_xid(), Ordering::SeqCst);

        raise_always_on_top(&radial);

        #[cfg(target_os = "linux")]
        RADIAL_MENU_SHOWN.store(true, Ordering::SeqCst);

        // Windows: 快捷键触发时进程在后台，tauri 的 set_focus 会被前台锁
        // 拒绝，菜单拿不到键盘焦点（Escape、失焦自隐藏都会失效），需强制
        // 接管前台。
        #[cfg(target_os = "windows")]
        win_hook::force_focus_window(&radial);

        let preview_side = if strip_left { "left" } else { "right" };
        let preview_width = if dpi > 0.0 {
            (strip_w as f64 / (scale as f64 * dpi)).round() as i32
        } else {
            0
        };
        let _ = app.emit(
            "radial-menu-show",
            serde_json::json!({
                "theme": theme,
                "scale": scale,
                "previewSide": preview_side,
                "previewWidth": preview_width
            }),
        );

        log::info!(
            "[show_radial_menu] shown at ({}, {}) strip={}w={} theme={}",
            px,
            py,
            preview_side,
            preview_width,
            theme
        );
    }
}

// ---- clipboard create dialog ----

// 窗口尺寸均含透明阴影边距（见文件顶部"窗口层级约定"注释）。
const CLIPBOARD_CREATE_DEFAULT_WIDTH: f64 = 560.0 + 2.0 * crate::WINDOW_SHADOW_MARGIN;
const CLIPBOARD_CREATE_DEFAULT_HEIGHT: f64 = 520.0 + 2.0 * crate::WINDOW_SHADOW_MARGIN;
const CLIPBOARD_CREATE_MIN_WIDTH: f64 = 480.0 + 2.0 * crate::WINDOW_SHADOW_MARGIN;
const CLIPBOARD_CREATE_MIN_HEIGHT: f64 = 380.0 + 2.0 * crate::WINDOW_SHADOW_MARGIN;

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
    // Windows: 后台进程的 set_focus 会被前台锁拒绝，强制接管前台保证
    // 窗口可立即键入（见 win_hook::force_focus_window）。
    #[cfg(target_os = "windows")]
    win_hook::force_focus_window(&window);
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
                width: 600.0,
                height: 560.0,
                x: 700,
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
    RADIAL_MENU_ENABLED.store(enabled, Ordering::SeqCst);
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
#[cfg(target_os = "windows")]
pub mod win_hook {
    use super::{show_clipboard_create, show_radial_menu, toggle_window};
    use std::sync::atomic::{AtomicI32, Ordering};
    use std::sync::mpsc;
    use std::sync::{Mutex, OnceLock};

    type Handle = *mut core::ffi::c_void;

    const WH_KEYBOARD_LL: i32 = 13;
    const HC_ACTION: i32 = 0;
    const WM_KEYDOWN: usize = 0x0100;
    const WM_KEYUP: usize = 0x0101;
    const WM_SYSKEYDOWN: usize = 0x0104;
    const WM_SYSKEYUP: usize = 0x0105;
    const VK_SHIFT: i32 = 0x10;
    const VK_CONTROL: i32 = 0x11;
    const VK_MENU: i32 = 0x12;
    const VK_LWIN: i32 = 0x5B;
    const VK_RWIN: i32 = 0x5C;
    const KEYEVENTF_KEYUP: u32 = 0x0002;
    // KBDLLHOOKSTRUCT.flags:事件由本进程/其他进程经 SendInput 注入。
    const LLKHF_INJECTED: u32 = 0x10;
    const WM_TIMER: u32 = 0x0113;
    const WIN_HOOK_TIMER_ID: usize = 1;
    // 看门狗周期(毫秒):定时重装钩子。
    const WIN_HOOK_WATCHDOG_MS: u32 = 30_000;

    type HookProc = unsafe extern "system" fn(i32, usize, isize) -> isize;

    #[repr(C)]
    struct KbdLlHookStruct {
        vk_code: u32,
        scan_code: u32,
        flags: u32,
        time: u32,
        extra_info: usize,
    }

    #[repr(C)]
    struct MsgPoint {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct Msg {
        hwnd: Handle,
        message: u32,
        w_param: usize,
        l_param: isize,
        time: u32,
        pt: MsgPoint,
        l_private: i32,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn SetWindowsHookExW(id_hook: i32, lpfn: HookProc, hmod: Handle, thread_id: u32) -> Handle;
        fn UnhookWindowsHookEx(hhk: Handle) -> i32;
        fn CallNextHookEx(hhk: Handle, n_code: i32, w_param: usize, l_param: isize) -> isize;
        fn GetMessageW(lp_msg: *mut Msg, hwnd: Handle, w_min: u32, w_max: u32) -> i32;
        fn GetAsyncKeyState(v_key: i32) -> i16;
        fn GetModuleHandleW(lp_name: *const u16) -> Handle;
        fn GetForegroundWindow() -> Handle;
        fn GetWindowThreadProcessId(hwnd: Handle, out_pid: *mut u32) -> u32;
        fn SetForegroundWindow(hwnd: Handle) -> i32;
        fn SetFocus(hwnd: Handle) -> Handle;
        fn AttachThreadInput(id_attach: u32, id_attach_to: u32, f_attach: i32) -> i32;
        fn keybd_event(b_vk: u8, b_scan: u8, dw_flags: u32, dw_extra_info: usize);
        fn SetTimer(hwnd: Handle, n_id_event: usize, u_elapse: u32, lp_timer_func: usize) -> usize;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetLastError() -> u32;
        fn GetCurrentThreadId() -> u32;
    }

    #[derive(Clone, Copy, Debug)]
    enum Action {
        ToggleMain,
        RadialMenu,
        ClipboardCreate,
    }

    // 拦截表:虚拟键码 -> 动作;仅当快捷键为纯 Win 组合时填充。
    static COMBOS: Mutex<Vec<(u32, Action)>> = Mutex::new(Vec::new());

    pub fn has_combos() -> bool {
        !COMBOS.lock().unwrap().is_empty()
    }
    // 当前被吞掉键的虚拟键码:键按下时吞掉,对应的抬起事件也要吞掉,
    // 避免裸键抬起泄漏给前台应用。
    static SWALLOWING_VK: Mutex<u32> = Mutex::new(0);
    // 钩子自行统计的按下中 Win 键数量(LWIN/RWIN 各计一):用于清理
    // 抬起事件的计数偏差,不依赖 GetAsyncKeyState 的更新时序。
    // 注意:Win 抬起事件必须放行。Win 按下已透传给系统,若吞掉抬起,
    // 系统会认为 Win 仍被按住,用户之后敲的每个键都变成 Win+键 系统快捷
    // 键,整个键盘表现为"失灵"。"裸 Win 按键弹开始菜单"的问题由
    // dispatch 线程拦截组合键后注入的 Ctrl 点按化解(见 inject_ctrl_tap)。
    static WIN_KEYS_DOWN: AtomicI32 = AtomicI32::new(0);
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    // 钩子回调只入队,动作由常驻分发线程执行:回调里开线程或做耗时操作
    // 会拖慢回调,超过 LowLevelHooksTimeout 后该次按键会被系统跳过,
    // 直接漏给系统热键(表现为原生 Win+V 面板弹出)。
    static ACTION_TX: OnceLock<mpsc::SyncSender<Action>> = OnceLock::new();

    /// 解析快捷键字符串;仅当组合含 Win 修饰键且不含其他修饰键时返回主键虚拟键码。
    pub fn parse_win_combo_vk(shortcut: &str) -> Option<u32> {
        let tokens: Vec<String> = shortcut.split('+').map(|t| t.to_ascii_lowercase()).collect();
        let super_aliases = ["super", "meta", "win", "windows", "cmd", "command"];
        let has_super = tokens.iter().any(|t| super_aliases.contains(&t.as_str()));
        let has_other_mod = tokens
            .iter()
            .any(|t| matches!(t.as_str(), "ctrl" | "control" | "alt" | "option" | "shift"));
        if !has_super || has_other_mod {
            return None;
        }
        vk_from_name(tokens.last()?)
    }

    fn vk_from_name(key: &str) -> Option<u32> {
        let letter = |c: char| Some(c.to_ascii_uppercase() as u32);
        match key {
            "space" => Some(0x20),
            "enter" | "return" => Some(0x0D),
            "tab" => Some(0x09),
            "escape" | "esc" => Some(0x1B),
            "backspace" => Some(0x08),
            "minus" | "-" => Some(0xBD),
            "equal" | "=" => Some(0xBB),
            _ if key.len() == 1 && key.chars().next().unwrap().is_ascii_alphanumeric() => {
                letter(key.chars().next().unwrap())
            }
            // global-hotkey 风格的 Code 名:KeyV、Digit3、Numpad5、F1
            _ if key.len() == 4
                && key.starts_with("key")
                && key.as_bytes()[3].is_ascii_alphabetic() =>
            {
                letter(key.as_bytes()[3] as char)
            }
            _ if key.len() == 6
                && key.starts_with("digit")
                && key.as_bytes()[5].is_ascii_digit() =>
            {
                Some(0x30 + (key.as_bytes()[5] - b'0') as u32)
            }
            _ if key.len() == 7
                && key.starts_with("numpad")
                && key.as_bytes()[6].is_ascii_digit() =>
            {
                Some(0x60 + (key.as_bytes()[6] - b'0') as u32)
            }
            _ if key.len() >= 2
                && key.starts_with('f')
                && key[1..]
                    .parse::<u32>()
                    .map(|n| (1..=24).contains(&n))
                    .unwrap_or(false) =>
            {
                Some(0x6F + key[1..].parse::<u32>().unwrap())
            }
            _ => None,
        }
    }

    /// 依据当前三组快捷键配置重建拦截表;同一键码先到先得。
    /// 原生注册已成功的 Win 组合(如系统剪贴板历史关闭后 Win+V 变为可注册
    /// 的机器)由插件分发,不进拦截表,避免双重触发。
    pub fn refresh_combos(
        main: &str,
        radial: &str,
        clipboard_create: &str,
        app: &tauri::AppHandle,
    ) {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let mut combos = COMBOS.lock().unwrap();
        combos.clear();
        for (shortcut, action) in [
            (main, Action::ToggleMain),
            (radial, Action::RadialMenu),
            (clipboard_create, Action::ClipboardCreate),
        ] {
            if let Some(vk) = parse_win_combo_vk(shortcut) {
                let natively_registered =
                    <tauri_plugin_global_shortcut::Shortcut as std::str::FromStr>::from_str(
                        shortcut,
                    )
                    .map(|parsed| app.global_shortcut().is_registered(parsed))
                    .unwrap_or(false);
                if natively_registered {
                    log::info!("[win_hook] skipping vk 0x{vk:02X} ({shortcut}): registered natively");
                    continue;
                }
                if !combos.iter().any(|(v, _)| *v == vk) {
                    combos.push((vk, action));
                    log::info!("[win_hook] intercepting vk 0x{vk:02X} ({shortcut})");
                }
            }
        }
    }

    /// 借 AttachThreadInput 临时接管前台线程的输入队列后再设前台,
    /// 绕过系统对后台进程的 SetForegroundWindow 限制(前台锁)。
    /// 失败时静默退回,窗口仍会显示,只是可能没有键盘焦点。
    pub fn force_focus_window(window: &tauri::WebviewWindow) {
        let hwnd = match window.hwnd() {
            Ok(h) => h.0 as *mut core::ffi::c_void,
            Err(_) => {
                let _ = window.set_focus();
                return;
            }
        };
        unsafe {
            let fg = GetForegroundWindow();
            let fg_thread = if fg.is_null() {
                0
            } else {
                GetWindowThreadProcessId(fg, core::ptr::null_mut())
            };
            let cur_thread = GetCurrentThreadId();
            let attached = fg_thread != 0
                && fg_thread != cur_thread
                && AttachThreadInput(cur_thread, fg_thread, 1) != 0;
            SetForegroundWindow(hwnd);
            SetFocus(hwnd);
            if attached {
                AttachThreadInput(cur_thread, fg_thread, 0);
            }
        }
        // 同步 tauri 侧的焦点状态(上面的激活已发出 WM_ACTIVATE)
        let _ = window.set_focus();
    }

    /// 安装低级键盘钩子;独立线程泵消息,进程生命周期内常驻。
    pub fn install(app: tauri::AppHandle) {
        if APP.set(app).is_err() {
            return; // 已安装
        }
        // 常驻分发线程:show/hide、强制前台等操作都在这里执行,
        // 钩子回调只做非阻塞入队。
        let (tx, rx) = mpsc::sync_channel::<Action>(16);
        let _ = ACTION_TX.set(tx);
        std::thread::spawn(move || {
            while let Ok(action) = rx.recv() {
                let Some(app) = APP.get() else { continue };
                // 单次动作 panic 不能带走向量分发线程,否则后续所有快捷键
                // 都会静默失效(按键被吞但无事发生)。
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    dispatch(app, action)
                }));
                if let Err(panic) = result {
                    let msg = panic
                        .downcast_ref::<&str>()
                        .map(|s| s.to_string())
                        .or_else(|| panic.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "unknown panic".to_string());
                    log::error!("[win_hook] dispatcher panicked: {msg}");
                }
                // 组合键已被钩子吞掉,但 Win 按下透传给了系统;注入一次
                // 无害的 F15 点按,系统看到 Win 按住期间有其他按键介入,
                //之后的 Win 抬起就不会被当成"裸 Win 按键"弹出开始菜单,
                // Win 抬起因此可以安全放行(避免系统侧 Win 状态卡死)。
                inject_neutral_key_tap();
            }
        });
        std::thread::spawn(|| unsafe {
            let hmod = GetModuleHandleW(core::ptr::null());
            let mut hook = install_hook(hmod);
            if hook.is_null() {
                return;
            }
            SetTimer(
                core::ptr::null_mut(),
                WIN_HOOK_TIMER_ID,
                WIN_HOOK_WATCHDOG_MS,
                0,
            );
            let mut msg: Msg = std::mem::zeroed();
            loop {
                let r = GetMessageW(&mut msg, core::ptr::null_mut(), 0, 0);
                if r <= 0 {
                    log::warn!("[win_hook] pump exited r={} err={}", r, GetLastError());
                    break;
                }
                if msg.message == WM_TIMER {
                    // 看门狗:Windows 会在钩子回调超时后静默移除低级钩子
                    // (无任何通知),表现为快捷键用着用着就失效、按键漏给
                    // 系统热键。定时重装把这种中断自动恢复。
                    UnhookWindowsHookEx(hook);
                    hook = install_hook(hmod);
                }
            }
            UnhookWindowsHookEx(hook);
        });
    }

    fn lookup(vk: u32) -> Option<Action> {
        COMBOS
            .lock()
            .unwrap()
            .iter()
            .find(|(v, _)| *v == vk)
            .map(|(_, a)| *a)
    }

    fn win_held() -> bool {
        unsafe {
            (GetAsyncKeyState(VK_LWIN) as u16 & 0x8000) != 0
                || (GetAsyncKeyState(VK_RWIN) as u16 & 0x8000) != 0
        }
    }

    fn no_other_mods() -> bool {
        unsafe {
            (GetAsyncKeyState(VK_CONTROL) as u16 & 0x8000) == 0
                && (GetAsyncKeyState(VK_MENU) as u16 & 0x8000) == 0
                && (GetAsyncKeyState(VK_SHIFT) as u16 & 0x8000) == 0
        }
    }

    fn dispatch(app: &tauri::AppHandle, action: Action) {
        log::info!("[win_hook] dispatching {:?}", action);
        match action {
            Action::ToggleMain => toggle_window(app),
            Action::RadialMenu => show_radial_menu(app),
            Action::ClipboardCreate => show_clipboard_create(app, None, None),
        }
    }

    /// 注入一次无害的 F15 点按(按下+抬起)。拦截组合键后由分发线程调用:
    /// 系统看到 Win 按住期间有其他按键介入,之后的 Win 抋起便不会触发
    /// 开始菜单,Win 抛起因此可以安全放行。选 F15 而非 Ctrl:Ctrl 点按会
    /// 与用户未松开的 Shift 组成 Ctrl+Shift(Windows 默认的输入法/布局
    /// 切换键,表现为"快捷键一用输入法就被切走");F15 无任何系统绑定,
    /// 且注入事件经 LLKHF_INJECTED 过滤直接放行,不会被本钩子自吞。
    fn inject_neutral_key_tap() {
        const VK_F15: u8 = 0x7E;
        unsafe {
            keybd_event(VK_F15, 0, 0, 0);
            keybd_event(VK_F15, 0, KEYEVENTF_KEYUP, 0);
        }
    }

    unsafe fn install_hook(hmod: Handle) -> Handle {
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, hook_proc, hmod, 0);
        if hook.is_null() {
            log::error!("[win_hook] SetWindowsHookExW failed");
        } else {
            log::info!("[win_hook] low-level keyboard hook installed");
        }
        hook
    }

    unsafe extern "system" fn hook_proc(n_code: i32, w_param: usize, l_param: isize) -> isize {
        if n_code == HC_ACTION {
            let kb = &*(l_param as *const KbdLlHookStruct);
            // 注入事件(本应用自己的粘贴/焦点注入、AHK 等)一律放行:
            // 钩子只拦物理键盘,否则应用内部的合成按键会被自己吞掉,
            // 按住 Win 期间触发粘贴注入时还会误触发快捷键。
            if kb.flags & LLKHF_INJECTED != 0 {
                return CallNextHookEx(core::ptr::null_mut(), n_code, w_param, l_param);
            }
            let is_down = w_param == WM_KEYDOWN || w_param == WM_SYSKEYDOWN;
            let is_up = w_param == WM_KEYUP || w_param == WM_SYSKEYUP;
            let is_win_key = kb.vk_code == VK_LWIN as u32 || kb.vk_code == VK_RWIN as u32;
            let mut swallowing = SWALLOWING_VK.lock().unwrap();

            if is_win_key {
                if is_down {
                    WIN_KEYS_DOWN.fetch_add(1, Ordering::SeqCst);
                } else if is_up {
                    // Win 抬起必须放行(见 WIN_KEYS_DOWN 处的说明):
                    // 系统侧的 Win 状态靠这条抬起事件复位。
                    let prev = WIN_KEYS_DOWN.fetch_sub(1, Ordering::SeqCst);
                    if prev <= 1 {
                        WIN_KEYS_DOWN.store(0, Ordering::SeqCst);
                    }
                    log::info!("[win_hook][dbg] pass win-up prev={prev}");
                }
            } else if is_down && win_held() && no_other_mods() {
                if let Some(action) = lookup(kb.vk_code) {
                    if *swallowing == kb.vk_code {
                        // 按住不放产生的自动重复:吞掉但不重复触发动作。
                        log::info!("[win_hook][dbg] autorepeat swallowed");
                        return 1;
                    }
                    *swallowing = kb.vk_code;
                    drop(swallowing);
                    if let Some(tx) = ACTION_TX.get() {
                        match tx.try_send(action) {
                            Ok(()) => log::info!("[win_hook][dbg] queued {action:?}"),
                            Err(e) => log::error!("[win_hook][dbg] queue FAILED: {e}"),
                        }
                    } else {
                        log::error!("[win_hook][dbg] ACTION_TX missing");
                    }
                    return 1; // 吞掉按键,系统组件收不到
                }
            } else if is_up && *swallowing == kb.vk_code {
                *swallowing = 0;
                return 1;
            }
        }
        CallNextHookEx(core::ptr::null_mut(), n_code, w_param, l_param)
    }
}

#[cfg(test)]
mod tests {
    use super::clamp_position_into_work_area;

    #[test]
    fn keeps_preferred_position_inside_work_area() {
        assert_eq!(
            clamp_position_into_work_area((800, 300), (460, 690), (0, 0, 1920, 1040)),
            (800, 300)
        );
    }

    #[test]
    fn pulls_window_back_inside_the_right_and_bottom_edges() {
        // 光标贴右下角唤起：菜单右/下边缘与工作区对齐（截图反馈的场景）。
        assert_eq!(
            clamp_position_into_work_area((1700, 500), (460, 690), (0, 0, 1920, 1040)),
            (1460, 350)
        );
    }

    #[test]
    fn keeps_window_inside_work_area_origin_on_top_left() {
        assert_eq!(
            clamp_position_into_work_area((-100, -50), (460, 690), (0, 0, 1920, 1040)),
            (0, 0)
        );
    }

    #[test]
    fn anchors_at_work_area_origin_when_window_is_larger_than_area() {
        // 200% 缩放放到小屏：允许溢出，但左上角对齐工作区。
        assert_eq!(
            clamp_position_into_work_area((100, 100), (460, 690), (0, 0, 400, 300)),
            (0, 0)
        );
    }

    #[test]
    fn respects_work_area_offset_for_secondary_monitor() {
        // 副屏在主屏左侧（负原点）时按该屏工作区钳制。
        assert_eq!(
            clamp_position_into_work_area((-2500, 1200), (460, 690), (-1920, 0, 1920, 1040)),
            (-1920, 350)
        );
    }
}

#[cfg(test)]
mod radial_strip_tests {
    use super::decide_radial_strip;

    const MONITOR: Option<(f64, i32, i32, i32, i32)> = Some((1.0, 0, 0, 1920, 1040));

    #[test]
    fn expands_right_when_space_remains() {
        // 右侧剩余 1260 ≥ 最小条带 260：向右，宽度取期望值 440。
        assert_eq!(decide_radial_strip(200, 460, MONITOR, 1.0, 1.0), (false, 440));
    }

    #[test]
    fn expands_left_near_right_edge() {
        // 贴右缘（右侧仅剩负空间）时向左，面板自身位置不动。
        assert_eq!(decide_radial_strip(1500, 460, MONITOR, 1.0, 1.0), (true, 440));
    }

    #[test]
    fn uses_remaining_space_on_constrained_work_area() {
        // 工作区放不下整条：右侧剩 90（不足最小条带但比左侧宽），
        // 向右并压缩到 90。
        assert_eq!(
            decide_radial_strip(50, 460, Some((1.0, 0, 0, 600, 1040)), 1.0, 1.0),
            (false, 90)
        );
    }

    #[test]
    fn clamps_left_width_to_available_left_space() {
        // 左向扩展时宽度被左侧空间钳制：右侧 -240，左侧 300。
        assert_eq!(
            decide_radial_strip(300, 460, Some((1.0, 0, 0, 520, 1040)), 1.0, 1.0),
            (true, 300)
        );
    }

    #[test]
    fn scales_strip_with_ui_scale_and_dpi() {
        // 期望/最小宽度都随 uiScale × dpi 放大：440×1.5×2=1320。
        assert_eq!(
            decide_radial_strip(100, 1380, Some((2.0, 0, 0, 5000, 1040)), 1.5, 2.0),
            (false, 1320)
        );
    }

    #[test]
    fn keeps_integral_strip_under_fractional_ui_scale() {
        // 设置项 80% 的实际存储值带 f32 残渣（0.800000011920929）：
        // 440×…=352.000005…、260×…=208.000006…，round 后必须是整洁
        // 物理值 352/208，否则与窗口几何的整数世界对不上。
        let ui_scale = 0.800_000_011_920_929_f32;
        assert_eq!(
            decide_radial_strip(200, 368, MONITOR, ui_scale, 1.0),
            (false, 352)
        );
    }

    #[test]
    fn prefers_right_without_monitor_info() {
        // 找不到所在显示器时保持旧行为：按期望宽度向右。
        assert_eq!(decide_radial_strip(200, 460, None, 1.0, 1.0), (false, 440));
    }
}
