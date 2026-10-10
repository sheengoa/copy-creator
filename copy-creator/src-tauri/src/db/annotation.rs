// 资源文本标注域：划选标记的 CRUD。数据模型与约束见 ensure_schema 中
// resource_annotations 表——字符偏移锚定 + 锚文本校验，外键双向级联
// （记录删除随删、记录 id 改写随迁）。
use super::*;
use rusqlite::params;
use tauri::{AppHandle, Manager, Runtime};

/// 标注类型的白名单：五种高亮色 + 加粗 + 下划线。前端传值必须在此集合内。
const ANNOTATION_KINDS: [&str; 7] = ["hl-y", "hl-g", "hl-b", "hl-o", "hl-p", "bold", "underline"];

#[derive(Debug, serde::Serialize)]
pub struct ResourceAnnotation {
    pub id: String,
    pub record_id: String,
    pub start_offset: i64,
    pub length: i64,
    pub kind: String,
    pub anchor_text: String,
    pub created_at: String,
}

fn row_to_annotation(row: &rusqlite::Row) -> rusqlite::Result<ResourceAnnotation> {
    Ok(ResourceAnnotation {
        id: row.get(0)?,
        record_id: row.get(1)?,
        start_offset: row.get(2)?,
        length: row.get(3)?,
        kind: row.get(4)?,
        anchor_text: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn validate_annotation_input(start: i64, len: i64, kind: &str) -> Result<(), String> {
    if len <= 0 {
        return Err("标注长度必须大于 0".to_string());
    }
    if start < 0 || start.saturating_add(len) > i64::MAX {
        return Err("标注位置无效".to_string());
    }
    if !ANNOTATION_KINDS.contains(&kind) {
        return Err("未知的标注类型".to_string());
    }
    Ok(())
}

fn record_exists_as_resource(conn: &Connection, record_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM clipboard_records WHERE id = ?1 AND storage_mode = 'resource'",
        params![record_id],
        |_| Ok(true),
    )
    .optional()
    .map(|found| found.unwrap_or(false))
    .map_err(|e| e.to_string())
}

pub(crate) fn get_resource_annotations_inner<R: Runtime>(
    app: &AppHandle<R>,
    record_id: &str,
) -> Result<Vec<ResourceAnnotation>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, record_id, start_offset, length, kind, anchor_text, created_at
             FROM resource_annotations WHERE record_id = ?1
             ORDER BY start_offset, created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![record_id], row_to_annotation)
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

pub(crate) fn add_resource_annotation_inner<R: Runtime>(
    app: &AppHandle<R>,
    record_id: &str,
    start_offset: i64,
    length: i64,
    kind: &str,
    anchor_text: &str,
) -> Result<ResourceAnnotation, String> {
    validate_annotation_input(start_offset, length, kind)?;
    if anchor_text.is_empty() {
        return Err("标注锚文本不能为空".to_string());
    }
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    if !record_exists_as_resource(&conn, record_id)? {
        return Err("资源记录不存在".to_string());
    }
    let annotation = ResourceAnnotation {
        id: format!("ann-{}", uuid::Uuid::new_v4()),
        record_id: record_id.to_string(),
        start_offset,
        length,
        kind: kind.to_string(),
        anchor_text: anchor_text.to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    conn.execute(
        "INSERT INTO resource_annotations
         (id, record_id, start_offset, length, kind, anchor_text, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            annotation.id,
            annotation.record_id,
            annotation.start_offset,
            annotation.length,
            annotation.kind,
            annotation.anchor_text,
            annotation.created_at,
        ],
    )
    .map_err(|e| format!("保存标注失败: {e}"))?;
    Ok(annotation)
}

pub(crate) fn remove_resource_annotation_inner<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<bool, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let removed = conn
        .execute("DELETE FROM resource_annotations WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(removed > 0)
}

/// 清除选区内重叠的全部标注（部分重叠的整条移除：标注锚定的是用户
/// 感知的整段标记，截半保留会产生无法解释的残段）。
pub(crate) fn remove_resource_annotations_in_range_inner<R: Runtime>(
    app: &AppHandle<R>,
    record_id: &str,
    start_offset: i64,
    length: i64,
) -> Result<u64, String> {
    validate_annotation_input(start_offset, length, "hl-y")?;
    let end = start_offset.saturating_add(length);
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let removed = conn
        .execute(
            "DELETE FROM resource_annotations
             WHERE record_id = ?1 AND start_offset < ?2 AND start_offset + length > ?3",
            params![record_id, end, start_offset],
        )
        .map_err(|e| e.to_string())?;
    Ok(removed as u64)
}

pub(crate) fn clear_resource_annotations_inner<R: Runtime>(
    app: &AppHandle<R>,
    record_id: &str,
) -> Result<u64, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let removed = conn
        .execute(
            "DELETE FROM resource_annotations WHERE record_id = ?1",
            params![record_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(removed as u64)
}

#[tauri::command]
pub fn get_resource_annotations(
    app: AppHandle,
    record_id: String,
) -> Result<Vec<ResourceAnnotation>, String> {
    get_resource_annotations_inner(&app, &record_id)
}

#[tauri::command]
pub fn add_resource_annotation(
    app: AppHandle,
    record_id: String,
    start_offset: i64,
    length: i64,
    kind: String,
    anchor_text: String,
) -> Result<ResourceAnnotation, String> {
    add_resource_annotation_inner(&app, &record_id, start_offset, length, &kind, &anchor_text)
}

#[tauri::command]
pub fn remove_resource_annotation(app: AppHandle, id: String) -> Result<bool, String> {
    remove_resource_annotation_inner(&app, &id)
}

#[tauri::command]
pub fn remove_resource_annotations_in_range(
    app: AppHandle,
    record_id: String,
    start_offset: i64,
    length: i64,
) -> Result<u64, String> {
    remove_resource_annotations_in_range_inner(&app, &record_id, start_offset, length)
}

#[tauri::command]
pub fn clear_resource_annotations(app: AppHandle, record_id: String) -> Result<u64, String> {
    clear_resource_annotations_inner(&app, &record_id)
}

/// 记录删除（入回收站/彻底删除/过期清理）后标注由外键级联清理，无需
/// 手写；此助手仅供测试断言与未来的维护场景使用。
#[cfg(test)]
pub(crate) fn annotation_count(conn: &Connection, record_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM resource_annotations WHERE record_id = ?1",
        params![record_id],
        |row| row.get(0),
    )
    .unwrap_or(0)
}
