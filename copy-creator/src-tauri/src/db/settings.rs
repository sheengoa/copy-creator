// 设置域：settings 表的读写命令与应用内读取助手。
// 从 db/mod.rs 机械搬迁；实现与行为不变，共享助手经 super::* 引用。
use super::*;
use rusqlite::params;
use tauri::{AppHandle, Manager, Runtime};

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

pub(crate) fn set_setting_inner(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
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
