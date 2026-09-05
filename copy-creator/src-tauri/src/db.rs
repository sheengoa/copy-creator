use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};

// === API Key Detection ===

pub fn is_api_key(content: &str) -> bool {
    let content = content.trim();
    if content.len() < 20 || content.len() > 200 {
        return false;
    }
    if content.contains('\n') || content.contains(' ') {
        return false;
    }
    let patterns = ["sk-", "AIza", "glpat-", "ghp_", "xai-"];
    patterns.iter().any(|p| content.starts_with(p))
}

pub fn guess_service(content: &str) -> Option<&'static str> {
    if content.starts_with("sk-") {
        return Some("OpenAI");
    }
    if content.starts_with("AIza") {
        return Some("Gemini");
    }
    if content.starts_with("glpat-") {
        return Some("GitLab");
    }
    if content.starts_with("ghp_") {
        return Some("GitHub");
    }
    if content.starts_with("xai-") {
        return Some("Grok");
    }
    None
}

pub fn make_key_preview(content: &str) -> String {
    let c = content.trim();
    if c.len() >= 12 {
        format!("{}...{}", &c[..8], &c[c.len() - 4..])
    } else {
        c.to_string()
    }
}

const RESOURCE_RECORD_CONDITION: &str = "COALESCE(storage_mode, 'database') = 'resource'";

fn category_sql(category: &Option<String>) -> (String, String) {
    match category.as_deref() {
        Some("text") => (
            format!("WHERE type = 'text' AND NOT ({RESOURCE_RECORD_CONDITION})"),
            format!("AND type = 'text' AND NOT ({RESOURCE_RECORD_CONDITION})"),
        ),
        Some("image") => (
            format!("WHERE type = 'image' AND NOT ({RESOURCE_RECORD_CONDITION})"),
            format!("AND type = 'image' AND NOT ({RESOURCE_RECORD_CONDITION})"),
        ),
        Some("link") => (
            format!("WHERE type = 'link' AND NOT ({RESOURCE_RECORD_CONDITION})"),
            format!("AND type = 'link' AND NOT ({RESOURCE_RECORD_CONDITION})"),
        ),
        Some("file") => (
            format!("WHERE type = 'file' AND NOT ({RESOURCE_RECORD_CONDITION})"),
            format!("AND type = 'file' AND NOT ({RESOURCE_RECORD_CONDITION})"),
        ),
        Some("resources") => (
            format!("WHERE ({RESOURCE_RECORD_CONDITION})"),
            format!("AND ({RESOURCE_RECORD_CONDITION})"),
        ),
        Some("apikey") => (
            format!(
                "WHERE NOT ({RESOURCE_RECORD_CONDITION}) AND (user_api_key = 1 OR (type IN ('text', 'link') AND (content LIKE 'sk-%' OR content LIKE 'AIza%' OR content LIKE 'glpat-%' OR content LIKE 'ghp_%' OR content LIKE 'xai-%')))"
            ),
            format!(
                "AND NOT ({RESOURCE_RECORD_CONDITION}) AND (user_api_key = 1 OR (type IN ('text', 'link') AND (content LIKE 'sk-%' OR content LIKE 'AIza%' OR content LIKE 'glpat-%' OR content LIKE 'ghp_%' OR content LIKE 'xai-%')))"
            ),
        ),
        _ => (
            format!("WHERE NOT ({RESOURCE_RECORD_CONDITION})"),
            format!("AND NOT ({RESOURCE_RECORD_CONDITION})"),
        ),
    }
}

pub fn is_toast_shown_internal(app: &AppHandle, key_preview: &str) -> bool {
    let state = app.state::<DbState>();
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(_) => return false,
    };
    conn.query_row(
        "SELECT 1 FROM toast_shown WHERE key_preview = ?1",
        params![key_preview],
        |_| Ok(true),
    )
    .unwrap_or(false)
}

pub fn mark_toast_shown_internal(app: &AppHandle, key_preview: &str) {
    let state = app.state::<DbState>();
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    conn.execute(
        "INSERT OR IGNORE INTO toast_shown (key_preview) VALUES (?1)",
        params![key_preview],
    )
    .ok();
}

pub struct DbState {
    pub conn: Mutex<Connection>,
}

const CLIPBOARD_CONTENT_PREVIEW_CHARS: usize = 600;
const QUICK_INPUT_FILE_LIMIT_BYTES: u64 = 50 * 1024 * 1024;
const QUICK_INPUT_TEXT_PREVIEW_LIMIT_BYTES: u64 = 1024 * 1024;
pub(crate) const DATABASE_STORAGE_MODE: &str = "database";
pub(crate) const RESOURCE_STORAGE_MODE: &str = "resource";
const RESOURCE_LIBRARY_DIR_NAME: &str = "resource-library";
const RESOURCE_LIBRARY_HISTORY_SETTING: &str = "resource_library_history";

// 分组与手动暂存均已废弃，仅凭存储模式判定资源记录。
pub(crate) fn is_resource_record(storage_mode: &str) -> bool {
    storage_mode == RESOURCE_STORAGE_MODE
}

fn make_content_preview(content: &str) -> (String, i64, bool) {
    let total_chars = content.chars().count();
    if total_chars <= CLIPBOARD_CONTENT_PREVIEW_CHARS {
        return (content.to_string(), total_chars as i64, false);
    }

    (
        content
            .chars()
            .take(CLIPBOARD_CONTENT_PREVIEW_CHARS)
            .collect::<String>(),
        total_chars as i64,
        true,
    )
}

#[allow(clippy::too_many_arguments)]
fn clipboard_record_json(
    id: String,
    rec_type: String,
    content: String,
    source_app: String,
    created_at: String,
    user_api_key: i64,
    group_name: String,
    attachments: String,
    storage_mode: String,
    resource_path: String,
) -> serde_json::Value {
    let attachment_paths = serde_json::from_str::<Vec<String>>(&attachments).unwrap_or_default();
    let has_images = !attachment_paths.is_empty();
    let drag_path = attachment_paths.first().cloned().or_else(|| {
        if rec_type == "image" || rec_type == "file" {
            Some(content.clone())
        } else {
            None
        }
    });
    let content = if has_images {
        crate::clipboard::stash_content_for_display(&content)
    } else {
        content
    };
    let (list_content, content_length, content_truncated) = if rec_type == "text" {
        make_content_preview(&content)
    } else {
        (content, 0, false)
    };
    let content_length = if content_length == 0 {
        list_content.chars().count() as i64
    } else {
        content_length
    };
    serde_json::json!({
        "id": id,
        "type": rec_type,
        "content": list_content,
        "content_length": content_length,
        "content_truncated": content_truncated,
        "source_app": source_app,
        "created_at": created_at,
        "user_api_key": user_api_key,
        "group_name": group_name,
        "has_images": has_images,
        "drag_path": drag_path,
        "storage_mode": if storage_mode == RESOURCE_STORAGE_MODE {
            RESOURCE_STORAGE_MODE
        } else {
            DATABASE_STORAGE_MODE
        },
        "resource_path": resource_path,
    })
}

fn db_path(app: &AppHandle) -> PathBuf {
    let default_dir = app
        .path()
        .app_data_dir()
        .expect("failed to get app data dir");
    let default_db = default_dir.join("data.db");
    std::fs::create_dir_all(&default_dir).ok();

    if !default_db.exists() {
        return default_db;
    }

    let mut current = default_db;
    let mut visited: HashSet<PathBuf> = HashSet::new();

    loop {
        let conn = match Connection::open(&current) {
            Ok(c) => c,
            Err(_) => break,
        };

        let path: String = match conn.query_row(
            "SELECT value FROM settings WHERE key = 'storage_path'",
            [],
            |row| row.get::<_, String>(0),
        ) {
            Ok(p) if !p.is_empty() => p,
            _ => break,
        };

        let custom_dir = PathBuf::from(&path);
        let custom_db = custom_dir.join("data.db");

        if custom_db == current || !visited.insert(custom_db.clone()) {
            break;
        }

        if !custom_db.exists() {
            break;
        }

        current = custom_db;
    }

    current
}

pub fn get_storage_dir(app: &AppHandle) -> PathBuf {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().unwrap();
    if let Ok(path) = conn.query_row(
        "SELECT value FROM settings WHERE key = 'storage_path'",
        [],
        |row| row.get::<_, String>(0),
    ) {
        if !path.is_empty() {
            let custom_dir = PathBuf::from(&path);
            if custom_dir.exists() || std::fs::create_dir_all(&custom_dir).is_ok() {
                return custom_dir;
            }
        }
    }
    drop(conn);
    app.path()
        .app_data_dir()
        .expect("failed to get app data dir")
}

fn normalize_relative_path(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if normalized.as_os_str().is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn resolve_relative_storage_path(root: &Path, path: &str) -> Option<PathBuf> {
    normalize_relative_path(Path::new(path)).map(|relative| root.join(relative))
}

fn resolve_storage_path_from_root(root: &Path, path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        return Ok(path);
    }
    resolve_relative_storage_path(root, path.to_string_lossy().as_ref())
        .ok_or_else(|| "存储路径无效".to_string())
}

pub(crate) fn resolve_storage_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    resolve_storage_path_from_root(&get_storage_dir(app), path)
}

pub(crate) fn resolve_managed_storage_path(app: &AppHandle, path: &str) -> Option<PathBuf> {
    resolve_relative_storage_path(&get_storage_dir(app), path)
}

fn default_resource_library_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("failed to get app data dir")
        .join(RESOURCE_LIBRARY_DIR_NAME)
}

pub(crate) fn get_resource_library_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    let configured_path = get_setting_sync(app, "resource_library_path")
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    let dir = configured_path.unwrap_or_else(|| default_resource_library_dir(app));
    if let Err(error) = std::fs::create_dir_all(&dir) {
        log::warn!("无法创建资源库目录 {}: {}", dir.display(), error);
    }
    dir
}

pub(crate) fn normalize_resource_group_name(value: Option<&str>) -> Result<String, String> {
    let name = value.unwrap_or("").trim();
    if name.is_empty() {
        return Ok(String::new());
    }
    if name.chars().count() > 80 {
        return Err("分组名称不能超过 80 个字符".to_string());
    }
    if name == "." || name == ".." || name.starts_with('.') {
        return Err("分组名称不能以点号开头".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("分组名称不能包含路径分隔符".to_string());
    }
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("分组名称无效".to_string());
    }
    Ok(name.to_string())
}

pub(crate) fn resource_group_path<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
) -> Result<PathBuf, String> {
    let normalized = normalize_resource_group_name(Some(name))?;
    let root = get_resource_library_dir(app);
    if normalized.is_empty() {
        Ok(root)
    } else {
        Ok(root.join(normalized))
    }
}

pub(crate) fn resource_group_for_path(root: &Path, resource_path: &str) -> Option<String> {
    let path = Path::new(resource_path);
    if !path.is_absolute() {
        return None;
    }
    let parent = path.parent()?;
    if parent == root {
        return Some(String::new());
    }
    let relative_parent = parent.strip_prefix(root).ok()?;
    let mut components = relative_parent.components();
    let Component::Normal(group_name) = components.next()? else {
        return None;
    };
    if components.next().is_some() {
        return None;
    }
    let group_name = group_name.to_str()?.to_string();
    normalize_resource_group_name(Some(&group_name)).ok()
}

fn resource_library_history<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    get_setting_sync(app, RESOURCE_LIBRARY_HISTORY_SETTING)
        .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .collect()
}

fn resource_library_roots<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for root in std::iter::once(get_resource_library_dir(app))
        .chain(std::iter::once(default_resource_library_dir(app)))
        .chain(resource_library_history(app))
    {
        if !roots.iter().any(|existing| existing == &root) {
            roots.push(root);
        }
    }
    roots
}

fn managed_resource_file_path(
    resource_roots: &[PathBuf],
    record_id: &str,
    resource_path: &str,
) -> Option<(PathBuf, PathBuf)> {
    if record_id.is_empty() {
        return None;
    }
    let path = PathBuf::from(resource_path);
    if !path.is_absolute() {
        return None;
    }
    let file_name = path.file_name()?.to_str()?;
    let prefix = format!("copy-creator-{record_id}-");
    if !file_name
        .strip_prefix(&prefix)
        .is_some_and(|suffix| !suffix.is_empty())
    {
        return None;
    }
    if !matches!(path.extension()?.to_str()?, "txt" | "md") {
        return None;
    }
    let resource_root = resource_roots
        .iter()
        .find(|root| resource_group_for_path(root, path.to_string_lossy().as_ref()).is_some())?
        .clone();
    Some((path, resource_root))
}

fn managed_resource_attachment_path(
    resource_root: &Path,
    record_id: &str,
    attachment_path: &str,
) -> Option<(PathBuf, PathBuf)> {
    if record_id.is_empty() {
        return None;
    }
    let path = PathBuf::from(attachment_path);
    if !path.is_absolute() {
        return None;
    }

    let attachments_root = resource_root.join(".copy-creator").join("attachments");
    let relative = path.strip_prefix(&attachments_root).ok()?;
    let mut components = relative.components();
    let attachment_dir_name = components.next()?.as_os_str().to_str()?;
    let file_name = components.next()?.as_os_str().to_str()?;
    if components.next().is_some() {
        return None;
    }

    let record_prefix = format!("{record_id}-");
    if !attachment_dir_name
        .strip_prefix(&record_prefix)
        .is_some_and(|suffix| !suffix.is_empty())
    {
        return None;
    }
    let image_number = file_name
        .strip_prefix("image-")
        .and_then(|name| name.strip_suffix(".png"))?;
    let image_number = image_number.parse::<usize>().ok()?;
    if image_number == 0 {
        return None;
    }

    let attachment_dir = attachments_root.join(attachment_dir_name);
    if path.parent() != Some(attachment_dir.as_path()) {
        return None;
    }
    Some((path, attachment_dir))
}

fn remove_resource_record_attachments_from_roots(
    resource_roots: &[PathBuf],
    record_id: &str,
    attachment_paths: &[String],
) {
    for resource_root in resource_roots {
        for attachment in attachment_paths {
            let Some((path, parent)) =
                managed_resource_attachment_path(resource_root, record_id, attachment)
            else {
                continue;
            };
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_dir(&parent);
            if let Some(attachments_dir) = parent.parent() {
                let _ = std::fs::remove_dir(attachments_dir);
                if let Some(meta_dir) = attachments_dir.parent() {
                    let _ = std::fs::remove_dir(meta_dir);
                }
            }
        }
    }
}

pub(crate) fn remove_resource_record_attachments(
    app: &AppHandle,
    record_id: &str,
    attachment_paths: &[String],
) {
    let resource_roots = resource_library_roots(app);
    remove_resource_record_attachments_from_roots(&resource_roots, record_id, attachment_paths);
}

pub(crate) fn remove_resource_record_files(
    app: &AppHandle,
    record_id: &str,
    resource_path: &str,
    attachment_paths: &[String],
) {
    let resource_roots = resource_library_roots(app);
    if let Some((path, _)) = managed_resource_file_path(&resource_roots, record_id, resource_path) {
        let _ = std::fs::remove_file(path);
    } else if resource_path.trim().is_empty() {
        let resource_file_prefix = format!("copy-creator-{record_id}-");
        for resource_root in &resource_roots {
            if let Ok(entries) = std::fs::read_dir(resource_root) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let candidates = if entry.file_type().is_ok_and(|file_type| file_type.is_dir())
                        && resource_group_for_path(
                            resource_root,
                            path.join("placeholder.txt").to_string_lossy().as_ref(),
                        )
                        .is_some()
                    {
                        std::fs::read_dir(&path)
                            .map(|children| children.flatten().map(|child| child.path()).collect())
                            .unwrap_or_default()
                    } else {
                        vec![path]
                    };
                    for candidate in candidates {
                        let is_managed_resource_file = candidate
                            .file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| name.starts_with(&resource_file_prefix))
                            && candidate
                                .extension()
                                .and_then(|extension| extension.to_str())
                                .is_some_and(|extension| matches!(extension, "txt" | "md"));
                        if is_managed_resource_file {
                            let _ = std::fs::remove_file(candidate);
                        }
                    }
                }
            }
        }
    }

    remove_resource_record_attachments_from_roots(&resource_roots, record_id, attachment_paths);
}

fn quick_input_files_dir(app: &AppHandle) -> PathBuf {
    let dir = get_storage_dir(app).join("quick-input-files");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn quick_input_relative_path(dir_name: &str, filename: &str) -> String {
    format!("quick-input-files/{}/{}", dir_name, filename)
}

fn is_legacy_quick_input_file_path(relative_path: &str) -> bool {
    quick_input_relative_component_count(relative_path) == Some(1)
}

fn quick_input_relative_component_count(relative_path: &str) -> Option<usize> {
    let mut components = Path::new(relative_path).components();
    if components.next()? != Component::Normal(OsStr::new("quick-input-files")) {
        return None;
    }
    let rest = components.collect::<Vec<_>>();
    if !(1..=2).contains(&rest.len())
        || rest
            .iter()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    Some(rest.len())
}

fn quick_input_absolute_path(app: &AppHandle, relative_path: &str) -> Option<PathBuf> {
    quick_input_relative_component_count(relative_path)?;
    resolve_relative_storage_path(&get_storage_dir(app), relative_path)
}

fn remove_quick_input_file(app: &AppHandle, relative_path: &str) {
    if let Some(path) = quick_input_absolute_path(app, relative_path) {
        let _ = std::fs::remove_file(&path);
        if let Some(parent) = path.parent() {
            if parent != quick_input_files_dir(app) {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }
}

fn copy_quick_input_file(app: &AppHandle, source_path: &str) -> Result<(String, u64), String> {
    let source = PathBuf::from(source_path);
    let meta = std::fs::metadata(&source).map_err(|e| format!("读取文件失败: {}", e))?;
    if !meta.is_file() {
        return Err("请选择一个文件".to_string());
    }
    let size = meta.len();
    if size > QUICK_INPUT_FILE_LIMIT_BYTES {
        return Err(format!(
            "文件不能超过 {} MB",
            QUICK_INPUT_FILE_LIMIT_BYTES / 1024 / 1024
        ));
    }

    let original_filename = source
        .file_name()
        .and_then(|e| e.to_str())
        .ok_or_else(|| "文件名无效".to_string())?;
    let dir_name = uuid::Uuid::new_v4().to_string();
    let dest_dir = quick_input_files_dir(app).join(&dir_name);
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("创建文件目录失败: {}", e))?;
    let dest = dest_dir.join(original_filename);
    std::fs::copy(&source, &dest).map_err(|e| format!("复制文件失败: {}", e))?;
    Ok((
        quick_input_relative_path(&dir_name, original_filename),
        size,
    ))
}

fn legacy_quick_input_target_path(relative_path: &str, source_path: &str) -> Option<String> {
    if !is_legacy_quick_input_file_path(relative_path) {
        return None;
    }

    let stored_name = relative_path.strip_prefix("quick-input-files/")?;
    let dir_name = std::path::Path::new(stored_name).file_stem()?.to_str()?;
    let original_filename = std::path::Path::new(source_path).file_name()?.to_str()?;
    if original_filename.is_empty() {
        return None;
    }

    let target = quick_input_relative_path(dir_name, original_filename);
    (quick_input_relative_component_count(&target) == Some(2)).then_some(target)
}

fn migrate_legacy_quick_input_file_names(app: &AppHandle) {
    let storage_dir = get_storage_dir(app);
    let state = app.state::<DbState>();
    let conn = match state.conn.lock() {
        Ok(conn) => conn,
        Err(e) => {
            log::warn!("quick input file migration skipped: {}", e);
            return;
        }
    };

    let rows: Vec<(String, String, String)> = {
        let mut stmt = match conn
            .prepare("SELECT id, content, source_path FROM phrases WHERE input_type = 'file'")
        {
            Ok(stmt) => stmt,
            Err(e) => {
                log::warn!("quick input file migration query failed: {}", e);
                return;
            }
        };
        let rows = match stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        }) {
            Ok(rows) => rows,
            Err(e) => {
                log::warn!("quick input file migration rows failed: {}", e);
                return;
            }
        };
        rows.filter_map(|row| row.ok()).collect()
    };

    for (id, old_relative_path, source_path) in rows {
        let Some(new_relative_path) =
            legacy_quick_input_target_path(&old_relative_path, &source_path)
        else {
            continue;
        };
        let (Some(old_path), Some(new_path)) = (
            resolve_relative_storage_path(&storage_dir, &old_relative_path),
            resolve_relative_storage_path(&storage_dir, &new_relative_path),
        ) else {
            continue;
        };
        if !old_path.exists() {
            continue;
        }
        if let Some(parent) = new_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log::warn!("quick input file migration mkdir failed: {}", e);
                continue;
            }
        }
        let moved = std::fs::rename(&old_path, &new_path)
            .or_else(|_| std::fs::copy(&old_path, &new_path).map(|_| ()))
            .map(|_| {
                let _ = std::fs::remove_file(&old_path);
            });
        if let Err(e) = moved {
            log::warn!("quick input file migration move failed: {}", e);
            continue;
        }
        if let Err(e) = conn.execute(
            "UPDATE phrases SET content = ?1 WHERE id = ?2",
            params![new_relative_path, id],
        ) {
            log::warn!("quick input file migration db update failed: {}", e);
        }
    }
}

#[tauri::command]
pub async fn select_quick_input_file(app: AppHandle) -> Result<serde_json::Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_file(move |path| {
        let _ = tx.send(path);
    });
    let result =
        tokio::task::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(60)))
            .await
            .map_err(|e| format!("task error: {}", e))?;

    match result {
        Ok(Some(path)) => {
            let path_string = path.to_string();
            let meta = std::fs::metadata(PathBuf::from(&path_string))
                .map_err(|e| format!("读取文件失败: {}", e))?;
            if !meta.is_file() {
                return Err("请选择一个文件".to_string());
            }
            if meta.len() > QUICK_INPUT_FILE_LIMIT_BYTES {
                return Err(format!(
                    "文件不能超过 {} MB",
                    QUICK_INPUT_FILE_LIMIT_BYTES / 1024 / 1024
                ));
            }
            Ok(serde_json::json!({
                "path": path_string,
                "file_size": meta.len(),
            }))
        }
        Ok(None) => Err("cancelled".to_string()),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err("timeout".to_string()),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err("cancelled".to_string()),
    }
}

#[tauri::command]
pub fn get_quick_input_file_limit() -> u64 {
    QUICK_INPUT_FILE_LIMIT_BYTES
}

/// 拖入文件的元信息校验：确认是文件且不超过快捷输入的大小上限，
/// 让拖入与"选择文件"入口的行为一致。
#[tauri::command]
pub fn get_quick_input_file_info(path: String) -> Result<serde_json::Value, String> {
    let meta = std::fs::metadata(PathBuf::from(&path)).map_err(|e| format!("读取文件失败: {e}"))?;
    if !meta.is_file() {
        return Err("请选择一个文件".to_string());
    }
    if meta.len() > QUICK_INPUT_FILE_LIMIT_BYTES {
        return Err(format!(
            "文件不能超过 {} MB",
            QUICK_INPUT_FILE_LIMIT_BYTES / 1024 / 1024
        ));
    }
    Ok(serde_json::json!({
        "path": path,
        "file_size": meta.len(),
    }))
}

fn is_quick_input_text_preview_path(path: &str) -> bool {
    quick_input_relative_component_count(path).is_some()
        && is_text_preview_extension(Path::new(path))
}

fn is_text_preview_extension(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "json" | "txt" | "toml"
            )
        })
}

fn read_text_preview_file(path: PathBuf) -> Result<String, String> {
    if !is_text_preview_extension(&path) {
        return Err("仅支持预览 JSON、TXT 和 TOML 文件".to_string());
    }
    let metadata = std::fs::metadata(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    if !metadata.is_file() {
        return Err("请选择一个文件".to_string());
    }
    if metadata.len() > QUICK_INPUT_TEXT_PREVIEW_LIMIT_BYTES {
        return Err("预览文件不能超过 1 MB".to_string());
    }
    std::fs::read_to_string(path).map_err(|e| format!("读取文件失败: {e}"))
}

fn resolve_quick_input_text_preview_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    if !is_quick_input_text_preview_path(path) {
        return Err("仅支持预览 JSON、TXT 和 TOML 文件".to_string());
    }

    let preview_root = quick_input_files_dir(app)
        .canonicalize()
        .map_err(|e| format!("读取预览目录失败: {e}"))?;
    let preview_path = quick_input_absolute_path(app, path)
        .ok_or_else(|| "快捷输入文件路径无效".to_string())?
        .canonicalize()
        .map_err(|e| format!("读取文件失败: {e}"))?;
    if !preview_path.starts_with(&preview_root) {
        return Err("快捷输入文件路径无效".to_string());
    }

    let metadata = std::fs::metadata(&preview_path).map_err(|e| format!("读取文件失败: {e}"))?;
    if !metadata.is_file() {
        return Err("请选择一个文件".to_string());
    }
    if metadata.len() > QUICK_INPUT_TEXT_PREVIEW_LIMIT_BYTES {
        return Err("预览文件不能超过 1 MB".to_string());
    }
    Ok(preview_path)
}

#[tauri::command]
pub fn read_quick_input_text_preview(app: AppHandle, path: String) -> Result<String, String> {
    let preview_path = resolve_quick_input_text_preview_path(&app, &path)?;
    read_text_preview_file(preview_path)
}

#[tauri::command]
pub fn read_clipboard_text_preview(app: AppHandle, id: String) -> Result<String, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let (record_type, content): (String, String) = conn
        .query_row(
            "SELECT type, content FROM clipboard_records WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("读取剪切板记录失败: {e}"))?;
    drop(conn);

    if record_type != "file" {
        return Err("当前记录不是文件".to_string());
    }
    let path = if Path::new(&content).is_absolute() {
        PathBuf::from(content)
    } else {
        resolve_storage_path(&app, &content)?
    };
    read_text_preview_file(path)
}

pub fn init_db(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let path = db_path(app);
    let conn = Connection::open(&path)?;

    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8000;",
    )?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS clipboard_records (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            source_app TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            user_api_key INTEGER DEFAULT 0,
            attachments TEXT DEFAULT '[]',
            storage_mode TEXT DEFAULT 'database',
            resource_path TEXT DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_clipboard_created_at
            ON clipboard_records(created_at);

        CREATE TABLE IF NOT EXISTS phrase_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS phrases (
            id TEXT PRIMARY KEY,
            group_id TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            input_type TEXT DEFAULT 'text',
            source_path TEXT DEFAULT '',
            file_size INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (group_id) REFERENCES phrase_groups(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS translation_history (
            id TEXT PRIMARY KEY,
            source_text TEXT NOT NULL,
            target_text TEXT NOT NULL,
            source_lang TEXT DEFAULT 'auto',
            target_lang TEXT NOT NULL,
            engine TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_translation_created_at
            ON translation_history(created_at);

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        INSERT OR IGNORE INTO settings (key, value) VALUES ('clipboard_retention', '1month');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('default_translate_engine', 'google');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'light');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('language', 'zh-CN');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('google_api_key', '');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('translate_proxy', '');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('radial_menu_enabled', '1');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('autostart', '0');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('shortcut_key', '');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('resource_library_path', '');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('resource_library_history', '[]');

        UPDATE settings SET value = 'google' WHERE key = 'default_translate_engine' AND value = 'builtin';

        CREATE TABLE IF NOT EXISTS api_key_labels (
            record_id   TEXT PRIMARY KEY,
            key_preview TEXT NOT NULL,
            service     TEXT NOT NULL,
            api_base    TEXT DEFAULT '',
            note        TEXT DEFAULT '',
            is_expired  INTEGER DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS toast_shown (
            key_preview TEXT PRIMARY KEY
        );
        ",
    )?;

    // Migrate api_key_labels from old schema (no record_id PK) to new schema
    {
        let has_record_id_pk: bool = conn
            .prepare("PRAGMA table_info(api_key_labels)")
            .and_then(|mut stmt| {
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
                })?;
                let mut found = false;
                for row in rows.flatten() {
                    if row.0 == "record_id" && row.1 != 0 {
                        found = true;
                    }
                }
                Ok(found)
            })
            .unwrap_or(true);
        if !has_record_id_pk {
            conn.execute("DROP TABLE IF EXISTS api_key_labels", [])
                .map_err(|e| e.to_string())?;
            conn.execute(
                "CREATE TABLE api_key_labels (
                    record_id   TEXT PRIMARY KEY,
                    key_preview TEXT NOT NULL,
                    service     TEXT NOT NULL,
                    api_base    TEXT DEFAULT '',
                    note        TEXT DEFAULT '',
                    is_expired  INTEGER DEFAULT 0,
                    created_at  TEXT NOT NULL,
                    updated_at  TEXT NOT NULL
                )",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // Runtime migrations for existing databases
    conn.execute(
        "ALTER TABLE clipboard_records ADD COLUMN user_api_key INTEGER DEFAULT 0",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE phrases ADD COLUMN input_type TEXT DEFAULT 'text'",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE phrases ADD COLUMN source_path TEXT DEFAULT ''",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE phrases ADD COLUMN file_size INTEGER DEFAULT 0",
        [],
    )
    .ok();

    // ── sort_order migration for drag reorder ─────────────────────
    conn.execute_batch(
        "
        ALTER TABLE clipboard_records ADD COLUMN sort_order REAL;

        CREATE INDEX IF NOT EXISTS idx_clipboard_sort_order
            ON clipboard_records(sort_order DESC);
        ",
    )
    .ok();

    // Seed sort_order for existing records that still have NULL
    let seeded: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM clipboard_records WHERE sort_order IS NOT NULL LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if !seeded {
        conn.execute_batch(
            "
            UPDATE clipboard_records
            SET sort_order = CAST(
                (julianday(created_at) - 2440587.5) * 86400000 AS INTEGER
            )
            WHERE sort_order IS NULL;
            ",
        )
        .ok();
        log::info!(
            "db: seeded sort_order for {} clipboard records",
            conn.changes()
        );
    }

    // ── group_name migration for manual stash entries ─────────────
    conn.execute(
        "ALTER TABLE clipboard_records ADD COLUMN group_name TEXT DEFAULT ''",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE clipboard_records ADD COLUMN attachments TEXT DEFAULT '[]'",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE clipboard_records ADD COLUMN storage_mode TEXT DEFAULT 'database'",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE clipboard_records ADD COLUMN resource_path TEXT DEFAULT ''",
        [],
    )
    .ok();

    // ── 内容模式迁移：资源（资源库）与普通剪贴板两种模式，分组与“临时”标记废弃 ──
    // 旧版本以“是否有分组”推断资源，手动暂存记在 group_name（'stash'/'暂存'/'临时'）。
    // 统一为：带真实分组名的旧记录升级为资源后清空分组；手动暂存标记全部清除，并入剪贴板列表。
    conn.execute(
        "UPDATE clipboard_records SET storage_mode = ?1
         WHERE TRIM(COALESCE(group_name, '')) <> ''
           AND group_name NOT IN ('stash', '暂存', '默认', '临时')
           AND COALESCE(storage_mode, 'database') <> ?1",
        params![RESOURCE_STORAGE_MODE],
    )
    .ok();
    conn.execute(
        "UPDATE clipboard_records SET group_name = ''
         WHERE COALESCE(storage_mode, 'database') = ?1",
        params![RESOURCE_STORAGE_MODE],
    )
    .ok();
    conn.execute(
        "UPDATE clipboard_records SET group_name = ''
         WHERE group_name IN ('stash', '暂存', '默认', '临时')",
        [],
    )
    .ok();
    // 分组功能已删除，连同旧库中的分组表一起清理。
    conn.execute("DROP TABLE IF EXISTS resource_groups", [])
        .ok();

    app.manage(DbState {
        conn: Mutex::new(conn),
    });
    migrate_legacy_quick_input_file_names(app);

    Ok(())
}

pub fn prune_old_records(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let (days, image_contents) = {
        let mut image_contents = Vec::new();

        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;

        let retention = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'clipboard_retention'",
                [],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| "1month".to_string());

        let days = match retention.as_str() {
            "1week" => 7,
            "3months" => 90,
            _ => 30,
        };

        let mut stmt = conn.prepare(
            "SELECT type, content, attachments
             FROM clipboard_records
             WHERE datetime(created_at) < datetime('now', ?1)
               AND NOT (COALESCE(storage_mode, 'database') = 'resource')",
        )?;
        let rows = stmt.query_map(params![format!("-{} days", days)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (record_type, content, attachments) = row?;
            let attachment_paths =
                serde_json::from_str::<Vec<String>>(&attachments).unwrap_or_default();
            if record_type == "image" {
                image_contents.push(content);
            }
            image_contents.extend(attachment_paths);
        }

        conn.execute(
            "DELETE FROM clipboard_records
             WHERE datetime(created_at) < datetime('now', ?1)
               AND NOT (COALESCE(storage_mode, 'database') = 'resource')",
            params![format!("-{} days", days)],
        )?;
        (days, image_contents)
    };

    // Clean up image files and thumbnails only if no remaining records reference them.
    // Content-hash filenames mean multiple records can share the same file on disk.
    let base_dir = get_storage_dir(app);
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let removable_images = image_contents
        .into_iter()
        .filter(|content| {
            !conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM clipboard_records WHERE content = ?1",
                    params![content],
                    |row| row.get(0),
                )
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    drop(conn);

    for content in removable_images {
        crate::paste::remove_cached_images(std::slice::from_ref(&content));
        let Some(file_path) = resolve_relative_storage_path(&base_dir, &content) else {
            continue;
        };
        let _ = std::fs::remove_file(&file_path);
        if let Some(filename) = file_path.file_name() {
            let thumb_path = file_path
                .parent()
                .unwrap_or(&base_dir)
                .join("thumbs")
                .join(filename);
            let _ = std::fs::remove_file(&thumb_path);
        }
    }
    // Clean up temp paste image files older than retention period
    let paste_dir = std::env::temp_dir().join("copy_creator_paste");
    if let Ok(entries) = std::fs::read_dir(&paste_dir) {
        let cutoff =
            std::time::SystemTime::now() - std::time::Duration::from_secs(days as u64 * 86400);
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() && meta.modified().is_ok_and(|t| t < cutoff) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }

    Ok(())
}

// ---- Tauri Commands ----

#[tauri::command]
pub fn get_clipboard_records(
    app: AppHandle,
    search: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    category: Option<String>,
    resource_group: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    get_clipboard_records_inner(&app, search, limit, offset, category, resource_group)
}

fn get_clipboard_records_inner<R: Runtime>(
    app: &AppHandle<R>,
    search: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    category: Option<String>,
    resource_group: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    // 资源分组来自文件系统路径；先读取配置，避免持有数据库锁时再次读取设置。
    let resource_root = get_resource_library_dir(app);
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let off = offset.unwrap_or(0);

    let cat_filter = category_sql(&category);
    let resource_group = if category.as_deref() == Some("resources") {
        resource_group
            .as_deref()
            .map(|group| normalize_resource_group_name(Some(group)))
            .transpose()?
    } else {
        None
    };
    let query_lim = if resource_group.is_some() {
        u32::MAX
    } else {
        lim
    };
    let query_off = if resource_group.is_some() { 0 } else { off };

    let mut records: Vec<serde_json::Value> = Vec::new();

    if let Some(q) = search {
        let escaped = q
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let sql = format!(
            "SELECT id, type, content, source_app, created_at, user_api_key, group_name, attachments, storage_mode, resource_path FROM clipboard_records
             WHERE content LIKE '%' || ?1 || '%' ESCAPE '\\' {} ORDER BY sort_order DESC LIMIT ?2 OFFSET ?3",
            cat_filter.1
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![escaped, query_lim, query_off], |row| {
                Ok(clipboard_record_json(
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            records.push(row.map_err(|e| e.to_string())?);
        }
    } else {
        let sql = format!(
            "SELECT id, type, content, source_app, created_at, user_api_key, group_name, attachments, storage_mode, resource_path FROM clipboard_records
             {} ORDER BY sort_order DESC LIMIT ?1 OFFSET ?2",
            cat_filter.0
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![query_lim, query_off], |row| {
                Ok(clipboard_record_json(
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            records.push(row.map_err(|e| e.to_string())?);
        }
    }

    for record in &mut records {
        if record["storage_mode"].as_str() != Some(RESOURCE_STORAGE_MODE) {
            continue;
        }
        let group = record["resource_path"]
            .as_str()
            .and_then(|path| resource_group_for_path(&resource_root, path));
        if let Some(object) = record.as_object_mut() {
            object.insert(
                "resource_group".to_string(),
                group
                    .map(serde_json::Value::String)
                    .unwrap_or(serde_json::Value::Null),
            );
        }
    }
    if let Some(resource_group) = resource_group {
        records.retain(|record| record["resource_group"].as_str() == Some(resource_group.as_str()));
        records = records
            .into_iter()
            .skip(off as usize)
            .take(lim as usize)
            .collect();
    }

    // Build label map for API key enrichment
    let mut label_map: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT record_id, service, api_base, note, is_expired FROM api_key_labels")
    {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        }) {
            for row in rows.flatten() {
                let (record_id, service, api_base, note, is_expired) = row;
                label_map.insert(
                    record_id,
                    serde_json::json!({
                        "service": service,
                        "api_base": api_base,
                        "note": note,
                        "is_expired": is_expired != 0,
                    }),
                );
            }
        }
    }

    let records = records
        .into_iter()
        .map(|rec| {
            let rec_type = rec["type"].as_str().unwrap_or("").to_string();
            let content = rec["content"].as_str().unwrap_or("").to_string();
            let user_key = rec["user_api_key"].as_i64().unwrap_or(0) != 0;
            let (is_key, key_preview_val, guess_val, label_val) =
                if (rec_type == "text" || rec_type == "link") && (user_key || is_api_key(&content))
                {
                    let kp = make_key_preview(&content);
                    let g = guess_service(&content)
                        .map(|s| serde_json::Value::String(s.to_string()))
                        .unwrap_or(serde_json::Value::Null);
                    let rid = rec["id"].as_str().unwrap_or("");
                    let lbl = label_map
                        .get(rid)
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    (true, serde_json::Value::String(kp), g, lbl)
                } else {
                    (
                        false,
                        serde_json::Value::String(String::new()),
                        serde_json::Value::Null,
                        serde_json::Value::Null,
                    )
                };
            let mut obj = rec;
            if let serde_json::Value::Object(ref mut map) = obj {
                map.insert("is_api_key".to_string(), serde_json::Value::Bool(is_key));
                map.insert(
                    "user_api_key".to_string(),
                    serde_json::Value::Bool(user_key),
                );
                map.insert("key_preview".to_string(), key_preview_val);
                map.insert("guessed_service".to_string(), guess_val);
                map.insert("label".to_string(), label_val);
            }
            obj
        })
        .collect();

    Ok(records)
}

#[tauri::command]
pub fn get_clipboard_record_content(app: AppHandle, id: String) -> Result<String, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT content FROM clipboard_records WHERE id = ?1",
        params![id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_clipboard_record(app: AppHandle, id: String, content: String) -> Result<(), String> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("内容不能为空".to_string());
    }

    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let storage_mode: String = conn
        .query_row(
            "SELECT storage_mode FROM clipboard_records WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| format!("记录不存在: {}", e))?;

    if !is_resource_record(&storage_mode) {
        return Err("只能编辑资源库中的记录".to_string());
    }

    let record_type = crate::clipboard::classify_text_record(&content);
    let sort_order = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "UPDATE clipboard_records SET type = ?1, content = ?2, sort_order = ?3 WHERE id = ?4",
        params![record_type, content, sort_order, id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM api_key_labels WHERE record_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;

    let _ = app.emit("clipboard-record-updated", &id);
    Ok(())
}

#[tauri::command]
pub fn delete_all_clipboard_records(app: AppHandle) -> Result<(), String> {
    let ids = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id FROM clipboard_records WHERE NOT ({RESOURCE_RECORD_CONDITION})"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };

    delete_clipboard_records_internal(&app, &ids)?;

    // Remove labels left behind by databases created before label cleanup
    // was part of the clipboard deletion path.
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM api_key_labels", [])
        .map_err(|e| e.to_string())?;
    let _ = app.emit("clipboard-cleared", ());
    Ok(())
}

#[tauri::command]
pub fn delete_records_by_type(app: AppHandle, record_type: String) -> Result<(), String> {
    let ids = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id FROM clipboard_records WHERE type = ?1 AND NOT ({RESOURCE_RECORD_CONDITION})"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![record_type], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };

    delete_clipboard_records_internal(&app, &ids)
}

fn delete_clipboard_records_internal(app: &AppHandle, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }

    let mut deleted_ids = Vec::new();
    let mut image_contents = HashSet::new();
    let mut resource_files: Vec<(String, String, Vec<String>)> = Vec::new();

    {
        let state = app.state::<DbState>();
        let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        for id in ids {
            let record = tx
                .query_row(
                    "SELECT type, content, attachments, storage_mode, resource_path FROM clipboard_records WHERE id = ?1",
                    params![id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    },
                )
                .optional()
                .map_err(|e| e.to_string())?;

            let Some((record_type, content, attachments, storage_mode, resource_path)) = record
            else {
                continue;
            };

            tx.execute(
                "DELETE FROM api_key_labels WHERE record_id = ?1",
                params![id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM clipboard_records WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;

            let attachment_paths =
                serde_json::from_str::<Vec<String>>(&attachments).unwrap_or_default();
            if is_resource_record(&storage_mode) {
                resource_files.push((id.clone(), resource_path, attachment_paths));
            } else {
                if record_type == "image" {
                    image_contents.insert(content);
                }
                image_contents.extend(attachment_paths);
            }
            deleted_ids.push(id.clone());
        }

        tx.commit().map_err(|e| e.to_string())?;
    }

    let removable_images = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        image_contents
            .into_iter()
            .filter(|content| {
                !conn
                    .query_row(
                        "SELECT COUNT(*) > 0 FROM clipboard_records WHERE content = ?1",
                        params![content],
                        |row| row.get::<_, bool>(0),
                    )
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>()
    };

    let base_dir = get_storage_dir(app);
    crate::paste::remove_cached_images(&removable_images);
    for content in removable_images {
        let Some(file_path) = resolve_managed_storage_path(app, &content) else {
            continue;
        };
        let _ = std::fs::remove_file(&file_path);
        if let Some(filename) = file_path.file_name() {
            let thumb_path = file_path
                .parent()
                .unwrap_or(&base_dir)
                .join("thumbs")
                .join(filename);
            let _ = std::fs::remove_file(&thumb_path);
        }
    }

    let had_resources = !resource_files.is_empty();
    for (id, resource_path, attachment_paths) in resource_files {
        remove_resource_record_files(app, &id, &resource_path, &attachment_paths);
    }

    for id in deleted_ids {
        let _ = app.emit("clipboard-deleted", &id);
    }
    if had_resources {
        let _ = app.emit("resource-groups-changed", ());
    }

    Ok(())
}

#[tauri::command]
pub fn delete_clipboard_records(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    delete_clipboard_records_internal(&app, &ids)
}

#[tauri::command]
pub fn delete_clipboard_record(app: AppHandle, id: String) -> Result<(), String> {
    delete_clipboard_records_internal(&app, &[id])
}

#[tauri::command]
pub fn get_phrase_groups(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, sort_order, created_at, updated_at FROM phrase_groups ORDER BY sort_order DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "sort_order": row.get::<_, i32>(2)?,
                "created_at": row.get::<_, String>(3)?,
                "updated_at": row.get::<_, String>(4)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut groups = Vec::new();
    for row in rows {
        groups.push(row.map_err(|e| e.to_string())?);
    }
    Ok(groups)
}

#[tauri::command]
pub fn create_phrase_group(app: AppHandle, name: String) -> Result<serde_json::Value, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO phrase_groups (id, name, sort_order, created_at, updated_at) VALUES (?1, ?2, 0, ?3, ?4)",
        params![id, name, &now, &now],
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit("phrase-groups-changed", ());
    Ok(serde_json::json!({
        "id": id,
        "name": name,
        "sort_order": 0,
        "created_at": now,
        "updated_at": now,
    }))
}

#[tauri::command]
pub fn update_phrase_group(app: AppHandle, id: String, name: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE phrase_groups SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, &now, id],
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit("phrase-groups-changed", ());
    Ok(())
}

#[tauri::command]
pub fn delete_phrase_group(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let file_paths: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT content FROM phrases WHERE group_id = ?1 AND input_type = 'file'")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![&id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    conn.execute("DELETE FROM phrases WHERE group_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM phrase_groups WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    drop(conn);
    for path in file_paths {
        remove_quick_input_file(&app, &path);
    }
    let _ = app.emit("phrase-groups-changed", ());
    Ok(())
}

#[tauri::command]
pub fn get_phrases(app: AppHandle, group_id: String) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, group_id, title, content, input_type, source_path, file_size, sort_order, created_at, updated_at FROM phrases WHERE group_id = ?1 ORDER BY sort_order DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![group_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "group_id": row.get::<_, String>(1)?,
                "title": row.get::<_, String>(2)?,
                "content": row.get::<_, String>(3)?,
                "input_type": row.get::<_, String>(4)?,
                "source_path": row.get::<_, String>(5)?,
                "file_size": row.get::<_, i64>(6)?,
                "sort_order": row.get::<_, i32>(7)?,
                "created_at": row.get::<_, String>(8)?,
                "updated_at": row.get::<_, String>(9)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut phrases = Vec::new();
    for row in rows {
        phrases.push(row.map_err(|e| e.to_string())?);
    }
    Ok(phrases)
}

#[tauri::command]
pub fn create_phrase(
    app: AppHandle,
    group_id: String,
    title: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO phrases (id, group_id, title, content, input_type, source_path, file_size, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'text', '', 0, 0, ?5, ?6)",
        params![id, group_id, title, content, &now, &now],
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "id": id,
        "group_id": group_id,
        "title": title,
        "content": content,
        "input_type": "text",
        "source_path": "",
        "file_size": 0,
        "sort_order": 0,
        "created_at": now,
        "updated_at": now,
    }))
}

#[tauri::command]
pub fn create_file_phrase(
    app: AppHandle,
    group_id: String,
    source_path: String,
    title: String,
) -> Result<serde_json::Value, String> {
    let (content, file_size) = copy_quick_input_file(&app, &source_path)?;
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    if let Err(e) = conn.execute(
        "INSERT INTO phrases (id, group_id, title, content, input_type, source_path, file_size, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'file', ?5, ?6, 0, ?7, ?8)",
        params![&id, &group_id, &title, &content, &source_path, file_size as i64, &now, &now],
    ) {
        drop(conn);
        remove_quick_input_file(&app, &content);
        return Err(e.to_string());
    }
    Ok(serde_json::json!({
        "id": id,
        "group_id": group_id,
        "title": title,
        "content": content,
        "input_type": "file",
        "source_path": source_path,
        "file_size": file_size,
        "sort_order": 0,
        "created_at": now,
        "updated_at": now,
    }))
}

#[tauri::command]
pub fn update_phrase(
    app: AppHandle,
    id: String,
    title: String,
    content: String,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    let old_file: Option<String> = conn
        .query_row(
            "SELECT content FROM phrases WHERE id = ?1 AND input_type = 'file'",
            params![&id],
            |row| row.get(0),
        )
        .ok();
    conn.execute(
        "UPDATE phrases SET title = ?1, content = ?2, input_type = 'text', source_path = '', file_size = 0, updated_at = ?3 WHERE id = ?4",
        params![title, content, &now, id],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);
    if let Some(path) = old_file {
        remove_quick_input_file(&app, &path);
    }
    Ok(())
}

#[tauri::command]
pub fn update_file_phrase(
    app: AppHandle,
    id: String,
    source_path: String,
    title: String,
) -> Result<serde_json::Value, String> {
    if source_path.trim().is_empty() {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE phrases SET title = ?1, updated_at = ?2 WHERE id = ?3 AND input_type = 'file'",
            params![&title, &now, &id],
        )
        .map_err(|e| e.to_string())?;
        return conn
            .query_row(
                "SELECT id, group_id, title, content, input_type, source_path, file_size, sort_order, created_at, updated_at FROM phrases WHERE id = ?1",
                params![&id],
                |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "group_id": row.get::<_, String>(1)?,
                        "title": row.get::<_, String>(2)?,
                        "content": row.get::<_, String>(3)?,
                        "input_type": row.get::<_, String>(4)?,
                        "source_path": row.get::<_, String>(5)?,
                        "file_size": row.get::<_, i64>(6)?,
                        "sort_order": row.get::<_, i32>(7)?,
                        "created_at": row.get::<_, String>(8)?,
                        "updated_at": row.get::<_, String>(9)?,
                    }))
                },
            )
            .map_err(|e| e.to_string());
    }

    let (content, file_size) = copy_quick_input_file(&app, &source_path)?;
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let old_file: Option<String> = conn
        .query_row(
            "SELECT content FROM phrases WHERE id = ?1 AND input_type = 'file'",
            params![&id],
            |row| row.get(0),
        )
        .ok();
    let (group_id, sort_order, created_at): (String, i32, String) = match conn.query_row(
        "SELECT group_id, sort_order, created_at FROM phrases WHERE id = ?1",
        params![&id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ) {
        Ok(row) => row,
        Err(e) => {
            drop(conn);
            remove_quick_input_file(&app, &content);
            return Err(e.to_string());
        }
    };
    let now = chrono::Utc::now().to_rfc3339();
    if let Err(e) = conn.execute(
        "UPDATE phrases SET title = ?1, content = ?2, input_type = 'file', source_path = ?3, file_size = ?4, updated_at = ?5 WHERE id = ?6",
        params![&title, &content, &source_path, file_size as i64, &now, &id],
    ) {
        drop(conn);
        remove_quick_input_file(&app, &content);
        return Err(e.to_string());
    }
    drop(conn);
    if let Some(path) = old_file {
        remove_quick_input_file(&app, &path);
    }
    Ok(serde_json::json!({
        "id": id,
        "group_id": group_id,
        "title": title,
        "content": content,
        "input_type": "file",
        "source_path": source_path,
        "file_size": file_size,
        "sort_order": sort_order,
        "created_at": created_at,
        "updated_at": now,
    }))
}

#[tauri::command]
pub fn delete_phrases(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }

    let mut file_paths = HashSet::new();
    {
        let state = app.state::<DbState>();
        let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        for id in &ids {
            let old_file = tx
                .query_row(
                    "SELECT content FROM phrases WHERE id = ?1 AND input_type = 'file'",
                    params![id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM phrases WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            if let Some(path) = old_file {
                file_paths.insert(path);
            }
        }

        tx.commit().map_err(|e| e.to_string())?;
    }

    for path in file_paths {
        remove_quick_input_file(&app, &path);
    }
    Ok(())
}

#[tauri::command]
pub fn delete_phrase(app: AppHandle, id: String) -> Result<(), String> {
    delete_phrases(app, vec![id])
}

#[tauri::command]
pub fn get_translation_history(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let l = limit.unwrap_or(100);
    let mut stmt = conn
        .prepare(
            "SELECT id, source_text, target_text, source_lang, target_lang, engine, created_at
             FROM translation_history ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![l], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "source_text": row.get::<_, String>(1)?,
                "target_text": row.get::<_, String>(2)?,
                "source_lang": row.get::<_, String>(3)?,
                "target_lang": row.get::<_, String>(4)?,
                "engine": row.get::<_, String>(5)?,
                "created_at": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut history = Vec::new();
    for row in rows {
        history.push(row.map_err(|e| e.to_string())?);
    }
    Ok(history)
}

#[tauri::command]
pub fn clear_translation_history(app: AppHandle) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM translation_history", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_setting(app: AppHandle, key: String) -> Result<String, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    Ok(conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .unwrap_or_default())
}

pub fn get_setting_sync<R: Runtime>(app: &AppHandle<R>, key: &str) -> Option<String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().ok()?;
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .ok()
}

#[tauri::command]
pub fn get_all_settings(
    app: AppHandle,
) -> Result<std::collections::HashMap<String, String>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut map = std::collections::HashMap::new();
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        map.insert(k, v);
    }
    Ok(map)
}

#[tauri::command]
pub fn get_image_base64(app: AppHandle, path: String) -> Result<String, String> {
    let image_path = resolve_storage_path(&app, &path)?;
    let bytes = std::fs::read(&image_path).map_err(|e| format!("read image file: {}", e))?;

    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub fn get_image_thumbnail(app: AppHandle, path: String, max_size: u32) -> Result<String, String> {
    let image_path = resolve_storage_path(&app, &path)?;
    let base_dir = image_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| get_storage_dir(&app));

    // Try pre-generated thumbnail first (saved during clipboard capture)
    let thumb_dir = image_path.parent().unwrap_or(&base_dir).join("thumbs");
    let filename = image_path.file_name().ok_or("invalid path")?;
    let thumb_path = thumb_dir.join(filename);

    let thumb_bytes = if thumb_path.exists() {
        std::fs::read(&thumb_path).map_err(|e| format!("read thumbnail: {}", e))?
    } else {
        // Fallback: generate thumbnail from full image
        let bytes = std::fs::read(&image_path).map_err(|e| format!("read image file: {}", e))?;
        let img = image::load_from_memory(&bytes).map_err(|e| format!("decode image: {}", e))?;
        let (w, h) = (img.width(), img.height());
        let scale = if w > max_size || h > max_size {
            max_size as f32 / w.max(h) as f32
        } else {
            1.0
        };
        let thumb = if scale < 1.0 {
            let new_w = (w as f32 * scale) as u32;
            let new_h = (h as f32 * scale) as u32;
            img.resize(new_w, new_h, image::imageops::FilterType::Triangle)
        } else {
            img
        };
        let mut buf = std::io::Cursor::new(Vec::new());
        thumb
            .write_to(&mut buf, image::ImageFormat::Png)
            .map_err(|e| format!("encode thumbnail: {}", e))?;
        let data = buf.into_inner();
        // Save for future use
        std::fs::create_dir_all(&thumb_dir).ok();
        let _ = std::fs::write(&thumb_path, &data);
        data
    };

    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&thumb_bytes))
}

#[tauri::command]
pub fn set_setting(app: AppHandle, key: String, value: String) -> Result<(), String> {
    if key == "storage_path" {
        return migrate_storage(&app, &value);
    }
    set_setting_inner(&app, &key, &value)
}

/// Like `set_setting` but never triggers storage migration — even for
/// `storage_path`.  Used when the user wants to change the storage
/// directory without moving existing data.
#[tauri::command]
pub fn set_setting_skip_migrate(app: AppHandle, key: String, value: String) -> Result<(), String> {
    set_setting_inner(&app, &key, &value)
}

fn set_setting_inner(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_settings_batch(
    app: AppHandle,
    settings: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    if let Some(storage_path) = settings.get("storage_path") {
        migrate_storage(&app, storage_path)?;
    }

    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    for (key, value) in &settings {
        if key == "storage_path" {
            continue;
        }
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn migrate_storage(app: &AppHandle, new_path: &str) -> Result<(), String> {
    let custom_dir = PathBuf::from(new_path);
    std::fs::create_dir_all(&custom_dir).map_err(|e| format!("create dir: {}", e))?;
    let custom_db = custom_dir.join("data.db");

    // Collect all settings from current DB
    let settings: Vec<(String, String)> = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT key, value FROM settings")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // Create new DB with schema and settings at target location
    let new_conn = Connection::open(&custom_db).map_err(|e| format!("open new db: {}", e))?;

    new_conn
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS clipboard_records (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                source_app TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                user_api_key INTEGER DEFAULT 0,
                sort_order REAL,
                group_name TEXT DEFAULT '',
                attachments TEXT DEFAULT '[]',
                storage_mode TEXT DEFAULT 'database',
                resource_path TEXT DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_clipboard_created_at ON clipboard_records(created_at);
            CREATE INDEX IF NOT EXISTS idx_clipboard_sort_order ON clipboard_records(sort_order DESC);
            CREATE TABLE IF NOT EXISTS phrase_groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS phrases (
                id TEXT PRIMARY KEY,
                group_id TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                input_type TEXT DEFAULT 'text',
                source_path TEXT DEFAULT '',
                file_size INTEGER DEFAULT 0,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (group_id) REFERENCES phrase_groups(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS translation_history (
                id TEXT PRIMARY KEY,
                source_text TEXT NOT NULL,
                target_text TEXT NOT NULL,
                source_lang TEXT DEFAULT 'auto',
                target_lang TEXT NOT NULL,
                engine TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_translation_created_at ON translation_history(created_at);
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            DROP TABLE IF EXISTS api_key_labels;
            CREATE TABLE IF NOT EXISTS api_key_labels (
                record_id   TEXT PRIMARY KEY,
                key_preview TEXT NOT NULL,
                service     TEXT NOT NULL,
                api_base    TEXT DEFAULT '',
                note        TEXT DEFAULT '',
                is_expired  INTEGER DEFAULT 0,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS toast_shown (
                key_preview TEXT PRIMARY KEY
            );
            ",
        )
        .map_err(|e| format!("create schema: {}", e))?;

    // Copy settings to new DB
    {
        let mut stmt = new_conn
            .prepare("INSERT INTO settings (key, value) VALUES (?1, ?2)")
            .map_err(|e| e.to_string())?;
        for (k, v) in &settings {
            if k != "storage_path" && k != "shortcut_key" {
                stmt.execute(params![k, v]).map_err(|e| e.to_string())?;
            }
        }
        stmt.execute(params!["storage_path", new_path])
            .map_err(|e| e.to_string())?;
        stmt.execute(params!["shortcut_key", ""])
            .map_err(|e| e.to_string())?;
    }

    // Update old DB's storage_path (for chain-following on restart) and switch connection
    {
        let state = app.state::<DbState>();
        let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('storage_path', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
            params![new_path],
        )
        .map_err(|e| e.to_string())?;
        *conn = new_conn;
    }

    log::info!("Storage migrated to: {}", new_path);
    Ok(())
}

#[tauri::command]
pub fn get_storage_path(app: AppHandle) -> Result<String, String> {
    Ok(get_storage_dir(&app).to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_resource_library_path(app: AppHandle) -> Result<String, String> {
    Ok(get_resource_library_dir(&app).to_string_lossy().to_string())
}

fn validate_resource_library_path(app: &AppHandle, value: &str) -> Result<PathBuf, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("资源库目录不能为空".to_string());
    }

    let path = PathBuf::from(value);
    std::fs::create_dir_all(&path).map_err(|error| format!("创建资源库目录失败: {error}"))?;
    let path =
        std::fs::canonicalize(&path).map_err(|error| format!("读取资源库目录失败: {error}"))?;
    if !path.is_dir() {
        return Err("资源库路径不是目录".to_string());
    }

    let storage_path =
        std::fs::canonicalize(get_storage_dir(app)).unwrap_or_else(|_| get_storage_dir(app));
    if paths_overlap(&path, &storage_path) {
        return Err("资源库目录不能与应用存储目录重叠".to_string());
    }
    Ok(path)
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    left == right || left.starts_with(right) || right.starts_with(left)
}

#[tauri::command]
pub fn set_resource_library_path(app: AppHandle, path: String) -> Result<String, String> {
    let path = validate_resource_library_path(&app, &path)?;
    let path_string = path.to_string_lossy().to_string();
    let previous_path = get_setting_sync(&app, "resource_library_path")
        .filter(|previous| !previous.trim().is_empty())
        .map(PathBuf::from)
        .filter(|previous| previous.is_absolute());
    let mut history = resource_library_history(&app);
    if let Some(previous_path) = previous_path {
        if previous_path != path {
            history.retain(|entry| entry != &previous_path && entry != &path);
            history.insert(0, previous_path);
        }
    } else {
        history.retain(|entry| entry != &path);
    }
    history.truncate(20);

    let history_value = serde_json::to_string(
        &history
            .into_iter()
            .map(|entry| entry.to_string_lossy().to_string())
            .collect::<Vec<_>>(),
    )
    .map_err(|error| format!("保存资源库历史失败: {error}"))?;
    set_setting_inner(&app, "resource_library_path", &path_string)?;
    set_setting_inner(&app, RESOURCE_LIBRARY_HISTORY_SETTING, &history_value)?;
    let _ = app.emit("resource-library-path-changed", &path_string);
    Ok(path_string)
}

fn resource_record_paths_in_group<R: Runtime>(
    app: &AppHandle<R>,
    group_name: &str,
) -> Result<Vec<(String, String)>, String> {
    let root = get_resource_library_dir(app);
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, resource_path
             FROM clipboard_records
             WHERE COALESCE(storage_mode, 'database') = 'resource'",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut records = Vec::new();
    for row in rows {
        let (id, path) = row.map_err(|e| e.to_string())?;
        if resource_group_for_path(&root, &path).as_deref() == Some(group_name) {
            records.push((id, path));
        }
    }
    Ok(records)
}

fn update_resource_record_paths<R: Runtime>(
    app: &AppHandle<R>,
    updates: &[(String, String)],
    group_name: &str,
) -> Result<(), String> {
    if updates.is_empty() {
        return Ok(());
    }
    let state = app.state::<DbState>();
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (id, path) in updates {
        tx.execute(
            "UPDATE clipboard_records
             SET resource_path = ?1, group_name = ?2
             WHERE id = ?3 AND COALESCE(storage_mode, 'database') = 'resource'",
            params![path, group_name, id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

fn resource_group_count_map<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<HashMap<String, u64>, String> {
    let root = get_resource_library_dir(app);
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT resource_path
             FROM clipboard_records
             WHERE COALESCE(storage_mode, 'database') = 'resource'",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut counts = HashMap::new();
    for row in rows {
        let path = row.map_err(|e| e.to_string())?;
        if let Some(group_name) = resource_group_for_path(&root, &path) {
            *counts.entry(group_name).or_insert(0) += 1;
        }
    }
    Ok(counts)
}

#[tauri::command]
pub fn get_resource_groups(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let root = get_resource_library_dir(&app);
    let counts = resource_group_count_map(&app)?;
    let mut names = Vec::new();
    let entries = std::fs::read_dir(&root).map_err(|e| format!("读取资源分组失败: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取资源分组失败: {e}"))?;
        if !entry
            .file_type()
            .map_err(|e| format!("读取资源分组失败: {e}"))?
            .is_dir()
        {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if normalize_resource_group_name(Some(&name)).is_ok() {
            names.push(name);
        }
    }
    names.sort_by_key(|name| name.to_lowercase());

    let mut groups = vec![serde_json::json!({
        "name": "",
        "count": counts.get("").copied().unwrap_or(0),
    })];
    groups.extend(names.into_iter().map(|name| {
        serde_json::json!({
            "name": name,
            "count": counts.get(&name).copied().unwrap_or(0),
        })
    }));
    Ok(groups)
}

#[tauri::command]
pub fn create_resource_group(app: AppHandle, name: String) -> Result<serde_json::Value, String> {
    let name = normalize_resource_group_name(Some(&name))?;
    if name.is_empty() {
        return Err("分组名称不能为空".to_string());
    }
    let path = resource_group_path(&app, &name)?;
    std::fs::create_dir(&path).map_err(|e| format!("创建资源分组失败: {e}"))?;
    let _ = app.emit("resource-groups-changed", ());
    Ok(serde_json::json!({ "name": name, "count": 0 }))
}

#[tauri::command]
pub fn update_resource_group(
    app: AppHandle,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    update_resource_group_inner(&app, old_name, new_name)
}

fn update_resource_group_inner<R: Runtime>(
    app: &AppHandle<R>,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let old_name = normalize_resource_group_name(Some(&old_name))?;
    let new_name = normalize_resource_group_name(Some(&new_name))?;
    if old_name.is_empty() || new_name.is_empty() {
        return Err("分组名称不能为空".to_string());
    }
    if old_name == new_name {
        return Ok(());
    }

    let old_path = resource_group_path(app, &old_name)?;
    let new_path = resource_group_path(app, &new_name)?;
    if !old_path.is_dir() {
        return Err("资源分组不存在".to_string());
    }
    if new_path.exists() {
        return Err("目标分组已存在".to_string());
    }
    let records = resource_record_paths_in_group(app, &old_name)?;
    let new_records = records
        .iter()
        .filter_map(|(id, path)| {
            let filename = Path::new(path).file_name()?.to_os_string();
            Some((
                id.clone(),
                new_path.join(filename).to_string_lossy().to_string(),
            ))
        })
        .collect::<Vec<_>>();

    std::fs::rename(&old_path, &new_path).map_err(|e| format!("重命名资源分组失败: {e}"))?;
    if let Err(error) = update_resource_record_paths(app, &new_records, &new_name) {
        let _ = std::fs::rename(&new_path, &old_path);
        return Err(format!("更新资源路径失败: {error}"));
    }
    let _ = app.emit("resource-groups-changed", ());
    Ok(())
}

fn rollback_moved_resource_files(moved: &[(PathBuf, PathBuf, Option<String>)]) {
    for (from, to, original_content) in moved.iter().rev() {
        if let Some(content) = original_content {
            let _ = std::fs::write(to, content);
        }
        let _ = std::fs::rename(to, from);
    }
}

#[tauri::command]
pub fn delete_resource_group(app: AppHandle, name: String) -> Result<(), String> {
    delete_resource_group_inner(&app, name)
}

fn delete_resource_group_inner<R: Runtime>(app: &AppHandle<R>, name: String) -> Result<(), String> {
    let name = normalize_resource_group_name(Some(&name))?;
    if name.is_empty() {
        return Err("未分组不能删除".to_string());
    }
    let root = get_resource_library_dir(app);
    let group_path = resource_group_path(app, &name)?;
    if !group_path.is_dir() {
        return Err("资源分组不存在".to_string());
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&group_path).map_err(|e| format!("读取资源分组失败: {e}"))?
    {
        let entry = entry.map_err(|e| format!("读取资源分组失败: {e}"))?;
        if !entry
            .file_type()
            .map_err(|e| format!("读取资源分组失败: {e}"))?
            .is_file()
        {
            return Err("资源分组中不能包含子文件夹".to_string());
        }
        entries.push(entry.path());
    }
    entries.sort();

    for path in &entries {
        let Some(filename) = path.file_name() else {
            return Err("资源文件名无效".to_string());
        };
        if root.join(filename).exists() {
            return Err(format!(
                "资源库根目录已存在同名文件：{}",
                filename.to_string_lossy()
            ));
        }
    }

    let records = resource_record_paths_in_group(app, &name)?;
    let new_records = records
        .iter()
        .filter_map(|(id, path)| {
            let filename = Path::new(path).file_name()?.to_os_string();
            Some((
                id.clone(),
                root.join(filename).to_string_lossy().to_string(),
            ))
        })
        .collect::<Vec<_>>();
    let mut moved = Vec::new();
    for from in entries {
        let filename = match from.file_name() {
            Some(filename) => filename.to_os_string(),
            None => {
                rollback_moved_resource_files(&moved);
                return Err("资源文件名无效".to_string());
            }
        };
        let to = root.join(filename);
        let original_content = if from
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        {
            match std::fs::read_to_string(&from) {
                Ok(content) => Some(content),
                Err(error) => {
                    rollback_moved_resource_files(&moved);
                    return Err(format!("读取资源文件失败: {error}"));
                }
            }
        } else {
            None
        };
        std::fs::rename(&from, &to).map_err(|e| {
            rollback_moved_resource_files(&moved);
            format!("迁移资源文件失败: {e}")
        })?;
        moved.push((from, to.clone(), original_content.clone()));
        if let Some(content) = original_content {
            let updated = content.replace("../.copy-creator/", ".copy-creator/");
            if updated != content {
                if let Err(error) = std::fs::write(&to, updated) {
                    rollback_moved_resource_files(&moved);
                    return Err(format!("更新资源图片路径失败: {error}"));
                }
            }
        }
    }

    if let Err(error) = update_resource_record_paths(app, &new_records, "") {
        rollback_moved_resource_files(&moved);
        return Err(format!("更新资源路径失败: {error}"));
    }
    if let Err(error) = std::fs::remove_dir(&group_path) {
        let old_records = records;
        let _ = update_resource_record_paths(app, &old_records, &name);
        rollback_moved_resource_files(&moved);
        return Err(format!("删除资源分组失败: {error}"));
    }
    let _ = app.emit("resource-groups-changed", ());
    Ok(())
}

#[tauri::command]
pub fn open_resource_group(app: AppHandle, name: String) -> Result<(), String> {
    let name = normalize_resource_group_name(Some(&name))?;
    let path = resource_group_path(&app, &name)?;
    if !path.is_dir() {
        return Err("资源分组不存在".to_string());
    }

    #[cfg(target_os = "windows")]
    return std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开资源文件夹失败: {e}"));

    #[cfg(target_os = "macos")]
    return std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开资源文件夹失败: {e}"));

    #[cfg(target_os = "linux")]
    return std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开资源文件夹失败: {e}"));

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err("当前系统不支持打开资源文件夹".to_string())
}

#[tauri::command]
pub fn ensure_thumbnail(app: AppHandle, path: String) -> Result<String, String> {
    let base = resolve_storage_path(&app, &path)?;

    if !base.exists() {
        return Err("image file not found".to_string());
    }

    let filename = base
        .file_name()
        .ok_or("invalid path")?
        .to_string_lossy()
        .to_string();
    let mut thumb_dir = base.parent().ok_or("invalid path")?.to_path_buf();
    thumb_dir.push("thumbs");
    std::fs::create_dir_all(&thumb_dir).ok();
    let thumb_path = thumb_dir.join(&filename);

    if thumb_path.exists() {
        return Ok(thumb_path.to_string_lossy().to_string());
    }

    let bytes = std::fs::read(&base).map_err(|e| format!("read image: {}", e))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("decode image: {}", e))?;

    let (w, h) = (img.width(), img.height());
    let max_thumb: u32 = 200;
    let scale = if w > max_thumb || h > max_thumb {
        max_thumb as f32 / w.max(h) as f32
    } else {
        1.0
    };

    let thumb = if scale < 1.0 {
        img.resize(
            (w as f32 * scale) as u32,
            (h as f32 * scale) as u32,
            image::imageops::FilterType::Triangle,
        )
    } else {
        img
    };

    let mut buf = std::io::Cursor::new(Vec::new());
    thumb
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("encode thumbnail: {}", e))?;

    std::fs::write(&thumb_path, buf.into_inner()).map_err(|e| format!("write thumbnail: {}", e))?;

    Ok(thumb_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn select_storage_folder(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let result =
        tokio::task::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(60)))
            .await
            .map_err(|e| format!("task error: {}", e))?;

    match result {
        Ok(Some(path)) => Ok(path.to_string()),
        Ok(None) => Err("cancelled".to_string()),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err("timeout".to_string()),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err("cancelled".to_string()),
    }
}

#[tauri::command]
pub async fn select_resource_library_folder(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let result =
        tokio::task::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(60)))
            .await
            .map_err(|e| format!("task error: {}", e))?;

    match result {
        Ok(Some(path)) => Ok(path.to_string()),
        Ok(None) => Err("cancelled".to_string()),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err("timeout".to_string()),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err("cancelled".to_string()),
    }
}

// === API Key Label Commands ===

#[tauri::command]
pub fn check_api_key(content: String) -> serde_json::Value {
    let is_key = is_api_key(&content);
    let preview = if is_key {
        make_key_preview(&content)
    } else {
        String::new()
    };
    let guess = if is_key {
        guess_service(&content).map(|s| s.to_string())
    } else {
        None
    };
    serde_json::json!({ "is_key": is_key, "preview": preview, "guess": guess })
}

#[tauri::command]
pub fn save_api_key_label(
    app: AppHandle,
    record_id: String,
    key_preview: String,
    service: String,
    api_base: String,
    note: String,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO api_key_labels (record_id, key_preview, service, api_base, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(record_id) DO UPDATE SET service=?3, api_base=?4, note=?5, updated_at=?7",
        params![record_id, key_preview, service, api_base, note, &now, &now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_api_key_label(app: AppHandle, record_id: String) -> Option<serde_json::Value> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().ok()?;
    conn.query_row(
        "SELECT key_preview, service, api_base, note, is_expired, created_at FROM api_key_labels WHERE record_id = ?1",
        params![record_id],
        |row| {
            Ok(serde_json::json!({
                "record_id": record_id,
                "key_preview": row.get::<_, String>(0)?,
                "service": row.get::<_, String>(1)?,
                "api_base": row.get::<_, String>(2)?,
                "note": row.get::<_, String>(3)?,
                "is_expired": row.get::<_, i64>(4)? != 0,
                "created_at": row.get::<_, String>(5)?,
            }))
        },
    )
    .ok()
}

#[tauri::command]
pub fn delete_api_key_label(app: AppHandle, record_id: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM api_key_labels WHERE record_id = ?1",
        params![record_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn list_labels_internal(conn: &Connection) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT record_id, key_preview, service, api_base, note, is_expired, created_at \
             FROM api_key_labels ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "record_id": row.get::<_, String>(0)?,
                "key_preview": row.get::<_, String>(1)?,
                "service": row.get::<_, String>(2)?,
                "api_base": row.get::<_, String>(3)?,
                "note": row.get::<_, String>(4)?,
                "is_expired": row.get::<_, i64>(5)? != 0,
                "created_at": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut labels = Vec::new();
    for row in rows {
        labels.push(row.map_err(|e| e.to_string())?);
    }
    Ok(labels)
}

#[tauri::command]
pub fn list_api_key_labels(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    list_labels_internal(&conn)
}

#[tauri::command]
pub fn mark_expired(app: AppHandle, record_id: String, expired: bool) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE api_key_labels SET is_expired = ?1 WHERE record_id = ?2",
        params![expired as i64, record_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn export_labels_json(app: AppHandle) -> Result<String, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let labels = list_labels_internal(&conn)?;
    serde_json::to_string_pretty(&labels).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_toast_shown(app: AppHandle, key_preview: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO toast_shown (key_preview) VALUES (?1)",
        params![key_preview],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn is_toast_shown(app: AppHandle, key_preview: String) -> bool {
    is_toast_shown_internal(&app, &key_preview)
}

#[tauri::command]
pub fn set_user_api_key(app: AppHandle, id: String, value: bool) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE clipboard_records SET user_api_key = ?1 WHERE id = ?2",
        params![value as i64, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Reorder Commands ──────────────────────────────────────────

#[tauri::command]
pub fn reorder_clipboard_records(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let n = ids.len();

    if ids.is_empty() {
        return Ok(());
    }

    let mut case_clauses = String::new();
    let mut id_list = String::new();
    for (i, id) in ids.iter().enumerate() {
        let escaped = id.replace('\'', "''");
        case_clauses.push_str(&format!(" WHEN '{}' THEN {}", escaped, (n - i) * 10));
        if i > 0 {
            id_list.push(',');
        }
        id_list.push_str(&format!("'{}'", escaped));
    }

    let sql = format!(
        "UPDATE clipboard_records SET sort_order = CASE id{} END WHERE id IN ({})",
        case_clauses, id_list,
    );

    conn.execute(&sql, []).map_err(|e| e.to_string())?;
    log::info!("reorder_clipboard_records: {} items", ids.len());
    Ok(())
}

#[tauri::command]
pub fn reorder_phrase_groups(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let n = ids.len();

    if ids.is_empty() {
        return Ok(());
    }

    let mut case_clauses = String::new();
    let mut id_list = String::new();
    for (i, id) in ids.iter().enumerate() {
        let escaped = id.replace('\'', "''");
        case_clauses.push_str(&format!(" WHEN '{}' THEN {}", escaped, (n - i) * 10));
        if i > 0 {
            id_list.push(',');
        }
        id_list.push_str(&format!("'{}'", escaped));
    }

    conn.execute(
        &format!(
            "UPDATE phrase_groups SET sort_order = CASE id{} END WHERE id IN ({})",
            case_clauses, id_list
        ),
        [],
    )
    .map_err(|e| e.to_string())?;

    let _ = app.emit("phrase-groups-changed", ());
    log::info!("reorder_phrase_groups: {} items", ids.len());
    Ok(())
}

#[tauri::command]
pub fn reorder_phrases(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let n = ids.len();

    if ids.is_empty() {
        return Ok(());
    }

    let mut case_clauses = String::new();
    let mut id_list = String::new();
    for (i, id) in ids.iter().enumerate() {
        let escaped = id.replace('\'', "''");
        case_clauses.push_str(&format!(" WHEN '{}' THEN {}", escaped, (n - i) * 10));
        if i > 0 {
            id_list.push(',');
        }
        id_list.push_str(&format!("'{}'", escaped));
    }

    conn.execute(
        &format!(
            "UPDATE phrases SET sort_order = CASE id{} END WHERE id IN ({})",
            case_clauses, id_list
        ),
        [],
    )
    .map_err(|e| e.to_string())?;

    log::info!("reorder_phrases: {} items", ids.len());
    Ok(())
}

#[cfg(test)]
mod quick_input_file_tests {
    use super::{
        is_legacy_quick_input_file_path, is_quick_input_text_preview_path,
        legacy_quick_input_target_path, paths_overlap, quick_input_relative_path,
    };
    use std::path::Path;

    #[test]
    fn quick_input_relative_path_preserves_original_filename() {
        assert_eq!(
            quick_input_relative_path("preset-1", "example.md"),
            "quick-input-files/preset-1/example.md"
        );
    }

    #[test]
    fn quick_input_text_preview_accepts_only_supported_extensions() {
        assert!(is_quick_input_text_preview_path(
            "quick-input-files/preset-1/example.JSON"
        ));
        assert!(is_quick_input_text_preview_path(
            "quick-input-files/preset-1/example.txt"
        ));
        assert!(is_quick_input_text_preview_path(
            "quick-input-files/preset-1/example.toml"
        ));
        assert!(!is_quick_input_text_preview_path(
            "quick-input-files/preset-1/example.md"
        ));
        assert!(!is_quick_input_text_preview_path("/tmp/example.json"));
    }

    #[test]
    fn legacy_quick_input_file_path_is_single_file_under_root() {
        assert!(is_legacy_quick_input_file_path(
            "quick-input-files/3fcb74c0-4738-4230-a5bc-51067b34ec0b.md"
        ));
        assert!(!is_legacy_quick_input_file_path(
            "quick-input-files/preset-1/example.md"
        ));
    }

    #[test]
    fn legacy_quick_input_target_path_uses_original_filename() {
        assert_eq!(
            legacy_quick_input_target_path(
                "quick-input-files/3fcb74c0-4738-4230-a5bc-51067b34ec0b.md",
                "/home/ao/docs/original.md"
            ),
            Some("quick-input-files/3fcb74c0-4738-4230-a5bc-51067b34ec0b/original.md".to_string())
        );
    }

    #[test]
    fn storage_directories_cannot_overlap() {
        let storage = Path::new("/home/user/.local/share/copy-creator");
        assert!(paths_overlap(
            storage,
            Path::new("/home/user/.local/share/copy-creator/resources")
        ));
        assert!(paths_overlap(storage, Path::new("/home/user/.local/share")));
        assert!(!paths_overlap(
            storage,
            Path::new("/home/user/Documents/resources")
        ));
    }
}

#[cfg(test)]
mod resource_file_tests {
    use super::{
        managed_resource_attachment_path, managed_resource_file_path,
        normalize_resource_group_name, resource_group_for_path,
    };
    use std::path::{Path, PathBuf};

    #[test]
    fn managed_resource_file_requires_generated_name_and_extension() {
        let path =
            PathBuf::from("/tmp/resource-library/copy-creator-record-1-transaction-title.md");
        let roots = vec![PathBuf::from("/tmp/resource-library")];
        assert_eq!(
            managed_resource_file_path(&roots, "record-1", path.to_str().unwrap()),
            Some((path.clone(), roots[0].clone()))
        );
        assert!(managed_resource_file_path(
            &roots,
            "record-1",
            "/tmp/resource-library/copy-creator-record-1-transaction-title.md.bak",
        )
        .is_none());
        assert!(managed_resource_file_path(
            &roots,
            "record-2",
            "/tmp/resource-library/copy-creator-record-1-transaction-title.md",
        )
        .is_none());
        assert!(managed_resource_file_path(
            &roots,
            "record-1",
            "resource-library/copy-creator-record-1-transaction-title.md",
        )
        .is_none());
    }

    #[test]
    fn managed_resource_attachment_must_be_direct_child_of_record_directory() {
        let root = Path::new("/tmp/resource-library");
        let path = root.join(".copy-creator/attachments/record-1-transaction/image-1.png");
        let directory = root.join(".copy-creator/attachments/record-1-transaction");
        assert_eq!(
            managed_resource_attachment_path(root, "record-1", path.to_str().unwrap(),),
            Some((path, directory))
        );
        assert!(managed_resource_attachment_path(
            root,
            "record-1",
            "/tmp/resource-library/.copy-creator/attachments/record-2-transaction/image-1.png",
        )
        .is_none());
        assert!(
            managed_resource_attachment_path(
                root,
                "record-1",
                "/tmp/resource-library/.copy-creator/attachments/record-1-transaction/nested/image-1.png",
            )
            .is_none()
        );
        assert!(managed_resource_attachment_path(
            root,
            "record-1",
            "/tmp/other-library/.copy-creator/attachments/record-1-transaction/image-1.png",
        )
        .is_none());
        assert!(managed_resource_attachment_path(
            root,
            "record-1",
            "/tmp/resource-library/.copy-creator/attachments/record-1-transaction/image-0.png",
        )
        .is_none());
    }

    #[test]
    fn resource_group_name_rejects_path_traversal_and_nested_paths() {
        assert_eq!(
            normalize_resource_group_name(Some("  References  ")).unwrap(),
            "References"
        );
        assert!(normalize_resource_group_name(Some(".hidden")).is_err());
        assert!(normalize_resource_group_name(Some("../outside")).is_err());
        assert!(normalize_resource_group_name(Some("nested/group")).is_err());
        assert!(normalize_resource_group_name(Some("nested\\group")).is_err());
        assert!(normalize_resource_group_name(Some(&"x".repeat(81))).is_err());
    }

    #[test]
    fn resource_group_for_path_distinguishes_root_and_first_level_folder() {
        let root = Path::new("/tmp/resource-library");
        assert_eq!(
            resource_group_for_path(
                root,
                "/tmp/resource-library/copy-creator-record-1-title.txt",
            ),
            Some(String::new())
        );
        assert_eq!(
            resource_group_for_path(
                root,
                "/tmp/resource-library/References/copy-creator-record-2-title.md",
            ),
            Some("References".to_string())
        );
        assert_eq!(
            resource_group_for_path(
                root,
                "/tmp/resource-library/References/archive/copy-creator-record-3-title.md",
            ),
            None
        );
        assert_eq!(
            resource_group_for_path(root, "/tmp/other-library/copy-creator-record-4-title.txt",),
            None
        );
    }
}

#[cfg(test)]
mod record_classification_tests {
    use super::{category_sql, is_resource_record};

    #[test]
    fn treats_only_resource_storage_mode_as_resource() {
        assert!(is_resource_record("resource"));
        assert!(!is_resource_record("database"));
    }

    #[test]
    fn resource_category_sql_filters_by_storage_mode() {
        let (filter, search_filter) = category_sql(&Some("resources".to_string()));

        assert!(filter.contains("COALESCE(storage_mode, 'database') = 'resource'"));
        assert!(!filter.contains("group_name"));
        assert!(search_filter.contains("COALESCE(storage_mode, 'database') = 'resource'"));
        assert!(!search_filter.contains("group_name"));
    }

    #[test]
    fn temp_category_falls_back_to_plain_clipboard_filter() {
        let (filter, search_filter) = category_sql(&Some("temp".to_string()));

        assert!(filter.contains("NOT (COALESCE(storage_mode, 'database') = 'resource')"));
        assert!(!filter.contains("group_name"));
        assert!(search_filter.contains("NOT (COALESCE(storage_mode, 'database') = 'resource')"));
        assert!(!search_filter.contains("group_name"));
    }
}

#[cfg(test)]
mod resource_command_tests {
    use super::{
        delete_resource_group_inner, get_clipboard_records_inner, update_resource_group_inner,
        DbState,
    };
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::Duration;
    use tauri::Manager;

    fn test_app() -> (tauri::App<tauri::test::MockRuntime>, PathBuf) {
        let app = tauri::test::mock_app();
        let root = std::env::temp_dir().join(format!(
            "copy-creator-resource-command-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE clipboard_records (
                 id TEXT PRIMARY KEY,
                 type TEXT NOT NULL,
                 content TEXT NOT NULL,
                 source_app TEXT DEFAULT '',
                 created_at TEXT NOT NULL,
                 user_api_key INTEGER DEFAULT 0,
                 sort_order REAL,
                 group_name TEXT DEFAULT '',
                 attachments TEXT DEFAULT '[]',
                 storage_mode TEXT DEFAULT 'database',
                 resource_path TEXT DEFAULT ''
             );
             INSERT INTO settings (key, value) VALUES ('resource_library_path', '');",
        )
        .unwrap();
        app.manage(DbState {
            conn: Mutex::new(conn),
        });
        {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "UPDATE settings SET value = ?1 WHERE key = 'resource_library_path'",
                [&root.to_string_lossy().to_string()],
            )
            .unwrap();
        }

        (app, root)
    }

    fn insert_resource(
        app: &tauri::App<tauri::test::MockRuntime>,
        id: &str,
        sort_order: f64,
        group_name: &str,
        resource_path: &str,
    ) {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO clipboard_records
             (id, type, content, created_at, sort_order, group_name, storage_mode, resource_path)
             VALUES (?1, 'text', ?2, '2026-08-01T00:00:00Z', ?3, ?4, 'resource', ?5)",
            (id, id, sort_order, group_name, resource_path),
        )
        .unwrap();
    }

    fn cleanup(root: &PathBuf) {
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn resource_record_query_returns_without_reentrant_database_lock() {
        let (app, root) = test_app();
        let group = root.join("References");
        std::fs::create_dir_all(&group).unwrap();
        let path = group.join("copy-creator-resource-1.txt");
        std::fs::write(&path, "resource").unwrap();
        insert_resource(
            &app,
            "resource-1",
            10.0,
            "References",
            path.to_str().unwrap(),
        );

        let handle = app.handle().clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = get_clipboard_records_inner(
                &handle,
                None,
                Some(120),
                Some(0),
                Some("resources".to_string()),
                Some("References".to_string()),
            );
            sender.send(result).unwrap();
        });
        let records = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("资源列表查询不应因重复获取数据库锁而阻塞")
            .unwrap();

        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["resource_group"], "References");
        cleanup(&root);
    }

    #[test]
    fn resource_group_filter_supports_pagination_and_ungrouped_records() {
        let (app, root) = test_app();
        let group = root.join("References");
        std::fs::create_dir_all(&group).unwrap();
        let root_path = root.join("copy-creator-resource-root.txt");
        let first_group_path = group.join("copy-creator-resource-first.txt");
        let second_group_path = group.join("copy-creator-resource-second.txt");
        for path in [&root_path, &first_group_path, &second_group_path] {
            std::fs::write(path, "resource").unwrap();
        }
        insert_resource(&app, "root", 30.0, "", root_path.to_str().unwrap());
        insert_resource(
            &app,
            "first",
            20.0,
            "References",
            first_group_path.to_str().unwrap(),
        );
        insert_resource(
            &app,
            "second",
            10.0,
            "References",
            second_group_path.to_str().unwrap(),
        );

        let handle = app.handle().clone();
        let page = get_clipboard_records_inner(
            &handle,
            None,
            Some(1),
            Some(1),
            Some("resources".to_string()),
            Some("References".to_string()),
        )
        .unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0]["id"], "second");

        let ungrouped = get_clipboard_records_inner(
            &handle,
            None,
            Some(120),
            Some(0),
            Some("resources".to_string()),
            Some(String::new()),
        )
        .unwrap();
        assert_eq!(
            ungrouped
                .iter()
                .map(|record| &record["id"])
                .collect::<Vec<_>>(),
            vec![&serde_json::json!("root")]
        );
        cleanup(&root);
    }

    #[test]
    fn renaming_resource_group_updates_files_and_record_metadata() {
        let (app, root) = test_app();
        let old_path = root.join("Old");
        std::fs::create_dir_all(&old_path).unwrap();
        let file = old_path.join("copy-creator-resource-1.txt");
        std::fs::write(&file, "resource").unwrap();
        insert_resource(&app, "resource-1", 10.0, "Old", file.to_str().unwrap());

        update_resource_group_inner(app.handle(), "Old".to_string(), "New".to_string()).unwrap();

        let new_file = root.join("New/copy-creator-resource-1.txt");
        assert!(new_file.is_file());
        assert!(!old_path.exists());
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let (group_name, resource_path): (String, String) = conn
            .query_row(
                "SELECT group_name, resource_path FROM clipboard_records WHERE id = 'resource-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(group_name, "New");
        assert_eq!(resource_path, new_file.to_string_lossy());
        cleanup(&root);
    }

    #[test]
    fn deleting_resource_group_moves_files_updates_markdown_and_clears_metadata() {
        let (app, root) = test_app();
        let group_path = root.join("References");
        let attachments = root.join(".copy-creator/attachments/resource-1-transaction");
        std::fs::create_dir_all(&attachments).unwrap();
        std::fs::create_dir_all(&group_path).unwrap();
        let file = group_path.join("copy-creator-resource-1.md");
        std::fs::write(
            &file,
            "截图\n![截图 1](../.copy-creator/attachments/resource-1-transaction/image-1.png)\n",
        )
        .unwrap();
        insert_resource(
            &app,
            "resource-1",
            10.0,
            "References",
            file.to_str().unwrap(),
        );

        delete_resource_group_inner(app.handle(), "References".to_string()).unwrap();

        let moved_file = root.join("copy-creator-resource-1.md");
        assert!(moved_file.is_file());
        assert!(!group_path.exists());
        assert_eq!(
            std::fs::read_to_string(&moved_file).unwrap(),
            "截图\n![截图 1](.copy-creator/attachments/resource-1-transaction/image-1.png)\n",
        );
        let state = app.state::<DbState>();
        let conn = state.conn.lock().unwrap();
        let (group_name, resource_path): (String, String) = conn
            .query_row(
                "SELECT group_name, resource_path FROM clipboard_records WHERE id = 'resource-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(group_name.is_empty());
        assert_eq!(resource_path, moved_file.to_string_lossy());
        cleanup(&root);
    }

    #[test]
    fn deleting_resource_group_rolls_back_previous_moves_when_markdown_read_fails() {
        let (app, root) = test_app();
        let group_path = root.join("References");
        std::fs::create_dir_all(&group_path).unwrap();
        let first = group_path.join("01-resource.txt");
        let unreadable_markdown = group_path.join("02-resource.md");
        std::fs::write(&first, "resource").unwrap();
        std::fs::write(&unreadable_markdown, [0xff, 0xfe, 0xfd]).unwrap();

        let error = delete_resource_group_inner(app.handle(), "References".to_string())
            .expect_err("无效 UTF-8 的 Markdown 文件应使分组删除失败");
        assert!(error.contains("读取资源文件失败"));
        assert!(first.is_file());
        assert!(unreadable_markdown.is_file());
        assert!(!root.join("01-resource.txt").exists());
        assert!(root.join("References").is_dir());
        cleanup(&root);
    }
}
