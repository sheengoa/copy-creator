use std::sync::atomic::{AtomicBool, Ordering};

pub static PASTING: AtomicBool = AtomicBool::new(false);

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

struct CachedImage {
    rgba: Arc<Vec<u8>>,
    width: u32,
    height: u32,
    png_bytes: Arc<Vec<u8>>,
}

struct ImageCache {
    map: HashMap<String, CachedImage>,
    order: Vec<String>,
}

static IMAGE_CACHE: OnceLock<Mutex<ImageCache>> = OnceLock::new();

fn get_image_cache() -> &'static Mutex<ImageCache> {
    IMAGE_CACHE.get_or_init(|| {
        Mutex::new(ImageCache {
            map: HashMap::new(),
            order: Vec::new(),
        })
    })
}

struct PasteGuard;

impl Drop for PasteGuard {
    fn drop(&mut self) {
        PASTING.store(false, Ordering::SeqCst);
    }
}

pub fn cache_image(path: String, rgba: Vec<u8>, width: u32, height: u32, png_bytes: Vec<u8>) {
    let mut cache = get_image_cache().lock().unwrap();
    // Evict oldest entries (deterministic insertion order)
    if cache.map.len() >= 30 {
        let evict_count = 15.min(cache.order.len());
        let evicted: Vec<String> = cache.order.drain(..evict_count).collect();
        for k in &evicted {
            cache.map.remove(k);
        }
    }
    cache.order.push(path.clone());
    cache.map.insert(
        path,
        CachedImage {
            rgba: Arc::new(rgba),
            width,
            height,
            png_bytes: Arc::new(png_bytes),
        },
    );
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
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {e}"))?;
    enigo
        .key(Key::Control, Direction::Press)
        .map_err(|e| format!("enigo ctrl press: {e}"))?;
    enigo
        .key(Key::Shift, Direction::Press)
        .map_err(|e| format!("enigo shift press: {e}"))?;
    thread::sleep(Duration::from_millis(20));
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
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {e}"))?;
    enigo
        .key(Key::Control, Direction::Press)
        .map_err(|e| format!("enigo ctrl press: {e}"))?;
    thread::sleep(Duration::from_millis(30));
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
fn inject_paste_with_shortcut(shortcut: PasteShortcut) {
    log::info!("[paste] inject_paste_with_shortcut: {:?}", shortcut);
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
    let _ = Command::new("notify-send")
        .args(["--expire-time=5000", title, body])
        .spawn();
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
fn write_file_list(path: &std::path::Path) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("初始化文件剪切板失败: {e:?}"))?;
    clipboard
        .set()
        .file_list(&[path])
        .map_err(|e| format!("写入文件剪切板失败: {e:?}"))?;
    log::info!(
        "paste_file: wrote file list to clipboard: {}",
        path.display()
    );
    Ok(())
}

fn paste_with_defocus(app: &AppHandle, shortcut: PasteShortcut) -> Result<(), String> {
    // Hide radial popup if visible.  When pasting from the radial menu
    // itself the frontend has already issued a hide, so this is a fast
    // no-op in the common case — but it is a safety net for edge cases
    // where the popup was left open.
    if let Some(radial) = app.get_webview_window("radial-menu") {
        let _ = radial.hide();
    }

    let window = app.get_webview_window("main").ok_or("no window")?;

    let is_pinned = window.is_always_on_top().unwrap_or(false);
    if !is_pinned {
        window.hide().map_err(|e| e.to_string())?;
    }

    // Settle time for the compositor to defocus our window(s) and
    // transfer focus to the previously-active window.  200 ms has been
    // empirically sufficient on GNOME/Wayland and X11 alike now that
    // the Wayland keystroke-injection and terminal-shortcut issues are
    // fixed.
    thread::sleep(Duration::from_millis(200));

    inject_paste_with_shortcut(shortcut);

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

    if let Err(e) = app.clipboard().write_text(text) {
        PASTING.store(false, Ordering::SeqCst);
        return Err(e.to_string());
    }

    // Sync monitor cache so the clipboard poller doesn't re-record our own paste
    crate::clipboard::sync_monitor_cache(&app);

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

    if let Err(e) = app.clipboard().write_text(text) {
        PASTING.store(false, Ordering::SeqCst);
        return Err(e.to_string());
    }

    crate::clipboard::sync_monitor_cache(&app);

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

        let (rgba, w, h, _png) = {
            let cache = get_image_cache().lock().unwrap();
            if let Some(cached) = cache.map.get(&path) {
                (
                    cached.rgba.clone(),
                    cached.width,
                    cached.height,
                    cached.png_bytes.clone(),
                )
            } else {
                drop(cache);

                let mut base_dir = crate::db::get_storage_dir(&handle);
                base_dir.push(&path);

                let bytes = match std::fs::read(&base_dir) {
                    Ok(b) => b,
                    Err(e) => {
                        log::error!("paste_image: read error: {}", e);
                        return;
                    }
                };

                let png_arc = Arc::new(bytes.clone());

                let (rgba, w, h) = {
                    use image::ImageDecoder;
                    let decoder =
                        match image::codecs::png::PngDecoder::new(std::io::Cursor::new(&bytes)) {
                            Ok(d) => d,
                            Err(e) => {
                                log::error!("paste_image: decode error: {}", e);
                                return;
                            }
                        };
                    let dims = decoder.dimensions();
                    let mut buf = vec![0; (dims.0 * dims.1 * 4) as usize];
                    if let Err(e) = decoder.read_image(&mut buf) {
                        log::error!("paste_image: read pixels error: {}", e);
                        return;
                    }
                    (buf, dims.0, dims.1)
                };

                cache_image(path.clone(), rgba.clone(), w, h, bytes);
                (Arc::new(rgba), w, h, png_arc)
            }
        };

        // arboard writes proper image/png format that Linux apps understand
        let mut clipboard = match arboard::Clipboard::new() {
            Ok(c) => c,
            Err(e) => {
                log::error!("paste_image: arboard init: {:?}", e);
                return;
            }
        };
        let img = arboard::ImageData {
            width: w as usize,
            height: h as usize,
            bytes: std::borrow::Cow::Borrowed(&rgba),
        };
        if let Err(e) = clipboard.set_image(img) {
            log::error!("paste_image: arboard set_image: {:?}", e);
            return;
        }

        crate::clipboard::sync_monitor_cache(&handle);
        // 图像粘贴总是用 Ctrl+V：CLI 工具（Claude Code/Codex）捕获 Ctrl+V 读取剪贴板图像，
        // 普通应用也用 Ctrl+V 粘贴图像。Ctrl+Shift+V 是终端文本粘贴，对图像无效。
        paste_with_defocus(&handle, PasteShortcut::CtrlV).ok();
    });

    Ok(())
}

#[tauri::command]
pub fn paste_file(app: AppHandle, path: String) -> Result<(), String> {
    if PASTING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    // Verify the file still exists on disk before pasting
    let file_meta = std::fs::metadata(&path);
    if file_meta.is_err() {
        log::error!("paste_file: file not found: {}", path);
        PASTING.store(false, Ordering::SeqCst);
        return Err(format!("File not found: {}", path));
    }

    let file_path =
        std::fs::canonicalize(&path).unwrap_or_else(|_| std::path::PathBuf::from(&path));
    if let Err(e) = write_file_list(&file_path) {
        log::error!("paste_file: {}", e);
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
