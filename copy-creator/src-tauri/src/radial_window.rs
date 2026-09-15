// 径向菜单窗口域（A2 拆分）：几何 / 层级 / 停泊 / X11 激活与条带决策。
// 从 shortcut.rs 机械搬迁；实现与行为不变。
use enigo::{Enigo, Mouse, Settings};
use std::process::Command;
#[cfg(target_os = "windows")]
use crate::win_hook;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

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

/// RADIAL_MENU_ENABLED 的唯一写入口（A3 收敛）：快捷键装载/设置命令经此翻转。
pub(crate) fn set_radial_menu_enabled_flag(enabled: bool) {
    RADIAL_MENU_ENABLED.store(enabled, Ordering::SeqCst);
}

/// RADIAL_MENU_SHOWN / RADIAL_MENU_ENABLED 的唯一读入口（A3 收敛）。
/// Linux 常驻模型以标志为准判断显示态；Windows 直接查 is_visible。
#[cfg(target_os = "linux")]
pub(crate) fn radial_menu_shown() -> bool {
    RADIAL_MENU_SHOWN.load(Ordering::SeqCst)
}


/// RADIAL_MENU_SHOWN 的唯一写入口（A3 收敛）：显示/隐藏/停泊流程经此翻转。
pub(crate) fn set_radial_menu_shown(shown: bool) {
    RADIAL_MENU_SHOWN.store(shown, Ordering::SeqCst);
}

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

/// 呼出前持有焦点的**托管顶层**窗口 id（0 = 未知）。收仓时若径向窗口
/// 仍是活动窗口（快捷键二次按压/Escape），把焦点还给呼出前的窗口；
/// 用户已点击其他窗口（失焦自隐藏）则不抢回。仅 Linux 常驻模型使用。
#[cfg(target_os = "linux")]
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
            // parent == cur（自引用）只可能是异常窗口树，防死循环。
            if parent == root || parent == cur {
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

/// 主线程内读取给定 GTK 窗口的 X xid（GDK 调用）；无法获取返回 0。
#[cfg(target_os = "linux")]
fn gtk_window_xid_on_main(gtk_window: &gtk::ApplicationWindow) -> u32 {
    use gtk::prelude::*;
    use std::os::raw::{c_ulong, c_void};
    #[link(name = "gdk-3")]
    extern "C" {
        fn gdk_x11_window_get_xid(window: *mut c_void) -> c_ulong;
    }
    let Some(gdk_window) = gtk_window.window() else {
        return 0;
    };
    let stash = <gtk::gdk::Window as gtk::glib::translate::ToGlibPtr<
        '_,
        *mut gtk::gdk::ffi::GdkWindow,
    >>::to_glib_none(&gdk_window);
    unsafe { gdk_x11_window_get_xid(stash.0 as *mut c_void) as u32 }
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
    set_radial_menu_shown(false);
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
            // 隐藏）时 is_active 为 false，自然不抢回焦点。prev 等于
            // 径向自身（异步激活间隙被污染）时拒绝归还，否则焦点永远
            // 锁死在不可见窗口上。
            let own_xid = gtk_window_xid_on_main(&gtk_window);
            if gtk_window.is_active() && prev != 0 && prev != own_xid {
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

pub(crate) fn raise_always_on_top(window: &tauri::WebviewWindow) {
    raise_always_on_top_without_focus(window);
    let _ = window.set_focus();
    // X11 下 set_focus 会被 mutter 防抢占策略拒绝（焦点窗口压制约束），
    // 改以 pager 激活消息确保焦点与置顶同时生效。
    #[cfg(target_os = "linux")]
    activate_window_via_x11(window);
}

pub(crate) fn has_visible_popup_window(app: &AppHandle) -> bool {
    if let Some(create) = app.get_webview_window("clipboard-create") {
        if create.is_visible().unwrap_or(false) {
            return true;
        }
    }
    // Linux 常驻模型下径向窗口 is_visible 恒为 true（停泊也算可见），
    // 必须查显示状态标志，否则主窗口显示时永远拿不到键盘焦点（见
    // show_main_window 对本函数的用法）。
    #[cfg(target_os = "linux")]
    {
        radial_menu_shown()
    }
    #[cfg(not(target_os = "linux"))]
    {
        app.get_webview_window("radial-menu")
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false)
    }
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
        // Linux 常驻模型下 is_visible 恒为 true（常驻映射的停泊态也算
        // 可见），必须查显示状态标志，否则会把不可见的停泊窗口抬升并
        // 抢走焦点。
        #[cfg(target_os = "linux")]
        let radial_shown = radial_menu_shown();
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
        let visible_now = radial_menu_shown();
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
                // 显示状态即刻翻转：后续的停泊守卫（等待期间若重新呼出
                // 则放弃停泊）依赖它已为 false，否则守卫自身会把停泊
                // 整体跳过。
                set_radial_menu_shown(false);
                let _ = app.emit("radial-menu-hide", ());
                let task = app.clone();
                std::thread::spawn(move || {
                    // 170ms = 退场动画 110ms + 余量：停泊必须在动画播完
                    // 之后，否则最后一帧停在半途被截断（实测 140ms 时收
                    // 到 89% 尺寸半透明即消失，观感生硬）。等待期间用户
                    // 可能已再次呼出（快速连按切换）：已重新显示则放弃
                    // 停泊，否则会把刚弹出的菜单原地清掉输入和焦点。
                    if radial_menu_shown() {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(170));
                    if radial_menu_shown() {
                        return;
                    }
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
        // 前的应用。必须在抢焦点（raise + pager 激活）之前读取。径向
        // 窗口本就持焦时（快速"隐藏→再呼出"竞态，停泊尚未执行）不覆盖
        // ——否则 prev 被写成径向自身，收起时会"还给自己"。
        #[cfg(target_os = "linux")]
        if !radial.is_focused().unwrap_or(false) {
            RADIAL_PREV_FOCUS.store(x11_focus_toplevel_xid(), Ordering::SeqCst);
        }

        raise_always_on_top(&radial);

        #[cfg(target_os = "linux")]
        set_radial_menu_shown(true);

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
