use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// 资源库修订号：外部变更（监听防抖冲刷/启动对账）时自增。前端定时拉取
/// 比对，作为 resource-groups-changed 单次事件被 WebView 丢弃或延迟时的
/// 兜底自愈信号——事件是主路径，轮询对账只补漏。
static RESOURCE_LIBRARY_REVISION: AtomicU64 = AtomicU64::new(0);

pub(crate) fn bump_resource_library_revision() {
    RESOURCE_LIBRARY_REVISION.fetch_add(1, Ordering::Relaxed);
}

/// 前端心跳拉取当前修订号（纯内存读取，零 IO）。
#[tauri::command]
pub fn get_resource_library_revision() -> u64 {
    RESOURCE_LIBRARY_REVISION.load(Ordering::Relaxed)
}

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
    let total = c.chars().count();
    if total >= 12 {
        let head: String = c.chars().take(8).collect();
        let tail: String = c.chars().skip(total - 4).collect();
        format!("{}...{}", head, tail)
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
    use_count: i64,
    last_used_at: String,
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
        "use_count": use_count,
        "last_used_at": last_used_at,
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

pub fn get_storage_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
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

pub(crate) fn resolve_storage_path<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
) -> Result<PathBuf, String> {
    resolve_storage_path_from_root(&get_storage_dir(app), path)
}

/// 安全边界：判断路径是否位于应用自身管理的目录（存储目录、默认/当前/
/// 历史资源库）之内。媒体服务与图片读取命令共用——这些通道的 token /
/// 调用方一旦被注入，无边界即可读取磁盘任意文件；同时拒绝携带 `..`/
/// `.` 组件的路径防穿越。组件比较统一小写（Windows 大小写不敏感）。
pub(crate) fn is_app_managed_path<R: Runtime>(app: &AppHandle<R>, path: &Path) -> bool {
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return false;
    }
    let mut roots = resource_library_roots(app);
    roots.push(get_storage_dir(app));
    path_within_any(path, &roots)
}

/// 纯函数部分（便于单测）：path 是否落在任一 root 之内。
fn path_within_any(path: &Path, roots: &[PathBuf]) -> bool {
    let component_key = |p: &Path| -> Vec<String> {
        p.components()
            .filter_map(|c| match c {
                Component::Normal(part) => Some(part.to_string_lossy().to_lowercase()),
                _ => None,
            })
            .collect()
    };
    let target = component_key(path);
    if target.is_empty() {
        return false;
    }
    roots.iter().any(|root| {
        let root_key = component_key(root);
        target.len() >= root_key.len() && target[..root_key.len()] == root_key[..]
    })
}

pub(crate) fn resolve_managed_storage_path<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
) -> Option<PathBuf> {
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
    // 历史版本曾把 canonicalize 的 `\\?\` 扩展路径写入设置，读取时统一
    // 还原成常规形态，避免旧数据继续向前端与媒体 URL 泄露扩展前缀。
    let dir = simplify_windows_path(&dir);
    if let Err(error) = std::fs::create_dir_all(&dir) {
        log::warn!("无法创建资源库目录 {}: {}", dir.display(), error);
    }
    dir
}

/// 剥离 Windows `std::fs::canonicalize` 产生的 `\\?\` 扩展前缀，让路径在
/// 设置存储、前端展示与媒体 URL 中保持常规形态；UNC 路径还原 `\\server\share`。
pub(crate) fn simplify_windows_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        let mut chars = rest.chars();
        if let (Some(first), Some(':')) = (chars.next(), chars.next()) {
            if first.is_ascii_alphabetic() {
                return PathBuf::from(rest.to_string());
            }
        }
    }
    path.to_path_buf()
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

pub(crate) fn normalize_resource_folder_path(value: Option<&str>) -> Result<String, String> {
    let value = value.unwrap_or("").trim().replace('\\', "/");
    if value.is_empty() {
        return Ok(String::new());
    }
    let mut parts = Vec::new();
    for part in value.split('/') {
        if part.is_empty() {
            return Err("资源目录路径无效".to_string());
        }
        parts.push(normalize_resource_group_name(Some(part))?);
    }
    Ok(parts.join("/"))
}

pub(crate) fn resource_group_path<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
) -> Result<PathBuf, String> {
    let normalized = normalize_resource_folder_path(Some(name))?;
    let root = get_resource_library_dir(app);
    if normalized.is_empty() {
        Ok(root)
    } else {
        let mut path = root;
        for segment in normalized.split('/') {
            path.push(segment);
        }
        Ok(path)
    }
}

const RESOURCE_FILE_ID_PREFIX: &str = "resource-file:";

#[derive(Debug, Clone)]
struct ResourceFileEntry {
    path: PathBuf,
    group: String,
    modified_at: String,
    sort_order: f64,
}

/// 记录列表输出用：按路径把 file 记录归类为 image/video/audio/text/file。
fn resource_media_kind_for_path(path: &Path) -> &'static str {
    crate::media_kind::media_kind_for_path(path).as_str()
}

fn resource_file_id(path: &Path) -> String {
    format!("{RESOURCE_FILE_ID_PREFIX}{}", path.to_string_lossy())
}

fn resource_file_path_from_id<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<Option<PathBuf>, String> {
    let Some(path) = id.strip_prefix(RESOURCE_FILE_ID_PREFIX) else {
        return Ok(None);
    };
    if path.is_empty() {
        return Err("资源文件路径无效".to_string());
    }
    resolve_resource_file_path(app, path).map(Some)
}

fn resource_path_key(path: &Path) -> PathBuf {
    // canonicalize 在 Windows 上恒返回 `\\?\` 扩展形式；与常规形态的路径
    // 做 strip_prefix/join 前先还原，避免混用两种形态导致比较失效。
    simplify_windows_path(&path.canonicalize().unwrap_or_else(|_| path.to_path_buf()))
}

fn is_ignored_resource_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(OsStr::to_str) else {
        return false;
    };
    name.starts_with(".copy-creator-")
        || (name.starts_with('.') && name.ends_with(".tmp"))
        || is_temporary_resource_file_name(name)
}

/// 浏览器/下载器的半成品文件与 Office/LibreOffice 锁文件、系统派生文件：
/// 入库只会产生无内容可展示的「文件」占位卡片，覆盖完成后才会以真实
/// 文件名再次出现并被正常收录。扩展名清单由扫描忽略与启动清退共用
/// （is_temporary_resource_file_name 与 prune_temporary_resource_records）。
const TEMPORARY_RESOURCE_EXTENSIONS: [&str; 9] = [
    "tmp", "temp", "crdownload", "part", "download", "partial", "opdownload", "swp", "swo",
];

fn is_temporary_resource_file_name(name: &str) -> bool {
    if name.starts_with("~$") || name.starts_with(".~lock.") {
        return true;
    }
    let lower = name.to_lowercase();
    if matches!(lower.as_str(), "desktop.ini" | "thumbs.db" | ".ds_store") {
        return true;
    }
    lower
        .rsplit_once('.')
        .is_some_and(|(_, extension)| TEMPORARY_RESOURCE_EXTENSIONS.contains(&extension))
}

/// 应用缩略图目录约定：原图旁的 `thumbs/` 全部是派生缓存（可随时再生成），
/// 永不作为资源内容收录，否则缩略图会以「原图」身份混进库，还会被再次
/// 生成缩略图衍生出 thumbs/thumbs 嵌套污染。`.copy-creator` 是应用元数据。
fn is_ignored_resource_dir(name: &OsStr) -> bool {
    name == OsStr::new(".copy-creator") || name == OsStr::new("thumbs")
}

fn path_inside_ignored_dir(path: &Path) -> bool {
    path.components()
        .any(|component| is_ignored_resource_dir(component.as_os_str()))
}

/// 清退历史误入库的 thumbs 派生缓存记录：旧版本的缩略图命令会把
/// `thumbs/<同名文件>` 写在原图旁，资源发现又未排除该目录，导致缩略图
/// 以「原图」身份混进库（模糊重复条目 + thumbs 嵌套分组）。文件本体
/// 保留在磁盘上，仅移除入库记录。必须在 init_db 每次启动时执行——
/// 只挂在监听补建路径上时，无新文件移入则永远不会触发（已踩坑）。
fn prune_legacy_thumb_records(conn: &Connection) {
    if let Err(error) = conn.execute(
        "DELETE FROM clipboard_records
         WHERE COALESCE(storage_mode, 'database') = 'resource'
           AND (resource_path LIKE '%/thumbs/%' OR resource_path LIKE '%\\thumbs\\%')",
        [],
    ) {
        log::warn!("清理 thumbs 缓存记录失败: {error}");
    }
}

/// 清退历史误入库的外部临时文件记录（浏览器半成品下载 .crdownload/.tmp
/// 等）：文件本体保留在磁盘上，仅移除入库记录；此后扫描与监听补建均按
/// is_temporary_resource_file_name 忽略，不会重新出现。只清外部发现
/// （resource_external=1）的记录，应用内显式保存的资源不受影响。必须在
/// init_db 每次启动时执行（与 prune_legacy_thumb_records 同理）。扩展名
/// 清单须与 is_temporary_resource_file_name 保持一致（有单测钉住）。
fn prune_temporary_resource_records(conn: &Connection) {
    let conditions: Vec<String> = TEMPORARY_RESOURCE_EXTENSIONS
        .iter()
        .map(|extension| format!("LOWER(resource_path) LIKE '%.{extension}'"))
        .collect();
    let sql = format!(
        "DELETE FROM clipboard_records
         WHERE COALESCE(storage_mode, 'database') = 'resource'
           AND COALESCE(resource_external, 0) = 1
           AND ({})",
        conditions.join(" OR ")
    );
    if let Err(error) = conn.execute(&sql, []) {
        log::warn!("清理临时文件记录失败: {error}");
    }
}

fn scan_resource_files(root: &Path) -> Vec<ResourceFileEntry> {
    scan_resource_files_under(root, root)
}

/// 只递归 directory 子树（分组/文件夹相对 root 计算，调用方保证 directory
/// 位于 root 内）：整组粘贴/拖出只需要目标分组的内容，不必全库扫描。
fn scan_resource_files_under(root: &Path, directory: &Path) -> Vec<ResourceFileEntry> {
    fn visit(root: &Path, directory: &Path, entries: &mut Vec<ResourceFileEntry>) {
        let Ok(read_dir) = std::fs::read_dir(directory) else {
            return;
        };
        let mut children = read_dir.flatten().collect::<Vec<_>>();
        children.sort_by_key(|entry| entry.file_name());

        for entry in children {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                if is_ignored_resource_dir(&entry.file_name()) {
                    continue;
                }
                visit(root, &path, entries);
                continue;
            }
            if !file_type.is_file() || is_ignored_resource_file(&path) {
                continue;
            }

            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let Some(group) = resource_group_for_path(root, path.to_string_lossy().as_ref()) else {
                continue;
            };
            let modified = metadata
                .modified()
                .ok()
                .map(chrono::DateTime::<chrono::Utc>::from)
                .unwrap_or_else(chrono::Utc::now);
            let sort_order = modified.timestamp_millis() as f64;
            entries.push(ResourceFileEntry {
                path,
                group,
                modified_at: modified.to_rfc3339(),
                sort_order,
            });
        }
    }

    let mut entries = Vec::new();
    if directory.is_dir() {
        visit(root, directory, &mut entries);
    }
    entries
}

fn resource_file_is_inside_meta_directory(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root).ok().is_some_and(|relative| {
        relative
            .components()
            .any(|component| component.as_os_str() == OsStr::new(".copy-creator"))
    })
}

fn resolve_resource_file_path<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
) -> Result<PathBuf, String> {
    let root = get_resource_library_dir(app)
        .canonicalize()
        .map_err(|error| format!("读取资源库目录失败: {error}"))?;
    let candidate = PathBuf::from(path);
    if !candidate.is_absolute() {
        return Err("资源文件路径无效".to_string());
    }
    let candidate = candidate
        .canonicalize()
        .map_err(|error| format!("读取资源文件失败: {error}"))?;
    if !candidate.starts_with(&root)
        || candidate == root
        || resource_file_is_inside_meta_directory(&root, &candidate)
    {
        return Err("资源文件路径无效".to_string());
    }
    let metadata =
        std::fs::metadata(&candidate).map_err(|error| format!("读取资源文件失败: {error}"))?;
    if !metadata.is_file() {
        return Err("请选择一个文件".to_string());
    }
    Ok(simplify_windows_path(&candidate))
}

pub(crate) fn resource_folder_for_path(root: &Path, resource_path: &str) -> Option<String> {
    let path = Path::new(resource_path);
    if !path.is_absolute() {
        return None;
    }
    let parent = path.parent()?;
    if parent == root {
        return Some(String::new());
    }
    let relative_parent = parent.strip_prefix(root).ok()?;
    let components = relative_parent.components().collect::<Vec<_>>();
    if components
        .iter()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    let folder = components
        .into_iter()
        .map(|component| match component {
            Component::Normal(name) => name.to_str().map(str::to_string),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?
        .join("/");
    normalize_resource_folder_path(Some(&folder)).ok()
}

pub(crate) fn resource_group_for_path(root: &Path, resource_path: &str) -> Option<String> {
    let folder = resource_folder_for_path(root, resource_path)?;
    folder.split('/').next().map(str::to_string)
}

fn resource_library_history<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    get_setting_sync(app, RESOURCE_LIBRARY_HISTORY_SETTING)
        .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|entry| simplify_windows_path(Path::new(&entry)))
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

fn is_safe_managed_resource_file(root: &Path, path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return false;
    }
    let Ok(canonical_root) = root.canonicalize() else {
        return false;
    };
    let Ok(canonical_path) = path.canonicalize() else {
        return false;
    };
    canonical_path != canonical_root
        && canonical_path.starts_with(&canonical_root)
        && !resource_file_is_inside_meta_directory(&canonical_root, &canonical_path)
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

pub(crate) fn remove_resource_record_attachments<R: Runtime>(
    app: &AppHandle<R>,
    record_id: &str,
    attachment_paths: &[String],
) {
    let resource_roots = resource_library_roots(app);
    remove_resource_record_attachments_from_roots(&resource_roots, record_id, attachment_paths);
}

pub(crate) fn remove_resource_record_files<R: Runtime>(
    app: &AppHandle<R>,
    record_id: &str,
    resource_path: &str,
    attachment_paths: &[String],
) {
    let resource_roots = resource_library_roots(app);
    if let Some((path, resource_root)) =
        managed_resource_file_path(&resource_roots, record_id, resource_path)
    {
        if is_safe_managed_resource_file(&resource_root, &path) {
            let _ = std::fs::remove_file(path);
        }
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

// 与资源区可预览文本共用同一份扩展名清单（md/json/yaml 及各类代码等），
// 避免出现「资源区能预览、快捷输入/剪切板不能」的割裂。
fn is_text_preview_extension(path: &Path) -> bool {
    crate::media_kind::is_text_extension(path)
}

/// 校验路径是不超过上限的文件，返回 metadata。预览读取、预检与写入
/// 前置检查共用；超出上限的提示语由调用方按场景传入。
fn ensure_capped_file(
    path: &Path,
    limit: u64,
    over_limit_message: &str,
) -> Result<std::fs::Metadata, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("读取文件失败: {e}"))?;
    if !metadata.is_file() {
        return Err("请选择一个文件".to_string());
    }
    if metadata.len() > limit {
        return Err(over_limit_message.to_string());
    }
    Ok(metadata)
}

/// 读取不超过预览上限的文本文件内容（UTF-8）。
fn read_capped_text_file(path: &Path) -> Result<String, String> {
    ensure_capped_file(path, QUICK_INPUT_TEXT_PREVIEW_LIMIT_BYTES, "预览文件不能超过 1 MB")?;
    std::fs::read_to_string(path).map_err(|e| format!("读取文件失败: {e}"))
}

fn read_text_preview_file(path: PathBuf) -> Result<String, String> {
    if !is_text_preview_extension(&path) {
        return Err("当前文件不是可预览的文本文件".to_string());
    }
    read_capped_text_file(&path)
}

fn read_resource_text_preview_file(path: PathBuf) -> Result<String, String> {
    if !crate::media_kind::is_text_extension(&path) && !crate::media_kind::is_probably_text_file(&path) {
        return Err("当前文件不是可预览的文本文件".to_string());
    }
    read_capped_text_file(&path)
}

fn resolve_quick_input_text_preview_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    if !is_quick_input_text_preview_path(path) {
        return Err("当前文件不是可预览的文本文件".to_string());
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

    ensure_capped_file(&preview_path, QUICK_INPUT_TEXT_PREVIEW_LIMIT_BYTES, "预览文件不能超过 1 MB")?;
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

#[tauri::command]
pub fn read_resource_text_preview(app: AppHandle, path: String) -> Result<String, String> {
    let path = resolve_resource_file_path(&app, &path)?;
    read_resource_text_preview_file(path)
}

/// 粘贴场景的文本文件大小上限；预览是给人看的用 1 MB，粘贴是完整使用
/// 内容，放宽到 10 MB，超出仍按文件粘贴。
const RESOURCE_TEXT_PASTE_LIMIT_BYTES: u64 = 10 * 1024 * 1024;

/// 读取资源库内文本文件的完整内容，供「文件承载的文本资源」按内容粘贴使用。
/// 路径必须是资源库内的文件；超过大小上限或内容不是有效 UTF-8 时返回错误，
/// 由前端回退为文件粘贴。
pub fn read_text_file_content_inner<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
) -> Result<String, String> {
    let target = resolve_resource_file_path(app, path)?;
    ensure_capped_file(&target, RESOURCE_TEXT_PASTE_LIMIT_BYTES, "文本文件超过 10 MB，无法按内容粘贴")?;
    std::fs::read_to_string(&target).map_err(|e| format!("读取文件失败: {e}"))
}

#[tauri::command]
pub fn read_text_file_content(app: AppHandle, path: String) -> Result<String, String> {
    read_text_file_content_inner(&app, &path)
}

/// 保存资源详情页编辑后的文本正文。文件承载的文本是唯一事实来源；
/// 数据库记录（id 非空时）的 content 与文件同步。编辑不改动 sort_order，
/// 避免卡片在列表里跳位。
#[tauri::command]
pub fn write_resource_text_content(
    app: AppHandle,
    path: String,
    content: String,
    id: Option<String>,
) -> Result<serde_json::Value, String> {
    let trimmed = content.trim().to_string();
    if trimmed.is_empty() {
        return Err("内容不能为空".to_string());
    }
    let target = resolve_resource_file_path(&app, &path)?;
    if !crate::media_kind::is_text_extension(&target) && !crate::media_kind::is_probably_text_file(&target) {
        return Err("当前文件不是可编辑的文本文件".to_string());
    }
    ensure_capped_file(&target, QUICK_INPUT_TEXT_PREVIEW_LIMIT_BYTES, "文本内容不能超过 1 MB")?;
    // 与新建窗口写入路径保持一致：正文末尾补一个换行。
    std::fs::write(&target, format!("{trimmed}\n"))
        .map_err(|e| format!("写入资源文件失败: {e}"))?;

    let record_type = crate::clipboard::classify_text_record(&trimmed);
    if let Some(id) = id.as_deref() {
        let update_result = {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE clipboard_records SET content = ?1, type = ?2 WHERE id = ?3",
                params![&trimmed, record_type, id],
            )
            .map_err(|e| e.to_string())
        };
        if let Err(error) = update_result {
            return Err(format!("更新资源记录失败: {error}"));
        }
    }
    let _ = app.emit("resource-groups-changed", ());
    Ok(serde_json::json!({ "content": trimmed, "record_type": record_type }))
}

pub fn init_db(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let path = db_path(app);
    let conn = Connection::open(&path)?;

    conn.execute_batch(
        // foreign_keys 默认关闭：声明式级联（phrases.group_id）此前从未生效，
        // 级联删除一直靠手写 DELETE。显式开启让引用约真正生效。
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8000; PRAGMA foreign_keys=ON;",
    )?;

    ensure_schema(&conn)?;


    app.manage(DbState {
        conn: Mutex::new(conn),
    });
    migrate_legacy_quick_input_file_names(app);

    Ok(())
}

/// 连接 schema 与历史数据迁移的唯一入口：建表、索引、默认设置种子、
/// 历史结构增量迁移（全部幂等）。主库初始化与存储迁移共用，保证任何
/// 路径建出的库 schema 完全一致，不再各自维护一份 CREATE TABLE 文本。
fn ensure_schema(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
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
            resource_path TEXT DEFAULT '',
            last_used_at TEXT DEFAULT '',
            use_count INTEGER DEFAULT 0,
            touched_ms INTEGER DEFAULT 0
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
            last_used_at TEXT DEFAULT '',
            use_count INTEGER DEFAULT 0,
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
    conn.execute(
        "ALTER TABLE clipboard_records ADD COLUMN resource_note TEXT DEFAULT ''",
        [],
    )
    .ok();
    // 外部发现的资源文件（对账/监听补建）：区别于应用内保存的记录。
    // 前端据此决定文本详情保存走记录 id 还是直接写文件路径。
    conn.execute(
        "ALTER TABLE clipboard_records ADD COLUMN resource_external INTEGER DEFAULT 0",
        [],
    )
    .ok();

    // ── last_used_at：粘贴成功时记录使用时间，供径向菜单「最近使用」聚合查询 ──
    conn.execute(
        "ALTER TABLE clipboard_records ADD COLUMN last_used_at TEXT DEFAULT ''",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE phrases ADD COLUMN last_used_at TEXT DEFAULT ''",
        [],
    )
    .ok();

    // ── use_count / touched_ms：使用次数与最近使用毫秒时间戳，供内容列表排序偏好 ──
    // touched_ms 仅 touch 写入；「最近使用」排序键取 MAX(touched_ms, sort_order)，
    // 未使用过的条目自然回退到复制/文件时间（新复制置顶不沉底）。
    conn.execute(
        "ALTER TABLE clipboard_records ADD COLUMN use_count INTEGER DEFAULT 0",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE clipboard_records ADD COLUMN touched_ms INTEGER DEFAULT 0",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE phrases ADD COLUMN use_count INTEGER DEFAULT 0",
        [],
    )
    .ok();

    // ── created_ms 生成列：created_at 派生的毫秒时间戳 ──
    // 清理/去重等范围查询用毫秒整数比较，替代 datetime(created_at) 这类
    // 包列函数（索引失效）与 RFC3339 变精度字符串比较（边界误判）。生成列
    // 保证任何现有与未来的插入路径都自动带值，不可能漏写。索引建在虚拟列
    // 上，条目由 SQLite 存于索引内，不占用表存储。
    conn.execute(
        "ALTER TABLE clipboard_records ADD COLUMN created_ms INTEGER \
         GENERATED ALWAYS AS (CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER)) VIRTUAL",
        [],
    )
    .ok();
    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_clipboard_created_ms ON clipboard_records(created_ms);
        CREATE INDEX IF NOT EXISTS idx_clipboard_content ON clipboard_records(content);
        CREATE INDEX IF NOT EXISTS idx_clipboard_resource_path ON clipboard_records(resource_path);
        ",
    )?;

    // ── last_used_ms 生成列：phrases.last_used_at 派生的毫秒时间戳 ──
    // last_used_at 为 RFC3339 且亚秒位数可变（0/3/6/9 位），字符串比较在同秒
    // 内会误判（'…00Z' 字典序大于 '…00.100Z'）；「全部」视图排序改走毫秒整数。
    // 空串（从未使用）经 julianday 得 NULL，排序子句按 0 垫底。
    conn.execute(
        "ALTER TABLE phrases ADD COLUMN last_used_ms INTEGER \
         GENERATED ALWAYS AS (CAST((julianday(last_used_at) - 2440587.5) * 86400000 AS INTEGER)) VIRTUAL",
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

    // thumbs 派生缓存清退（每次启动执行，见函数注释）。
    prune_legacy_thumb_records(conn);
    prune_temporary_resource_records(conn);
    Ok(())
}

/// 启动时清洗文件记录的路径：历史版本从 `text/uri-list` 采集的路径可能带
/// 行尾 `\r`（arboard 只按 `\n` 切分），脏字符会让图片导入判断失效，粘贴
/// 与拖出也必然失败。只处理 file 记录；文本记录中间的 `\r\n` 是合法换行，
/// 必须保持原样。
pub fn sanitize_file_record_contents<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<DbState>();
    let Ok(conn) = state.conn.lock() else {
        return;
    };
    let dirty: Vec<(String, String)> = match conn
        .prepare("SELECT id, content FROM clipboard_records WHERE type = 'file'")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map(|rows| {
                rows.filter_map(|row| row.ok())
                    .filter(|(_, content)| content.trim() != *content)
                    .collect()
            })
        }) {
        Ok(rows) => rows,
        Err(error) => {
            log::warn!("扫描待清洗的文件记录失败: {error}");
            return;
        }
    };
    for (id, content) in &dirty {
        if let Err(error) = conn.execute(
            "UPDATE clipboard_records SET content = ?1 WHERE id = ?2",
            params![content.trim(), id],
        ) {
            log::warn!("清洗文件记录 {id} 失败: {error}");
        }
    }
    if !dirty.is_empty() {
        log::info!("已清洗 {} 条路径带空白字符的文件记录", dirty.len());
    }
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

        let cutoff_ms = chrono::Utc::now().timestamp_millis() - days as i64 * 86_400_000;

        // 一条语句完成筛选与删除（RETURNING 拿回被删行）；created_ms 走
        // idx_clipboard_created_ms，替代 datetime(created_at) 的全表扫描。
        let mut stmt = conn.prepare(
            "DELETE FROM clipboard_records
             WHERE created_ms < ?1
               AND NOT (COALESCE(storage_mode, 'database') = 'resource')
             RETURNING type, content, attachments",
        )?;
        let rows = stmt.query_map(params![cutoff_ms], |row| {
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

/// 资源库全量对账：以磁盘为准一次性同步索引——补录缺失文件、清退幽灵
/// 记录（文件已被外部删除）。只在应用启动与库路径切换时执行；运行期的
/// 增删由 resource_watch 增量上报。查询路径不得再做全目录扫描与逐行
/// stat——那是大库（数万文件）每次切换/搜索都卡顿的根源。返回补录条数。
pub fn sync_resource_library<R: Runtime>(app: &AppHandle<R>) -> usize {
    let root = get_resource_library_dir(app);
    let entries = scan_resource_files(&root);
    let state = app.state::<DbState>();
    let Ok(conn) = state.conn.lock() else {
        return 0;
    };

    let scanned_keys: HashSet<PathBuf> =
        entries.iter().map(|entry| resource_path_key(&entry.path)).collect();

    // 幽灵清退：库内文件已不存在（且不在本次扫描结果中）的记录移除，
    // 与原查询路径的「文件不在，记录不留」语义一致。
    let mut removable: Vec<(String, String)> = Vec::new();
    {
        let Ok(mut stmt) = conn.prepare(
            "SELECT id, resource_path FROM clipboard_records
             WHERE COALESCE(storage_mode, 'database') = 'resource'",
        ) else {
            return 0;
        };
        let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) else {
            return 0;
        };
        for row in rows.flatten() {
            let path = PathBuf::from(&row.1);
            if path.starts_with(&root) && !scanned_keys.contains(&resource_path_key(&path)) {
                removable.push(row);
            }
        }
    }
    for (id, _) in &removable {
        let _ = conn.execute("DELETE FROM api_key_labels WHERE record_id = ?1", params![id]);
        let _ = conn.execute("DELETE FROM clipboard_records WHERE id = ?1", params![id]);
    }

    // 补录：应用未运行期间放入库的文件按扫描语义入库——created_at 取文件
    // 修改时间、sort_order 取修改毫秒，与原「查询内扫描合并」的排序一致。
    // （运行期由监听补建的记录仍是发现时刻置顶，语义分工不变。）
    let mut known: HashSet<PathBuf> = {
        let Ok(mut stmt) = conn.prepare(
            "SELECT resource_path FROM clipboard_records
             WHERE COALESCE(storage_mode, 'database') = 'resource'
               AND COALESCE(resource_path, '') <> ''",
        ) else {
            return removable.len();
        };
        let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
            return removable.len();
        };
        rows.flatten().map(|p| resource_path_key(Path::new(&p))).collect()
    };
    let mut added = 0;
    for entry in &entries {
        let key = resource_path_key(&entry.path);
        if known.contains(&key) {
            continue;
        }
        let path_text = entry.path.to_string_lossy().to_string();
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO clipboard_records
             (id, type, content, source_app, created_at, group_name, attachments,
              storage_mode, resource_path, sort_order, use_count, resource_external)
             VALUES (?1, 'file', ?2, '', ?3, ?4, '[]', 'resource', ?2, ?5, 0, 1)",
            params![
                resource_file_id(&entry.path),
                path_text,
                entry.modified_at,
                entry.group,
                entry.sort_order
            ],
        );
        if let Ok(count) = inserted {
            if count > 0 {
                known.insert(key);
                added += count;
            }
        }
    }
    let total_removed = removable.len();
    drop(conn);
    if added > 0 || total_removed > 0 {
        bump_resource_library_revision();
        log::info!("资源库对账完成：补录 {added} 条，清退 {total_removed} 条");
    }
    added
}

/// 按路径移除资源记录（监听到外部删除时调用）：文件不在，记录不留。
pub fn forget_resource_records<R: Runtime>(app: &AppHandle<R>, paths: &[PathBuf]) {
    if paths.is_empty() {
        return;
    }
    let state = app.state::<DbState>();
    let Ok(conn) = state.conn.lock() else {
        return;
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT id FROM clipboard_records
         WHERE COALESCE(storage_mode, 'database') = 'resource' AND resource_path = ?1",
    ) else {
        return;
    };
    for path in paths {
        let path_text = path.to_string_lossy().to_string();
        let Ok(rows) = stmt.query_map(params![path_text], |row| row.get::<_, String>(0)) else {
            continue;
        };
        let ids: Vec<String> = rows.flatten().collect();
        for id in ids {
            let _ = conn.execute("DELETE FROM api_key_labels WHERE record_id = ?1", params![id]);
            let _ = conn.execute("DELETE FROM clipboard_records WHERE id = ?1", params![id]);
        }
    }
}

/// 外部移入资源库的新文件按发现时间补建入库：sort_order 取发现时刻，
/// 使其在「全部」列表置顶（与刚复制的剪切板内容同待遇）。已存在记录的
/// 路径（管理中 / 此前补建）不重复置顶；应用未运行期间放入的文件不追溯。
/// 由资源库目录监听在防抖结束后调用，失败仅记日志，不阻塞常规重扫。
pub fn discover_external_resource_files<R: Runtime>(
    app: &AppHandle<R>,
    paths: &[PathBuf],
) {
    if paths.is_empty() {
        return;
    }
    let root = get_resource_library_dir(app);
    let now = chrono::Utc::now().to_rfc3339();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let state = app.state::<DbState>();
    let Ok(conn) = state.conn.lock() else {
        return;
    };
    // 去重与 touch 补建同口径：按归一化路径键比较（Windows 大小写、
    // 分隔符形态差异不产生重复记录）。
    let mut by_path: HashMap<PathBuf, String> = HashMap::new();
    // 双保险：init_db 已按启动清退历史 thumbs 记录，此处兜底运行期
    // 旧版本数据被外部引入的场景。
    prune_legacy_thumb_records(&conn);
    let mut stmt = match conn.prepare(
        "SELECT id, resource_path FROM clipboard_records
         WHERE COALESCE(storage_mode, 'database') = 'resource'
           AND COALESCE(resource_path, '') <> ''",
    ) {
        Ok(stmt) => stmt,
        Err(error) => {
            log::warn!("读取资源记录路径失败: {error}");
            return;
        }
    };
    let rows = match stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) {
        Ok(rows) => rows,
        Err(error) => {
            log::warn!("读取资源记录路径失败: {error}");
            return;
        }
    };
    for row in rows {
        let Ok((id, resource_path)) = row else {
            continue;
        };
        by_path.insert(resource_path_key(Path::new(&resource_path)), id);
    }
    drop(stmt);
    for path in paths {
        if !path.is_file() || !path.starts_with(&root) || is_ignored_resource_file(&path) {
            continue;
        }
        // 与扫描同一套忽略规则：应用自身的附件、临时文件与 thumbs/ 派生
        // 缓存不是内容，否则保存图文暂存或缩略图生成时会被当作新放入
        // 置顶成独立资源条目。
        if path_inside_ignored_dir(path) || is_ignored_resource_file(path) {
            continue;
        }
        let path_text = path.to_string_lossy().to_string();
        if by_path.contains_key(&resource_path_key(path)) {
            continue;
        }
        let id = resource_file_id(path);
        match conn.execute(
            "INSERT OR IGNORE INTO clipboard_records
             (id, type, content, source_app, created_at, storage_mode, resource_path,
              sort_order, use_count, resource_external)
             VALUES (?1, 'file', ?2, '', ?3, 'resource', ?2, ?4, 0, 1)",
            params![id, path_text, &now, now_ms],
        ) {
            Err(error) => {
                log::warn!("外部移入文件补建入库失败 {}: {error}", path.display());
            }
            Ok(_) => {
                by_path.insert(resource_path_key(path), id);
                log::info!("外部移入文件已按发现时间入库置顶: {}", path.display());
            }
        }
    }
}

#[tauri::command]
pub fn get_clipboard_records(
    app: AppHandle,
    search: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    category: Option<String>,
    resource_group: Option<String>,
    sort_by: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    get_clipboard_records_inner(&app, search, limit, offset, category, resource_group, sort_by)
}

/// 内容列表排序子句：created=现状时间序；recent=最近使用（touch 毫秒，
/// 未使用回退 sort_order 即复制/文件时间，新复制置顶不沉底）；count=最多使用。
fn clipboard_order_clause(sort_by: Option<&str>) -> &'static str {
    match sort_by {
        Some("count") => "(COALESCE(use_count, 0) = 0) ASC, use_count DESC,
                MAX(COALESCE(touched_ms, 0), sort_order) DESC",
        Some("recent") => "MAX(COALESCE(touched_ms, 0), sort_order) DESC",
        _ => "sort_order DESC",
    }
}

/// 资源列表查询的中间行：只承载过滤与排序所需的标量字段。完整 JSON 组装
/// 与文件 stat 延迟到分页之后，仅对返回页（≤limit 行）执行——原先全量
/// 构建 JSON + 逐行 stat，数万文件的库每次查询都是十万级系统调用。
struct ResourceRow {
    id: String,
    record_type: String,
    content: String,
    source_app: String,
    created_at: String,
    user_api_key: i64,
    group_name: String,
    attachments: String,
    storage_mode: String,
    resource_path: String,
    path: Option<PathBuf>,
    relative_path: Option<String>,
    folder: Option<String>,
    sort_order: f64,
    resource_note: String,
    use_count: i64,
    touched_ms: i64,
    last_used_at: String,
    resource_external: i64,
}

fn resource_record_value(
    mut value: serde_json::Value,
    root: &Path,
    path: Option<&Path>,
    media_kind: &str,
    managed: bool,
) -> serde_json::Value {
    let group =
        path.and_then(|path| resource_group_for_path(root, path.to_string_lossy().as_ref()));
    let folder =
        path.and_then(|path| resource_folder_for_path(root, path.to_string_lossy().as_ref()));
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "resource_group".to_string(),
            group
                .clone()
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "resource_folder".to_string(),
            folder
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
        object.insert(
            "resource_kind".to_string(),
            serde_json::Value::String(media_kind.to_string()),
        );
        object.insert(
            "resource_managed".to_string(),
            serde_json::Value::Bool(managed),
        );
        if let Some(path) = path {
            if let Ok(relative_path) = path.strip_prefix(root) {
                object.insert(
                    "resource_relative_path".to_string(),
                    serde_json::Value::String(relative_path.to_string_lossy().to_string()),
                );
            }
            if let Ok(metadata) = std::fs::metadata(path) {
                object.insert(
                    "resource_file_size".to_string(),
                    serde_json::Value::Number(metadata.len().into()),
                );
                // 媒体版本（修改毫秒）：前端媒体 URL 与进程内缓存键携带它，
                // 文件被覆盖保存后版本变化，各缓存层随之失效（与缩略图
                // 缓存「路径+大小+修改时间」键同一口径）。复用本次 stat，
                // 不增加查询路径的系统调用。仅对返回页执行，实时性保留。
                if let Ok(modified) = metadata.modified() {
                    let millis = modified
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|duration| duration.as_millis() as u64)
                        .unwrap_or(0);
                    object.insert(
                        "resource_modified".to_string(),
                        serde_json::Value::Number(millis.into()),
                    );
                }
            }
        }
    }
    value
}

fn get_resource_records_inner<R: Runtime>(
    app: &AppHandle<R>,
    search: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    resource_group: Option<String>,
    sort_by: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let resource_root = get_resource_library_dir(app);
    let normalized_folder = resource_group
        .as_deref()
        .map(|folder| normalize_resource_folder_path(Some(folder)))
        .transpose()?;

    let database_records = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, type, content, source_app, created_at, user_api_key,
                        group_name, attachments, storage_mode, resource_path,
                        COALESCE(sort_order, 0), COALESCE(resource_note, ''),
                        COALESCE(use_count, 0), COALESCE(touched_ms, 0),
                        COALESCE(last_used_at, ''), COALESCE(resource_external, 0)
                 FROM clipboard_records
                 WHERE COALESCE(storage_mode, 'database') = 'resource'",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let id = row.get::<_, String>(0)?;
                let record_type = row.get::<_, String>(1)?;
                let content = row.get::<_, String>(2)?;
                let source_app = row.get::<_, String>(3)?;
                let created_at = row.get::<_, String>(4)?;
                let user_api_key = row.get::<_, i64>(5)?;
                let group_name = row.get::<_, String>(6)?;
                let attachments = row.get::<_, String>(7)?;
                let storage_mode = row.get::<_, String>(8)?;
                let resource_path = row.get::<_, String>(9)?;
                let sort_order = row.get::<_, f64>(10)?;
                let resource_note = row.get::<_, String>(11)?;
                let use_count = row.get::<_, i64>(12)?;
                let touched_ms = row.get::<_, i64>(13)?;
                let last_used_at = row.get::<_, String>(14)?;
                let resource_external = row.get::<_, i64>(15)?;

                let path = if resource_path.is_empty() {
                    None
                } else {
                    Some(PathBuf::from(&resource_path))
                };
                let relative_path = path
                    .as_ref()
                    .and_then(|path| path.strip_prefix(&resource_root).ok())
                    .map(|relative| relative.to_string_lossy().to_string());
                let folder = path.as_ref().and_then(|path| {
                    resource_folder_for_path(&resource_root, path.to_string_lossy().as_ref())
                });
                Ok(ResourceRow {
                    id,
                    record_type,
                    content,
                    source_app,
                    created_at,
                    user_api_key,
                    group_name,
                    attachments,
                    storage_mode,
                    resource_path,
                    path,
                    relative_path,
                    folder,
                    sort_order,
                    resource_note,
                    use_count,
                    touched_ms,
                    last_used_at,
                    resource_external,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };

    let query = search
        .as_deref()
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .map(str::to_lowercase);
    let mut matches: Vec<ResourceRow> = database_records
        .into_iter()
        .filter(|record| {
            let matches_folder = normalized_folder.as_deref().map_or(true, |folder| {
                let record_folder = record.folder.as_deref();
                if folder.is_empty() {
                    record_folder == Some("")
                } else {
                    record_folder.is_some_and(|current| {
                        current == folder
                            || current
                                .strip_prefix(folder)
                                .is_some_and(|rest| rest.starts_with('/'))
                    })
                }
            });
            if !matches_folder {
                return false;
            }
            query.as_deref().map_or(true, |query| {
                [
                    record.content.as_str(),
                    record.resource_path.as_str(),
                    record.relative_path.as_deref().unwrap_or_default(),
                    record.resource_note.as_str(),
                ]
                .iter()
                .any(|value| value.to_lowercase().contains(query))
            })
        })
        .collect();

    // 排序键与 clipboard_order_clause 同语义。
    let effective_ms = |record: &ResourceRow| (record.touched_ms as f64).max(record.sort_order);
    matches.sort_by(|left, right| {
        let ordering = match sort_by.as_deref() {
            Some("count") => (left.use_count == 0)
                .cmp(&(right.use_count == 0))
                .then_with(|| right.use_count.cmp(&left.use_count))
                .then_with(|| effective_ms(right).total_cmp(&effective_ms(left))),
            Some("recent") => effective_ms(right).total_cmp(&effective_ms(left)),
            _ => right
                .sort_order
                .partial_cmp(&left.sort_order)
                .unwrap_or(std::cmp::Ordering::Equal),
        };
        ordering.then_with(|| left.id.cmp(&right.id))
    });

    let offset = offset.unwrap_or(0) as usize;
    let limit = limit.unwrap_or(200) as usize;

    // 幽灵清退已移出查询路径：启动对账（sync_resource_library）与监听
    // 删除事件（forget_resource_records）负责「文件不在，记录不留」。
    Ok(matches
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|record| {
            // managed 语义：应用内保存的记录 true；对账/监听发现的外部
            // 文件 false（文本详情保存直接写路径）。
            let managed = record.resource_external == 0;
            let media_kind = if record.record_type == "image" {
                "image"
            } else if record.record_type == "file" {
                record
                    .path
                    .as_deref()
                    .map(resource_media_kind_for_path)
                    .unwrap_or("file")
            } else {
                "text"
            };
            let value = clipboard_record_json(
                record.id,
                record.record_type,
                record.content,
                record.source_app,
                record.created_at,
                record.user_api_key,
                record.group_name,
                record.attachments,
                record.storage_mode,
                record.resource_path,
                record.use_count,
                record.last_used_at,
            );
            let mut value = resource_record_value(
                value,
                &resource_root,
                record.path.as_deref(),
                media_kind,
                managed,
            );
            value["resource_note"] = serde_json::Value::String(record.resource_note);
            value
        })
        .collect())
}

fn get_clipboard_records_inner<R: Runtime>(
    app: &AppHandle<R>,
    search: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    category: Option<String>,
    resource_group: Option<String>,
    sort_by: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    if category.as_deref() == Some("resources") {
        return get_resource_records_inner(app, search, limit, offset, resource_group, sort_by);
    }

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
            "SELECT id, type, content, source_app, created_at, user_api_key, group_name, attachments, storage_mode, resource_path, COALESCE(use_count, 0), COALESCE(last_used_at, '') FROM clipboard_records
             WHERE content LIKE '%' || ?1 || '%' ESCAPE '\\' {} ORDER BY {} LIMIT ?2 OFFSET ?3",
            cat_filter.1,
            clipboard_order_clause(sort_by.as_deref())
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
                    row.get::<_, i64>(10)?,
                    row.get::<_, String>(11)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            records.push(row.map_err(|e| e.to_string())?);
        }
    } else {
        let sql = format!(
            "SELECT id, type, content, source_app, created_at, user_api_key, group_name, attachments, storage_mode, resource_path, COALESCE(use_count, 0), COALESCE(last_used_at, '') FROM clipboard_records
             {} ORDER BY {} LIMIT ?1 OFFSET ?2",
            cat_filter.0,
            clipboard_order_clause(sort_by.as_deref())
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
                    row.get::<_, i64>(10)?,
                    row.get::<_, String>(11)?,
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

    let records = enrich_api_key_records(&conn, records);

    Ok(records)
}

/// 为剪贴板记录补充 API Key 标注（is_api_key / key_preview / guessed_service / label），
/// 供剪贴板记录列表与「最近使用」聚合查询共用。
fn enrich_api_key_records(
    conn: &Connection,
    records: Vec<serde_json::Value>,
) -> Vec<serde_json::Value> {
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

    records
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
        .collect()
}

// ── 使用记录 ─────────────────────────────────────────────────
// 粘贴/拖出成功时写入 last_used_at（touch_*_usage），
// 供快捷输入「全部」视图按最近使用排序展示。

// ── 快捷输入「全部」视图 ─────────────────────────────────────
// 跨分组聚合短语：排序依据是粘贴成功写入的 last_used_at（touch_phrase_usage）。

/// 「全部」视图的单行映射：短语字段 + 分组名（供来源标签展示）。
fn phrase_row_with_group(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "group_id": row.get::<_, String>(1)?,
        "title": row.get::<_, String>(2)?,
        "content": row.get::<_, String>(3)?,
        "input_type": row.get::<_, String>(4)?,
        "source_path": row.get::<_, String>(5)?,
        "file_size": row.get::<_, i64>(6)?,
        "sort_order": row.get::<_, f64>(7)?,
        "created_at": row.get::<_, String>(8)?,
        "updated_at": row.get::<_, String>(9)?,
        "last_used_at": row.get::<_, String>(10)?,
        "group_name": row.get::<_, Option<String>>(11)?,
        "use_count": row.get::<_, i64>(12)?,
    }))
}

/// 「全部」视图排序子句：recent=最近使用（未使用按分组 + 手动顺序垫底）；
/// count=最多使用（次数倒序、并列按最近使用，未使用垫底规则相同）。
/// 时间比较统一走 last_used_ms 生成列（毫秒整数），不受 RFC3339 变精度
/// 字符串比较的同秒误判影响。
fn phrases_all_order_clause(sort_by: Option<&str>) -> &'static str {
    match sort_by {
        Some("count") => "(COALESCE(p.use_count, 0) = 0) ASC, p.use_count DESC, p.last_used_ms DESC,
                COALESCE(g.sort_order, 0) DESC, p.sort_order DESC",
        _ => "(COALESCE(p.last_used_ms, 0) = 0) ASC,
                      p.last_used_ms DESC,
                      COALESCE(g.sort_order, 0) DESC,
                      p.sort_order DESC",
    }
}

/// 查询全部短语：有使用记录的按最近使用（last_used_ms）倒序在前，未使用的按
/// 「分组顺序 + 组内手动顺序」垫底（分组、手动均为 sort_order 越大越靠前）。
/// limit 传 i64::MAX 表示全量。
fn all_phrase_rows(
    conn: &Connection,
    limit: i64,
    sort_by: Option<&str>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT p.id, p.group_id, p.title, p.content, p.input_type, p.source_path,
                    p.file_size, p.sort_order, p.created_at, p.updated_at, p.last_used_at, g.name,
                    COALESCE(p.use_count, 0)
             FROM phrases p
             LEFT JOIN phrase_groups g ON p.group_id = g.id
             ORDER BY {} LIMIT ?1",
            phrases_all_order_clause(sort_by)
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit], phrase_row_with_group)
        .map_err(|e| e.to_string())?;
    let mut phrases = Vec::new();
    for row in rows {
        phrases.push(row.map_err(|e| e.to_string())?);
    }
    Ok(phrases)
}

/// 快捷输入「全部」视图：聚合全部分组的短语，径向菜单与主窗口共用。
/// limit 仅径向菜单使用（首屏条数）；主窗口不传即全量加载。
#[tauri::command]
pub fn get_all_phrases<R: Runtime>(
    app: AppHandle<R>,
    limit: Option<u32>,
    sort_by: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let lim = limit.map_or(i64::MAX, |n| n.clamp(1, 2000) as i64);
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    all_phrase_rows(&conn, lim, sort_by.as_deref())
}

/// 记录剪贴板/资源记录的使用时间：粘贴成功与拖出成功放下共用。
/// 自动发现（未入库）的资源记录不在数据库中，直接 UPDATE 会静默丢失；
/// 对 `resource-file:` 虚拟 id 在持锁前先解析文件路径，未命中时按文件
/// 路径查找既有记录（避免按 id 补建造成同一文件出现两行），找到则更新
/// 其使用时间，确实没有记录才补建入库（与备注、移动功能同一机制）。
pub(crate) fn touch_clipboard_usage_internal<R: Runtime>(
    app: &AppHandle<R>,
    ids: &[String],
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut discovered: HashMap<&str, PathBuf> = HashMap::new();
    for id in ids {
        if !id.starts_with(RESOURCE_FILE_ID_PREFIX) {
            continue;
        }
        if let Ok(Some(path)) = resource_file_path_from_id(app, id) {
            discovered.insert(id.as_str(), path);
        }
    }
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut touched = false;
    for id in ids {
        if discovered.contains_key(id.as_str()) {
            // 未入库资源（resource-file: 虚拟 id）由下方按路径去重处理，
            // 这里跳过以免既有记录被重复计数。
            continue;
        }
        let changed = conn.execute(
            "UPDATE clipboard_records SET last_used_at = ?1, use_count = COALESCE(use_count, 0) + 1,
                    touched_ms = ?2 WHERE id = ?3",
            params![&now, now_ms, id],
        )
        .map_err(|e| e.to_string())?;
        touched |= changed > 0;
    }
    if discovered.is_empty() {
        emit_usage_updated(app, ids, touched);
        return Ok(());
    }
    // 库中全部资源记录的路径键 → 记录 id，用于按文件路径去重。
    let mut by_path: HashMap<PathBuf, String> = HashMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT id, resource_path FROM clipboard_records
             WHERE COALESCE(storage_mode, 'database') = 'resource'
               AND COALESCE(resource_path, '') <> ''",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, resource_path) = row.map_err(|e| e.to_string())?;
        by_path.insert(resource_path_key(Path::new(&resource_path)), id);
    }
    drop(stmt);
    for (id, path) in &discovered {
        let key = resource_path_key(path);
        let changed = if let Some(existing_id) = by_path.get(&key) {
            conn.execute(
                "UPDATE clipboard_records SET last_used_at = ?1, use_count = COALESCE(use_count, 0) + 1,
                        touched_ms = ?2 WHERE id = ?3",
                params![&now, now_ms, existing_id],
            )
            .map_err(|e| e.to_string())?
        } else {
            let path_text = path.to_string_lossy();
            conn.execute(
                "INSERT INTO clipboard_records
                 (id, type, content, source_app, created_at, storage_mode, resource_path,
                  last_used_at, use_count, touched_ms)
                 VALUES (?1, 'file', ?2, '', ?3, 'resource', ?2, ?3, 1, ?4)",
                params![id, path_text, &now, now_ms],
            )
            .map_err(|e| e.to_string())?
        };
        touched |= changed > 0;
    }
    emit_usage_updated(app, ids, touched);
    Ok(())
}

/// 使用变化（次数 / 最近使用时间）只写库不发前端可见的返回值：统一在此
/// 发 `clipboard-record-updated`，让主窗口与径向菜单重载列表，徽标与
/// 「最近使用」排序实时更新。无实际变更（如 id 均未命中记录）不发，
/// 避免无谓刷新。
fn emit_usage_updated<R: Runtime>(app: &AppHandle<R>, ids: &[String], touched: bool) {
    if touched {
        let _ = app.emit("clipboard-record-updated", ids);
    }
}

/// 记录短语的使用时间：粘贴成功与拖出成功放下共用。
pub(crate) fn touch_phrase_usage_internal<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE phrases SET last_used_at = ?1, use_count = COALESCE(use_count, 0) + 1 WHERE id = ?2",
        params![now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 记录资源分组整组使用的使用时间：整组拖出与整组粘贴同口径，
/// 分组（含子分组）下的全部资源记录一次计入「最近使用」。
/// 自动发现（未入库）的文件按文件路径去重后补建入库再计入，避免同一
/// 文件出现两行。需在持有数据库锁之前读取资源库根目录（内部会再次加锁
/// 读取设置）。
pub(crate) fn touch_resource_group_usage_internal<R: Runtime>(
    app: &AppHandle<R>,
    group: &str,
) -> Result<(), String> {
    let folder = normalize_resource_folder_path(Some(group))?;
    let root = get_resource_library_dir(app);
    let in_group = |record_folder: Option<String>| -> bool {
        let Some(record_folder) = record_folder else {
            return false;
        };
        if folder.is_empty() {
            record_folder.is_empty()
        } else {
            record_folder == folder
                || record_folder
                    .strip_prefix(folder.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
        }
    };
    // 分组内未入库的文件：库中无对应行，稍后补建再写使用时间。只扫目标
    // 分组子目录，不再全库递归——整组粘贴/拖出是高频操作，全库扫描是它
    // 最大的可避免开销。未分组语义即库根一级文件，非递归列出与旧的全库
    // 扫描后按空文件夹过滤等价。
    let mut discovered: Vec<(String, PathBuf)> = Vec::new();
    if folder.is_empty() {
        if let Ok(read_dir) = std::fs::read_dir(&root) {
            for entry in read_dir.flatten() {
                let path = entry.path();
                if !entry.file_type().is_ok_and(|file_type| file_type.is_file())
                    || is_ignored_resource_file(&path)
                {
                    continue;
                }
                discovered.push((resource_file_id(&path), path));
            }
        }
    } else {
        for entry in scan_resource_files_under(&root, &root.join(&folder)) {
            discovered.push((resource_file_id(&entry.path), entry.path.clone()));
        }
    }
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, resource_path FROM clipboard_records
             WHERE COALESCE(storage_mode, 'database') = 'resource'
               AND COALESCE(resource_path, '') <> ''",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut ids = Vec::new();
    let mut known_paths: HashSet<PathBuf> = HashSet::new();
    for row in rows {
        let (id, resource_path) = row.map_err(|e| e.to_string())?;
        known_paths.insert(resource_path_key(Path::new(&resource_path)));
        if in_group(resource_folder_for_path(&root, &resource_path)) {
            ids.push(id);
        }
    }
    drop(stmt);
    let now = chrono::Utc::now().to_rfc3339();
    let mut touched = false;
    for id in &ids {
        let changed = conn
            .execute(
                "UPDATE clipboard_records SET last_used_at = ?1 WHERE id = ?2",
                params![&now, id],
            )
            .map_err(|e| e.to_string())?;
        touched |= changed > 0;
    }
    for (id, path) in &discovered {
        // 路径已有记录（不同 id）的文件不再补建，其记录已在上面按分组更新。
        if known_paths.contains(&resource_path_key(path)) {
            continue;
        }
        let path_text = path.to_string_lossy();
        let changed = conn
            .execute(
                "INSERT INTO clipboard_records
                 (id, type, content, source_app, created_at, storage_mode, resource_path, last_used_at)
                 VALUES (?1, 'file', ?2, '', ?3, 'resource', ?2, ?3)",
                params![id, path_text, &now],
            )
            .map_err(|e| e.to_string())?;
        touched |= changed > 0;
    }
    emit_usage_updated(app, &ids, touched);
    Ok(())
}

/// 粘贴成功后记录剪贴板/资源记录的使用时间（整组粘贴一次记全部记录）。
#[tauri::command]
pub fn touch_clipboard_usage(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    touch_clipboard_usage_internal(&app, &ids)
}

/// 粘贴成功后记录短语的使用时间。
#[tauri::command]
pub fn touch_phrase_usage(app: AppHandle, id: String) -> Result<(), String> {
    touch_phrase_usage_internal(&app, &id)
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

fn delete_external_resource_file<R: Runtime>(
    _app: &AppHandle<R>,
    path: &Path,
) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|error| format!("删除资源文件失败: {error}"))
}

struct StagedExternalResourceFile {
    id: String,
    original_path: PathBuf,
    staged_path: PathBuf,
}

fn stage_external_resource_files<R: Runtime>(
    app: &AppHandle<R>,
    ids: &[String],
) -> Result<Vec<StagedExternalResourceFile>, String> {
    let mut staged = Vec::new();
    for id in ids {
        // 解析失败最常见的原因正是文件已被外部删除（canonicalize 对不存在的
        // 路径必然报错）：视同文件已不在，跳过暂存并继续清理记录，避免整个
        // 删除命令失败。
        let original_path = match resource_file_path_from_id(app, id) {
            Ok(Some(path)) => path,
            Ok(None) => continue,
            Err(error) => {
                log::info!("资源文件解析失败，按已删除处理并继续清理记录: {error}");
                continue;
            }
        };
        if !original_path.exists() {
            continue;
        }
        let parent = original_path
            .parent()
            .ok_or_else(|| "资源文件路径无效".to_string())?;
        let staged_path = parent.join(format!(".copy-creator-delete-{}.tmp", uuid::Uuid::new_v4()));
        if let Err(error) = std::fs::rename(&original_path, &staged_path) {
            restore_staged_external_resource_files(&staged);
            return Err(format!("准备删除资源文件失败: {error}"));
        }
        staged.push(StagedExternalResourceFile {
            id: id.clone(),
            original_path,
            staged_path,
        });
    }
    Ok(staged)
}

fn restore_staged_external_resource_files(staged: &[StagedExternalResourceFile]) {
    for file in staged.iter().rev() {
        if file.staged_path.exists() {
            let _ = std::fs::rename(&file.staged_path, &file.original_path);
        }
    }
}

fn finalize_staged_external_resource_files<R: Runtime>(
    app: &AppHandle<R>,
    staged: &[StagedExternalResourceFile],
) -> Result<(), String> {
    let mut first_error = None;
    for file in staged {
        if let Err(error) = delete_external_resource_file(app, &file.staged_path) {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn delete_clipboard_records_internal<R: Runtime>(
    app: &AppHandle<R>,
    ids: &[String],
) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }

    let staged_external_files = stage_external_resource_files(app, ids)?;
    let mut deleted_ids = Vec::new();
    let mut image_contents = HashSet::new();
    let mut resource_files: Vec<(String, String, Vec<String>)> = Vec::new();

    let transaction_result = (|| -> Result<(), String> {
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
        Ok(())
    })();
    if let Err(error) = transaction_result {
        restore_staged_external_resource_files(&staged_external_files);
        return Err(error);
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
    if let Err(error) = finalize_staged_external_resource_files(app, &staged_external_files) {
        log::warn!("资源文件临时清理失败，已保留隐藏临时文件: {error}");
    }
    for file in staged_external_files {
        deleted_ids.push(file.id);
    }

    for id in deleted_ids {
        let _ = app.emit("clipboard-deleted", &id);
    }
    if had_resources || ids.iter().any(|id| id.starts_with(RESOURCE_FILE_ID_PREFIX)) {
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
    // 安全边界：只读应用管理目录内的图片，拒绝越界绝对路径。
    if !is_app_managed_path(&app, &image_path) {
        return Err("图片路径越界".to_string());
    }
    let bytes = std::fs::read(&image_path).map_err(|e| format!("read image file: {}", e))?;

    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub async fn get_image_thumbnail(
    app: AppHandle,
    path: String,
    max_size: u32,
) -> Result<String, String> {
    // 图片解码是重 CPU 操作，必须离开主线程：同步命令在主线程执行，
    // 大图串行解码会直接冻结 UI（切换资源区卡顿的主因之一）。
    tokio::task::spawn_blocking(move || get_image_thumbnail_blocking(app, path, max_size))
        .await
        .map_err(|e| format!("thumbnail task join: {e}"))?
}

fn get_image_thumbnail_blocking(
    app: AppHandle,
    path: String,
    max_size: u32,
) -> Result<String, String> {
    let image_path = resolve_storage_path(&app, &path)?;
    // 安全边界：同 get_image_base64，拒绝应用管理目录之外的绝对路径。
    if !is_app_managed_path(&app, &image_path) {
        return Err("图片路径越界".to_string());
    }
    let base_dir = image_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| get_storage_dir(&app));

    // 应用存储图沿用剪贴板捕获时写在原图旁 thumbs/ 的预生成缩略图；
    // 外部绝对路径（资源库等用户目录）不得写入派生文件——thumbs/ 曾被
    // 资源发现误收录为内容。缓存统一进应用缓存目录，键含路径与修改时间。
    let thumb_path = if Path::new(&path).is_absolute() {
        let metadata =
            std::fs::metadata(&image_path).map_err(|e| format!("stat image: {e}"))?;
        let modified_secs = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let key = format!(
            "{:016x}-{}-{}",
            fnv1a64(path.as_bytes()),
            metadata.len(),
            modified_secs
        );
        app.path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .join("external-image-thumbs")
            .join(format!("{key}.png"))
    } else {
        // Try pre-generated thumbnail first (saved during clipboard capture)
        let thumb_dir = image_path.parent().unwrap_or(&base_dir).join("thumbs");
        let filename = image_path.file_name().ok_or("invalid path")?;
        thumb_dir.join(filename)
    };

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
        if let Some(thumb_dir) = thumb_path.parent() {
            std::fs::create_dir_all(thumb_dir).ok();
        }
        let _ = std::fs::write(&thumb_path, &data);
        data
    };

    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&thumb_bytes))
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 视频海报缓存路径：与图片缩略图同策略（路径哈希 + 大小 + 修改时间），
/// 集中存放在应用缓存目录，永不写入用户库。
fn video_poster_cache_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("stat video: {e}"))?;
    let modified_secs = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let key = format!(
        "{:016x}-{}-{}",
        fnv1a64(path.as_bytes()),
        metadata.len(),
        modified_secs
    );
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("video-posters")
        .join(format!("{key}.jpg")))
}

/// 读取已持久化的视频海报（base64 JPEG）。未生成返回空串，调用方回退
/// 现场抽帧流程。
#[tauri::command]
pub async fn load_resource_video_poster(app: AppHandle, path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let cache_path = video_poster_cache_path(&app, &path)?;
        if !cache_path.exists() {
            return Ok(String::new());
        }
        let bytes = std::fs::read(cache_path).map_err(|e| format!("read poster: {e}"))?;
        use base64::Engine;
        Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
    })
    .await
    .map_err(|e| format!("poster task join: {e}"))?
}

/// 持久化前端抽帧得到的海报（data:image/jpeg;base64,...）。此后列表展示
/// 该视频只加载这张图，不再挂 <video> 加载元数据与寻帧。
#[tauri::command]
pub async fn save_resource_video_poster(
    app: AppHandle,
    path: String,
    data_url: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let base64_part = data_url
            .strip_prefix("data:image/jpeg;base64,")
            .ok_or("poster dataUrl 格式不符")?;
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64_part)
            .map_err(|e| format!("decode poster: {e}"))?;
        let cache_path = video_poster_cache_path(&app, &path)?;
        if let Some(dir) = cache_path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        std::fs::write(cache_path, &bytes).map_err(|e| format!("write poster: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("poster task join: {e}"))?
}

// 缓存条目超限后按修改时间裁剪最旧的一批，防止缩略图目录无限增长。
fn trim_resource_thumbnail_cache(cache_dir: &Path) {
    const MAX_ENTRIES: usize = 1000;
    const TRIM_TO: usize = 800;
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "png"))
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect();
    if files.len() <= MAX_ENTRIES {
        return;
    }
    files.sort_by_key(|(modified, _)| *modified);
    let excess = files.len() - TRIM_TO;
    for (_, path) in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
}

/// 为任意本地图片文件生成缩略图（base64 PNG）。与 `get_image_thumbnail`
/// 不同，本命令面向资源库里用户自选路径的图片文件：缓存集中存放在应用
/// 缓存目录，key 由"路径哈希 + 文件大小 + 修改时间"组成，文件被覆盖后
/// 自动失效。解码失败（svg/heic 等格式）交由前端回退原图。
/// 解码经 spawn_blocking 在线程池执行，不阻塞主线程（大库切换流畅的前提）。
#[tauri::command]
pub async fn get_resource_file_thumbnail(
    app: AppHandle,
    path: String,
    max_size: u32,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || get_resource_file_thumbnail_blocking(app, path, max_size))
        .await
        .map_err(|e| format!("thumbnail task join: {e}"))?
}

fn get_resource_file_thumbnail_blocking(
    app: AppHandle,
    path: String,
    max_size: u32,
) -> Result<String, String> {
    // 统一路径解析：绝对路径原样（资源库/外部文件），存储相对路径按存储目录
    // 展开（剪切板图片记录的 content 即此形态）。
    let image_path = resolve_storage_path(&app, &path)?;
    let metadata = std::fs::metadata(&image_path).map_err(|e| format!("stat image: {e}"))?;
    let modified_secs = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let key = format!(
        "{:016x}-{}-{}",
        fnv1a64(path.as_bytes()),
        metadata.len(),
        modified_secs
    );

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("resource-thumbs");
    let cache_path = cache_dir.join(format!("{key}.png"));

    let thumb_bytes = if let Ok(bytes) = std::fs::read(&cache_path) {
        bytes
    } else {
        let bytes = std::fs::read(&image_path).map_err(|e| format!("read image file: {e}"))?;
        let img = image::load_from_memory(&bytes).map_err(|e| format!("decode image: {e}"))?;
        let (w, h) = (img.width(), img.height());
        let thumb = if w > max_size || h > max_size {
            let scale = max_size as f32 / w.max(h) as f32;
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
            .map_err(|e| format!("encode thumbnail: {e}"))?;
        let data = buf.into_inner();
        std::fs::create_dir_all(&cache_dir).ok();
        let _ = std::fs::write(&cache_path, &data);
        trim_resource_thumbnail_cache(&cache_dir);
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

    // 旧存储目录在切换前解析（此刻 settings 仍指向旧位置）。
    let old_storage_dir = get_storage_dir(app);

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

    // 完整迁移：业务数据逐表复制 + 附件目录搬迁 + 行数校验，全部成功后
    // 才在下方切换连接；中途失败时旧库不受影响，重试会先清掉半成品新库。
    let new_conn = migrate_storage_data(
        &old_storage_dir.join("data.db"),
        &old_storage_dir,
        &custom_dir,
    )?;

    // Copy settings to new DB（ensure_schema 已种子化默认设置，旧值
    // 必须以 REPLACE 覆盖种子，否则与种子键冲突报 UNIQUE 约束错误）
    {
        let mut stmt = new_conn
            .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)")
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

/// 迁移涉及的业务表（settings 由命令层单独复制：storage_path/shortcut_key
/// 有特殊处理）。表名为内部常量，不来自用户输入。
const MIGRATED_BUSINESS_TABLES: [&str; 6] = [
    "clipboard_records",
    "phrase_groups",
    "phrases",
    "translation_history",
    "api_key_labels",
    "toast_shown",
];

/// 存储迁移的数据搬运核心：在 new_dir 建新库（PRAGMA + ensure_schema 与
/// 主库同源），旧库逐表按"两库共同列"复制并校验行数一致，附件目录跟随
/// 搬迁；任一步失败即返回 Err，调用方不得切换连接。返回打开的新连接。
fn migrate_storage_data(
    old_db: &Path,
    old_storage_dir: &Path,
    new_dir: &Path,
) -> Result<Connection, String> {
    if !old_db.exists() {
        return Err(format!("旧数据库不存在: {}", old_db.display()));
    }
    let new_db = new_dir.join("data.db");
    // 上次迁移失败可能残留半成品库：重建前清掉，保证重试幂等。
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(PathBuf::from(format!("{}{}", new_db.display(), suffix)));
    }
    std::fs::create_dir_all(new_dir).map_err(|e| format!("create dir: {}", e))?;

    let new_conn = Connection::open(&new_db).map_err(|e| format!("open new db: {}", e))?;
    new_conn
        .execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8000; PRAGMA foreign_keys=ON;",
        )
        .map_err(|e| format!("set pragmas: {}", e))?;
    ensure_schema(&new_conn).map_err(|e| format!("create schema: {}", e))?;

    // 旧库以别名接入后逐表复制。复制期间临时关闭新连接的外键：旧库若存
    // 在历史孤儿行（外键约束启用前的遗留），严格校验会让整个迁移失败；
    // 数据保真优先，孤儿行原样保留进新库。
    new_conn
        .execute("PRAGMA foreign_keys=OFF", [])
        .map_err(|e| format!("toggle foreign_keys: {}", e))?;
    new_conn
        .execute(
            "ATTACH DATABASE ?1 AS migrate_src",
            params![old_db.to_string_lossy()],
        )
        .map_err(|e| format!("attach old db: {}", e))?;
    for table in MIGRATED_BUSINESS_TABLES {
        let copied = copy_table_across_databases(&new_conn, table)?;
        let old_count: i64 = new_conn
            .query_row(
                &format!("SELECT COUNT(*) FROM migrate_src.{table}"),
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("count {table}: {}", e))?;
        let new_count: i64 = new_conn
            .query_row(
                &format!("SELECT COUNT(*) FROM main.{table}"),
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("count {table}: {}", e))?;
        if old_count != new_count {
            return Err(format!(
                "迁移校验失败：{table} 旧库 {old_count} 行，新库 {new_count} 行"
            ));
        }
        log::info!("migrate_storage: {table} 复制 {copied} 行");
    }
    new_conn
        .execute("DETACH DATABASE migrate_src", [])
        .map_err(|e| format!("detach old db: {}", e))?;
    // 复制完成，恢复外键约束（与主库同配置）。
    new_conn
        .execute("PRAGMA foreign_keys=ON", [])
        .map_err(|e| format!("restore foreign_keys: {}", e))?;

    // 附件（images/thumbs）与快捷输入文件跟随搬迁；数据库文件由 ATTACH
    // 直接读取、settings 在命令层复制，均不在搬迁范围。旧目录保留作备份。
    copy_storage_dir_tree(old_storage_dir, new_dir)?;

    Ok(new_conn)
}

/// 把 migrate_src 里的同名表复制到 main，返回复制的行数。按两库共同列
/// 交集复制：历史 ALTER 演进可能让两库列序不同，`SELECT *` 不可靠。
fn copy_table_across_databases(conn: &Connection, table: &str) -> Result<usize, String> {
    let columns_of = |database: &str| -> Result<Vec<String>, String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA {database}.table_info({table})"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    };
    let new_columns = columns_of("main")?;
    let old_columns = columns_of("migrate_src")?;
    let shared: Vec<String> = new_columns
        .into_iter()
        .filter(|column| old_columns.contains(column))
        .collect();
    if shared.is_empty() {
        return Err(format!("迁移失败：{table} 两库没有共同列"));
    }
    let column_list = shared
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute(
        &format!(
            "INSERT INTO main.{table} ({column_list}) SELECT {column_list} FROM migrate_src.{table}"
        ),
        [],
    )
    .map_err(|e| format!("复制 {table} 失败: {}", e))
}

/// 递归搬迁目录内容到目标目录（data.db/-wal/-shm 除外，同名文件覆盖）。
fn copy_storage_dir_tree(src: &Path, dest: &Path) -> Result<(), String> {
    for entry in
        std::fs::read_dir(src).map_err(|e| format!("read dir {}: {}", src.display(), e))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if matches!(
            name.to_str(),
            Some("data.db") | Some("data.db-wal") | Some("data.db-shm")
        ) {
            continue;
        }
        let target = dest.join(&name);
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|e| format!("create dir {}: {}", target.display(), e))?;
            copy_storage_dir_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &target)
                .map_err(|e| format!("复制 {}: {}", entry.path().display(), e))?;
        }
    }
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
    let path = simplify_windows_path(
        &std::fs::canonicalize(&path).map_err(|error| format!("读取资源库目录失败: {error}"))?,
    );
    if !path.is_dir() {
        return Err("资源库路径不是目录".to_string());
    }

    let storage_path = simplify_windows_path(
        &std::fs::canonicalize(get_storage_dir(app)).unwrap_or_else(|_| get_storage_dir(app)),
    );
    if paths_overlap(&path, &storage_path) {
        return Err("资源库目录不能与应用存储目录重叠".to_string());
    }
    Ok(path)
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    left == right || left.starts_with(right) || right.starts_with(left)
}

#[tauri::command]
pub async fn set_resource_library_path(
    app: AppHandle,
    path: String,
) -> Result<String, String> {
    // 切库后的全量对账含整库扫描，必须离开主线程（大库会冻结 UI 数秒）。
    tokio::task::spawn_blocking(move || set_resource_library_path_blocking(app, path))
        .await
        .map_err(|e| format!("library path task join: {e}"))?
}

fn set_resource_library_path_blocking(app: AppHandle, path: String) -> Result<String, String> {
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
    // 库路径切换后立即对新库全量对账：这是用户主动的低频操作，同步执行
    // 换取切换完成即是完整索引（查询路径已不做扫描，缺这步新库不显示）。
    sync_resource_library(&app);
    let _ = app.emit("resource-library-path-changed", &path_string);
    Ok(path_string)
}

fn resource_record_paths_in_folder<R: Runtime>(
    app: &AppHandle<R>,
    folder: &str,
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
    let nested_prefix = format!("{folder}/");
    let mut records = Vec::new();
    for row in rows {
        let (id, path) = row.map_err(|e| e.to_string())?;
        let matches_folder = match resource_folder_for_path(&root, &path) {
            Some(record_folder) => {
                record_folder == folder || record_folder.starts_with(&nested_prefix)
            }
            None => folder.is_empty(),
        };
        if matches_folder {
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
    let mut counts = HashMap::new();
    let database_paths = {
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
        let mut paths = HashSet::new();
        for row in rows {
            let path = row.map_err(|e| e.to_string())?;
            if let Some(folder) = resource_folder_for_path(&root, &path) {
                *counts.entry(folder).or_insert(0) += 1;
            }
            if !path.is_empty() {
                paths.insert(resource_path_key(Path::new(&path)));
            }
        }
        paths
    };
    for entry in scan_resource_files(&root) {
        if database_paths.contains(&resource_path_key(&entry.path)) {
            continue;
        }
        let folder = resource_folder_for_path(&root, entry.path.to_string_lossy().as_ref())
            .unwrap_or_default();
        *counts.entry(folder).or_insert(0) += 1;
    }
    Ok(counts)
}

/// 汇总某分组目录（含全部子级）的记录数，用于分组树的总量展示。
fn resource_group_total_under(counts: &HashMap<String, u64>, folder: &str) -> u64 {
    let nested_prefix = format!("{folder}/");
    counts
        .iter()
        .filter(|(key, _)| key.as_str() == folder || key.starts_with(&nested_prefix))
        .map(|(_, value)| value)
        .sum()
}

fn is_ignored_resource_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name == ".copy-creator" || name.starts_with('.'))
}

fn resource_directory_relative_path(root: &Path, directory: &Path) -> Option<String> {
    let relative = directory.strip_prefix(root).ok()?;
    let path = relative
        .components()
        .map(|component| match component {
            Component::Normal(name) => name.to_str().map(str::to_string),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?
        .join("/");
    normalize_resource_folder_path(Some(&path)).ok()
}

fn resource_folder_tree(
    root: &Path,
    directory: &Path,
    counts: &HashMap<String, u64>,
    order: &HashMap<String, usize>,
) -> Option<serde_json::Value> {
    let name = directory.file_name()?.to_str()?.to_string();
    let path = resource_directory_relative_path(root, directory)?;
    let count = resource_group_total_under(counts, &path);
    let mut child_directories = std::fs::read_dir(directory)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_dir() || is_ignored_resource_directory(&entry.path()) {
                return None;
            }
            Some(entry.path())
        })
        .collect::<Vec<_>>();
    sort_resource_directories(root, &mut child_directories, order);
    let children = child_directories
        .into_iter()
        .filter_map(|child| resource_folder_tree(root, &child, counts, order))
        .collect::<Vec<_>>();

    Some(serde_json::json!({
        "name": name,
        "path": path,
        "count": count,
        "children": children,
    }))
}

/// 用户手动拖拽的分组顺序存于 settings（扁平的全路径列表，按位置即次序）。
/// 未登记的分组排在其同级已登记分组之后，再按名称兜底排序，保证新增分组可见。
const RESOURCE_GROUP_ORDER_KEY: &str = "resource_group_order";

fn read_resource_group_order(conn: &Connection) -> Vec<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![RESOURCE_GROUP_ORDER_KEY],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
    .unwrap_or_default()
}

fn write_resource_group_order(conn: &Connection, order: &[String]) -> Result<(), String> {
    let value = serde_json::to_string(order).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![RESOURCE_GROUP_ORDER_KEY, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn sort_resource_directories(
    root: &Path,
    directories: &mut [PathBuf],
    order: &HashMap<String, usize>,
) {
    directories.sort_by_key(|path| {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let relative = resource_directory_relative_path(root, path).unwrap_or_default();
        (order.get(&relative).copied().unwrap_or(usize::MAX), name)
    });
}

/// 按调用方提供的变换维护顺序表；失败不阻断主流程（顺序退化为字母序，无功能影响）。
fn rewrite_resource_group_order<R: Runtime>(
    app: &AppHandle<R>,
    rewrite: impl FnOnce(&mut Vec<String>),
) {
    let result = (|| -> Result<(), String> {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let mut order = read_resource_group_order(&conn);
        rewrite(&mut order);
        write_resource_group_order(&conn, &order)
    })();
    if let Err(error) = result {
        log::warn!("维护资源分组顺序失败: {error}");
    }
}

/// 分组改名/移动后同步替换顺序表中的路径（含全部子孙路径前缀）。
fn rewrite_group_order_prefix(order: &mut [String], old_prefix: &str, new_prefix: &str) {
    let nested_prefix = format!("{old_prefix}/");
    for path in order.iter_mut() {
        if path.as_str() == old_prefix {
            *path = new_prefix.to_string();
        } else if let Some(rest) = path.strip_prefix(&nested_prefix) {
            *path = format!("{new_prefix}/{rest}");
        }
    }
}

fn remove_group_order_prefix(order: &mut Vec<String>, prefix: &str) {
    let nested_prefix = format!("{prefix}/");
    order.retain(|path| path.as_str() != prefix && !path.starts_with(&nested_prefix));
}

#[tauri::command]
pub fn reorder_resource_groups(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    reorder_resource_groups_inner(&app, ids)
}

fn reorder_resource_groups_inner<R: Runtime>(
    app: &AppHandle<R>,
    ids: Vec<String>,
) -> Result<(), String> {
    let mut order = Vec::with_capacity(ids.len());
    for id in ids {
        let normalized = normalize_resource_folder_path(Some(&id))?;
        if !normalized.is_empty() && !order.contains(&normalized) {
            order.push(normalized);
        }
    }
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        write_resource_group_order(&conn, &order)?;
    }
    let _ = app.emit("resource-groups-changed", ());
    Ok(())
}

#[tauri::command]
pub fn get_resource_groups(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    get_resource_groups_inner(&app)
}

fn get_resource_groups_inner<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<serde_json::Value>, String> {
    let root = get_resource_library_dir(app);
    let counts = resource_group_count_map(app)?;
    let order: HashMap<String, usize> = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        read_resource_group_order(&conn)
    }
    .into_iter()
    .enumerate()
    .map(|(index, path)| (path, index))
    .collect();
    let mut directories = std::fs::read_dir(&root)
        .map_err(|e| format!("读取资源分组失败: {e}"))?
        .flatten()
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_dir() || is_ignored_resource_directory(&entry.path()) {
                return None;
            }
            normalize_resource_group_name(entry.file_name().to_str()).ok()?;
            Some(entry.path())
        })
        .collect::<Vec<_>>();
    sort_resource_directories(&root, &mut directories, &order);

    let mut groups = vec![serde_json::json!({
        "name": "",
        "path": "",
        "count": counts.get("").copied().unwrap_or(0),
        "children": [],
    })];
    for directory in directories {
        if let Some(group) = resource_folder_tree(&root, &directory, &counts, &order) {
            groups.push(group);
        }
    }
    Ok(groups)
}

#[tauri::command]
pub fn create_resource_group(app: AppHandle, name: String) -> Result<serde_json::Value, String> {
    create_resource_group_inner(&app, &name)
}

fn create_resource_group_inner<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
) -> Result<serde_json::Value, String> {
    // name 允许携带多级路径（如「工作资料/角色」），缺失的父级自动创建。
    let name = normalize_resource_folder_path(Some(name))?;
    if name.is_empty() {
        return Err("分组名称不能为空".to_string());
    }
    let path = resource_group_path(app, &name)?;
    if path.exists() {
        return Err("分组已存在".to_string());
    }
    std::fs::create_dir_all(&path).map_err(|e| format!("创建资源分组失败: {e}"))?;
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
    // old_name/new_name 为完整分组路径（如「工作资料/角色」），支持重命名任意层级的分组。
    let old_name = normalize_resource_folder_path(Some(&old_name))?;
    let new_name = normalize_resource_folder_path(Some(&new_name))?;
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
    let records = resource_record_paths_in_folder(app, &old_name)?;
    let new_group = new_name.split('/').next().unwrap_or_default().to_string();
    let new_records = records
        .iter()
        .filter_map(|(id, path)| {
            let relative_path = Path::new(path).strip_prefix(&old_path).ok()?;
            Some((
                id.clone(),
                new_path.join(relative_path).to_string_lossy().to_string(),
            ))
        })
        .collect::<Vec<_>>();

    std::fs::rename(&old_path, &new_path).map_err(|e| format!("重命名资源分组失败: {e}"))?;
    if let Err(error) = update_resource_record_paths(app, &new_records, &new_group) {
        let _ = std::fs::rename(&new_path, &old_path);
        return Err(format!("更新资源路径失败: {error}"));
    }
    rewrite_resource_group_order(app, |order| {
        rewrite_group_order_prefix(order, &old_name, &new_name)
    });
    let _ = app.emit("resource-groups-changed", ());
    Ok(())
}

fn rollback_moved_resource_files(moved: &[(PathBuf, PathBuf, Option<String>)]) {
    for (from, to, original_content) in moved.iter().rev() {
        if let Some(content) = original_content {
            let _ = std::fs::write(to, content);
        }
        if let Some(parent) = from.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::rename(to, from);
    }
}

fn rewrite_moved_resource_markdown_links(content: &str, from: &Path, group_path: &Path) -> String {
    let Ok(relative_path) = from.strip_prefix(group_path) else {
        return content.to_string();
    };
    let nested_directory_depth = relative_path
        .parent()
        .map(|parent| parent.components().count())
        .unwrap_or(0);
    let old_prefix = format!("{}.copy-creator/", "../".repeat(nested_directory_depth + 1));
    let new_prefix = format!("{}.copy-creator/", "../".repeat(nested_directory_depth));
    content.replace(&old_prefix, &new_prefix)
}

/// 按文件所在目录相对资源库根的层级变化，重写 markdown 内指向 `.copy-creator/`
/// 附件目录的相对链接（层级不变时原样返回）。单个文件内的附件链接层级与其
/// 所在目录一致，因此整文件按前后缀替换是安全的。
pub(crate) fn rewrite_resource_markdown_links_for_depth(
    content: &str,
    old_depth: usize,
    new_depth: usize,
) -> String {
    if old_depth == new_depth {
        return content.to_string();
    }
    let old_prefix = format!("{}{}", "../".repeat(old_depth), ".copy-creator/");
    let new_prefix = format!("{}{}", "../".repeat(new_depth), ".copy-creator/");
    content.replace(&old_prefix, &new_prefix)
}

#[tauri::command]
pub fn delete_resource_group(app: AppHandle, name: String) -> Result<(), String> {
    delete_resource_group_inner(&app, name)
}

fn delete_resource_group_inner<R: Runtime>(app: &AppHandle<R>, name: String) -> Result<(), String> {
    // name 为完整分组路径，支持删除任意层级；其中内容会保留并移动到未分组。
    let name = normalize_resource_folder_path(Some(&name))?;
    if name.is_empty() {
        return Err("未分组不能删除".to_string());
    }
    let root = get_resource_library_dir(app);
    let group_path = resource_group_path(app, &name)?;
    if !group_path.is_dir() {
        return Err("资源分组不存在".to_string());
    }

    fn collect_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
        let mut children = std::fs::read_dir(directory)
            .map_err(|e| format!("读取资源分组失败: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取资源分组失败: {e}"))?;
        children.sort_by_key(|entry| entry.file_name());
        for entry in children {
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|e| format!("读取资源分组失败: {e}"))?;
            if file_type.is_dir() {
                if entry.file_name() == OsStr::new(".copy-creator") {
                    continue;
                }
                collect_files(&path, files)?;
            } else if file_type.is_file() {
                files.push(path);
            }
        }
        Ok(())
    }

    let mut entries = Vec::new();
    collect_files(&group_path, &mut entries)?;
    entries.sort();

    for path in &entries {
        let relative_path = path
            .strip_prefix(&group_path)
            .map_err(|_| "资源文件路径无效".to_string())?;
        let destination = root.join(relative_path);
        if destination.exists() {
            return Err(format!(
                "资源库根目录已存在同名文件：{}",
                relative_path.to_string_lossy()
            ));
        }
    }

    let records = resource_record_paths_in_folder(app, &name)?;
    let new_records = records
        .iter()
        .filter_map(|(id, path)| {
            let relative_path = Path::new(path).strip_prefix(&group_path).ok()?;
            Some((
                id.clone(),
                root.join(relative_path).to_string_lossy().to_string(),
            ))
        })
        .collect::<Vec<_>>();
    let old_records = records.clone();
    let mut moved = Vec::new();
    for from in entries {
        let relative_path = match from.strip_prefix(&group_path) {
            Ok(path) => path,
            Err(_) => {
                rollback_moved_resource_files(&moved);
                return Err("资源文件路径无效".to_string());
            }
        };
        let to = root.join(relative_path);
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
        if let Some(parent) = to.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                rollback_moved_resource_files(&moved);
                return Err(format!("创建资源目录失败: {error}"));
            }
        }
        std::fs::rename(&from, &to).map_err(|e| {
            rollback_moved_resource_files(&moved);
            format!("迁移资源文件失败: {e}")
        })?;
        moved.push((from.clone(), to.clone(), original_content.clone()));
        if let Some(content) = original_content {
            let updated = rewrite_moved_resource_markdown_links(&content, &from, &group_path);
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
    if let Err(error) = std::fs::remove_dir_all(&group_path) {
        let _ = update_resource_record_paths(app, &old_records, &name);
        rollback_moved_resource_files(&moved);
        return Err(format!("删除资源分组失败: {error}"));
    }
    rewrite_resource_group_order(app, |order| remove_group_order_prefix(order, &name));
    let _ = app.emit("resource-groups-changed", ());
    Ok(())
}

const RESOURCE_RENAME_MAX_LEN: usize = 120;

/// 校验重命名输入并返回文件名主干（不含扩展名）。
/// 扩展名始终沿用原文件：用户输入带不带原扩展名都可以，但不允许借改名更换扩展名。
pub(crate) fn validate_resource_rename_stem(new_name: &str, old_path: &Path) -> Result<String, String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("文件名不能为空".to_string());
    }
    let trimmed_chars: Vec<char> = trimmed.chars().collect();
    let stem = match old_path.extension().and_then(OsStr::to_str) {
        Some(extension) => {
            let suffix: Vec<char> = format!(".{}", extension.to_lowercase()).chars().collect();
            let has_suffix = trimmed_chars.len() > suffix.len()
                && trimmed_chars[trimmed_chars.len() - suffix.len()..]
                    .iter()
                    .collect::<String>()
                    .to_lowercase()
                    == suffix.iter().collect::<String>();
            if has_suffix {
                trimmed_chars[..trimmed_chars.len() - suffix.len()]
                    .iter()
                    .collect::<String>()
            } else {
                trimmed.to_string()
            }
        }
        None => trimmed.to_string(),
    };
    let stem = stem.trim_end_matches(['.', ' ']).trim();
    if stem.is_empty() {
        return Err("文件名不能为空".to_string());
    }
    if stem.chars().count() > RESOURCE_RENAME_MAX_LEN {
        return Err(format!("文件名不能超过 {RESOURCE_RENAME_MAX_LEN} 字"));
    }
    if stem.starts_with('.') {
        return Err("文件名不能以点号开头".to_string());
    }
    // 同步沿用 Windows 的非法字符约束，避免资源库目录在双平台间同步时出错。
    if stem.contains(['/', '\\', '<', '>', ':', '"', '|', '?', '*']) {
        return Err("文件名包含非法字符".to_string());
    }
    const WINDOWS_RESERVED_STEMS: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if WINDOWS_RESERVED_STEMS
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
    {
        return Err("该文件名是系统保留名称".to_string());
    }
    Ok(stem.to_string())
}

#[tauri::command]
pub fn rename_resource_file(
    app: AppHandle,
    id: String,
    new_name: String,
) -> Result<serde_json::Value, String> {
    rename_resource_file_inner(&app, id, new_name)
}

fn rename_resource_file_inner<R: Runtime>(
    app: &AppHandle<R>,
    id: String,
    new_name: String,
) -> Result<serde_json::Value, String> {
    // 路径解析与数据库访问各自加连接锁，必须串行执行避免重入死锁（同 set_resource_note_inner）。
    let record = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT type, content, resource_path FROM clipboard_records WHERE id = ?1",
            params![&id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
    };
    // 图片/文件的标题即文件名；资源库文本记录（新建窗口写入的 .txt/.md）也有对应
    // 文件，同样可改名（只改文件名，正文不变）；无文件的纯文本标题来自正文，不支
    // 持重命名。自动发现的文件一律视为文件记录。
    let (old_path, content, db_backed) = match record {
        Some((record_type, content, resource_path)) => {
            if record_type != "image" && record_type != "file" && resource_path.is_empty() {
                return Err("文本内容的标题来自正文，不支持重命名".to_string());
            }
            if resource_path.is_empty() {
                return Err("该内容没有对应文件，无法重命名".to_string());
            }
            let path = resolve_resource_file_path(app, &resource_path)?;
            (path, content, true)
        }
        None => {
            let path = resource_file_path_from_id(app, &id)?.ok_or("资源不存在")?;
            // 自动发现记录（无数据库行）在前端内存中的 content 即完整路径，
            // 以完整路径为基准推导改名后的 content，返回给前端刷新内存记录。
            let content = path.to_string_lossy().to_string();
            (path, content, false)
        }
    };

    let stem = validate_resource_rename_stem(&new_name, &old_path)?;
    let new_file_name = match old_path.extension().and_then(OsStr::to_str) {
        Some(extension) => format!("{stem}.{extension}"),
        None => stem,
    };
    let parent = old_path.parent().ok_or("资源文件路径无效")?;
    let new_path = parent.join(&new_file_name);
    if new_path == old_path {
        return Ok(serde_json::json!({ "id": id }));
    }
    if new_path.exists() {
        return Err(format!("已存在同名文件：{new_file_name}"));
    }

    std::fs::rename(&old_path, &new_path).map_err(|e| format!("重命名文件失败: {e}"))?;

    let new_path_text = new_path.to_string_lossy().to_string();
    // 类型为 image/file 的记录标题与粘贴都依赖 content 中的文件路径，文件名变化时同步替换；
    // 自动发现记录（无数据库行）的 content 即完整路径，同样需要新值返回给前端刷新内存记录。
    let old_file_name = old_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let new_content = if !old_file_name.is_empty() {
        if content == old_file_name {
            new_file_name.clone()
        } else if let Some(prefix) = content
            .strip_suffix(&old_file_name)
            .filter(|prefix| prefix.ends_with('/') || prefix.ends_with('\\'))
        {
            format!("{prefix}{new_file_name}")
        } else {
            content.clone()
        }
    } else {
        content.clone()
    };
    if db_backed {
        let update_result = {
            let state = app.state::<DbState>();
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE clipboard_records SET content = ?1, resource_path = ?2 WHERE id = ?3",
                params![&new_content, &new_path_text, &id],
            )
            .map_err(|e| e.to_string())
        };
        if let Err(error) = update_result {
            let _ = std::fs::rename(&new_path, &old_path);
            return Err(format!("更新资源记录失败: {error}"));
        }
    }

    let root = resource_path_key(&get_resource_library_dir(app));
    let relative_path = new_path
        .strip_prefix(&root)
        .ok()
        .map(|relative| relative.to_string_lossy().to_string());
    let _ = app.emit("resource-groups-changed", ());
    // 自动发现记录的 id 由路径派生，改名后需返回新 id 供前端同步内存记录。
    let result_id = if db_backed {
        id
    } else {
        resource_file_id(&new_path)
    };
    Ok(serde_json::json!({
        "id": result_id,
        "resource_path": new_path_text,
        "resource_relative_path": relative_path,
        "content": new_content,
        "name": new_file_name,
    }))
}

#[tauri::command]
pub fn move_resource_records(
    app: AppHandle,
    ids: Vec<String>,
    target_folder: String,
) -> Result<Vec<serde_json::Value>, String> {
    move_resource_records_inner(&app, ids, target_folder)
}

fn move_resource_records_inner<R: Runtime>(
    app: &AppHandle<R>,
    ids: Vec<String>,
    target_folder: String,
) -> Result<Vec<serde_json::Value>, String> {
    let target_folder = normalize_resource_folder_path(Some(&target_folder))?;
    let target_group = target_folder.split('/').next().unwrap_or("").to_string();

    // 第一阶段：一次性读出待移动记录的存储路径（连接锁内不做文件 IO 与嵌套加锁）。
    let rows: Vec<(String, Option<String>)> = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let mut entries = Vec::with_capacity(ids.len());
        for id in &ids {
            let row = conn
                .query_row(
                    "SELECT resource_path FROM clipboard_records WHERE id = ?1",
                    params![id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            entries.push((id.clone(), row.filter(|path| !path.is_empty())));
        }
        entries
    };

    // 第二阶段：解析真实文件路径；数据库托管记录同时保留原存储路径文本供 content 比对。
    let mut entries: Vec<(String, PathBuf, bool, Option<String>)> = Vec::with_capacity(rows.len());
    for (id, stored_path) in rows {
        if let Some(path) = &stored_path {
            let resolved = resolve_resource_file_path(app, path)?;
            entries.push((id, resolved, true, Some(path.clone())));
        } else {
            let path = resource_file_path_from_id(app, &id)?.ok_or("资源不存在")?;
            entries.push((id, path, false, None));
        }
    }

    let root = resource_path_key(&get_resource_library_dir(app));
    let mut target_dir = root.clone();
    if !target_folder.is_empty() {
        for segment in target_folder.split('/') {
            target_dir.push(segment);
        }
    }
    let target_depth = if target_folder.is_empty() {
        0
    } else {
        target_folder.split('/').count()
    };

    // 第三阶段：规划目标路径并预检冲突（磁盘已有同名文件，或选中内容之间同名）。
    let mut seen_targets = HashSet::new();
    let mut planned = Vec::with_capacity(entries.len());
    for (id, old_path, db_backed, stored_path) in &entries {
        let old_dir_depth = old_path
            .parent()
            .and_then(|parent| parent.strip_prefix(&root).ok())
            .map(|relative| relative.components().count())
            .unwrap_or(0);
        let file_name = old_path
            .file_name()
            .ok_or_else(|| "资源文件路径无效".to_string())?
            .to_os_string();
        let new_path = target_dir.join(&file_name);
        let unchanged = old_path.parent() == Some(target_dir.as_path());
        if !unchanged && !seen_targets.insert(resource_path_key(&new_path)) {
            return Err(format!(
                "选择的内容中存在同名文件：{}",
                file_name.to_string_lossy()
            ));
        }
        planned.push((
            id.clone(),
            old_path.clone(),
            new_path,
            old_dir_depth,
            *db_backed,
            stored_path.clone(),
            unchanged,
        ));
    }
    for (_, _, new_path, _, _, _, unchanged) in &planned {
        if *unchanged {
            continue;
        }
        if new_path.exists() {
            return Err(format!(
                "目标分组已存在同名文件：{}",
                new_path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default()
            ));
        }
    }

    // 第四阶段：移动文件，失败时回滚已移动部分；markdown 附件链接按层级重写。
    let mut moved: Vec<(PathBuf, PathBuf, Option<String>)> = Vec::new();
    for (_, old_path, new_path, old_depth, _, _, unchanged) in &planned {
        if *unchanged {
            continue;
        }
        let original_content = if old_path
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        {
            match std::fs::read_to_string(old_path) {
                Ok(content) => Some(content),
                Err(error) => {
                    rollback_moved_resource_files(&moved);
                    return Err(format!("读取资源文件失败: {error}"));
                }
            }
        } else {
            None
        };
        if let Some(parent) = new_path.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                rollback_moved_resource_files(&moved);
                return Err(format!("创建资源目录失败: {error}"));
            }
        }
        if let Err(error) = std::fs::rename(old_path, new_path) {
            rollback_moved_resource_files(&moved);
            return Err(format!("移动资源文件失败: {error}"));
        }
        moved.push((old_path.clone(), new_path.clone(), original_content.clone()));
        if let Some(content) = original_content {
            let updated =
                rewrite_resource_markdown_links_for_depth(content.as_str(), *old_depth, target_depth);
            if updated != content {
                if let Err(error) = std::fs::write(new_path, updated) {
                    rollback_moved_resource_files(&moved);
                    return Err(format!("更新资源图片路径失败: {error}"));
                }
            }
        }
    }

    // 第五阶段：同步数据库路径、分组与路径型 content，失败时回滚文件移动。
    let mut new_content_by_id: HashMap<String, String> = HashMap::new();
    let db_updates: Vec<(String, String, String, String)> = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let mut updates = Vec::new();
        for (id, old_path, new_path, _, db_backed, stored_path, _) in &planned {
            if !db_backed {
                continue;
            }
            let row_content: String = conn
                .query_row(
                    "SELECT content FROM clipboard_records WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            let old_path_text = old_path.to_string_lossy().to_string();
            let new_path_text = new_path.to_string_lossy().to_string();
            let stored_old_text = stored_path.clone().unwrap_or_default();
            // 自动发现/补充入库记录的 content 即完整路径，移动后同步替换。
            let new_content = if row_content == old_path_text || row_content == stored_old_text {
                new_path_text.clone()
            } else {
                row_content
            };
            new_content_by_id.insert(id.clone(), new_content.clone());
            updates.push((id.clone(), new_path_text, new_content, target_group.clone()));
        }
        updates
    };
    if !db_updates.is_empty() {
        let update_result: Result<(), String> = {
            let state = app.state::<DbState>();
            let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for (id, path, content, group) in &db_updates {
                tx.execute(
                    "UPDATE clipboard_records SET resource_path = ?1, content = ?2, group_name = ?3 WHERE id = ?4",
                    params![path, content, group, id],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())
        };
        if let Err(error) = update_result {
            rollback_moved_resource_files(&moved);
            return Err(format!("更新资源记录失败: {error}"));
        }
    }

    let mut results = Vec::with_capacity(planned.len());
    for (id, _, new_path, _, db_backed, _, _) in &planned {
        let relative_path = new_path
            .strip_prefix(&root)
            .ok()
            .map(|relative| relative.to_string_lossy().to_string());
        // 自动发现记录的 content 即文件完整路径；入库记录以数据库同步结果为准。
        let content = if *db_backed {
            new_content_by_id.get(id).cloned().unwrap_or_default()
        } else {
            new_path.to_string_lossy().to_string()
        };
        results.push(serde_json::json!({
            "id": if *db_backed { id.clone() } else { resource_file_id(new_path) },
            "resource_path": new_path.to_string_lossy().to_string(),
            "resource_relative_path": relative_path,
            "content": content,
            "group_name": target_group.clone(),
            "resource_folder": target_folder.clone(),
        }));
    }

    if !moved.is_empty() {
        let _ = app.emit("resource-groups-changed", ());
    }
    Ok(results)
}

/// 递归重写目录下全部 markdown 的附件相对链接（层级整体平移 delta），返回撤销信息。
fn rewrite_folder_markdown_links(
    root: &Path,
    directory: &Path,
    delta: isize,
) -> Result<Vec<(PathBuf, String)>, String> {
    fn visit(
        root: &Path,
        directory: &Path,
        delta: isize,
        undo: &mut Vec<(PathBuf, String)>,
    ) -> Result<(), String> {
        let children = std::fs::read_dir(directory)
            .map_err(|e| format!("读取资源分组失败: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取资源分组失败: {e}"))?;
        let mut children = children;
        children.sort_by_key(|entry| entry.file_name());
        for entry in children {
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|e| format!("读取资源分组失败: {e}"))?;
            if file_type.is_dir() {
                if entry.file_name() == OsStr::new(".copy-creator") {
                    continue;
                }
                visit(root, &path, delta, undo)?;
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let is_markdown = path
                .extension()
                .and_then(OsStr::to_str)
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
            if !is_markdown {
                continue;
            }
            let new_depth = path
                .parent()
                .and_then(|parent| parent.strip_prefix(root).ok())
                .map(|relative| relative.components().count())
                .unwrap_or(0);
            let old_depth = (new_depth as isize - delta).max(0) as usize;
            let content = std::fs::read_to_string(&path)
                .map_err(|e| format!("读取资源文件失败: {e}"))?;
            let updated = rewrite_resource_markdown_links_for_depth(&content, old_depth, new_depth);
            if updated != content {
                std::fs::write(&path, &updated)
                    .map_err(|e| format!("更新资源图片路径失败: {e}"))?;
                undo.push((path, content));
            }
        }
        Ok(())
    }

    let mut undo = Vec::new();
    visit(root, directory, delta, &mut undo)?;
    Ok(undo)
}

#[tauri::command]
pub fn move_resource_group(
    app: AppHandle,
    path: String,
    new_parent: String,
) -> Result<(), String> {
    move_resource_group_inner(&app, path, new_parent)
}

fn move_resource_group_inner<R: Runtime>(
    app: &AppHandle<R>,
    path: String,
    new_parent: String,
) -> Result<(), String> {
    let path = normalize_resource_folder_path(Some(&path))?;
    let new_parent = normalize_resource_folder_path(Some(&new_parent))?;
    if path.is_empty() {
        return Err("未分组不能移动".to_string());
    }
    // 禁止把分组移动到自身或其子分组内，避免形成环。
    if new_parent == path || new_parent.starts_with(&format!("{path}/")) {
        return Err("不能把分组移动到它自身或其子分组内".to_string());
    }
    let base_name = path.rsplit('/').next().unwrap_or_default().to_string();
    let current_parent = path
        .rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default();
    if current_parent == new_parent {
        return Ok(());
    }

    let old_dir = resource_group_path(app, &path)?;
    let mut new_dir = resource_group_path(app, &new_parent)?;
    new_dir.push(&base_name);
    if !old_dir.is_dir() {
        return Err("资源分组不存在".to_string());
    }
    if new_dir.exists() {
        return Err("目标位置已存在同名分组".to_string());
    }
    let new_path_text = if new_parent.is_empty() {
        base_name.clone()
    } else {
        format!("{new_parent}/{base_name}")
    };
    let new_group = new_path_text.split('/').next().unwrap_or_default().to_string();
    let old_group = path.split('/').next().unwrap_or_default().to_string();

    let records = resource_record_paths_in_folder(app, &path)?;
    let new_records = records
        .iter()
        .filter_map(|(id, file_path)| {
            let relative = Path::new(file_path).strip_prefix(&old_dir).ok()?;
            Some((
                id.clone(),
                new_dir.join(relative).to_string_lossy().to_string(),
            ))
        })
        .collect::<Vec<_>>();

    let old_folder_depth = path.split('/').count();
    let new_folder_depth = new_path_text.split('/').count();
    let depth_delta = new_folder_depth as isize - old_folder_depth as isize;

    std::fs::rename(&old_dir, &new_dir).map_err(|e| format!("移动资源分组失败: {e}"))?;

    if let Err(error) = update_resource_record_paths(app, &new_records, &new_group) {
        let _ = std::fs::rename(&new_dir, &old_dir);
        return Err(format!("更新资源路径失败: {error}"));
    }

    if depth_delta != 0 {
        // 目录整体迁移后统一平移 markdown 附件链接层级；中途失败时恢复链接、
        // 记录路径与目录位置，保证三处状态一致。
        let root_dir = get_resource_library_dir(app);
        let undo = rewrite_folder_markdown_links(&root_dir, &new_dir, depth_delta);
        if let Err(error) = undo {
            let _ = update_resource_record_paths(app, &records, &old_group);
            let _ = std::fs::rename(&new_dir, &old_dir);
            return Err(error);
        }
    }

    rewrite_resource_group_order(app, |order| {
        rewrite_group_order_prefix(order, &path, &new_path_text)
    });
    let _ = app.emit("resource-groups-changed", ());
    Ok(())
}

#[tauri::command]
pub fn open_resource_group(app: AppHandle, name: String) -> Result<(), String> {
    let name = normalize_resource_folder_path(Some(&name))?;
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

const RESOURCE_NOTE_MAX_LEN: usize = 1000;

/// 保存资源备注。资源库中自动发现、尚未入库的文件在首次备注时补建记录，
/// 使备注跟随记录持久化并可参与搜索。
#[tauri::command]
pub fn set_resource_note(app: AppHandle, id: String, note: String) -> Result<String, String> {
    set_resource_note_inner(&app, id, note)
}

fn set_resource_note_inner<R: Runtime>(
    app: &AppHandle<R>,
    id: String,
    note: String,
) -> Result<String, String> {
    let trimmed = note.trim();
    if trimmed.chars().count() > RESOURCE_NOTE_MAX_LEN {
        return Err(format!("备注长度不能超过 {RESOURCE_NOTE_MAX_LEN} 字"));
    }
    let note = trimmed.to_string();

    // 路径解析内部会读取数据库设置并加连接锁，必须先于本函数持锁执行，避免重入死锁。
    let needs_insert = !resource_record_row_exists(app, &id)?;
    let discovered_path = if needs_insert {
        Some(resource_file_path_from_id(app, &id)?.ok_or("资源不存在")?)
    } else {
        None
    };

    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let updated = conn
        .execute(
            "UPDATE clipboard_records SET resource_note = ?1 WHERE id = ?2",
            params![&note, &id],
        )
        .map_err(|e| e.to_string())?;
    if updated == 0 {
        let path = discovered_path.ok_or("资源不存在")?;
        let path_text = path.to_string_lossy().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO clipboard_records
             (id, type, content, source_app, created_at, storage_mode, resource_path, resource_note)
             VALUES (?1, 'file', ?2, '', ?3, 'resource', ?2, ?4)",
            params![&id, &path_text, &now, &note],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(note)
}

/// 检查记录是否已存在；不持有外层连接锁时可安全调用。
fn resource_record_row_exists<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<bool, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let exists: Option<String> = match conn.query_row(
        "SELECT id FROM clipboard_records WHERE id = ?1",
        params![id],
        |row| row.get(0),
    ) {
        Ok(value) => Some(value),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(error) => return Err(error.to_string()),
    };
    Ok(exists.is_some())
}

#[tauri::command]
pub fn open_resource_file(app: AppHandle, path: String) -> Result<(), String> {    let path = resolve_resource_file_path(&app, &path)?;

    #[cfg(target_os = "windows")]
    return std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开资源文件失败: {e}"));

    #[cfg(target_os = "macos")]
    return std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开资源文件失败: {e}"));

    #[cfg(target_os = "linux")]
    return std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开资源文件失败: {e}"));

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err("当前系统不支持打开资源文件".to_string())
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
pub fn reorder_phrase_groups(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    write_id_order(&conn, "phrase_groups", &ids, |i, n| ((n - i) * 10) as f64)?;

    let _ = app.emit("phrase-groups-changed", ());
    log::info!("reorder_phrase_groups: {} items", ids.len());
    Ok(())
}

#[tauri::command]
pub fn reorder_phrases(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    write_id_order(&conn, "phrases", &ids, |i, n| ((n - i) * 10) as f64)?;

    log::info!("reorder_phrases: {} items", ids.len());
    Ok(())
}

/// 按传入顺序为 ids 写 sort_order：第 i 个 id 的 sort_order 由
/// value(i, n) 计算。置顶与重排序共用的唯一写序实现；表名来自内部
/// 常量调用点，不引入注入风险；id 值做转义。
fn write_id_order(
    conn: &Connection,
    table: &str,
    ids: &[String],
    value: impl Fn(usize, usize) -> f64,
) -> Result<(), String> {
    let n = ids.len();
    if n == 0 {
        return Ok(());
    }
    let mut case_clauses = String::new();
    let mut id_list = String::new();
    for (i, id) in ids.iter().enumerate() {
        let escaped = id.replace('\'', "''");
        case_clauses.push_str(&format!(" WHEN '{}' THEN {}", escaped, value(i, n)));
        if i > 0 {
            id_list.push(',');
        }
        id_list.push_str(&format!("'{}'", escaped));
    }
    conn.execute(
        &format!("UPDATE {table} SET sort_order = CASE id{case_clauses} END WHERE id IN ({id_list})"),
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 将给定 id 的行按传入顺序依次置顶（第一个 id 最靠前）：sort_order 取
/// 当前最大值之上的递减序。之后新写入的记录（sort_order 为时间戳）照常
/// 插到最前面，被置顶内容随新内容积累自然下移。
fn move_rows_to_top(conn: &Connection, table: &str, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let max: f64 = conn
        .query_row(
            &format!("SELECT COALESCE(MAX(sort_order), 0) FROM {table}"),
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    write_id_order(conn, table, ids, |i, n| max + (n - i) as f64)
}

#[tauri::command]
pub fn move_clipboard_records_to_top(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    move_rows_to_top(&conn, "clipboard_records", &ids)?;
    log::info!("move_clipboard_records_to_top: {} items", ids.len());
    Ok(())
}

#[tauri::command]
pub fn move_phrases_to_top(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    move_rows_to_top(&conn, "phrases", &ids)?;
    log::info!("move_phrases_to_top: {} items", ids.len());
    Ok(())
}













#[cfg(test)]
mod tests;
