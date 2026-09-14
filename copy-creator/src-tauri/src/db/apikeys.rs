// API Key 域：检测/预览助手、标签管理、气泡与用户标记命令。
// 从 db/mod.rs 机械搬迁；实现与行为不变，共享助手经 super::* 引用。
use super::*;
use rusqlite::params;
use tauri::{AppHandle, Manager};

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

pub(crate) fn list_labels_internal(conn: &Connection) -> Result<Vec<serde_json::Value>, String> {
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
