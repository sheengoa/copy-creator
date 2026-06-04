use std::io::Write;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

fn is_url(text: &str) -> bool {
    let lower = text.trim().to_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("ftp://")
        || lower.starts_with("ftps://")
}

fn is_previewable_image_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".png")
}

const IMAGE_PREVIEW_MAX_BYTES: u64 = 3 * 1024 * 1024;
const TEXT_EVENT_PREVIEW_CHARS: usize = 600;

fn is_image_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".bmp")
        || lower.ends_with(".webp")
        || lower.ends_with(".ico")
}

/// Decode percent-encoded characters in a file:// URI path component.
fn percent_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut bytes = s.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let hi = bytes.next().unwrap_or(b'0');
            let lo = bytes.next().unwrap_or(b'0');
            let h = match hi {
                b'0'..=b'9' => hi - b'0',
                b'a'..=b'f' => hi - b'a' + 10,
                b'A'..=b'F' => hi - b'A' + 10,
                _ => { result.push('%'); result.push(hi as char); result.push(lo as char); continue; }
            };
            let l = match lo {
                b'0'..=b'9' => lo - b'0',
                b'a'..=b'f' => lo - b'a' + 10,
                b'A'..=b'F' => lo - b'A' + 10,
                _ => { result.push('%'); result.push(hi as char); result.push(lo as char); continue; }
            };
            result.push(((h << 4) | l) as char);
        } else {
            result.push(b as char);
        }
    }
    result
}

/// Parse a file:// URI into a local filesystem path.
/// Handles `file:///path`, `file://localhost/path`, and percent-encoded characters.
/// Returns None for non-local URIs or paths containing traversal sequences.
fn parse_file_uri(uri: &str) -> Option<String> {
    let path = uri
        .strip_prefix("file://localhost")
        .or_else(|| uri.strip_prefix("file://"))
        .unwrap_or(uri);
    // Must be an absolute local path (rejects remote hostnames like file://host/path)
    if !path.starts_with('/') {
        return None;
    }
    let decoded = percent_decode(path);
    if decoded.is_empty() {
        return None;
    }
    // Reject path traversal sequences
    if decoded.contains("/../") || decoded.contains("/./") || decoded.ends_with("/..") {
        return None;
    }
    Some(decoded)
}

fn make_text_event_content(record_type: &str, content: &str) -> (String, i64, bool) {
    let total_chars = content.chars().count();
    if record_type != "text" || total_chars <= TEXT_EVENT_PREVIEW_CHARS {
        return (content.to_string(), total_chars as i64, false);
    }

    (
        content.chars().take(TEXT_EVENT_PREVIEW_CHARS).collect(),
        total_chars as i64,
        true,
    )
}

/// Import an image file from disk into the storage directory.
/// Returns true if the file was imported as an image record.
fn import_image_file(app: &AppHandle, file_path: &str) -> bool {
    let file_size = std::fs::metadata(file_path)
        .map(|m| m.len())
        .unwrap_or(0);

    let should_import = is_previewable_image_file(file_path)
        .then(|| file_size < IMAGE_PREVIEW_MAX_BYTES)
        .unwrap_or(true);

    if !should_import {
        return false;
    }

    let img_bytes = match std::fs::read(file_path) {
        Ok(b) => b,
        Err(_) => return false,
    };

    let decoded = match image::load_from_memory(&img_bytes) {
        Ok(d) => d,
        Err(_) => return false,
    };

    let rgba = decoded.to_rgba8();
    let img_w = decoded.width();
    let img_h = decoded.height();

    let content_hash: u64 = rgba.iter()
        .fold(0u64, |acc, &b| acc.wrapping_mul(31).wrapping_add(b as u64));
    let content_hash_str = format!("{:016x}", content_hash);
    let filename = format!("{}.png", content_hash_str);
    let relative = format!("images/{}", filename);

    let mut png_bytes: Vec<u8> = Vec::new();
    {
        let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
        use image::ImageEncoder;
        let _ = encoder.write_image(
            &rgba,
            img_w,
            img_h,
            image::ExtendedColorType::Rgba8,
        );
    }

    if png_bytes.is_empty() {
        return false;
    }

    let mut dir = crate::db::get_storage_dir(app);
    dir.push("images");
    std::fs::create_dir_all(&dir).ok();

    let out_path = dir.join(&filename);
    if !out_path.exists() {
        if let Ok(mut f) = std::fs::File::create(&out_path) {
            let _ = f.write_all(&png_bytes);
        }
    }

    crate::paste::cache_image(relative.clone(), rgba.to_vec(), img_w, img_h, png_bytes.clone());

    let mut thumb_dir = dir.clone();
    thumb_dir.push("thumbs");
    std::fs::create_dir_all(&thumb_dir).ok();
    let thumb_path = thumb_dir.join(&filename);
    if !thumb_path.exists() {
        let (tw, th) = (decoded.width(), decoded.height());
        let max_thumb: u32 = 200;
        let scale = if tw > max_thumb || th > max_thumb {
            max_thumb as f32 / tw.max(th) as f32
        } else {
            1.0
        };
        let thumb = if scale < 1.0 {
            decoded.resize(
                (tw as f32 * scale) as u32,
                (th as f32 * scale) as u32,
                image::imageops::FilterType::Triangle,
            )
        } else {
            decoded
        };
        let mut thumb_buf = std::io::Cursor::new(Vec::new());
        if thumb.write_to(&mut thumb_buf, image::ImageFormat::Png).is_ok() {
            if let Ok(mut tf) = std::fs::File::create(&thumb_path) {
                let _ = tf.write_all(&thumb_buf.into_inner());
            }
        }
    }

    insert_and_emit(app, "image", &relative);
    true
}

/// Insert a new record into the DB and emit clipboard-update.
/// Skips insertion only if the most recent record has identical type and content
/// AND was created within the last 2 seconds (debounce window).
fn insert_and_emit(app: &AppHandle, record_type: &str, content: &str) {
    let one_second_ago = chrono::Utc::now() - chrono::Duration::seconds(1);
    let cutoff = one_second_ago.to_rfc3339();

    let is_duplicate: bool = {
        let state = app.state::<crate::db::DbState>();
        let x = match state.conn.lock() {
            Ok(conn) => conn.query_row(
                "SELECT type, content, created_at FROM clipboard_records ORDER BY created_at DESC LIMIT 1",
                [],
                |row| {
                    let last_type: String = row.get(0)?;
                    let last_content: String = row.get(1)?;
                    let last_created: String = row.get(2)?;
                    Ok(last_type == record_type && last_content == content && last_created >= cutoff)
                },
            )
            .unwrap_or(false),
            Err(_) => false,
        };
        x
    };

    if is_duplicate {
        return;
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    {
        let state = app.state::<crate::db::DbState>();
        let _x = match state.conn.lock() {
            Ok(conn) => conn.execute(
                "INSERT INTO clipboard_records (id, type, content, source_app, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![id, record_type, content, "", &now],
            ).ok(),
            Err(_) => None,
        };
    }
    // API Key detection
    let (is_key, key_preview, guessed_service) =
        if (record_type == "text" || record_type == "link") && crate::db::is_api_key(content) {
            let preview = crate::db::make_key_preview(content);
            let guess = crate::db::guess_service(content).map(|s| s.to_string());
            if !crate::db::is_toast_shown_internal(app, &preview) {
                crate::db::mark_toast_shown_internal(app, &preview);
                app.emit(
                    "api-key-detected",
                    serde_json::json!({
                        "record_id": id,
                        "key_preview": &preview,
                        "guess": &guess,
                    }),
                )
                .ok();
            }
            (true, preview, guess)
        } else {
            (false, String::new(), None::<String>)
        };

    let (event_content, content_length, content_truncated) =
        make_text_event_content(record_type, content);

    app.emit(
        "clipboard-update",
        serde_json::json!({
            "id": id,
            "type": record_type,
            "content": event_content,
            "content_length": content_length,
            "content_truncated": content_truncated,
            "source_app": "",
            "created_at": now,
            "is_api_key": is_key,
            "key_preview": key_preview,
            "guessed_service": guessed_service,
            "label": null,
        }),
    ).ok();
}

/// Cached clipboard state, updated by the monitor and by paste functions.
pub static LAST_CLIPBOARD_TEXT: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
pub static LAST_CLIPBOARD_IMAGE_HASH: std::sync::Mutex<u64> = std::sync::Mutex::new(0);
pub static LAST_CLIPBOARD_FILES_KEY: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

pub fn sync_monitor_cache(handle: &AppHandle) {
    if let Ok(text) = handle.clipboard().read_text() {
        *LAST_CLIPBOARD_TEXT.lock().unwrap() = text.trim().to_string();
    }
    // Cache file URIs to prevent re-recording our own file paste
    if let Ok(text) = handle.clipboard().read_text() {
        let text = text.trim().to_string();
        if text.contains("file://") {
            *LAST_CLIPBOARD_FILES_KEY.lock().unwrap() = text.lines()
                .filter_map(|l| parse_file_uri(l.trim()))
                .collect::<Vec<_>>()
                .join("|");
        }
    }
}

pub fn start_monitor(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.clone();

    {
        let initial_text = handle.clipboard().read_text()
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        *LAST_CLIPBOARD_TEXT.lock().unwrap() = initial_text;
    }

    {
        let key = handle.clipboard().read_text()
            .map(|text| {
                text.lines()
                    .filter_map(|l| parse_file_uri(l.trim()))
                    .collect::<Vec<_>>()
                    .join("|")
            })
            .unwrap_or_default();
        *LAST_CLIPBOARD_FILES_KEY.lock().unwrap() = key;
    }

    std::thread::spawn(move || {
        let mut poll_count: u32 = 0;
        loop {
        std::thread::sleep(std::time::Duration::from_millis(800));
        poll_count += 1;

        // Skip first 2 polls (1.6s) to avoid recording startup clipboard state
        if poll_count <= 2 {
            sync_monitor_cache(&handle);
            continue;
        }

        if crate::paste::PASTING.load(std::sync::atomic::Ordering::SeqCst) {
            sync_monitor_cache(&handle);
            continue;
        }

        // Linux: poll-based detection via content comparison every cycle
        let mut image_recorded = false;

        let mut image_data: Option<(Vec<u8>, u32, u32)> = None;
        let mut image_is_same = false;

        // Image detection via arboard with stratified full-RGBA hash
        if let Ok(mut clipboard) = arboard::Clipboard::new() {
            if let Ok(image) = clipboard.get_image() {
                let rgba = &image.bytes;
                if !rgba.is_empty() && image.width > 0 && image.height > 0 {
                    let hash = rgba.iter()
                        .step_by(64)
                        .fold(0u64, |acc, &b| acc.wrapping_mul(31).wrapping_add(b as u64));
                    let mut cached_hash = LAST_CLIPBOARD_IMAGE_HASH.lock().unwrap();
                    if hash != *cached_hash {
                        *cached_hash = hash;
                        image_data = Some((rgba.to_vec(), image.width as u32, image.height as u32));
                    } else {
                        // Hash matched — same image re-copied
                        image_is_same = true;
                    }
                }
            }
        }

        if let Some((rgba_vec, img_w, img_h)) = image_data.take() {
            let content_hash: u64 = rgba_vec.iter()
                .fold(0u64, |acc, &b| acc.wrapping_mul(31).wrapping_add(b as u64));
            let content_hash_str = format!("{:016x}", content_hash);
            let filename = format!("{}.png", content_hash_str);
            let relative = format!("images/{}", filename);

            let mut png_bytes: Vec<u8> = Vec::new();
            {
                let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
                use image::ImageEncoder;
                let _ = encoder.write_image(
                    &rgba_vec,
                    img_w,
                    img_h,
                    image::ExtendedColorType::Rgba8,
                );
            }

            if !png_bytes.is_empty() {
                let mut dir = crate::db::get_storage_dir(&handle);
                dir.push("images");
                std::fs::create_dir_all(&dir).ok();

                let filepath = dir.join(&filename);

                if !filepath.exists() {
                    if let Ok(mut f) = std::fs::File::create(&filepath) {
                        let _ = f.write_all(&png_bytes);
                    }
                }

                log::info!("clipboard: recorded image {}x{} hash={}", img_w, img_h, content_hash_str);

                crate::paste::cache_image(relative.clone(), rgba_vec, img_w, img_h, png_bytes.clone());

                // Generate thumbnail if missing
                let mut thumb_dir = dir.clone();
                thumb_dir.push("thumbs");
                std::fs::create_dir_all(&thumb_dir).ok();
                let thumb_path = thumb_dir.join(&filename);
                if !thumb_path.exists() {
                    if let Ok(decoded) = image::load_from_memory(&png_bytes) {
                        let (tw, th) = (decoded.width(), decoded.height());
                        let max_thumb: u32 = 200;
                        let scale = if tw > max_thumb || th > max_thumb {
                            max_thumb as f32 / tw.max(th) as f32
                        } else {
                            1.0
                        };
                        let thumb = if scale < 1.0 {
                            decoded.resize(
                                (tw as f32 * scale) as u32,
                                (th as f32 * scale) as u32,
                                image::imageops::FilterType::Triangle,
                            )
                        } else {
                            decoded
                        };
                        let mut thumb_buf = std::io::Cursor::new(Vec::new());
                        if thumb.write_to(&mut thumb_buf, image::ImageFormat::Png).is_ok() {
                            if let Ok(mut tf) = std::fs::File::create(&thumb_path) {
                                let _ = tf.write_all(&thumb_buf.into_inner());
                            }
                        }
                    }
                }

                insert_and_emit(&handle, "image", &relative);
                image_recorded = true;
            }
        }

        // Handle re-copy of same image: insert a new chronological record
        if image_is_same {
            if let Ok(mut clipboard) = arboard::Clipboard::new() {
                if let Ok(image) = clipboard.get_image() {
                    let content_hash: u64 = image.bytes.iter()
                        .fold(0u64, |acc, &b| acc.wrapping_mul(31).wrapping_add(b as u64));
                    let content_hash_str = format!("{:016x}", content_hash);
                    let relative = format!("images/{}.png", content_hash_str);
                    insert_and_emit(&handle, "image", &relative);
                }
            }
            sync_monitor_cache(&handle);
        } else if image_recorded {
            if let Ok(text) = handle.clipboard().read_text() {
                *LAST_CLIPBOARD_TEXT.lock().unwrap() = text.trim().to_string();
            }
        } else {
            if let Ok(text) = handle.clipboard().read_text() {
                let text = text.trim().to_string();
                if !text.is_empty() && text != *LAST_CLIPBOARD_TEXT.lock().unwrap() {
                    *LAST_CLIPBOARD_TEXT.lock().unwrap() = text.clone();
                    let record_type = if is_url(&text) { "link" } else { "text" };
                    insert_and_emit(&handle, record_type, &text);
                } else if !text.is_empty() {
                    let record_type = if is_url(&text) { "link" } else { "text" };
                    insert_and_emit(&handle, record_type, &text);
                }
            }

            // Detect file:// URIs in clipboard text (text/uri-list)
            if let Ok(text) = handle.clipboard().read_text() {
                let text = text.trim().to_string();
                if !text.is_empty() && text.contains("file://") {
                    let files: Vec<String> = text
                        .lines()
                        .filter_map(|l| parse_file_uri(l.trim()))
                        .filter(|p| !p.is_empty())
                        .collect();

                    if !files.is_empty() {
                        let key = files.join("|");
                        {
                            let mut cached = LAST_CLIPBOARD_FILES_KEY.lock().unwrap();
                            if key == *cached {
                                for file_path in &files {
                                    if file_path.trim().is_empty() { continue; }
                                    if is_previewable_image_file(file_path) || is_image_file(file_path) {
                                        import_image_file(&handle, file_path);
                                        continue;
                                    }
                                    insert_and_emit(&handle, "file", file_path);
                                }
                                continue;
                            }
                            *cached = key.clone();
                        }

                        for file_path in files {
                            if file_path.trim().is_empty() { continue; }
                            if is_previewable_image_file(&file_path) || is_image_file(&file_path) {
                                if import_image_file(&handle, &file_path) { continue; }
                                continue;
                            }
                            insert_and_emit(&handle, "file", &file_path);
                        }
                    }
                }
            }
        }
        }
    });

    Ok(())
}
