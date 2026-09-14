// 快捷输入域（历史标识 quick_input/phrases）：文件短语、分组与条目 CRUD、「全部」聚合视图。
// 从 db/mod.rs 机械搬迁；实现与行为不变，共享助手经 super::* 引用。
use super::*;
use rusqlite::params;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub(crate) fn quick_input_files_dir(app: &AppHandle) -> PathBuf {
    let dir = get_storage_dir(app).join("quick-input-files");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub(crate) fn quick_input_relative_path(dir_name: &str, filename: &str) -> String {
    format!("quick-input-files/{}/{}", dir_name, filename)
}

pub(crate) fn is_legacy_quick_input_file_path(relative_path: &str) -> bool {
    quick_input_relative_component_count(relative_path) == Some(1)
}

pub(crate) fn quick_input_relative_component_count(relative_path: &str) -> Option<usize> {
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

pub(crate) fn quick_input_absolute_path(app: &AppHandle, relative_path: &str) -> Option<PathBuf> {
    quick_input_relative_component_count(relative_path)?;
    resolve_relative_storage_path(&get_storage_dir(app), relative_path)
}

pub(crate) fn remove_quick_input_file(app: &AppHandle, relative_path: &str) {
    if let Some(path) = quick_input_absolute_path(app, relative_path) {
        let _ = std::fs::remove_file(&path);
        if let Some(parent) = path.parent() {
            if parent != quick_input_files_dir(app) {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }
}

pub(crate) fn copy_quick_input_file(app: &AppHandle, source_path: &str) -> Result<(String, u64), String> {
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

pub(crate) fn legacy_quick_input_target_path(relative_path: &str, source_path: &str) -> Option<String> {
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

pub(crate) fn migrate_legacy_quick_input_file_names(app: &AppHandle) {
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

pub(crate) fn is_quick_input_text_preview_path(path: &str) -> bool {
    quick_input_relative_component_count(path).is_some()
        && is_text_preview_extension(Path::new(path))
}

// 与资源区可预览文本共用同一份扩展名清单（md/json/yaml 及各类代码等），
// 避免出现「资源区能预览、快捷输入/剪切板不能」的割裂。
pub(crate) fn is_text_preview_extension(path: &Path) -> bool {
    crate::media_kind::is_text_extension(path)
}

/// 校验路径是不超过上限的文件，返回 metadata。预览读取、预检与写入
/// 前置检查共用；超出上限的提示语由调用方按场景传入。
pub(crate) fn ensure_capped_file(
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
pub(crate) fn read_capped_text_file(path: &Path) -> Result<String, String> {
    ensure_capped_file(path, QUICK_INPUT_TEXT_PREVIEW_LIMIT_BYTES, "预览文件不能超过 1 MB")?;
    std::fs::read_to_string(path).map_err(|e| format!("读取文件失败: {e}"))
}

pub(crate) fn read_text_preview_file(path: PathBuf) -> Result<String, String> {
    if !is_text_preview_extension(&path) {
        return Err("当前文件不是可预览的文本文件".to_string());
    }
    read_capped_text_file(&path)
}

pub(crate) fn read_resource_text_preview_file(path: PathBuf) -> Result<String, String> {
    if !crate::media_kind::is_text_extension(&path) && !crate::media_kind::is_probably_text_file(&path) {
        return Err("当前文件不是可预览的文本文件".to_string());
    }
    read_capped_text_file(&path)
}

pub(crate) fn resolve_quick_input_text_preview_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
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

// ── 使用记录 ─────────────────────────────────────────────────
// 粘贴/拖出成功时写入 last_used_at（touch_*_usage），
// 供快捷输入「全部」视图按最近使用排序展示。

// ── 快捷输入「全部」视图 ─────────────────────────────────────
// 跨分组聚合短语：排序依据是粘贴成功写入的 last_used_at（touch_phrase_usage）。

/// 「全部」视图的单行映射：短语字段 + 分组名（供来源标签展示）。
pub(crate) fn phrase_row_with_group(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
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
pub(crate) fn phrases_all_order_clause(sort_by: Option<&str>) -> &'static str {
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
pub(crate) fn all_phrase_rows(
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

#[tauri::command]
pub fn move_phrases_to_top(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    move_rows_to_top(&conn, "phrases", &ids)?;
    log::info!("move_phrases_to_top: {} items", ids.len());
    Ok(())
}
