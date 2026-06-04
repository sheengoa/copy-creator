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
use std::thread;
use std::time::Duration;

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

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;

    // Ctrl+V via enigo (Linux uses Key::Unicode for letter keys)
    enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
    thread::sleep(Duration::from_millis(30));
    enigo.key(Key::Unicode('v'), Direction::Click).map_err(|e| e.to_string())?;
    thread::sleep(Duration::from_millis(10));
    enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;

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

        // Write as file:// URI (standard text/uri-list format on Linux)
        let uri = format!("file://{}", path);
        if let Err(e) = handle.clipboard().write_text(&uri) {
            log::error!("paste_file: write clipboard error: {}", e);
            return;
        }

        crate::clipboard::sync_monitor_cache(&handle);
        paste_with_defocus(&handle).ok();
    });

    Ok(())
}
