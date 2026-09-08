use std::sync::atomic::{AtomicBool, Ordering};

pub static PASTING: AtomicBool = AtomicBool::new(false);

/// 径向菜单呼出那一刻，焦点是否在本应用窗口上（主窗口 / 新建弹窗）。
/// 为 true 且径向菜单仍可见时，粘贴目标是自家编辑器：defocus 不能把
/// 主窗口藏掉，否则用户看到的是“一点内容整个窗口就消失”，Ctrl+V 也
/// 会因为焦点无处可落而失效。每次 show_radial_menu 都会刷新此标记。
pub static RADIAL_ORIGIN_OWN_WINDOW: AtomicBool = AtomicBool::new(false);

pub fn set_radial_origin_own_window(value: bool) {
    RADIAL_ORIGIN_OWN_WINDOW.store(value, Ordering::SeqCst);
}

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

struct CachedImage {
    rgba: Arc<Vec<u8>>,
    width: u32,
    height: u32,
}

struct ImageCache {
    map: HashMap<String, CachedImage>,
    order: Vec<String>,
    total_bytes: usize,
}

static IMAGE_CACHE: OnceLock<Mutex<ImageCache>> = OnceLock::new();
const IMAGE_CACHE_MAX_ENTRIES: usize = 30;
const IMAGE_CACHE_MAX_BYTES: usize = 128 * 1024 * 1024;
pub(crate) const STASH_IMAGE_PLACEHOLDER: char = '\u{FFFC}';
const STASH_SEGMENT_DELAY_MS: u64 = 180;

fn get_image_cache() -> &'static Mutex<ImageCache> {
    IMAGE_CACHE.get_or_init(|| {
        Mutex::new(ImageCache {
            map: HashMap::new(),
            order: Vec::new(),
            total_bytes: 0,
        })
    })
}

struct PasteGuard;

impl Drop for PasteGuard {
    fn drop(&mut self) {
        PASTING.store(false, Ordering::SeqCst);
    }
}

pub fn cache_image(path: String, rgba: Vec<u8>, width: u32, height: u32) {
    let image_bytes = rgba.len();
    if image_bytes > IMAGE_CACHE_MAX_BYTES {
        return;
    }
    let mut cache = get_image_cache().lock().unwrap();
    if let Some(previous) = cache.map.remove(&path) {
        cache.total_bytes = cache.total_bytes.saturating_sub(previous.rgba.len());
        cache.order.retain(|item| item != &path);
    }
    while cache.map.len() >= IMAGE_CACHE_MAX_ENTRIES
        || cache.total_bytes + image_bytes > IMAGE_CACHE_MAX_BYTES
    {
        if cache.order.is_empty() {
            break;
        }
        let evicted = cache.order.remove(0);
        if let Some(previous) = cache.map.remove(&evicted) {
            cache.total_bytes = cache.total_bytes.saturating_sub(previous.rgba.len());
        }
    }
    cache.order.push(path.clone());
    cache.total_bytes += image_bytes;
    cache.map.insert(
        path,
        CachedImage {
            rgba: Arc::new(rgba),
            width,
            height,
        },
    );
}

pub(crate) fn remove_cached_images(paths: &[String]) {
    let mut cache = get_image_cache().lock().unwrap();
    for path in paths {
        if let Some(previous) = cache.map.remove(path) {
            cache.total_bytes = cache.total_bytes.saturating_sub(previous.rgba.len());
        }
    }
    let remaining: std::collections::HashSet<String> = cache.map.keys().cloned().collect();
    cache.order.retain(|path| remaining.contains(path));
}

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::process::Command;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PasteShortcut {
    CtrlV,
    CtrlShiftV,
}

// ── Environment detection ───────────────────────────────────────

/// Whether we are running under a Wayland compositor.
fn is_wayland() -> bool {
    std::env::var("WAYLAND_DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

/// Whether we are running under X11.
fn is_x11() -> bool {
    std::env::var("DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

/// Try to locate an executable in PATH.
fn which(cmd: &str) -> Option<String> {
    Command::new("which")
        .arg(cmd)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// Check whether ydotool daemon is reachable (ydotool needs ydotoold running).
fn ydotool_available() -> bool {
    which("ydotool").is_some()
}

// ── Keystroke simulation ────────────────────────────────────────

/// Inject Ctrl+Shift+V via ydotool (kernel-level uinput — works on all
/// Wayland compositors including GNOME/Mutter).
///
/// Keycodes: 29=LCtrl 42=LShift 47=V
/// :1 = press, :0 = release
fn ydotool_ctrl_shift_v() -> Result<(), String> {
    let status = Command::new("ydotool")
        .args(["key", "29:1", "42:1", "47:1", "47:0", "42:0", "29:0"])
        .status()
        .map_err(|e| format!("ydotool spawn failed: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("ydotool exited with {status}"))
    }
}

/// Inject Ctrl+V via ydotool.
fn ydotool_ctrl_v() -> Result<(), String> {
    let status = Command::new("ydotool")
        .args(["key", "29:1", "47:1", "47:0", "29:0"])
        .status()
        .map_err(|e| format!("ydotool spawn failed: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("ydotool exited with {status}"))
    }
}

/// Inject Ctrl+Shift+V via enigo.
fn enigo_ctrl_shift_v() -> Result<(), String> {
    // SendInput(Win32) 是原子注入队列，按键间无需长沉降；
    // Linux 的 enigo 后端依赖现有节奏，维持原值。
    #[cfg(target_os = "windows")]
    const MODIFIER_SETTLE_MS: u64 = 5;
    #[cfg(not(target_os = "windows"))]
    const MODIFIER_SETTLE_MS: u64 = 20;
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {e}"))?;
    enigo
        .key(Key::Control, Direction::Press)
        .map_err(|e| format!("enigo ctrl press: {e}"))?;
    enigo
        .key(Key::Shift, Direction::Press)
        .map_err(|e| format!("enigo shift press: {e}"))?;
    thread::sleep(Duration::from_millis(MODIFIER_SETTLE_MS));
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| format!("enigo v click: {e}"))?;
    thread::sleep(Duration::from_millis(10));
    enigo
        .key(Key::Shift, Direction::Release)
        .map_err(|e| format!("enigo shift release: {e}"))?;
    enigo
        .key(Key::Control, Direction::Release)
        .map_err(|e| format!("enigo ctrl release: {e}"))?;
    Ok(())
}

/// Inject Ctrl+V via enigo.
fn enigo_ctrl_v() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    const MODIFIER_SETTLE_MS: u64 = 5;
    #[cfg(not(target_os = "windows"))]
    const MODIFIER_SETTLE_MS: u64 = 30;
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {e}"))?;
    enigo
        .key(Key::Control, Direction::Press)
        .map_err(|e| format!("enigo ctrl press: {e}"))?;
    thread::sleep(Duration::from_millis(MODIFIER_SETTLE_MS));
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| format!("enigo v click: {e}"))?;
    thread::sleep(Duration::from_millis(10));
    enigo
        .key(Key::Control, Direction::Release)
        .map_err(|e| format!("enigo ctrl release: {e}"))?;
    Ok(())
}

/// Inject Ctrl+V via xdotool.
fn xdotool_ctrl_v() -> Result<(), String> {
    let status = Command::new("xdotool")
        .args(["key", "--clearmodifiers", "ctrl+v"])
        .status()
        .map_err(|e| format!("xdotool spawn failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("xdotool exited with {status}"))
    }
}

/// Inject Ctrl+Shift+V via xdotool.
fn xdotool_ctrl_shift_v() -> Result<(), String> {
    let status = Command::new("xdotool")
        .args(["key", "--clearmodifiers", "ctrl+shift+v"])
        .status()
        .map_err(|e| format!("xdotool spawn failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("xdotool exited with {status}"))
    }
}

/// Inject Ctrl+V via wtype.
fn wtype_ctrl_v() -> Result<(), String> {
    let status = Command::new("wtype")
        .args(["-M", "ctrl", "-k", "v"])
        .status()
        .map_err(|e| format!("wtype spawn failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("wtype exited with {status}"))
    }
}

/// Inject Ctrl+Shift+V via wtype.
fn wtype_ctrl_shift_v() -> Result<(), String> {
    let status = Command::new("wtype")
        .args(["-M", "ctrl", "-M", "shift", "-k", "v"])
        .status()
        .map_err(|e| format!("wtype spawn failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("wtype exited with {status}"))
    }
}

// ── Unified paste entry-point ───────────────────────────────────

/// Run the best available keystroke injection method using the
/// shortcut selected for the target app. Terminals use Ctrl+Shift+V;
/// regular document editors and file managers use Ctrl+V.
// Windows 分支以 cfg 块提前 return，其后仅 Linux 可达的注入分支在
// Windows 编译时会触发 unreachable_code；Linux 上它们是正常路径。
#[allow(unreachable_code)]
fn inject_paste_with_shortcut(shortcut: PasteShortcut) {
    log::info!("[paste] inject_paste_with_shortcut: {:?}", shortcut);

    // Windows 没有 Wayland/X11 概念，enigo 直接走 Win32 SendInput；
    // 必须在显示服务器检测之前处理，否则会误报
    // "cannot detect display server" 并多余地探测一遍 Linux 工具。
    #[cfg(target_os = "windows")]
    {
        let result = match shortcut {
            PasteShortcut::CtrlShiftV => enigo_ctrl_shift_v(),
            PasteShortcut::CtrlV => enigo_ctrl_v(),
        };
        if let Err(e) = result {
            log::warn!("enigo paste failed: {e}");
        }
        return;
    }

    if is_wayland() && ydotool_available() {
        // Wayland + ydotool: the most reliable combination on all compositors
        match shortcut {
            PasteShortcut::CtrlShiftV => {
                if let Err(e) = ydotool_ctrl_shift_v() {
                    log::warn!("ydotool Ctrl+Shift+V failed: {e}");
                }
            }
            PasteShortcut::CtrlV => {
                if let Err(e) = ydotool_ctrl_v() {
                    log::warn!("ydotool Ctrl+V failed: {e}");
                }
            }
        }
        return;
    }

    if is_wayland() {
        // Wayland without ydotool — try wtype (wlroots only), then enigo
        if which("wtype").is_some() {
            let result = match shortcut {
                PasteShortcut::CtrlShiftV => wtype_ctrl_shift_v(),
                PasteShortcut::CtrlV => wtype_ctrl_v(),
            };
            match result {
                Ok(()) => return,
                Err(e) => log::warn!("wtype paste failed: {e}"),
            }
        }

        // Last resort: enigo (only works on XWayland or with older enigo)
        let result = match shortcut {
            PasteShortcut::CtrlShiftV => enigo_ctrl_shift_v(),
            PasteShortcut::CtrlV => enigo_ctrl_v(),
        };
        match result {
            Ok(()) => return,
            Err(e) => log::warn!("enigo paste failed on Wayland: {e}"),
        }
        return;
    }

    // X11 path (DISPLAY is set, WAYLAND_DISPLAY is not)
    if is_x11() {
        log::info!("[paste] X11 path — trying enigo for {:?}", shortcut);
        let result = match shortcut {
            PasteShortcut::CtrlShiftV => enigo_ctrl_shift_v(),
            PasteShortcut::CtrlV => enigo_ctrl_v(),
        };
        match result {
            Ok(()) => {
                log::info!("[paste] enigo succeeded for {:?}", shortcut);
                return;
            }
            Err(e) => log::warn!("[paste] enigo failed for {:?}: {e}", shortcut),
        }
        if which("xdotool").is_some() {
            let result = match shortcut {
                PasteShortcut::CtrlShiftV => xdotool_ctrl_shift_v(),
                PasteShortcut::CtrlV => xdotool_ctrl_v(),
            };
            if let Err(e) = result {
                log::warn!("xdotool paste failed: {e}");
            }
        }
        return;
    }

    // Neither Wayland nor X11 detected — try enigo anyway
    log::error!(
        "paste: cannot detect display server (no WAYLAND_DISPLAY, no DISPLAY); \
         paste may not work"
    );
    let _ = match shortcut {
        PasteShortcut::CtrlShiftV => enigo_ctrl_shift_v(),
        PasteShortcut::CtrlV => enigo_ctrl_v(),
    };
}

// ── Diagnostics (called once at startup) ────────────────────────

/// Emit a desktop notification if `notify-send` is available.
pub fn notify(title: &str, body: &str) {
    #[cfg(target_os = "linux")]
    let _ = Command::new("notify-send")
        .args(["--expire-time=5000", title, body])
        .spawn();
    #[cfg(not(target_os = "linux"))]
    {
        // 其他平台的桌面通知尚未实现；调用点仅为 Linux 工具缺失提示。
        let _ = (title, body);
    }
}

/// Run at startup: log the paste environment and warn if no method is
/// available.
pub fn diagnose_paste_environment() {
    let wayland = is_wayland();
    let x11 = is_x11();
    let has_ydotool = ydotool_available();
    let has_xdotool = which("xdotool").is_some();
    let has_wtype = which("wtype").is_some();

    log::info!(
        "Paste environment: wayland={wayland}, x11={x11}, \
         ydotool={has_ydotool}, xdotool={has_xdotool}, wtype={has_wtype}"
    );

    if wayland && !has_ydotool {
        log::warn!(
            "Wayland detected but ydotool is not installed. \
             Install it for reliable paste support: \
             sudo apt install ydotool"
        );
        notify(
            "Copy Creator — 粘贴功能提示",
            "检测到 Wayland 但未安装 ydotool。\n\
             请运行: sudo apt install ydotool\n\
             以确保粘贴功能正常工作。",
        );
    }

    if !wayland && x11 && !has_xdotool {
        log::warn!(
            "X11 detected but xdotool is not installed. \
             Install it for fallback paste support: \
             sudo apt install xdotool"
        );
    }
}

// ── File-paste helpers ──────────────────────────────────────────

/// Write a file list to the system clipboard so Linux apps receive
/// `text/uri-list`, not a plain-text path.
fn write_file_list(paths: &[std::path::PathBuf]) -> Result<(), String> {
    // Windows 资源管理器对 CF_HDROP 里的 `\\?\` 扩展路径前缀兼容性差
    // （粘贴菜单/目标窗口直接忽略），这里统一转回常规路径；UNC 设备
    // 路径（\\?\UNC\host\share）还原为 \\host\share。Linux 分支无此
    // 前缀，不受影响。
    let normalized: Vec<std::path::PathBuf> = paths
        .iter()
        .map(|path| {
            let raw = path.to_string_lossy();
            if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
                std::path::PathBuf::from(format!(r"\\{rest}"))
            } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
                std::path::PathBuf::from(rest)
            } else {
                path.clone()
            }
        })
        .collect();

    // Windows 必须走标准 Win32 序列（EmptyClipboard + CF_HDROP）：
    // arboard 的 file_list 不先清空剪贴板，残留的旧文本格式会让
    // 资源管理器走文本粘贴分支，文件永远粘不进去（实测踩坑）。
    #[cfg(target_os = "windows")]
    {
        write_file_list_windows(&normalized)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| format!("初始化文件剪切板失败: {e:?}"))?;
        clipboard
            .set()
            .file_list(&normalized)
            .map_err(|e| format!("写入文件剪切板失败: {e:?}"))?;
    }
    log::info!(
        "paste_file: wrote file list to clipboard: {} file(s)",
        paths.len()
    );
    Ok(())
}

/// 标准 Win32 CF_HDROP 写入：DROPFILES 结构 + 双 NUL 结尾的宽字符路径表。
#[cfg(target_os = "windows")]
fn write_file_list_windows(paths: &[std::path::PathBuf]) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    const CF_HDROP: u32 = 15;
    const GMEM_MOVEABLE: u32 = 0x0002;
    const GMEM_ZEROINIT: u32 = 0x0040;

    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct DropFiles {
        p_files: u32,
        pt: Point,
        f_nc: u32,
        f_wide: u32,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn OpenClipboard(hwnd_new_owner: *mut core::ffi::c_void) -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(format: u32, data: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
        fn CloseClipboard() -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> *mut core::ffi::c_void;
        fn GlobalLock(h_mem: *mut core::ffi::c_void) -> *mut u8;
        fn GlobalUnlock(h_mem: *mut core::ffi::c_void) -> i32;
        fn GlobalFree(h_mem: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
    }

    // DROPFILES 头 + 路径宽字符 + 双 NUL 结尾。
    let mut data: Vec<u8> = Vec::new();
    let header = DropFiles {
        p_files: std::mem::size_of::<DropFiles>() as u32,
        pt: Point { x: 0, y: 0 },
        f_nc: 0,
        f_wide: 1,
    };
    data.extend_from_slice(unsafe {
        std::slice::from_raw_parts(
            (&header as *const DropFiles) as *const u8,
            std::mem::size_of::<DropFiles>(),
        )
    });
    for path in paths {
        for unit in path.as_os_str().encode_wide() {
            data.extend_from_slice(&unit.to_le_bytes());
        }
        data.extend_from_slice(&[0, 0]);
    }
    data.extend_from_slice(&[0, 0]);

    unsafe {
        if OpenClipboard(core::ptr::null_mut()) == 0 {
            return Err("打开剪贴板失败".to_string());
        }
        if EmptyClipboard() == 0 {
            CloseClipboard();
            return Err("清空剪贴板失败".to_string());
        }
        let handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, data.len());
        if handle.is_null() {
            CloseClipboard();
            return Err("分配剪贴板内存失败".to_string());
        }
        let locked = GlobalLock(handle);
        if locked.is_null() {
            CloseClipboard();
            GlobalFree(handle);
            return Err("锁定剪贴板内存失败".to_string());
        }
        std::ptr::copy_nonoverlapping(data.as_ptr(), locked, data.len());
        GlobalUnlock(handle);
        // 成功后系统接管 handle，不再释放；失败时系统未接管，需自行归还。
        if SetClipboardData(CF_HDROP, handle).is_null() {
            CloseClipboard();
            GlobalFree(handle);
            return Err("写入 CF_HDROP 失败".to_string());
        }
        if CloseClipboard() == 0 {
            return Err("关闭剪贴板失败".to_string());
        }
    }
    Ok(())
}

/// 窗口隐藏后的合成器沉降时间：等待焦点切回先前激活的窗口。
/// 200 ms 在 GNOME/Wayland 与 X11 上均已实测足够。
/// Windows 走焦点轮询，不需要固定沉降值。
#[cfg(not(target_os = "windows"))]
const DEFOCUS_SETTLE_MS: u64 = 200;

/// Windows 上轮询等待"焦点已离开本进程"的上限：目标窗口通常在隐藏后
/// 10-40ms 内成为前台，轮询命中即刻注入，避免盲等 Linux 沉降时间。
#[cfg(target_os = "windows")]
const DEFOCUS_POLL_TIMEOUT_MS: u64 = 150;
/// 等待用户松开残留修饰键（如 Shift+单击后的 Shift）的上限。
const STRAY_MODIFIER_WAIT_MS: u64 = 400;

/// Windows: 轮询 GetForegroundWindow，直到前台进程不再是本进程
/// （粘贴目标已接管焦点）或超时。粘贴目标为本应用自家窗口时，
/// 前台始终是本进程，行为退化为等待上限——仍优于原固定 200ms。
#[cfg(target_os = "windows")]
fn wait_paste_target_ready(timeout_ms: u64) {
    use std::time::Instant;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetForegroundWindow() -> *mut core::ffi::c_void;
        fn GetWindowThreadProcessId(hwnd: *mut core::ffi::c_void, out_pid: *mut u32) -> u32;
    }

    let our_pid = std::process::id();
    let start = Instant::now();
    while start.elapsed().as_millis() < timeout_ms as u128 {
        unsafe {
            let foreground = GetForegroundWindow();
            if !foreground.is_null() {
                let mut pid = 0_u32;
                GetWindowThreadProcessId(foreground, &mut pid);
                if pid != our_pid {
                    log::info!("[paste] focus left our process after {}ms", start.elapsed().as_millis());
                    return;
                }
            }
        }
        thread::sleep(Duration::from_millis(5));
    }
    log::info!("[paste] focus wait timed out after {}ms", start.elapsed().as_millis());
}

/// 隐藏本应用窗口，让合成器/系统把焦点交还给目标窗口。
/// 返回 true 表示粘贴目标是本应用自家窗口（主窗口保持可见且获得焦点）。
fn defocus_windows(app: &AppHandle) -> Result<bool, String> {
    // Hide radial popup if visible.  When pasting from the radial menu
    // itself the frontend has already issued a hide, so this is a fast
    // no-op in the common case — but it is a safety net for edge cases
    // where the popup was left open.
    let radial = app.get_webview_window("radial-menu");
    if let Some(radial) = radial {
        let _ = radial.hide();
    }

    // 粘贴目标判定只用呼出时刻的标志，不依赖径向菜单当下的可见性：
    // 前端现在"先藏菜单再触发粘贴"，可见性检查存在竞态。标志在每次
    // show_radial_menu 刷新——从主窗口页面直接粘贴时它即使残留为 true，
    // 焦点本就在主窗口，保留主窗口同样是正确行为。
    let paste_into_own_window = RADIAL_ORIGIN_OWN_WINDOW.load(Ordering::SeqCst);
    log::info!("[paste] defocus: paste_into_own={paste_into_own_window}");

    if !paste_into_own_window {
        let window = app.get_webview_window("main").ok_or("no window")?;

        let is_pinned = window.is_always_on_top().unwrap_or(false);
        log::info!(
            "[paste] defocus: main pinned={is_pinned} -> {}",
            if is_pinned { "keep visible" } else { "hide" }
        );
        if !is_pinned {
            window.hide().map_err(|e| e.to_string())?;
        }
    }

    Ok(paste_into_own_window)
}

fn paste_with_defocus(app: &AppHandle, shortcut: PasteShortcut) -> Result<(), String> {
    let paste_into_own_window = defocus_windows(app)?;

    #[cfg(target_os = "windows")]
    {
        // 自家窗口粘贴时焦点本就正确，无需等待焦点切换。
        if !paste_into_own_window {
            wait_paste_target_ready(DEFOCUS_POLL_TIMEOUT_MS);
        }
        // 焦点进程切换后，目标窗口内部的输入焦点（子控件）仍在恢复，
        // 立刻注入会被吞掉（实测文件粘贴因此丢失）；给一个短沉降窗。
        thread::sleep(Duration::from_millis(120));
        // Shift+单击等手势触发粘贴时，物理 Shift 常仍被按住，会把合成
        // Ctrl+V 叠加成 Ctrl+Shift+V 而被目标应用忽略（实测整组粘贴失效）。
        release_stray_modifiers(shortcut);
    }
    #[cfg(not(target_os = "windows"))]
    thread::sleep(Duration::from_millis(DEFOCUS_SETTLE_MS));

    inject_paste_with_shortcut(shortcut);

    Ok(())
}

/// Windows：注入前等待不属于注入组合键的物理修饰键释放。
/// 等待上限内自然松开最理想（物理按住期间的自动重复随时会再按下，
/// 合成释放不保险）；超时仍被按住则发送合成释放兜底，保证注入必然发生。
#[cfg(target_os = "windows")]
fn release_stray_modifiers(shortcut: PasteShortcut) {
    use std::time::Instant;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetAsyncKeyState(v_key: i32) -> i16;
        fn keybd_event(b_vk: u8, b_scan: u8, dw_flags: u32, dw_extra_info: usize);
    }

    const VK_SHIFT: i32 = 0x10;
    const VK_MENU: i32 = 0x12;
    const VK_LSHIFT: i32 = 0xA0;
    const VK_RSHIFT: i32 = 0xA1;
    const VK_LMENU: i32 = 0xA4;
    const VK_RMENU: i32 = 0xA5;
    const VK_LWIN: i32 = 0x5B;
    const VK_RWIN: i32 = 0x5C;
    const KEYEVENTF_KEYUP: u32 = 0x0002;

    // 注入组合键自身包含的修饰键（Ctrl、终端粘贴所需的 Shift）不清理。
    let stray: &[i32] = match shortcut {
        PasteShortcut::CtrlV => &[
            VK_SHIFT, VK_LSHIFT, VK_RSHIFT, VK_MENU, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN,
        ],
        PasteShortcut::CtrlShiftV => &[VK_MENU, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN],
    };
    let is_down = |vk: i32| unsafe { GetAsyncKeyState(vk) as u16 & 0x8000 != 0 };

    let start = Instant::now();
    while stray.iter().any(|vk| is_down(*vk)) {
        if start.elapsed().as_millis() >= STRAY_MODIFIER_WAIT_MS as u128 {
            for vk in stray {
                if is_down(*vk) {
                    unsafe { keybd_event(*vk as u8, 0, KEYEVENTF_KEYUP, 0) };
                }
            }
            thread::sleep(Duration::from_millis(10));
            log::warn!(
                "[paste] stray modifiers still held after {STRAY_MODIFIER_WAIT_MS}ms; sent synthetic releases"
            );
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let elapsed = start.elapsed().as_millis();
    if elapsed > 0 {
        log::info!("[paste] stray modifiers released after {elapsed}ms");
    }
}

#[derive(Debug, PartialEq, Eq)]
enum StashSegment {
    Text(String),
    Image(String),
}

fn parse_stash_segments(content: &str, images: &[String]) -> Result<Vec<StashSegment>, String> {
    if content.contains(STASH_IMAGE_PLACEHOLDER) {
        let placeholder_count = content
            .chars()
            .filter(|character| *character == STASH_IMAGE_PLACEHOLDER)
            .count();
        if placeholder_count != images.len() {
            return Err(format!(
                "暂存内容中的图片位置数量为 {placeholder_count}，附件数量为 {}",
                images.len()
            ));
        }
        return parse_stash_segments_with_tokens(
            content,
            images,
            std::iter::repeat(STASH_IMAGE_PLACEHOLDER.to_string()).take(images.len()),
        );
    }

    parse_stash_segments_with_tokens(
        content,
        images,
        (1..=images.len()).map(|index| format!("[Image #{index}]")),
    )
}

fn parse_stash_segments_with_tokens(
    content: &str,
    images: &[String],
    tokens: impl Iterator<Item = String>,
) -> Result<Vec<StashSegment>, String> {
    let mut segments = Vec::new();
    let mut remaining = content;
    for (path, token) in images.iter().zip(tokens) {
        let position = remaining
            .find(&token)
            .ok_or_else(|| format!("暂存内容缺少图片占位符 {token}"))?;
        let text = &remaining[..position];
        if !text.is_empty() {
            segments.push(StashSegment::Text(text.to_string()));
        }
        segments.push(StashSegment::Image(path.clone()));
        remaining = &remaining[position + token.len()..];
    }
    if !remaining.is_empty() {
        segments.push(StashSegment::Text(remaining.to_string()));
    }
    Ok(segments)
}

/// 解码任意常见格式（PNG/JPEG/WebP/GIF/BMP）的图片字节为 RGBA 像素。
fn decode_image_bytes(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("解析图片失败: {e}"))?;
    let (width, height) = (img.width(), img.height());
    Ok((img.to_rgba8().into_raw(), width, height))
}

fn write_stored_image(app: &AppHandle, path: &str) -> Result<(), String> {
    let (rgba, width, height) = {
        let cache = get_image_cache().lock().unwrap();
        if let Some(cached) = cache.map.get(path) {
            (cached.rgba.clone(), cached.width, cached.height)
        } else {
            drop(cache);
            let bytes = std::fs::read(crate::db::resolve_storage_path(app, path)?)
                .map_err(|e| format!("读取图片失败: {e}"))?;
            let (rgba, width, height) = decode_image_bytes(&bytes)?;
            cache_image(path.to_string(), rgba.clone(), width, height);
            (Arc::new(rgba), width, height)
        }
    };

    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("初始化图片剪切板失败: {e:?}"))?;
    clipboard
        .set_image(arboard::ImageData {
            width: width as usize,
            height: height as usize,
            bytes: std::borrow::Cow::Borrowed(&rgba),
        })
        .map_err(|e| format!("写入图片剪切板失败: {e:?}"))?;
    crate::clipboard::sync_monitor_image(&rgba);
    Ok(())
}

// ── Tauri commands ──────────────────────────────────────────────

#[tauri::command]
pub fn paste_text(app: AppHandle, text: String) -> Result<(), String> {
    log::info!("[paste] paste_text called — CtrlV (普通粘贴)");
    if PASTING.swap(true, Ordering::SeqCst) {
        log::warn!("[paste] PASTING flag already true, skipping");
        return Ok(());
    }

    if let Err(e) = app.clipboard().write_text(text.clone()) {
        PASTING.store(false, Ordering::SeqCst);
        return Err(e.to_string());
    }

    crate::clipboard::sync_monitor_text(&text);

    let handle = app.clone();
    std::thread::spawn(move || {
        let _guard = PasteGuard;
        paste_with_defocus(&handle, PasteShortcut::CtrlV).ok();
    });

    Ok(())
}

#[tauri::command]
pub fn paste_text_terminal(app: AppHandle, text: String) -> Result<(), String> {
    log::info!("[paste] paste_text_terminal called — CtrlShiftV (终端粘贴)");
    if PASTING.swap(true, Ordering::SeqCst) {
        log::warn!("[paste] PASTING flag already true, skipping");
        return Ok(());
    }

    if let Err(e) = app.clipboard().write_text(text.clone()) {
        PASTING.store(false, Ordering::SeqCst);
        return Err(e.to_string());
    }

    crate::clipboard::sync_monitor_text(&text);

    let handle = app.clone();
    std::thread::spawn(move || {
        let _guard = PasteGuard;
        paste_with_defocus(&handle, PasteShortcut::CtrlShiftV).ok();
    });

    Ok(())
}

#[tauri::command]
pub fn paste_image(app: AppHandle, path: String) -> Result<(), String> {
    if PASTING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        let _guard = PasteGuard;

        if let Err(e) = write_stored_image(&handle, &path) {
            log::error!("paste_image: {e}");
            return;
        }

        // 图像粘贴总是用 Ctrl+V：CLI 工具（Claude Code/Codex）捕获 Ctrl+V 读取剪贴板图像，
        // 普通应用也用 Ctrl+V 粘贴图像。Ctrl+Shift+V 是终端文本粘贴，对图像无效。
        paste_with_defocus(&handle, PasteShortcut::CtrlV).ok();
    });

    Ok(())
}

/// 快捷输入的图像文件预设：读取绝对路径的图片文件，以位图形式写入剪切板后
/// 模拟 Ctrl+V。与 paste_file（文件引用 uri-list）不同，聊天框/编辑器能直接
/// 收到图像内容。解码结果按路径缓存，重复粘贴无需再次解码。
#[tauri::command]
pub fn paste_image_file(app: AppHandle, path: String) -> Result<(), String> {
    if PASTING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    // 同步读文件：失败立刻反馈给前端，且此时窗口尚未隐藏。
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) => {
            PASTING.store(false, Ordering::SeqCst);
            log::error!("paste_image_file: 读取文件失败 {path}: {e}");
            return Err(format!("读取图片文件失败: {e}"));
        }
    };

    let handle = app.clone();
    std::thread::spawn(move || {
        let _guard = PasteGuard;

        // 解码 + 写剪贴板与窗口失焦并行执行：解码是大头（RGBA 转换），
        // 让它与合成器沉降窗口一起跑，总耗时从串行叠加变为两者取大。
        let decode_thread = std::thread::spawn(move || -> Result<(), String> {
            let (rgba, width, height) = {
                let cache = get_image_cache().lock().unwrap();
                if let Some(cached) = cache.map.get(&path) {
                    (cached.rgba.clone(), cached.width, cached.height)
                } else {
                    drop(cache);
                    let (rgba, width, height) = decode_image_bytes(&bytes)?;
                    let rgba = Arc::new(rgba);
                    cache_image(path.clone(), (*rgba).clone(), width, height);
                    (rgba, width, height)
                }
            };

            let mut clipboard =
                arboard::Clipboard::new().map_err(|e| format!("初始化图片剪切板失败: {e:?}"))?;
            clipboard
                .set_image(arboard::ImageData {
                    width: width as usize,
                    height: height as usize,
                    bytes: std::borrow::Cow::Borrowed(&rgba),
                })
                .map_err(|e| format!("写入图片剪切板失败: {e:?}"))?;
            crate::clipboard::sync_monitor_image(&rgba);
            Ok(())
        });

        // Linux 沉降按"defocus 起始"计时；Windows 用焦点轮询，无需起始点。
        #[cfg(not(target_os = "windows"))]
        let defocus_start = std::time::Instant::now();
        let paste_into_own = match defocus_windows(&handle) {
            Ok(own) => own,
            Err(e) => {
                log::error!("paste_image_file: {e}");
                return;
            }
        };
        match decode_thread.join() {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                log::error!("paste_image_file: {e}");
                return;
            }
            Err(join_error) => {
                log::error!("paste_image_file: 解码线程崩溃: {join_error:?}");
                return;
            }
        }

        // 与 paste_with_defocus 相同的沉降策略，减去与解码并行的部分。
        #[cfg(target_os = "windows")]
        {
            if !paste_into_own {
                wait_paste_target_ready(DEFOCUS_POLL_TIMEOUT_MS);
            }
            thread::sleep(Duration::from_millis(120));
        }
        #[cfg(not(target_os = "windows"))]
        {
            let elapsed = defocus_start.elapsed().as_millis() as u64;
            if elapsed < DEFOCUS_SETTLE_MS {
                thread::sleep(Duration::from_millis(DEFOCUS_SETTLE_MS - elapsed));
            }
        }

        // 图像粘贴总是用 Ctrl+V，同 paste_image。
        inject_paste_with_shortcut(PasteShortcut::CtrlV);
    });

    Ok(())
}

#[tauri::command]
pub async fn paste_stash_record(app: AppHandle, id: String, terminal: bool) -> Result<(), String> {
    let (content, attachments) = {
        let state = app.state::<crate::db::DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT content, attachments FROM clipboard_records WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| e.to_string())?
    };
    let images = serde_json::from_str::<Vec<String>>(&attachments).map_err(|e| e.to_string())?;
    let segments = parse_stash_segments(&content, &images)?;

    if PASTING.swap(true, Ordering::SeqCst) {
        return Err("已有粘贴任务正在进行".to_string());
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _guard = PasteGuard;
        if let Some(radial) = handle.get_webview_window("radial-menu") {
            let _ = radial.hide();
        }
        if let Some(window) = handle.get_webview_window("main") {
            if !window.is_always_on_top().unwrap_or(false) {
                let _ = window.hide();
            }
        }
        thread::sleep(Duration::from_millis(200));

        let segment_count = segments.len();
        for (index, segment) in segments.into_iter().enumerate() {
            let result = match segment {
                StashSegment::Text(text) => handle
                    .clipboard()
                    .write_text(text.clone())
                    .map_err(|e| e.to_string())
                    .map(|_| {
                        crate::clipboard::sync_monitor_text(&text);
                        inject_paste_with_shortcut(if terminal {
                            PasteShortcut::CtrlShiftV
                        } else {
                            PasteShortcut::CtrlV
                        });
                    }),
                StashSegment::Image(path) => write_stored_image(&handle, &path).map(|_| {
                    inject_paste_with_shortcut(PasteShortcut::CtrlV);
                }),
            };
            if let Err(e) = result {
                log::error!("paste_stash_record: {e}");
                return Err(e);
            }
            if index + 1 < segment_count {
                thread::sleep(Duration::from_millis(STASH_SEGMENT_DELAY_MS));
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("图文粘贴任务失败: {error}"))?
}

#[tauri::command]
pub fn paste_file(app: AppHandle, path: String) -> Result<(), String> {
    paste_files(app, vec![path])
}

/// 把多个文件作为文件列表写入剪切板后模拟 Ctrl+V，用于整组粘贴等批量场景。
#[tauri::command]
pub fn paste_files(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    log::info!("[paste] paste_files called — {} file(s) (普通粘贴)", paths.len());
    if paths.is_empty() {
        return Err("没有可粘贴的文件".to_string());
    }
    if PASTING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let mut resolved = Vec::with_capacity(paths.len());
    for path in &paths {
        if std::fs::metadata(path).is_err() {
            log::error!("paste_files: file not found: {path}");
            PASTING.store(false, Ordering::SeqCst);
            return Err(format!("File not found: {path}"));
        }
        resolved.push(
            std::fs::canonicalize(path).unwrap_or_else(|_| std::path::PathBuf::from(path)),
        );
    }
    if let Err(e) = write_file_list(&resolved) {
        log::error!("paste_files: {e}");
        PASTING.store(false, Ordering::SeqCst);
        return Err(e);
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        let _guard = PasteGuard;

        crate::clipboard::sync_monitor_cache(&handle);
        paste_with_defocus(&handle, PasteShortcut::CtrlV).ok();
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_stash_segments, StashSegment, STASH_IMAGE_PLACEHOLDER};

    #[test]
    fn parses_text_and_images_in_document_order() {
        let segments = parse_stash_segments(
            "开始\n[Image #1]\n中间[Image #2]结束",
            &["first.png".to_string(), "second.png".to_string()],
        )
        .unwrap();

        assert_eq!(
            segments,
            vec![
                StashSegment::Text("开始\n".to_string()),
                StashSegment::Image("first.png".to_string()),
                StashSegment::Text("\n中间".to_string()),
                StashSegment::Image("second.png".to_string()),
                StashSegment::Text("结束".to_string()),
            ]
        );
    }

    #[test]
    fn rejects_missing_image_placeholder() {
        let error = parse_stash_segments("只有文字", &["first.png".to_string()]).unwrap_err();

        assert!(error.contains("[Image #1]"));
    }

    #[test]
    fn parses_object_placeholders_without_consuming_visible_text() {
        let content = format!("字面 [Image #1]{STASH_IMAGE_PLACEHOLDER}结束");
        let segments = parse_stash_segments(&content, &["first.png".to_string()]).unwrap();

        assert_eq!(
            segments,
            vec![
                StashSegment::Text("字面 [Image #1]".to_string()),
                StashSegment::Image("first.png".to_string()),
                StashSegment::Text("结束".to_string()),
            ]
        );
    }

    #[test]
    fn rejects_mismatched_object_placeholder_count() {
        let error = parse_stash_segments(
            "\u{FFFC}",
            &["first.png".to_string(), "second.png".to_string()],
        )
        .unwrap_err();

        assert!(error.contains("附件数量"));
    }
}
