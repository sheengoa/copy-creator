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

/// Detect whether we are running under Wayland.
fn is_wayland() -> bool {
    std::env::var("WAYLAND_DISPLAY")
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
    // Hide radial popup if visible
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

    // Simple settle time before paste (no foreground window tracking on Linux)
    thread::sleep(Duration::from_millis(200));

    // Simulate Ctrl+V — try enigo (X11/XWayland) first, then CLI fallback
    match Enigo::new(&Settings::default()) {
        Ok(mut enigo) => {
            if let Err(e) = enigo.key(Key::Control, Direction::Press) {
                log::warn!("enigo ctrl press failed: {}", e);
            }
            thread::sleep(Duration::from_millis(30));
            if let Err(e) = enigo.key(Key::Unicode('v'), Direction::Click) {
                log::warn!("enigo v click failed: {}", e);
            }
            thread::sleep(Duration::from_millis(10));
            if let Err(e) = enigo.key(Key::Control, Direction::Release) {
                log::warn!("enigo ctrl release failed: {}", e);
            }
        }
        Err(e) => {
            log::warn!("enigo init failed ({}), trying CLI fallback", e);
            let result = if is_wayland() {
                which("ydotool")
                    .and_then(|_| {
                        Command::new("ydotool")
                            .args(["key", "29:1", "47:1", "47:0", "29:0"])
                            .status().ok()
                    })
                    .or_else(|| {
                        which("wtype").and_then(|_| {
                            Command::new("wtype")
                                .args(["-M", "ctrl", "-k", "v"])
                                .status().ok()
                        })
                    })
            } else {
                which("xdotool").and_then(|_| {
                    Command::new("xdotool")
                        .args(["key", "--clearmodifiers", "ctrl+v"])
                        .status().ok()
                })
            };
            match result {
                Some(status) if status.success() => {}
                _ => log::error!("paste_with_defocus: no keyboard simulation method available; install xdotool (X11) or ydotool/wtype (Wayland)"),
            }
        }
    }

    Ok(())
}

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
