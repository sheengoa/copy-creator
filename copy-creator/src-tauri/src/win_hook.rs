// Windows 低级键盘钩子（A2 拆分，cfg(windows)）：抢在系统热键前识别
// 含 Win 修饰键的自定义快捷键并分发。从 shortcut.rs 机械搬迁。

use crate::shortcut::{show_clipboard_create, show_radial_menu, toggle_window};
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
