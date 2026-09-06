use base64::Engine;
use rusqlite::OptionalExtension;
use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

fn is_url(text: &str) -> bool {
    let lower = text.trim().to_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("ftp://")
        || lower.starts_with("ftps://")
}

pub(crate) fn classify_text_record(content: &str) -> &'static str {
    if is_url(content) {
        "link"
    } else {
        "text"
    }
}

fn api_key_metadata(
    app: &AppHandle,
    record_id: &str,
    record_type: &str,
    content: &str,
) -> (bool, String, Option<String>) {
    if (record_type == "text" || record_type == "link") && crate::db::is_api_key(content) {
        let preview = crate::db::make_key_preview(content);
        let guess = crate::db::guess_service(content).map(|s| s.to_string());
        if !crate::db::is_toast_shown_internal(app, &preview) {
            crate::db::mark_toast_shown_internal(app, &preview);
            app.emit(
                "api-key-detected",
                serde_json::json!({
                    "record_id": record_id,
                    "key_preview": &preview,
                    "guess": &guess,
                }),
            )
            .ok();
        }
        (true, preview, guess)
    } else {
        (false, String::new(), None::<String>)
    }
}

fn is_previewable_image_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".jpg") || lower.ends_with(".jpeg") || lower.ends_with(".png")
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
    let mut bytes_out = Vec::with_capacity(s.len());
    let mut bytes = s.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let hi = bytes.next().unwrap_or(b'0');
            let lo = bytes.next().unwrap_or(b'0');
            let h = match hi {
                b'0'..=b'9' => hi - b'0',
                b'a'..=b'f' => hi - b'a' + 10,
                b'A'..=b'F' => hi - b'A' + 10,
                _ => {
                    bytes_out.push(b'%');
                    bytes_out.push(hi);
                    bytes_out.push(lo);
                    continue;
                }
            };
            let l = match lo {
                b'0'..=b'9' => lo - b'0',
                b'a'..=b'f' => lo - b'a' + 10,
                b'A'..=b'F' => lo - b'A' + 10,
                _ => {
                    bytes_out.push(b'%');
                    bytes_out.push(hi);
                    bytes_out.push(lo);
                    continue;
                }
            };
            bytes_out.push((h << 4) | l);
        } else {
            bytes_out.push(b);
        }
    }
    String::from_utf8_lossy(&bytes_out).into_owned()
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

fn write_stash_images(
    app: &AppHandle,
    images: &[String],
    reusable_paths: &HashSet<String>,
) -> Result<(Vec<String>, Vec<String>), String> {
    let relative_dir = "stash-images";
    let storage_dir = crate::db::get_storage_dir(app);
    let target_dir = storage_dir.join(relative_dir);
    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    let mut paths = Vec::with_capacity(images.len());
    let mut created_paths = Vec::new();
    for image_data in images {
        if reusable_paths.contains(image_data) {
            let existing_path = crate::db::resolve_storage_path(app, image_data)?;
            if !existing_path.is_file() {
                remove_stash_images(app, &created_paths);
                return Err("原暂存图片文件已不存在".to_string());
            }
            paths.push(image_data.clone());
            continue;
        }
        let result = (|| -> Result<String, String> {
            let bytes = read_image_source(app, image_data)?;
            let image =
                image::load_from_memory(&bytes).map_err(|e| format!("图片格式无效: {e}"))?;
            let width = image.width();
            let height = image.height();
            let rgba = image.to_rgba8().into_raw();
            let filename = format!("{}.png", uuid::Uuid::new_v4());
            let relative_path = format!("{relative_dir}/{filename}");
            image
                .save_with_format(target_dir.join(&filename), image::ImageFormat::Png)
                .map_err(|e| format!("图片保存失败: {e}"))?;
            crate::paste::cache_image(relative_path.clone(), rgba, width, height);
            Ok(relative_path)
        })();
        match result {
            Ok(path) => {
                created_paths.push(path.clone());
                paths.push(path);
            }
            Err(e) => {
                remove_stash_images(app, &created_paths);
                return Err(e);
            }
        }
    }
    Ok((paths, created_paths))
}

fn remove_stash_images(app: &AppHandle, paths: &[String]) {
    crate::paste::remove_cached_images(paths);
    for path in paths {
        if let Some(path) = crate::db::resolve_managed_storage_path(app, path) {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn read_image_source(app: &AppHandle, value: &str) -> Result<Vec<u8>, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("图片数据为空".to_string());
    }

    if value.starts_with("data:") {
        let encoded = value
            .split_once(',')
            .map(|(_, data)| data)
            .ok_or_else(|| "图片数据无效".to_string())?;
        return base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|e| format!("图片数据无效: {e}"));
    }

    let path = if value.starts_with("file://") {
        parse_file_uri(value)
            .map(PathBuf::from)
            .ok_or_else(|| "图片路径无效".to_string())?
    } else {
        PathBuf::from(value)
    };
    let path = if path.is_absolute() {
        path
    } else {
        crate::db::resolve_storage_path(app, value)?
    };
    if path.is_file() {
        return std::fs::read(&path).map_err(|e| format!("读取图片失败: {e}"));
    }

    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|e| format!("图片数据无效: {e}"))
}

fn sanitize_resource_file_stem(content: &str) -> String {
    let cleaned_content = content
        .replace(crate::paste::STASH_IMAGE_PLACEHOLDER, "")
        .replace("[Image #1]", "");
    let source = cleaned_content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("content");
    let mut result = String::new();
    let mut previous_separator = false;
    for character in source.chars() {
        let next = if character.is_whitespace() {
            '-'
        } else if matches!(
            character,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
        ) {
            '_'
        } else {
            character
        };
        if next == '-' || next == '_' {
            if previous_separator {
                continue;
            }
            previous_separator = true;
        } else {
            previous_separator = false;
        }
        result.push(next);
        if result.chars().count() >= 60 {
            break;
        }
    }
    let result = result.trim_matches(['-', '_']).to_string();
    if result.is_empty() {
        "content".to_string()
    } else {
        result
    }
}

fn render_resource_markdown(
    content: &str,
    relative_image_paths: &[String],
) -> Result<String, String> {
    let mut output = String::new();
    let mut remaining = content;
    let uses_object_placeholders = content.contains(crate::paste::STASH_IMAGE_PLACEHOLDER);

    for (index, relative_path) in relative_image_paths.iter().enumerate() {
        let token = if uses_object_placeholders {
            crate::paste::STASH_IMAGE_PLACEHOLDER.to_string()
        } else {
            format!("[Image #{}]", index + 1)
        };
        let position = remaining
            .find(&token)
            .ok_or_else(|| format!("缺少图片占位符 {}", index + 1))?;
        output.push_str(&remaining[..position]);
        output.push_str(&format!("![截图 {}]({relative_path})", index + 1));
        remaining = &remaining[position + token.len()..];
    }
    output.push_str(remaining);
    if !output.ends_with('\n') {
        output.push('\n');
    }
    Ok(output)
}

struct ResourceWriteResult {
    resource_path: String,
    attachment_paths: Vec<String>,
}

fn write_resource_record(
    app: &AppHandle,
    record_id: &str,
    content: &str,
    images: &[String],
    group_name: &str,
) -> Result<ResourceWriteResult, String> {
    let resource_root = crate::db::get_resource_library_dir(app);
    let resource_dir = crate::db::resource_group_path(app, group_name)?;
    if !resource_dir.exists() {
        if group_name.is_empty() {
            std::fs::create_dir_all(&resource_dir)
                .map_err(|e| format!("创建资源库目录失败: {e}"))?;
        } else {
            return Err("资源分组不存在".to_string());
        }
    }
    let transaction_id = uuid::Uuid::new_v4().to_string();
    let attachment_dir_name = format!("{record_id}-{transaction_id}");
    let attachment_dir = resource_root
        .join(".copy-creator")
        .join("attachments")
        .join(&attachment_dir_name);
    let mut attachment_paths = Vec::with_capacity(images.len());

    let result = (|| -> Result<ResourceWriteResult, String> {
        if !images.is_empty() {
            std::fs::create_dir_all(&attachment_dir)
                .map_err(|e| format!("创建资源附件目录失败: {e}"))?;
        }

        for (index, image_data) in images.iter().enumerate() {
            let target = attachment_dir.join(format!("image-{}.png", index + 1));
            let target_string = target.to_string_lossy().to_string();
            attachment_paths.push(target_string);
            let bytes = read_image_source(app, image_data)?;
            let image =
                image::load_from_memory(&bytes).map_err(|e| format!("图片格式无效: {e}"))?;
            image
                .save_with_format(&target, image::ImageFormat::Png)
                .map_err(|e| format!("资源图片保存失败: {e}"))?;
        }

        let extension = if images.is_empty() { "txt" } else { "md" };
        let file_stem = format!(
            "copy-creator-{record_id}-{transaction_id}-{}",
            sanitize_resource_file_stem(content)
        );
        let resource_path = resource_dir.join(format!("{file_stem}.{extension}"));
        let file_content = if images.is_empty() {
            format!("{content}\n")
        } else {
            let relative_paths = (1..=images.len())
                .map(|index| {
                    let prefix = if group_name.is_empty() { "" } else { "../" };
                    format!(
                        "{prefix}.copy-creator/attachments/{attachment_dir_name}/image-{index}.png"
                    )
                })
                .collect::<Vec<_>>();
            render_resource_markdown(content, &relative_paths)?
        };
        let temp_path = resource_dir.join(format!(".{file_stem}.tmp"));
        std::fs::write(&temp_path, file_content).map_err(|e| format!("资源文件写入失败: {e}"))?;
        if let Err(error) = std::fs::rename(&temp_path, &resource_path) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("资源文件提交失败: {error}"));
        }

        Ok(ResourceWriteResult {
            resource_path: resource_path.to_string_lossy().to_string(),
            attachment_paths: attachment_paths.clone(),
        })
    })();

    if result.is_err() {
        crate::db::remove_resource_record_attachments(app, record_id, &attachment_paths);
    }
    result
}

fn validate_stash_content(content: &str, image_count: usize) -> Result<(), String> {
    let object_count = content
        .chars()
        .filter(|character| *character == crate::paste::STASH_IMAGE_PLACEHOLDER)
        .count();
    if object_count > 0 {
        if object_count != image_count {
            return Err(format!(
                "图片位置数量为 {object_count}，附件数量为 {image_count}"
            ));
        }
        return Ok(());
    }

    let mut remaining = content;
    for index in 1..=image_count {
        let token = format!("[Image #{index}]");
        let position = remaining
            .find(&token)
            .ok_or_else(|| format!("缺少图片占位符 {token}"))?;
        remaining = &remaining[position + token.len()..];
    }
    Ok(())
}

pub(crate) fn stash_content_for_display(content: &str) -> String {
    let mut image_index = 0;
    content
        .chars()
        .map(|character| {
            if character == crate::paste::STASH_IMAGE_PLACEHOLDER {
                image_index += 1;
                format!("[Image #{image_index}]")
            } else {
                character.to_string()
            }
        })
        .collect()
}

#[tauri::command]
pub fn save_stash_record(
    app: AppHandle,
    id: Option<String>,
    content: String,
    images: Vec<String>,
    storage_mode: Option<String>,
    group_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("内容不能为空".to_string());
    }
    validate_stash_content(&content, images.len())?;

    let record_type = classify_text_record(&content);
    let record_id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let sort_order = chrono::Utc::now().timestamp_millis();
    let existing = {
        let state = app.state::<crate::db::DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT group_name, attachments, storage_mode, resource_path FROM clipboard_records WHERE id = ?1",
            rusqlite::params![&record_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
    };
    let current_storage_mode = existing
        .as_ref()
        .map(|(_, _, mode, _)| mode.as_str())
        .unwrap_or(crate::db::DATABASE_STORAGE_MODE);
    let updated = existing.is_some();
    let current_is_resource = existing
        .as_ref()
        .is_some_and(|(_, _, mode, _)| crate::db::is_resource_record(mode));
    let target_storage_mode = match storage_mode.as_deref() {
        Some(crate::db::DATABASE_STORAGE_MODE) => crate::db::DATABASE_STORAGE_MODE,
        Some(crate::db::RESOURCE_STORAGE_MODE) => crate::db::RESOURCE_STORAGE_MODE,
        Some(_) => return Err("保存位置无效".to_string()),
        None if current_storage_mode == crate::db::RESOURCE_STORAGE_MODE => {
            crate::db::RESOURCE_STORAGE_MODE
        }
        None => crate::db::DATABASE_STORAGE_MODE,
    };
    let old_paths = if let Some((_, attachments, _, _)) = &existing {
        serde_json::from_str::<Vec<String>>(attachments).unwrap_or_default()
    } else {
        Vec::new()
    };
    let old_resource_path = existing
        .as_ref()
        .map(|(_, _, _, path)| path.clone())
        .unwrap_or_default();
    let target_group_name = if target_storage_mode == crate::db::RESOURCE_STORAGE_MODE {
        let default_group = if current_is_resource {
            crate::db::resource_group_for_path(
                &crate::db::get_resource_library_dir(&app),
                &old_resource_path,
            )
            .unwrap_or_default()
        } else {
            String::new()
        };
        crate::db::normalize_resource_group_name(
            group_name.as_deref().or(Some(default_group.as_str())),
        )?
    } else {
        String::new()
    };
    let reusable_paths = if updated
        && current_storage_mode == crate::db::DATABASE_STORAGE_MODE
        && !current_is_resource
    {
        old_paths.iter().cloned().collect::<HashSet<_>>()
    } else {
        HashSet::new()
    };
    let (new_paths, created_stash_paths, new_resource_path, new_resource_paths) =
        if target_storage_mode == crate::db::RESOURCE_STORAGE_MODE {
            let result =
                write_resource_record(&app, &record_id, &content, &images, &target_group_name)?;
            (
                result.attachment_paths.clone(),
                Vec::new(),
                result.resource_path,
                result.attachment_paths,
            )
        } else {
            let (paths, created_paths) = write_stash_images(&app, &images, &reusable_paths)?;
            (paths, created_paths, String::new(), Vec::new())
        };
    let attachments = serde_json::to_string(&new_paths).map_err(|e| e.to_string())?;

    let result = (|| -> Result<(), String> {
        let state = app.state::<crate::db::DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        if updated {
            let affected = conn.execute(
                "UPDATE clipboard_records SET type = ?1, content = ?2, sort_order = ?3, group_name = ?4, attachments = ?5, storage_mode = ?6, resource_path = ?7 WHERE id = ?8",
                rusqlite::params![
                    record_type,
                    &content,
                    sort_order,
                    &target_group_name,
                    &attachments,
                    target_storage_mode,
                    &new_resource_path,
                    &record_id,
                ],
            )
            .map_err(|e| e.to_string())?;
            if affected == 0 {
                return Err("暂存记录已不存在".to_string());
            }
            conn.execute(
                "DELETE FROM api_key_labels WHERE record_id = ?1",
                rusqlite::params![&record_id],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "INSERT INTO clipboard_records (id, type, content, source_app, created_at, sort_order, group_name, attachments, storage_mode, resource_path) VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    &record_id,
                    record_type,
                    &content,
                    &now,
                    sort_order,
                    &target_group_name,
                    &attachments,
                    target_storage_mode,
                    &new_resource_path,
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    })();

    if let Err(error) = result {
        remove_stash_images(&app, &created_stash_paths);
        if !new_resource_path.is_empty() || !new_resource_paths.is_empty() {
            crate::db::remove_resource_record_files(
                &app,
                &record_id,
                &new_resource_path,
                &new_resource_paths,
            );
        }
        return Err(error);
    }
    let retained_paths = new_paths.iter().cloned().collect::<HashSet<_>>();
    if current_is_resource {
        crate::db::remove_resource_record_files(&app, &record_id, &old_resource_path, &old_paths);
    } else {
        let obsolete_paths = old_paths
            .into_iter()
            .filter(|path| !retained_paths.contains(path))
            .collect::<Vec<_>>();
        remove_stash_images(&app, &obsolete_paths);
    }

    if updated {
        app.emit("clipboard-record-updated", &record_id).ok();
    } else {
        let event_content = stash_content_for_display(&content);
        app.emit(
            "clipboard-update",
            serde_json::json!({
                "id": &record_id,
                "type": record_type,
                "content": &event_content,
                "content_length": event_content.chars().count(),
                "content_truncated": false,
                "source_app": "",
                "created_at": now,
                "is_api_key": false,
                "key_preview": "",
                "guessed_service": null,
                "label": null,
                "group_name": &target_group_name,
                "has_images": !new_paths.is_empty(),
                "storage_mode": target_storage_mode,
                "resource_path": &new_resource_path,
                "resource_group": &target_group_name,
            }),
        )
        .ok();
    }
    if target_storage_mode == crate::db::RESOURCE_STORAGE_MODE || current_is_resource {
        app.emit("resource-groups-changed", ()).ok();
    }
    Ok(serde_json::json!({
        "id": record_id,
        "storage_mode": target_storage_mode,
        "resource_path": new_resource_path,
        "resource_group": target_group_name,
    }))
}

#[tauri::command]
pub fn get_stash_record_images(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    let state = app.state::<crate::db::DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let attachments = conn
        .query_row(
            "SELECT attachments FROM clipboard_records WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&attachments).map_err(|e| e.to_string())
}

fn encode_rgba_png(rgba: &[u8], width: u32, height: u32) -> Result<String, String> {
    use image::ImageEncoder;

    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new_with_quality(
        &mut png,
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::NoFilter,
    )
    .write_image(rgba, width, height, image::ColorType::Rgba8.into())
    .map_err(|e| format!("图片编码失败: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

#[tauri::command]
pub async fn read_clipboard_image_base64() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| format!("无法读取系统剪切板: {e:?}"))?;
        let image = clipboard
            .get_image()
            .map_err(|e| format!("系统剪切板中没有可读取的图片: {e:?}"))?;
        encode_rgba_png(
            image.bytes.as_ref(),
            image.width as u32,
            image.height as u32,
        )
    })
    .await
    .map_err(|e| format!("读取剪切板图片任务失败: {e}"))?
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

/// 从剪贴板文件格式读取文件路径列表（Windows CF_HDROP /
/// Linux text/uri-list）。剪贴板没有文件格式时返回 None。
fn clipboard_file_list() -> Option<Vec<String>> {
    let mut clipboard = arboard::Clipboard::new().ok()?;
    let paths = clipboard.get().file_list().ok()?;
    if paths.is_empty() {
        return None;
    }
    Some(
        paths
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
    )
}

fn clipboard_text_files(text: &str) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }

    if text.contains("file://") {
        return text
            .lines()
            .filter_map(|line| parse_file_uri(line.trim()))
            .filter(|path| !path.is_empty())
            .collect();
    }

    let paths: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect();

    if paths.is_empty()
        || paths
            .iter()
            .any(|path| !std::path::Path::new(path).is_absolute())
        || paths.iter().any(|path| {
            !std::fs::metadata(path)
                .map(|m| m.is_file())
                .unwrap_or(false)
        })
    {
        return Vec::new();
    }

    paths
}

/// Import an image file from disk into the storage directory.
/// Returns true if the file was imported as an image record.
fn import_image_file(app: &AppHandle, file_path: &str) -> bool {
    let file_size = std::fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);

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

    let content_hash: u64 = rgba
        .iter()
        .fold(0u64, |acc, &b| acc.wrapping_mul(31).wrapping_add(b as u64));
    let content_hash_str = format!("{:016x}", content_hash);
    let filename = format!("{}.png", content_hash_str);
    let relative = format!("images/{}", filename);

    let mut png_bytes: Vec<u8> = Vec::new();
    {
        let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
        use image::ImageEncoder;
        let _ = encoder.write_image(&rgba, img_w, img_h, image::ExtendedColorType::Rgba8);
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

    crate::paste::cache_image(relative.clone(), rgba.to_vec(), img_w, img_h);

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
        if thumb
            .write_to(&mut thumb_buf, image::ImageFormat::Png)
            .is_ok()
        {
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
    let two_seconds_ago = chrono::Utc::now() - chrono::Duration::seconds(2);
    let cutoff = two_seconds_ago.to_rfc3339();

    // Check ANY recent record with same type+content (not just the last one)
    // so that batches of files/images don't circumvent deduplication.
    let is_duplicate: bool = {
        let state = app.state::<crate::db::DbState>();
        let x = match state.conn.lock() {
            Ok(conn) => conn
                .query_row(
                    "SELECT COUNT(*) FROM clipboard_records WHERE type = ?1 AND content = ?2 AND created_at >= ?3",
                    rusqlite::params![record_type, content, cutoff],
                    |row| row.get::<_, i64>(0),
                )
                .map(|count| count > 0)
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
    let sort_order = chrono::Utc::now().timestamp_millis();
    {
        let state = app.state::<crate::db::DbState>();
        let _x = match state.conn.lock() {
            Ok(conn) => conn.execute(
                "INSERT INTO clipboard_records (id, type, content, source_app, created_at, sort_order, group_name) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![id, record_type, content, "", &now, sort_order, ""],
            ).ok(),
            Err(_) => None,
        };
    }
    let (is_key, key_preview, guessed_service) = api_key_metadata(app, &id, record_type, content);

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
            "group_name": "",
        }),
    )
    .ok();
}

/// Cached clipboard state, updated by the monitor and by paste functions.
pub static LAST_CLIPBOARD_TEXT: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
pub static LAST_CLIPBOARD_IMAGE_HASH: std::sync::Mutex<u64> = std::sync::Mutex::new(0);
pub static LAST_CLIPBOARD_FILES_KEY: std::sync::Mutex<String> =
    std::sync::Mutex::new(String::new());

/// Capture the current clipboard image hash (if any) so we don't
/// re-record an existing image on startup or after our own paste.
fn capture_current_image_hash() -> u64 {
    if let Ok(mut clipboard) = arboard::Clipboard::new() {
        if let Ok(image) = clipboard.get_image() {
            let rgba = &image.bytes;
            if !rgba.is_empty() && image.width > 0 && image.height > 0 {
                return rgba
                    .iter()
                    .step_by(64)
                    .fold(0u64, |acc, &b| acc.wrapping_mul(31).wrapping_add(b as u64));
            }
        }
    }
    0
}

pub fn sync_monitor_text(text: &str) {
    *LAST_CLIPBOARD_TEXT.lock().unwrap() = text.trim().to_string();
}

pub fn sync_monitor_image(rgba: &[u8]) {
    let hash = rgba.iter().step_by(64).fold(0u64, |acc, &byte| {
        acc.wrapping_mul(31).wrapping_add(byte as u64)
    });
    *LAST_CLIPBOARD_IMAGE_HASH.lock().unwrap() = hash;
}

pub fn sync_monitor_cache(handle: &AppHandle) {
    // Text
    if let Ok(text) = handle.clipboard().read_text() {
        *LAST_CLIPBOARD_TEXT.lock().unwrap() = text.trim().to_string();
    }
    // Image
    let hash = capture_current_image_hash();
    if hash != 0 {
        *LAST_CLIPBOARD_IMAGE_HASH.lock().unwrap() = hash;
    }
    // File lists — prevent re-recording our own file paste.
    // paste_file 与 Windows 资源管理器复制文件都写文件格式（CF_HDROP /
    // uri-list），Windows 上读不到对应文本，因此优先从文件格式生成 key。
    match clipboard_file_list() {
        Some(files) => {
            *LAST_CLIPBOARD_FILES_KEY.lock().unwrap() = files.join("|");
        }
        None => {
            if let Ok(text) = handle.clipboard().read_text() {
                let text = text.trim().to_string();
                if text.contains("file://") {
                    *LAST_CLIPBOARD_FILES_KEY.lock().unwrap() = text
                        .lines()
                        .filter_map(|l| parse_file_uri(l.trim()))
                        .collect::<Vec<_>>()
                        .join("|");
                }
            }
        }
    }
}

pub fn start_monitor(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.clone();

    {
        let initial_text = handle
            .clipboard()
            .read_text()
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        *LAST_CLIPBOARD_TEXT.lock().unwrap() = initial_text;
    }

    {
        // 优先从文件格式生成 key（Windows 复制文件时没有文本格式），
        // 没有文件格式时回退 file:// 文本启发式。
        let key = clipboard_file_list()
            .map(|files| files.join("|"))
            .unwrap_or_else(|| {
                handle
                    .clipboard()
                    .read_text()
                    .map(|text| {
                        text.lines()
                            .filter_map(|l| parse_file_uri(l.trim()))
                            .collect::<Vec<_>>()
                            .join("|")
                    })
                    .unwrap_or_default()
            });
        *LAST_CLIPBOARD_FILES_KEY.lock().unwrap() = key;
    }

    // Seed image hash so a hot restart doesn't re-record the
    // image that was already in the clipboard.
    {
        let hash = capture_current_image_hash();
        *LAST_CLIPBOARD_IMAGE_HASH.lock().unwrap() = hash;
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
                continue;
            }

            // Linux: poll-based detection via content comparison every cycle
            let mut image_recorded = false;

            let mut image_data: Option<(Vec<u8>, u32, u32)> = None;

            // Image detection via arboard — only record when the image actually changes
            if let Ok(mut clipboard) = arboard::Clipboard::new() {
                if let Ok(image) = clipboard.get_image() {
                    let rgba = &image.bytes;
                    if !rgba.is_empty() && image.width > 0 && image.height > 0 {
                        let hash = rgba
                            .iter()
                            .step_by(64)
                            .fold(0u64, |acc, &b| acc.wrapping_mul(31).wrapping_add(b as u64));
                        let mut cached_hash = LAST_CLIPBOARD_IMAGE_HASH.lock().unwrap();
                        if hash != *cached_hash {
                            *cached_hash = hash;
                            image_data =
                                Some((rgba.to_vec(), image.width as u32, image.height as u32));
                        }
                        // If hash matches: image hasn't changed → skip (no re-insertion)
                    }
                }
            }

            if let Some((rgba_vec, img_w, img_h)) = image_data.take() {
                let content_hash: u64 = rgba_vec
                    .iter()
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

                    log::info!(
                        "clipboard: recorded image {}x{} hash={}",
                        img_w,
                        img_h,
                        content_hash_str
                    );

                    crate::paste::cache_image(relative.clone(), rgba_vec, img_w, img_h);

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
                            if thumb
                                .write_to(&mut thumb_buf, image::ImageFormat::Png)
                                .is_ok()
                            {
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

            if image_recorded {
                if let Ok(text) = handle.clipboard().read_text() {
                    *LAST_CLIPBOARD_TEXT.lock().unwrap() = text.trim().to_string();
                }
            } else {
                // 优先读剪贴板文件格式：Windows 资源管理器复制文件只放
                // CF_HDROP 不放文本，仅靠文本启发式会漏掉这类文件记录。
                let mut files = clipboard_file_list().unwrap_or_default();

                if files.is_empty() {
                    if let Ok(text) = handle.clipboard().read_text() {
                        let text = text.trim().to_string();
                        files = clipboard_text_files(&text);

                        if !files.is_empty() {
                            *LAST_CLIPBOARD_TEXT.lock().unwrap() = text;
                        }
                    }
                }

                if !files.is_empty() {
                    let key = files.join("|");
                    {
                        let mut cached = LAST_CLIPBOARD_FILES_KEY.lock().unwrap();
                        if key == *cached {
                            // File list unchanged — skip to avoid re-inserting
                            // the same images/files on every poll cycle.
                            continue;
                        }
                        *cached = key.clone();
                    }

                    for file_path in files {
                        if file_path.trim().is_empty() {
                            continue;
                        }
                        if is_previewable_image_file(&file_path) || is_image_file(&file_path) {
                            if import_image_file(&handle, &file_path) {
                                continue;
                            }
                            continue;
                        }
                        insert_and_emit(&handle, "file", &file_path);
                    }
                } else if let Ok(text) = handle.clipboard().read_text() {
                    let text = text.trim().to_string();
                    if !text.is_empty() && text != *LAST_CLIPBOARD_TEXT.lock().unwrap() {
                        *LAST_CLIPBOARD_TEXT.lock().unwrap() = text.clone();
                        let record_type = classify_text_record(&text);
                        insert_and_emit(&handle, record_type, &text);
                    }
                }
            }
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        clipboard_text_files, encode_rgba_png, parse_file_uri, render_resource_markdown,
        sanitize_resource_file_stem, stash_content_for_display, validate_stash_content,
    };
    use base64::Engine;

    #[test]
    fn parses_local_file_uri_with_original_filename() {
        assert_eq!(
            parse_file_uri("file:///tmp/quick-input/%E6%B5%8B%E8%AF%95%20file.txt"),
            Some("/tmp/quick-input/测试 file.txt".to_string())
        );
    }

    #[test]
    fn classifies_file_uri_clipboard_text_as_files_before_plain_text() {
        let files = clipboard_text_files(
            "file:///home/ao/.local/share/copy-creator/quick-input-files/123/report%20final.pdf\n",
        );

        assert_eq!(
            files,
            vec![
                "/home/ao/.local/share/copy-creator/quick-input-files/123/report final.pdf"
                    .to_string()
            ]
        );
    }

    #[test]
    fn classifies_existing_absolute_path_clipboard_text_as_file() {
        let path = std::env::temp_dir().join(format!(
            "copy-creator-clipboard-file-test-{}.txt",
            std::process::id()
        ));
        std::fs::write(&path, "file clipboard test").unwrap();

        let files = clipboard_text_files(path.to_str().unwrap());

        std::fs::remove_file(&path).unwrap();
        assert_eq!(files, vec![path.to_string_lossy().into_owned()]);
    }

    #[test]
    fn encodes_clipboard_rgba_as_png() {
        let encoded = encode_rgba_png(&[255, 0, 0, 255], 1, 1).unwrap();
        let png = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();

        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn validates_object_placeholders_and_preserves_visible_tokens() {
        let content = "字面 [Image #1]\u{FFFC}结束";

        validate_stash_content(content, 1).unwrap();
        assert_eq!(
            stash_content_for_display(content),
            "字面 [Image #1][Image #1]结束"
        );
    }

    #[test]
    fn rejects_mismatched_or_out_of_order_stash_placeholders() {
        assert!(validate_stash_content("\u{FFFC}", 2).is_err());
        assert!(validate_stash_content("[Image #2][Image #1]", 2).is_err());
    }

    #[test]
    fn renders_plain_resource_text_as_a_markdown_image_document() {
        let markdown = render_resource_markdown(
            "截图前\u{FFFC}截图后",
            &[".copy-creator/attachments/item/image-1.png".to_string()],
        )
        .unwrap();

        assert_eq!(
            markdown,
            "截图前![截图 1](.copy-creator/attachments/item/image-1.png)截图后\n"
        );
    }

    #[test]
    fn generates_a_safe_resource_file_stem_from_visible_content() {
        assert_eq!(
            sanitize_resource_file_stem("  一个/文件:标题\u{FFFC}"),
            "一个_文件_标题"
        );
    }
}
