// 回收站域：应用内删除资源改为移入库根 .trash 目录，记录整行序列化进
// trash_items（恢复时原样回插，保住分组/备注/类型等全部元数据）。
// 时序硬约束：trash_items 行必须与 clipboard_records 行在同一事务内落库，
// 文件移动放在事务提交后——watcher 裁决（forget/relocate）只作用于
// clipboard_records 现存行，settle 运行时行已不在，不会被误清退或跟随
// 重定向。文件移动失败则整体补偿回滚（文件移回 + 记录行回插）。
use super::*;
use rusqlite::{params, params_from_iter};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub(crate) const TRASH_DIR_NAME: &str = ".trash";
/// v1 常量；settings 键 trash_retention 预留，设置页暴露放后续版本。
pub(crate) const DEFAULT_TRASH_RETENTION_DAYS: i64 = 30;

/// 待移动文件的暂存描述：主事务提交后逐项移入库根 .trash。
/// 附件不随文件移入 .trash——它们留在库根 .copy-creator/attachments
/// （组只是 md 内的相对链接前缀），恢复后内链仍然有效；彻底删除时
/// 按 record_json 清理附件。
#[derive(Clone)]
pub(crate) struct TrashedResourceFile {
    pub trash_id: String,
    pub record_id: String,
    pub resource_path: String,
    pub trash_dir: String,
}

/// SELECT * 序列化整行（排除生成列 created_ms——插入生成列会报错；
/// api_key_label 附加以 "__api_key_label" 键存放在同一 JSON 内）。
pub(crate) fn serialize_resource_record(
    conn: &rusqlite::Connection,
    record_id: &str,
) -> Result<String, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM clipboard_records WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params![record_id])
        .map_err(|e| e.to_string())?;
    let row = rows
        .next()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "记录不存在".to_string())?;
    let columns = row.as_ref().column_names();
    let mut map = serde_json::Map::new();
    for (index, name) in columns.iter().enumerate() {
        if *name == "created_ms" {
            continue;
        }
        let value = match row.get_ref(index).map_err(|e| e.to_string())? {
            rusqlite::types::ValueRef::Null => serde_json::Value::Null,
            rusqlite::types::ValueRef::Integer(v) => serde_json::Value::from(v),
            rusqlite::types::ValueRef::Real(v) => serde_json::Value::from(v),
            rusqlite::types::ValueRef::Text(v) => {
                serde_json::Value::from(String::from_utf8_lossy(v).to_string())
            }
            rusqlite::types::ValueRef::Blob(_) => continue,
        };
        map.insert((*name).to_string(), value);
    }
    if let Ok(label) = conn.query_row(
        "SELECT label FROM api_key_labels WHERE record_id = ?1",
        params![record_id],
        |row| row.get::<_, String>(0),
    ) {
        map.insert("__api_key_label".to_string(), serde_json::Value::from(label));
    }
    serde_json::to_string(&serde_json::Value::Object(map))
        .map_err(|e| format!("序列化记录失败: {e}"))
}

/// 事务内落 trash_items 行（与记录删除同事务，保证原子性）。
pub(crate) fn insert_trash_item_in_tx(
    tx: &rusqlite::Transaction,
    record_id: &str,
    record_json: &str,
    resource_path: &str,
    library_root: &Path,
) -> Result<TrashedResourceFile, String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let trash_id = uuid::Uuid::new_v4().to_string();
    let trash_dir = format!(
        "{}/{}-{}",
        TRASH_DIR_NAME,
        now_ms,
        uuid::Uuid::new_v4().simple()
    );
    let original_group =
        resource_group_for_path(library_root, resource_path).unwrap_or_default();
    let file_name = Path::new(resource_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    tx.execute(
        "INSERT INTO trash_items (id, record_id, record_json, file_name, original_group, original_path, trash_dir, trashed_at, trashed_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            trash_id,
            record_id,
            record_json,
            file_name,
            original_group,
            resource_path,
            trash_dir,
            chrono::Utc::now().to_rfc3339(),
            now_ms,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(TrashedResourceFile {
        trash_id,
        record_id: record_id.to_string(),
        resource_path: resource_path.to_string(),
        trash_dir,
    })
}

fn trash_dir_absolute(library_root: &Path, trash_dir: &str) -> PathBuf {
    library_root.join(trash_dir)
}

/// 主事务提交后：把资源文件移入库根 .trash。任一项失败即整体补偿——
/// 已移动文件移回原位、trash_items 行删除、记录行从 record_json 回插，
/// 对外表现为删除失败（不丢数据）。
pub(crate) fn move_trashed_resource_files<R: Runtime>(
    app: &AppHandle<R>,
    library_root: &Path,
    items: &[(TrashedResourceFile, Option<std::path::PathBuf>)],
) -> Result<(), String> {
    let roots = resource_library_roots(app);
    let mut moved_backups: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut completed: Vec<&TrashedResourceFile> = Vec::new();
    let result = (|| -> Result<(), String> {
        for (item, staged_source) in items {
            let trash_abs = trash_dir_absolute(library_root, &item.trash_dir);
            std::fs::create_dir_all(&trash_abs)
                .map_err(|e| format!("创建回收目录失败: {e}"))?;

            // 主文件：外部暂存文件已 rename 到临时路径，从暂存位移动；
            // 其余按 resource_path 定位；文件已不在磁盘则只留记录行。
            let source: Option<PathBuf> = match staged_source {
                Some(staged_path) => Some(staged_path.clone()),
                None => resolve_trash_source(&roots, &item.record_id, &item.resource_path),
            };
            if let Some(source) = source {
                let target_name = source
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| "file".to_string());
                let target = trash_abs.join(&target_name);
                std::fs::rename(&source, &target)
                    .map_err(|e| format!("移入回收站失败: {e}"))?;
                moved_backups.push((target, source));
            }
            completed.push(item);
        }
        Ok(())
    })();

    if let Err(error) = result {
        for (target, source) in moved_backups.iter().rev() {
            let _ = std::fs::rename(target, source);
        }
        for item in completed {
            compensate_trash_item(app, item.trash_id.as_str());
        }
        return Err(error);
    }
    Ok(())
}

/// 定位资源主文件：托管命名走受控解析；外部文件（库内绝对路径）直接用。
/// 都找不到返回 None（文件已不在磁盘，仅记录行入回收站，恢复时无文件可移）。
fn resolve_trash_source(
    roots: &[PathBuf],
    record_id: &str,
    resource_path: &str,
) -> Option<PathBuf> {
    if let Some((path, root)) = managed_resource_file_path(roots, record_id, resource_path) {
        if is_safe_managed_resource_file(&root, &path) {
            return Some(path);
        }
    }
    let path = PathBuf::from(resource_path);
    if path.is_absolute() && path.is_file() {
        return Some(path);
    }
    None
}

/// 补偿：删 trash_items 行 + 从 record_json 回插记录行（文件移回由调用方完成）。
fn compensate_trash_item<R: Runtime>(app: &AppHandle<R>, trash_id: &str) {
    let state = app.state::<DbState>();
    let Ok(conn) = state.conn.lock() else {
        return;
    };
    let record_json: Option<String> = conn
        .query_row(
            "SELECT record_json FROM trash_items WHERE id = ?1",
            params![trash_id],
            |row| row.get(0),
        )
        .ok();
    let _ = conn.execute("DELETE FROM trash_items WHERE id = ?1", params![trash_id]);
    if let Some(json) = record_json {
        if let Err(e) = reinsert_record_from_json(&conn, &json) {
            log::warn!("回收站补偿回插记录失败（trash={trash_id}）: {e}");
        }
    }
}

/// 从 record_json 回插 clipboard_records 行；带回 api_key_label。
pub(crate) fn reinsert_record_from_json(
    conn: &rusqlite::Connection,
    record_json: &str,
) -> Result<(), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(record_json).map_err(|e| format!("解析记录失败: {e}"))?;
    let object = parsed.as_object().ok_or("记录数据不是对象")?;
    let label = object.get("__api_key_label").cloned();
    let mut columns: Vec<String> = Vec::new();
    let mut values: Vec<String> = Vec::new();
    for (key, value) in object {
        if key == "__api_key_label" {
            continue;
        }
        columns.push(key.clone());
        // 统一以文本参数写入：SQLite 按列亲和性转换（INTEGER/REAL 列接受
        // 数字文本），避免为每列区分绑定类型。
        values.push(match value {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Null => String::new(),
            other => other.to_string(),
        });
    }
    if columns.is_empty() {
        return Err("记录数据为空".to_string());
    }
    let placeholders = vec!["?"; columns.len()].join(", ");
    let sql = format!(
        "INSERT OR REPLACE INTO clipboard_records ({}) VALUES ({})",
        columns.join(", "),
        placeholders
    );
    conn.execute(&sql, params_from_iter(values.iter()))
        .map_err(|e| format!("回插记录失败: {e}"))?;
    if let Some(serde_json::Value::String(label)) = label {
        let record_id = object.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if !record_id.is_empty() {
            let _ = conn.execute(
                "INSERT OR REPLACE INTO api_key_labels (record_id, label) VALUES (?1, ?2)",
                params![record_id, label],
            );
        }
    }
    Ok(())
}

pub(crate) fn list_trash_items_internal<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, file_name, original_group, original_path, trashed_at, record_json
             FROM trash_items ORDER BY trashed_ms DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "file_name": row.get::<_, String>(1)?,
                "original_group": row.get::<_, String>(2)?,
                "original_path": row.get::<_, String>(3)?,
                "trashed_at": row.get::<_, String>(4)?,
                "has_attachments": record_json_has_attachments(row.get::<_, String>(5)?.as_str()),
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_trash_items(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    list_trash_items_internal(&app)
}

fn record_json_has_attachments(record_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(record_json)
        .ok()
        .and_then(|value| {
            value.get("attachments").and_then(|attachments| {
                attachments.as_array().map(|items| !items.is_empty())
            })
        })
        .unwrap_or(false)
}

#[tauri::command]
pub fn trash_items_count(app: AppHandle) -> Result<u64, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT COUNT(*) FROM trash_items", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

/// 恢复：文件移回原位（同名自动加序号并同步记录路径），记录行整行回插。
/// 恢复出的文件会触发 watcher 到达事件，自动发现按路径去重（resource.rs
/// discover 的 by_path 表）——插行在前即不会重复建记录；仍按 resource_path
/// 兜底清理极端时序下可能已建的幽灵记录。
pub(crate) fn restore_trash_item_internal<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<(), String> {
    // 多根查找要在拿数据库锁之前完成：roots 解析要读 settings，而
    // conn 是不可重入 Mutex，锁内再取会死锁（purge 同样先 drop(conn)）。
    let library_root = get_resource_library_dir(app);
    let roots = resource_library_roots(app);
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

    let (record_id, record_json, original_path, trash_dir): (String, String, String, String) = conn
        .query_row(
            "SELECT record_id, record_json, original_path, trash_dir FROM trash_items WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| format!("回收站条目不存在: {e}"))?;

    // 幽灵清理：同路径的自动发现记录（不同 id）让位给完整元数据的恢复行。
    if !original_path.is_empty() {
        conn.execute(
            "DELETE FROM clipboard_records WHERE resource_path = ?1 AND id != ?2",
            params![original_path, record_id],
        )
        .map_err(|e| e.to_string())?;
    }

    // 回收目录按多根查找：删除后用户可能切换过资源库，.trash 留在历史
    // 库根（purge 已按多根清理，恢复保持同一口径）。都找不到时按当前根
    // 拼接，维持「无文件可移」的原语义。
    let trash_abs = roots
        .iter()
        .map(|root| trash_dir_absolute(root, &trash_dir))
        .find(|path| path.is_dir())
        .unwrap_or_else(|| trash_dir_absolute(&library_root, &trash_dir));

    // 文件移回：主文件按原 resource_path 落位，被占用则加序号并更新记录。
    let mut updated_json = record_json.clone();
    if !original_path.is_empty() {
        let restored = move_trash_files_back(&library_root, &trash_abs, &original_path)?;
        if let Some(final_path) = restored {
            if final_path != PathBuf::from(&original_path) {
                updated_json = rewrite_json_path(&record_json, &final_path)?;
            }
        }
    }

    reinsert_record_from_json(&conn, &updated_json)?;
    conn.execute("DELETE FROM trash_items WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&trash_abs);
    drop(conn);
    let _ = app.emit("resource-groups-changed", ());
    Ok(())
}

#[tauri::command]
pub fn restore_trash_item(app: AppHandle, id: String) -> Result<(), String> {
    restore_trash_item_internal(&app, &id)
}

/// 移回主文件；原位被占用时依次尝试 "name (1).ext"，返回最终落位路径
/// （None = 回收站内没有该文件，无需移动）。
fn move_trash_files_back(
    library_root: &Path,
    trash_abs: &Path,
    original_path: &str,
) -> Result<Option<PathBuf>, String> {
    let original = PathBuf::from(original_path);
    let Some(file_name) = original.file_name() else {
        return Ok(None);
    };
    let candidates: Vec<PathBuf> = {
        let mut found = Vec::new();
        let mut dir: PathBuf = trash_abs.to_path_buf();
        // 主文件直接位于回收目录根部；防御式向下找一层（附件目录除外）。
        loop {
            let candidate = dir.join(file_name);
            if candidate.is_file() {
                found.push(candidate);
                break;
            }
            match dir.read_dir() {
                Ok(entries) => {
                    let mut next = None;
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_dir()
                            && path.file_name().map(|n| n != "attachments").unwrap_or(false)
                        {
                            next = Some(path);
                            break;
                        }
                    }
                    match next {
                        Some(path) => dir = path,
                        None => break,
                    }
                }
                Err(_) => break,
            }
        }
        found
    };
    let Some(source) = candidates.into_iter().next() else {
        return Ok(None);
    };

    std::fs::create_dir_all(original.parent().unwrap_or(library_root))
        .map_err(|e| format!("创建原分组目录失败: {e}"))?;
    if !original.exists() {
        std::fs::rename(&source, &original).map_err(|e| format!("恢复文件失败: {e}"))?;
        return Ok(Some(original));
    }
    // 同名冲突：加序号后缀，并让调用方同步记录里的路径。
    let stem = original
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let extension = original
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    for index in 1..=999u32 {
        let candidate_name = if extension.is_empty() {
            format!("{stem} ({index})")
        } else {
            format!("{stem} ({index}).{extension}")
        };
        let candidate = original.with_file_name(candidate_name);
        if !candidate.exists() {
            std::fs::rename(&source, &candidate).map_err(|e| format!("恢复文件失败: {e}"))?;
            return Ok(Some(candidate));
        }
    }
    Err("恢复位置存在大量同名文件，无法自动命名".to_string())
}

/// 恢复落位路径与原路径不同时，同步 record_json 里的 content / resource_path。
fn rewrite_json_path(record_json: &str, final_path: &Path) -> Result<String, String> {
    let mut value: serde_json::Value =
        serde_json::from_str(record_json).map_err(|e| format!("解析记录失败: {e}"))?;
    if let Some(object) = value.as_object_mut() {
        let path_value = serde_json::Value::from(final_path.to_string_lossy().to_string());
        object.insert("content".to_string(), path_value.clone());
        object.insert("resource_path".to_string(), path_value);
    }
    serde_json::to_string(&value).map_err(|e| format!("序列化记录失败: {e}"))
}

/// 彻底删除：ids 为空表示清空全部。文件删除尽力而为（跨库历史根也找），
/// trash_items 行必删。
#[tauri::command]
pub fn purge_trash_items(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    purge_trash_internal(&app, if ids.is_empty() { None } else { Some(&ids) })?;
    let _ = app.emit("resource-groups-changed", ());
    Ok(())
}

pub(crate) fn purge_trash_internal<R: Runtime>(
    app: &AppHandle<R>,
    ids: Option<&[String]>,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, String)> = match ids {
        Some(ids) => {
            let mut out = Vec::new();
            for id in ids {
                if let Ok(row) = conn.query_row(
                    "SELECT id, trash_dir, record_json, record_id FROM trash_items WHERE id = ?1",
                    params![id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                ) {
                    out.push(row);
                }
            }
            out
        }
        None => {
            let mut stmt = conn
                .prepare("SELECT id, trash_dir, record_json, record_id FROM trash_items")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        }
    };
    drop(conn);
    let roots = resource_library_roots(app);
    for (id, trash_dir, record_json, record_id) in rows {
        for root in &roots {
            let _ = std::fs::remove_dir_all(root.join(&trash_dir));
        }
        // 附件清理：附件未随文件入回收站（留在库根 .copy-creator/attachments），
        // 彻底删除时按 record_json 清掉，避免孤儿附件无限累积。
        // 注意 attachments 列本身是 JSON 字符串，序列化后是双重编码。
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&record_json) {
            let attachments: Vec<String> = value
                .get("attachments")
                .and_then(|v| v.as_str())
                .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
                .unwrap_or_default();
            if !attachments.is_empty() {
                remove_resource_record_attachments_from_roots(&roots, &record_id, &attachments);
            }
        }
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM trash_items WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        drop(conn);
    }
    Ok(())
}

pub(crate) fn trash_retention_days<R: Runtime>(app: &AppHandle<R>) -> i64 {
    let state = app.state::<DbState>();
    let Ok(conn) = state.conn.lock() else {
        return DEFAULT_TRASH_RETENTION_DAYS;
    };
    conn.query_row(
        "SELECT value FROM settings WHERE key = 'trash_retention'",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|raw| raw.trim().parse::<i64>().ok())
    .filter(|days| *days > 0)
    .unwrap_or(DEFAULT_TRASH_RETENTION_DAYS)
}

/// 过期清理：随保留期清理任务（启动 + 每小时）执行。
pub(crate) fn purge_expired_trash<R: Runtime>(app: &AppHandle<R>) {
    let days = trash_retention_days(app);
    let cutoff_ms = chrono::Utc::now().timestamp_millis() - days * 86_400_000;
    if let Err(error) = purge_trash_expired_before(app, cutoff_ms) {
        log::warn!("回收站过期清理失败: {error}");
    }
}

fn purge_trash_expired_before<R: Runtime>(
    app: &AppHandle<R>,
    cutoff_ms: i64,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, trash_dir FROM trash_items WHERE trashed_ms < ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![cutoff_ms], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let expired: Vec<(String, String)> =
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    drop(stmt);
    drop(conn);
    if expired.is_empty() {
        return Ok(());
    }
    let ids: Vec<String> = expired.iter().map(|(id, _)| id.clone()).collect();
    purge_trash_internal(app, Some(&ids))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trash_retention_falls_back_to_thirty_days() {
        assert_eq!(DEFAULT_TRASH_RETENTION_DAYS, 30);
    }
}
