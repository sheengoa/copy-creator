// 资源文本改动记录域：正文每次落盘自动记一版（内容快照），改错可还原。
// 数据模型与约束见 ensure_schema 中 resource_text_versions 表——record_id
// 外键双向级联（记录删除随删、记录 id 改写随迁），与 resource_annotations 同构。
//
// 记版采用「保存后快照」模型：版本链顶端永远等于文件当前内容。外部修改
// 不在文件监听器挂钩（监听时机紧张且拿不到修改前内容），在列表读取时
// 懒检测对齐——文件内容 ≠ 顶端版本即补记一版「外部修改」，修改前的内容
// 自然就在上一版。还原直接复用正文写入通道，还原动作本身也记一版，
// 还原永远可逆，无需确认框。
use super::*;
use rusqlite::params;
use tauri::{AppHandle, Manager, Runtime};

/// 每条资源保留的版本上限：超出按写入顺序淘汰最旧。
pub(crate) const RESOURCE_TEXT_VERSION_LIMIT: i64 = 20;

/// 版本来源（前端展示为标签）：入库初始内容 / 应用内编辑 / 外部修改 / 还原动作。
pub(crate) const VERSION_SOURCE_INIT: &str = "init";
pub(crate) const VERSION_SOURCE_EDIT: &str = "edit";
pub(crate) const VERSION_SOURCE_EXTERNAL: &str = "external";
pub(crate) const VERSION_SOURCE_RESTORE: &str = "restore";

#[derive(Debug, serde::Serialize)]
pub struct ResourceTextVersion {
    pub id: String,
    pub record_id: String,
    /// 版本字节大小（列表展示用，正文按需单独拉取）。
    pub byte_size: i64,
    pub source: String,
    pub created_at: String,
}

fn row_to_version(row: &rusqlite::Row) -> rusqlite::Result<ResourceTextVersion> {
    Ok(ResourceTextVersion {
        id: row.get(0)?,
        record_id: row.get(1)?,
        byte_size: row.get(2)?,
        source: row.get(3)?,
        created_at: row.get(4)?,
    })
}

/// 版本链顶端（最新一版）的内容；链为空返回 None。排序按 rowid（插入序），
/// created_at 是 RFC3339 文本、同秒内无法区分先后。
pub(crate) fn top_text_version_content(
    conn: &Connection,
    record_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT content FROM resource_text_versions
         WHERE record_id = ?1 ORDER BY rowid DESC LIMIT 1",
        params![record_id],
        |row| row.get(0),
    )
    .optional()
    .map(|content| content)
    .map_err(|e| e.to_string())
}

/// 追加一版；与顶端内容相同则跳过（空转保存、重复还原不产生噪音版本）。
/// 随后按上限淘汰最旧。返回是否真的新增。
pub(crate) fn add_text_version(
    conn: &Connection,
    record_id: &str,
    content: &str,
    source: &str,
) -> Result<bool, String> {
    if content.trim().is_empty() {
        return Ok(false);
    }
    if let Some(top) = top_text_version_content(conn, record_id)? {
        if top == content {
            return Ok(false);
        }
    }
    let id = format!("rtv-{}", uuid::Uuid::new_v4());
    conn.execute(
        "INSERT INTO resource_text_versions
         (id, record_id, content, byte_size, source, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            id,
            record_id,
            content,
            content.len() as i64,
            source,
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|e| format!("记录改动版本失败: {e}"))?;
    conn.execute(
        "DELETE FROM resource_text_versions
         WHERE record_id = ?1
           AND id NOT IN (
               SELECT id FROM resource_text_versions
               WHERE record_id = ?1 ORDER BY rowid DESC LIMIT ?2
           )",
        params![record_id, RESOURCE_TEXT_VERSION_LIMIT],
    )
    .map_err(|e| format!("淘汰过期版本失败: {e}"))?;
    Ok(true)
}

/// 正文落盘后的记版：版本链为空时先把入库原文（写入前内容）补为首版
/// 「首次入库」，再记本次写入内容。prior_content 为 None（文件原本缺失/
/// 非 UTF-8）或空内容时跳过补记。
pub(crate) fn record_versions_after_write(
    conn: &Connection,
    record_id: &str,
    prior_content: Option<&str>,
    new_content: &str,
    source: &str,
) -> Result<(), String> {
    if top_text_version_content(conn, record_id)?.is_none() {
        if let Some(prior) = prior_content {
            add_text_version(conn, record_id, prior, VERSION_SOURCE_INIT)?;
        }
    }
    add_text_version(conn, record_id, new_content, source)?;
    Ok(())
}

/// 读取当前文件内容用于懒对齐（必须在未持 DB 锁时调用：resolve 经
/// get_resource_library_dir → get_setting_sync 会再次获取 DB 锁，持锁
/// 调用即自锁死）。文件缺失、超大或非 UTF-8 时返回 None，跳过对齐。
fn read_current_file_text<R: Runtime>(app: &AppHandle<R>, path: &str) -> Option<String> {
    let target = resolve_resource_file_path(app, path).ok()?;
    // 读文件前限大小：懒对齐只在面板打开时触发，不应无意间吞下
    // 超大文件；超限文件本就进不了应用内编辑，历史照常展示。
    let metadata = std::fs::metadata(&target).ok()?;
    if metadata.len() > super::resource::RESOURCE_TEXT_PASTE_LIMIT_BYTES {
        return None;
    }
    std::fs::read_to_string(&target).ok()
}

pub(crate) fn list_resource_text_versions_inner<R: Runtime>(
    app: &AppHandle<R>,
    record_id: &str,
    path: &str,
) -> Result<Vec<ResourceTextVersion>, String> {
    // 先读文件再取锁：懒对齐要拿当前文件内容，而路径解析内部会再次
    // 获取 DB 锁，持锁状态下解析路径会自锁死。
    let current = read_current_file_text(app, path);
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    if !record_exists_as_resource(&conn, record_id)? {
        return Err("资源记录不存在".to_string());
    }
    // 懒对齐：文件内容与顶端版本漂移（被外部程序改过）补记一版「外部
    // 修改」——修改前的内容自然就在上一版。链为空不补记：从未在应用内
    // 编辑过的资源展示空历史更符合直觉（首版由首次保存时的
    // record_versions_after_write 补记入库原文）。
    if let Some(text) = current {
        let chain_empty = top_text_version_content(&conn, record_id)?.is_none();
        if !chain_empty {
            let _ = add_text_version(&conn, record_id, &text, VERSION_SOURCE_EXTERNAL);
        }
    }
    let mut stmt = conn
        .prepare(
            "SELECT id, record_id, byte_size, source, created_at
             FROM resource_text_versions WHERE record_id = ?1
             ORDER BY rowid DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![record_id], row_to_version)
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

#[tauri::command]
pub fn list_resource_text_versions(
    app: AppHandle,
    record_id: String,
    path: String,
) -> Result<Vec<ResourceTextVersion>, String> {
    list_resource_text_versions_inner(&app, &record_id, &path)
}

#[tauri::command]
pub fn get_resource_text_version_content(
    app: AppHandle,
    version_id: String,
) -> Result<String, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT content FROM resource_text_versions WHERE id = ?1",
        params![version_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "改动版本不存在".to_string())
}

/// 还原核心（命令层与测试共用）：查版本 → 查记录当前路径 → 走正文写入
/// 通道原样落盘并记「还原」版。
pub(crate) fn restore_resource_text_version_inner<R: Runtime>(
    app: &AppHandle<R>,
    version_id: &str,
) -> Result<serde_json::Value, String> {
    let (record_id, content): (String, String) = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT record_id, content FROM resource_text_versions WHERE id = ?1",
            params![version_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "改动版本不存在".to_string())?
    };
    let path: String = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT content FROM clipboard_records WHERE id = ?1",
            params![record_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "资源记录不存在".to_string())?
    };
    super::resource::write_text_content_inner(
        app,
        &path,
        &content,
        Some(record_id),
        VERSION_SOURCE_RESTORE,
    )
}

/// 还原：把版本快照写回记录当前指向的文件（记录的 content 是权威路径，
/// 文件被移动过也写回现位）。还原走正文写入通道，写入内容原样落盘
/// （不做 trim/补尾换行——规范化会让还原后的文件内容偏离版本快照，下次
/// 懒对齐会误记一版外部修改），并自动记一版「还原」。
#[tauri::command]
pub fn restore_resource_text_version(
    app: AppHandle,
    version_id: String,
) -> Result<serde_json::Value, String> {
    restore_resource_text_version_inner(&app, &version_id)
}

pub(crate) fn clear_resource_text_versions_inner<R: Runtime>(
    app: &AppHandle<R>,
    record_id: &str,
) -> Result<u64, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let removed = conn
        .execute(
            "DELETE FROM resource_text_versions WHERE record_id = ?1",
            params![record_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(removed as u64)
}

#[tauri::command]
pub fn clear_resource_text_versions(app: AppHandle, record_id: String) -> Result<u64, String> {
    clear_resource_text_versions_inner(&app, &record_id)
}

/// 记录删除（入回收站/彻底删除/过期清理）后版本由外键级联清理，无需
/// 手写；此助手仅供测试断言使用。
#[cfg(test)]
pub(crate) fn text_version_count(conn: &Connection, record_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM resource_text_versions WHERE record_id = ?1",
        params![record_id],
        |row| row.get(0),
    )
    .unwrap_or(0)
}
