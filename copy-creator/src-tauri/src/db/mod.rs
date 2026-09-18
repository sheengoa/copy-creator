use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

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


// storage_mode 列在 schema 层有 DEFAULT 'database' 且历史数据已回填，
// 永不为 NULL：直接等值比较可命中 idx_clipboard_storage_mode 索引。
// 不要改回 COALESCE(storage_mode, 'database') 包裹——那会让索引失效。
const RESOURCE_RECORD_CONDITION: &str = "storage_mode = 'resource'";

/// storage_mode 历史数据回填 + 资源查询组合索引。ensure_schema 与测试共用
/// 同一份 SQL，保证两者建的库结构一致。
const RESOURCE_INDEX_MIGRATION_SQL: &str = "
UPDATE clipboard_records SET storage_mode = 'database' WHERE storage_mode IS NULL;

CREATE INDEX IF NOT EXISTS idx_clipboard_storage_mode
    ON clipboard_records(storage_mode, resource_path);
";

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
        // 「收藏」视图：跨类别只看收藏记录（与其它类别一样走数据库层过滤）。
        Some("favorites") => (
            format!("WHERE pinned = 1 AND NOT ({RESOURCE_RECORD_CONDITION})"),
            format!("AND pinned = 1 AND NOT ({RESOURCE_RECORD_CONDITION})"),
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

// ── 业务域子模块（#19 拆分）────────────────────────────────
// 命令经 pub use 保持在 `db::` 路径下，lib.rs 注册路径不变；
// 域内助手为 pub(crate)，跨域调用与测试经 crate::db:: 可达。
mod apikeys;
mod clipboard;
mod media;
mod migrate;
mod phrase;
mod resource;
mod settings;
mod trash;
pub(crate) use apikeys::*;
pub(crate) use clipboard::*;
pub(crate) use media::*;
pub(crate) use migrate::*;
pub(crate) use phrase::*;
pub(crate) use resource::*;
pub(crate) use settings::*;
pub(crate) use trash::*;

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
    pinned: i64,
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
        "pinned": pinned != 0,
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
         WHERE storage_mode = 'resource'
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
         WHERE storage_mode = 'resource'
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
pub(crate) fn ensure_schema(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
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
            touched_ms INTEGER DEFAULT 0,
            pinned INTEGER NOT NULL DEFAULT 0
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

        CREATE TABLE IF NOT EXISTS trash_items (
            id TEXT PRIMARY KEY,
            record_id TEXT DEFAULT '',
            record_json TEXT NOT NULL,
            file_name TEXT DEFAULT '',
            original_group TEXT DEFAULT '',
            original_path TEXT DEFAULT '',
            trash_dir TEXT NOT NULL,
            trashed_at TEXT NOT NULL,
            trashed_ms INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_trash_trashed_ms ON trash_items(trashed_ms);
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

    // ── pinned：收藏标记 ──
    // 收藏记录不受保留期清理（prune_old_records 排除），列表查询恒定浮顶
    // （clipboard_order_clause 前置 pinned DESC）。用户主动删除仍可移除。
    conn.execute(
        "ALTER TABLE clipboard_records ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
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
    // 前置回填：storage_mode 列经 DEFAULT/ALTER 均带 'database'，NULL 只可能来自
    // 异常路径；先回填再等值比较，保证「storage_mode = 'resource'」与旧
    // COALESCE 语义一致，资源等值查询命中组合索引。
    conn.execute_batch(RESOURCE_INDEX_MIGRATION_SQL).ok();
    conn.execute(
        "UPDATE clipboard_records SET storage_mode = ?1
         WHERE TRIM(COALESCE(group_name, '')) <> ''
           AND group_name NOT IN ('stash', '暂存', '默认', '临时')
           AND storage_mode <> ?1",
        params![RESOURCE_STORAGE_MODE],
    )
    .ok();
    conn.execute(
        "UPDATE clipboard_records SET group_name = ''
         WHERE storage_mode = ?1",
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
// ── Reorder Commands ──────────────────────────────────────────
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

#[cfg(test)]
mod tests;
