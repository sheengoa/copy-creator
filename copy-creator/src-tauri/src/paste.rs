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
    IMAGE_CACHE.get_or_init(|| Mutex::new(ImageCache {
        map: HashMap::new(),
        order: Vec::new(),
    }))
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
    cache.map.insert(path, CachedImage {
        rgba: Arc::new(rgba),
        width,
        height,
        png_bytes: Arc::new(png_bytes),
    });
}

use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use enigo::{Enigo, Keyboard, Key, Direction, Settings};
use std::process::Command;
use std::thread;
use std::time::Duration;

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
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("enigo init: {e}"))?;
    enigo.key(Key::Control, Direction::Press)
        .map_err(|e| format!("enigo ctrl press: {e}"))?;
    enigo.key(Key::Shift, Direction::Press)
        .map_err(|e| format!("enigo shift press: {e}"))?;
    thread::sleep(Duration::from_millis(20));
    enigo.key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| format!("enigo v click: {e}"))?;
    thread::sleep(Duration::from_millis(10));
    enigo.key(Key::Shift, Direction::Release)
        .map_err(|e| format!("enigo shift release: {e}"))?;
    enigo.key(Key::Control, Direction::Release)
        .map_err(|e| format!("enigo ctrl release: {e}"))?;
    Ok(())
}

/// Inject Ctrl+V via enigo.
fn enigo_ctrl_v() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("enigo init: {e}"))?;
    enigo.key(Key::Control, Direction::Press)
        .map_err(|e| format!("enigo ctrl press: {e}"))?;
    thread::sleep(Duration::from_millis(30));
    enigo.key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| format!("enigo v click: {e}"))?;
    thread::sleep(Duration::from_millis(10));
    enigo.key(Key::Control, Direction::Release)
        .map_err(|e| format!("enigo ctrl release: {e}"))?;
    Ok(())
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

/// Run the best available keystroke injection method.
///
/// Strategy:
///   Wayland → ydotool (Ctrl+Shift+V) → wtype → enigo Ctrl+V fallback
///   X11     → enigo (Ctrl+Shift+V)    → xdotool
///
/// Ctrl+Shift+V is used as the primary shortcut because it is the
/// universal paste key-binding across all Linux terminal emulators
/// (GNOME Terminal, Alacritty, Kitty, Konsole, xterm) AND is
/// accepted by virtually all GUI applications as "paste without
/// formatting", which is correct for plain-text clipboard content.
fn inject_paste() {
    if is_wayland() && ydotool_available() {
        // Wayland + ydotool: the most reliable combination on all compositors
        match ydotool_ctrl_shift_v() {
            Ok(()) => return,
            Err(e) => log::warn!("ydotool Ctrl+Shift+V failed: {e}"),
        }
        // Fallback: Ctrl+V via ydotool
        if let Err(e) = ydotool_ctrl_v() {
            log::warn!("ydotool Ctrl+V also failed: {e}");
        }
        return;
    }

    if is_wayland() {
        // Wayland without ydotool — try wtype (wlroots only), then enigo
        if which("wtype").is_some() {
            match wtype_ctrl_shift_v() {
                Ok(()) => return,
                Err(e) => log::warn!("wtype Ctrl+Shift+V failed: {e}"),
            }
        }

        // Last resort: enigo (only works on XWayland or with older enigo)
        match enigo_ctrl_shift_v() {
            Ok(()) => return,
            Err(e) => log::warn!("enigo Ctrl+Shift+V failed on Wayland: {e}"),
        }
        if let Err(e) = enigo_ctrl_v() {
            log::warn!("enigo Ctrl+V also failed on Wayland: {e}");
        }
        return;
    }

    // X11 path (DISPLAY is set, WAYLAND_DISPLAY is not)
    if is_x11() {
        match enigo_ctrl_shift_v() {
            Ok(()) => return,
            Err(e) => log::warn!("enigo Ctrl+Shift+V failed: {e}"),
        }
        // Fallback: xdotool Ctrl+Shift+V
        if which("xdotool").is_some() {
            if let Err(e) = xdotool_ctrl_shift_v() {
                log::warn!("xdotool Ctrl+Shift+V failed: {e}");
            }
        }
        return;
    }

    // Neither Wayland nor X11 detected — try enigo anyway
    log::error!(
        "paste: cannot detect display server (no WAYLAND_DISPLAY, no DISPLAY); \
         paste may not work"
    );
    let _ = enigo_ctrl_shift_v();
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

/// Write a URI list to the system clipboard so that Linux file managers
/// recognise the paste as a file operation (rather than plain text).
///
/// On X11 this uses `xclip -t text/uri-list`; on Wayland it uses
/// `wl-copy -t text/uri-list`.  Falls back to writing plain text via
/// the Tauri clipboard plugin when neither tool is available.
fn write_uri_list(handle: &AppHandle, uri: &str) {
    let (cmd, args): (&str, &[&str]) = if is_wayland() {
        ("wl-copy", &["-t", "text/uri-list"])
    } else {
        ("xclip", &["-selection", "clipboard", "-t", "text/uri-list"])
    };

    let result = Command::new(cmd)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(uri.as_bytes());
            }
            child.wait()
        });

    match result {
        Ok(status) if status.success() => {
            log::info!("paste_file: wrote text/uri-list via {}", cmd);
        }
        _ => {
            log::warn!(
                "paste_file: {} not available, falling back to plain-text URI; \
                 install xclip (X11) or wl-clipboard (Wayland) for proper file paste",
                cmd
            );
            // Last-resort fallback: plain-text file:// URI
            let _ = handle.clipboard().write_text(uri);
        }
    }
}

fn paste_with_defocus(app: &AppHandle) -> Result<(), String> {
    // Hide radial popup if visible.  When pasting from the radial menu
    // itself the frontend has already issued a hide, so this is a fast
    // no-op in the common case — but it is a safety net for edge cases
    // where the popup was left open.
    if let Some(radial) = app.get_webview_window("radial-menu") {
        let _ = radial.hide();
    }

    let window = app
        .get_webview_window("main")
        .ok_or("no window")?;

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

    inject_paste();

    Ok(())
}

// ── Tauri commands ──────────────────────────────────────────────

#[tauri::command]
pub fn paste_text(app: AppHandle, text: String) -> Result<(), String> {
    if PASTING.swap(true, Ordering::SeqCst) {
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
        paste_with_defocus(&handle).ok();
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
                (cached.rgba.clone(), cached.width, cached.height, cached.png_bytes.clone())
            } else {
                drop(cache);

                let mut base_dir = crate::db::get_storage_dir(&handle);
                base_dir.push(&path);

                let bytes = match std::fs::read(&base_dir) {
                    Ok(b) => b,
                    Err(e) => { log::error!("paste_image: read error: {}", e); return; }
                };

                let png_arc = Arc::new(bytes.clone());

                let (rgba, w, h) = {
                    use image::ImageDecoder;
                    let decoder = match image::codecs::png::PngDecoder::new(std::io::Cursor::new(&bytes)) {
                        Ok(d) => d,
                        Err(e) => { log::error!("paste_image: decode error: {}", e); return; }
                    };
                    let dims = decoder.dimensions();
                    let mut buf = vec![0; (dims.0 * dims.1 * 4) as usize];
                    if let Err(e) = decoder.read_image(&mut buf) {
                        log::error!("paste_image: read pixels error: {}", e); return;
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
            Err(e) => { log::error!("paste_image: arboard init: {:?}", e); return; }
        };
        let img = arboard::ImageData {
            width: w as usize,
            height: h as usize,
            bytes: std::borrow::Cow::Borrowed(&rgba),
        };
        if let Err(e) = clipboard.set_image(img) {
            log::error!("paste_image: arboard set_image: {:?}", e); return;
        }

        crate::clipboard::sync_monitor_cache(&handle);
        paste_with_defocus(&handle).ok();
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

    let handle = app.clone();
    std::thread::spawn(move || {
        let _guard = PasteGuard;

        // Write file:// URI as text/uri-list MIME type so file managers
        // recognise the paste as a file operation.
        let uri = format!("file://{}", path);
        write_uri_list(&handle, &uri);

        crate::clipboard::sync_monitor_cache(&handle);
        paste_with_defocus(&handle).ok();
    });

    Ok(())
}
