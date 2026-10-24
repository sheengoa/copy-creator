// 回收站域：应用内删除资源改为移入**系统回收站**（Windows Shell COM /
// Linux freedesktop 规范，经 trash_backend 抽象；测试注入临时目录 fake，
// 绝不触碰真实系统回收站），记录整行序列化进 trash_items（恢复时原样
// 回插，保住分组/备注/类型等全部元数据）。恢复优先按原始路径从系统回收
// 站找回最新一版——资源管理器里删除的文件同样在系统回收站，对账/监听
// 产生的占位条目因此也能真实恢复。
// 时序硬约束：trash_items 行必须与 clipboard_records 行在同一事务内落库，
// 文件移入系统回收站放在事务提交后——watcher 裁决（forget/relocate）只
// 作用于 clipboard_records 现存行，settle 运行时行已不在，不会被误清退
// 或跟随重定向；删除进行中守卫（delete_in_flight）覆盖事务到移入全程，
// 防 settle 的补录把窗口内的现存文件当外部新文件重建记录。文件移入失败
// 则整体补偿回滚（文件从系统回收站恢复回原位 + 记录行回插）。
// 历史兼容：旧版本把回收站文件放在库外隐藏目录（.<库名>.trash）或库内
// .trash，启动迁移会把它们改送系统回收站；迁移前的行仍按旧桶位置恢复
// （resolve_trash_bucket / find_file_in_bucket / move_trash_files_back）。
use super::*;
use rusqlite::{params, params_from_iter};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::trash_backend::{bin_path_eq, trash_backend, TrashBackend};

pub(crate) const TRASH_DIR_NAME: &str = ".trash";
/// v1 常量；settings 键 trash_retention 预留，设置页暴露放后续版本。
pub(crate) const DEFAULT_TRASH_RETENTION_DAYS: i64 = 30;

/// 待移入系统回收站的文件描述：主事务提交后逐项送入。附件不随文件进
/// 系统回收站——它们留在库根 .copy-creator/attachments（组只是 md 内的
/// 相对链接前缀），恢复后内链仍然有效；彻底删除时按 record_json 清理
/// 附件。
#[derive(Clone)]
pub(crate) struct TrashedResourceFile {
    pub trash_id: String,
    pub record_id: String,
    pub resource_path: String,
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
    })
}

fn trash_dir_absolute(library_root: &Path, trash_dir: &str) -> PathBuf {
    library_root.join(trash_dir)
}

/// 回收站实际存放根：库根的同级隐藏目录。与库同盘——删除/恢复是同盘
/// 原子重命名（大体积也是瞬间完成，不占用系统盘）；在库外——用户清理、
/// 误删资源库文件夹时不会连带删掉回收站。
fn sibling_trash_base(library_root: &Path) -> PathBuf {
    let base = library_root
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("library");
    library_root
        .parent()
        .unwrap_or(library_root)
        .join(format!(".{base}.trash"))
}

fn sibling_trash_dir(library_root: &Path, trash_dir: &str) -> PathBuf {
    sibling_trash_base(library_root).join(trash_dir)
}

/// 回收目录解析（按优先级）：当前库根的同级隐藏目录（新位置）→ 各根的
/// sibling 与库内旧位置（迁移前的历史遗留）。返回 None 表示桶目录不存在
/// （对账转存的占位条目，或文件已被外部清理）——恢复与条目实体判定
/// （has_file）共用同一口径。
fn resolve_trash_bucket(
    roots: &[PathBuf],
    library_root: &Path,
    trash_dir: &str,
) -> Option<PathBuf> {
    let sibling_abs = sibling_trash_dir(library_root, trash_dir);
    if sibling_abs.is_dir() {
        return Some(sibling_abs);
    }
    roots
        .iter()
        .flat_map(|root| {
            [
                sibling_trash_dir(root, trash_dir),
                trash_dir_absolute(root, trash_dir),
            ]
        })
        .chain(std::iter::once(trash_dir_absolute(
            library_root,
            trash_dir,
        )))
        .find(|path| path.is_dir())
}

/// 一次性迁移：历史版本把回收站文件放在库外隐藏目录（.<库名>.trash）
/// 或库内 .trash——启动时逐文件改送系统回收站。能对上 trash_items 行且
/// 原始路径未被占用的文件先移回原位再送入（系统回收站记录的原始路径
/// 与条目一致，恢复匹配才成立）；对不上行或被占用的直接从桶位置送入
/// （用户在系统回收站可见、可手动还原，绝不静默删除）。迁移后删除已
/// 清空的遗留目录；送入失败的文件保留原状，下次启动重试。
pub(crate) fn migrate_trash_out_of_library<R: Runtime>(app: &AppHandle<R>) {
    let mut roots = resource_library_roots(app);
    let current = get_resource_library_dir(app);
    if !roots.iter().any(|root| root == &current) {
        roots.push(current.clone());
    }
    let rows: Vec<(String, String, String)> = {
        let state = app.state::<DbState>();
        let Ok(conn) = state.conn.lock() else {
            return;
        };
        conn.prepare("SELECT id, original_path, trash_dir FROM trash_items")
            .and_then(|mut stmt| {
                stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
            })
            .unwrap_or_default()
    };
    // 行索引：桶目录名（trash_dir 尾段）→ 原始路径。
    let mut original_by_bucket: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for (_, original_path, trash_dir) in &rows {
        if let Some(tail) = trash_dir.rsplit('/').next() {
            original_by_bucket.insert(tail.to_string(), original_path.clone());
        }
    }
    let ops = trash_backend();
    let mut migrated = 0usize;
    for root in &roots {
        for legacy_base in [sibling_trash_base(root), root.join(TRASH_DIR_NAME)] {
            if !legacy_base.is_dir() {
                continue;
            }
            for file in walk_files(&legacy_base) {
                let Some(bucket_name) = file
                    .parent()
                    .and_then(|parent| parent.file_name())
                    .and_then(|name| name.to_str())
                else {
                    continue;
                };
                let sent = match original_by_bucket
                    .get(bucket_name)
                    .filter(|path| !path.is_empty())
                    .map(PathBuf::from)
                {
                    // 原位未被占用：先回位再送入。
                    Some(path) if !path.exists() => {
                        if let Some(parent) = path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        std::fs::rename(&file, &path).is_ok() && ops.send_to_trash(&path).is_ok()
                    }
                    // 原位被占用或行已消费：直接从桶位置送入。
                    _ => ops.send_to_trash(&file).is_ok(),
                };
                if sent {
                    migrated += 1;
                }
            }
            // 全部送出（rename 是移动）后自底向上清理空目录树（只删空
            // 目录；有失败残留文件的层级保留，下次启动重试）。
            remove_empty_dir_tree(&legacy_base);
        }
    }
    if migrated > 0 {
        log::info!("历史回收桶已改送系统回收站（迁移 {migrated} 项）");
    }
}

/// 递归收集目录下的全部文件（回收桶条目目录结构简单，深度有限）。
fn walk_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push(path);
            }
        }
    }
    out
}

/// 自底向上删除空目录树：只删目录、不删任何文件；非空层级 remove_dir
/// 自然失败并保留（供下次启动重试迁移）。
fn remove_empty_dir_tree(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                remove_empty_dir_tree(&path);
            }
        }
    }
    let _ = std::fs::remove_dir(dir);
}

/// 主事务提交后：把资源文件移入系统回收站。任一项失败即整体补偿——
/// 已移入的文件从系统回收站恢复回原位（send 刚成功，匹配项必为本次
/// 删除的那条）、trash_items 行删除、记录行从 record_json 回插，对外
/// 表现为删除失败（不丢数据）。返回「文件在删除之前就已不在磁盘、仅
/// 记录行入桶」的条目数，供删除结果如实告知用户。
pub(crate) fn move_trashed_resource_files<R: Runtime>(
    app: &AppHandle<R>,
    roots: &[PathBuf],
    items: &[TrashedResourceFile],
) -> Result<u32, String> {
    let ops = trash_backend();
    let mut files_already_missing = 0u32;
    // completed 记录已移入系统回收站条目的原位路径——补偿恢复按它从
    // 系统回收站找回（send_to_trash 之后原位必然已空，匹配项唯一且
    // 是本次删除的那条）。
    let mut completed: Vec<(&TrashedResourceFile, Option<PathBuf>)> = Vec::new();
    let result = (|| -> Result<(), String> {
        for item in items {
            // 定位主文件；文件已不在磁盘则只留记录行（占位条目——恢复时
            // 优先按原始路径从系统回收站找回，其次同名关联）。
            let Some(source) = resolve_trash_source(roots, &item.record_id, &item.resource_path)
            else {
                files_already_missing += 1;
                completed.push((item, None));
                continue;
            };
            if let Err(error) = ops.send_to_trash(&source) {
                return Err(format!("移入系统回收站失败: {error}"));
            }
            completed.push((item, Some(source)));
        }
        Ok(())
    })();

    if let Err(error) = result {
        for (item, source) in completed.iter().rev() {
            if let Some(source) = source {
                if let Err(restore_error) = ops.restore_newest(source) {
                    // 补偿恢复失败不中断其余项的补偿：文件仍在系统回收站
                    // （用户可手动还原），记录行照常回插保证列表一致。
                    log::error!(
                        "删除补偿从系统回收站恢复文件失败（trash={}，文件可手动还原）: {restore_error}",
                        item.trash_id
                    );
                }
            }
            compensate_trash_item(app, item.trash_id.as_str());
        }
        return Err(error);
    }
    Ok(files_already_missing)
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

/// 对账/监听清退的兜底转存：把"文件已不在库内"的记录整行转入应用内
/// 回收站，而不是直接删除——记录永不对账即消失，用户可在回收站查看、
/// 恢复（优先按原始路径从系统回收站找回——资源管理器删除的文件就在
/// 那里；其次同名文件自动关联）或彻底删除。
/// 注意：原文件已不在磁盘、也不再另存副本，has_file 由系统回收站匹配
/// 与同名关联兜底判定；恢复时还会走同名文件自动关联兜底。
pub(crate) fn archive_resource_record_to_trash(
    conn: &rusqlite::Connection,
    root: &Path,
    record_id: &str,
    resource_path: &str,
) -> Result<(), String> {
    let record_json = serialize_resource_record(conn, record_id)?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let trash_id = uuid::Uuid::new_v4().to_string();
    let trash_dir = format!(
        "{}/{}-{}",
        TRASH_DIR_NAME,
        now_ms,
        uuid::Uuid::new_v4().simple()
    );
    let original_group = resource_group_for_path(root, resource_path).unwrap_or_default();
    let file_name = Path::new(resource_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    conn.execute(
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
    conn.execute("DELETE FROM api_key_labels WHERE record_id = ?1", params![record_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM clipboard_records WHERE id = ?1", params![record_id])
        .map_err(|e| e.to_string())?;
    Ok(())
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
    let mut values: Vec<rusqlite::types::Value> = Vec::new();
    for (key, value) in object {
        if key == "__api_key_label" {
            continue;
        }
        // NULL 列整列跳过：回插来自同表序列化，缺列即回落建表默认值。
        // 若按文本写入空串，INTEGER/REAL 列会存成 TEXT，列表查询按数值
        // 读取时直接类型报错，一条恢复过的脏行就能炸掉整个列表（真实
        // 事故：「资源列表加载失败」重试无效）。
        if value.is_null() {
            continue;
        }
        columns.push(key.clone());
        let sql_value = match value {
            serde_json::Value::String(s) => rusqlite::types::Value::Text(s.clone()),
            serde_json::Value::Number(n) => {
                if let Some(int) = n.as_i64() {
                    rusqlite::types::Value::Integer(int)
                } else {
                    rusqlite::types::Value::Real(n.as_f64().unwrap_or_default())
                }
            }
            serde_json::Value::Bool(flag) => {
                rusqlite::types::Value::Integer(i64::from(*flag))
            }
            other => rusqlite::types::Value::Text(other.to_string()),
        };
        values.push(sql_value);
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
    // 多根/库根解析与系统回收站快照都要在拿数据库锁之前完成（锁序约束）。
    let library_root = get_resource_library_dir(app);
    let roots = resource_library_roots(app);
    let bin_paths = trash_backend().list_original_paths()?;
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, file_name, original_group, original_path, trashed_at, record_json, trash_dir
             FROM trash_items ORDER BY trashed_ms DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, String, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    drop(conn);
    Ok(rows
        .into_iter()
        .map(
            |(id, file_name, original_group, original_path, trashed_at, record_json, trash_dir)| {
                // 条目实体判定（运行时判定，不持久化——磁盘与系统回收站
                // 随时在变）：原位文件还在，或系统回收站有该原始路径的
                // 条目（含资源管理器删除的文件），或历史桶目录内能找到
                // （迁移前的遗留条目）。三者皆无才如实标为文件已丢失。
                let original = Path::new(&original_path);
                let has_file = original.is_file()
                    || bin_paths
                        .iter()
                        .any(|entry| bin_path_eq(&entry.original_path, original))
                    || match original.file_name() {
                        Some(name) => resolve_trash_bucket(&roots, &library_root, trash_dir.as_str())
                            .and_then(|bucket| find_file_in_bucket(&bucket, name))
                            .is_some(),
                        None => false,
                    };
                serde_json::json!({
                    "id": id,
                    "file_name": file_name,
                    "original_group": original_group,
                    "original_path": original_path,
                    "trashed_at": trashed_at,
                    "has_attachments": record_json_has_attachments(&record_json),
                    "has_file": has_file,
                })
            },
        )
        .collect())
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

/// 恢复：优先从系统回收站按原始路径找回最新一版（应用内删除与资源
/// 管理器删除都覆盖），记录行整行回插。恢复出的文件会触发 watcher 到达
/// 事件，自动发现按路径去重（resource.rs discover 的 by_path 表）——
/// 插行在前即不会重复建记录；仍按 resource_path 兜底清理极端时序下
/// 可能已建的幽灵记录。单条恢复结果三态。
/// - Restored：原位文件还在（视同恢复），或从系统回收站恢复回原位，
///   或从历史回收桶移回原位；
/// - Relinked：回收站与历史桶都无文件，但库内存在唯一同名文件，记录
///   改指过去（记录跟随文件，不移动用户整理好的目录结构）；
/// - MetadataOnly：都找不到文件（或同名候选多于一个），仅恢复记录
///   元数据——文件已被彻底清除，恢复无法凭空还原。
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RestoreOutcome {
    Restored,
    Relinked,
    MetadataOnly,
}

/// 在库根们之下按文件名查找唯一同名文件。跳过点开头的元数据目录
/// （.trash / .copy-creator 等，与资源扫描同一口径）；零个或多个同名
/// 候选都返回 None——多个候选无法替用户做选择，宁可不关联。
fn find_same_named_file(roots: &[PathBuf], file_name: &str) -> Option<PathBuf> {
    let mut found: Option<PathBuf> = None;
    for root in roots {
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let hidden = path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(|name| name.starts_with('.'))
                        .unwrap_or(true);
                    if !hidden {
                        stack.push(path);
                    }
                } else if path.file_name().and_then(|name| name.to_str()) == Some(file_name) {
                    if found.is_some() {
                        return None;
                    }
                    found = Some(path);
                }
            }
        }
    }
    found
}

pub(crate) fn restore_trash_item_internal<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<RestoreOutcome, String> {
    // 多根/库根解析与回收站后端获取都要在拿数据库锁之前完成（锁序约束：
    // roots 解析要读 settings，conn 是不可重入 Mutex，锁内再取会死锁）。
    let library_root = get_resource_library_dir(app);
    let roots = resource_library_roots(app);
    let ops = trash_backend();
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let outcome = restore_trash_item_on_conn(&conn, &library_root, &roots, ops.as_ref(), id)?;
    drop(conn);
    let _ = app.emit("resource-groups-changed", ());
    Ok(outcome)
}

/// 恢复核心：调用方须已持有数据库锁（不可重入），本函数自身不再加锁。
/// ops 由调用方传入（单条与批量恢复、同名复活共用）。
pub(crate) fn restore_trash_item_on_conn(
    conn: &rusqlite::Connection,
    library_root: &Path,
    roots: &[PathBuf],
    ops: &dyn TrashBackend,
    id: &str,
) -> Result<RestoreOutcome, String> {
    let (record_id, record_json, original_path, trash_dir): (String, String, String, String) = conn
        .query_row(
            "SELECT record_id, record_json, original_path, trash_dir FROM trash_items WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| format!("回收站条目不存在: {e}"))?;

    let original = PathBuf::from(&original_path);

    // 文件找回判定（按优先级）：
    // 1) 原位文件还在（恢复前被外部放回）→ 视同恢复，无需移动；
    // 2) 系统回收站有该原始路径的条目 → 恢复最新一版回原路径（应用内
    //    删除与资源管理器删除都走这里；父目录可能已被整组清理，先建）；
    // 3) 历史回收桶（迁移前的遗留条目）内有该文件 → 移回原位，被占用
    //    自动加序号并同步记录路径；
    // 4) 库内唯一同名文件 → 改指过去；
    // 5) 都没有 → 仅恢复元数据。
    let mut updated_json = record_json.clone();
    let (outcome, effective_path) = if original.is_file() {
        (RestoreOutcome::Restored, original.clone())
    } else if !original_path.is_empty()
        && ops
            .list_original_paths()?
            .iter()
            .any(|entry| bin_path_eq(&entry.original_path, &original))
    {
        if let Some(parent) = original.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建原分组目录失败: {e}"))?;
        }
        ops.restore_newest(&original)?;
        (RestoreOutcome::Restored, original.clone())
    } else {
        // 历史回收桶遗留（启动迁移完成前的旧条目）：原桶恢复语义整段保留。
        let trash_abs = resolve_trash_bucket(roots, library_root, trash_dir.as_str());
        match move_trash_files_back(trash_abs.as_deref(), original_path.as_str())? {
            Some(final_path) => {
                if final_path != original {
                    updated_json = rewrite_json_path(&record_json, &final_path)?;
                }
                (RestoreOutcome::Restored, final_path)
            }
            None => {
                let file_name = original
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default();
                match find_same_named_file(roots, &file_name) {
                    Some(found) => {
                        updated_json = rewrite_json_path(&record_json, &found)?;
                        (RestoreOutcome::Relinked, found)
                    }
                    None => (RestoreOutcome::MetadataOnly, original.clone()),
                }
            }
        }
    };

    // id 级联改写：resource-file 形态的 id 内嵌路径，落位路径与原路径
    // 不一致时（同名改指/带序号落位）必须连 id 一起改写——与外部目录
    // 重定向同一语义，否则 id 与 resource_path 脱节，以 id 提取路径的
    // 操作（删除暂存、按 id 解析）会永远指向旧位置（真实事故：记录 id
    // 指旧目录、文件在新位置）。非该形态 id（uuid 等用户侧标识）不改写。
    let effective_record_id = if record_id.starts_with(RESOURCE_FILE_ID_PREFIX)
        && effective_path != original
    {
        let derived_id = resource_file_id(&effective_path);
        updated_json = rewrite_json_id(&updated_json, &derived_id)?;
        derived_id
    } else {
        record_id.clone()
    };

    // 幽灵清理：同路径的自动发现记录（不同 id）让位给完整元数据的恢复行。
    // 原路径与最终落位路径都清一遍——改指（relink）后新路径下可能存在
    // 自动发现行，不清理会与恢复行并存成双记录；同 id 的幽灵行由
    // reinsert 的 INSERT OR REPLACE 直接替换。
    let effective_str = effective_path.to_string_lossy().to_string();
    for ghost_path in [original_path.as_str(), effective_str.as_str()] {
        if !ghost_path.is_empty() {
            conn.execute(
                "DELETE FROM clipboard_records WHERE resource_path = ?1 AND id != ?2",
                params![ghost_path, effective_record_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    reinsert_record_from_json(conn, &updated_json)?;
    // 文件已实际回位/改指到存在的文件：缺失标志清零（record_json 带回的
    // 是入桶前的旧值，对 MetadataOnly 保留——文件仍缺失，如实维持）。
    // 用生效 id：id 已级联改写时旧 id 不再对应任何行。
    if !matches!(outcome, RestoreOutcome::MetadataOnly) {
        conn.execute(
            "UPDATE clipboard_records SET resource_missing = 0 WHERE id = ?1",
            params![effective_record_id],
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute("DELETE FROM trash_items WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    // 历史回收桶遗留：恢复完成后清理该条目的桶目录（迁移后的新条目
    // 从不落桶，解析返回 None 自然跳过）。
    if let Some(bucket) = resolve_trash_bucket(roots, library_root, trash_dir.as_str()) {
        let _ = std::fs::remove_dir_all(bucket);
    }
    Ok(outcome)
}

#[tauri::command]
pub fn restore_trash_item(app: AppHandle, id: String) -> Result<RestoreOutcome, String> {
    restore_trash_item_internal(&app, &id)
}

/// 批量恢复汇总：按三态计数，失败条目带 id 汇总返回（尽力而为，
/// 单条失败不中断整批）。
#[derive(serde::Serialize)]
pub struct RestoreBatchSummary {
    pub restored: u32,
    pub relinked: u32,
    pub metadata_only: u32,
    pub failed: Vec<String>,
}

/// 批量恢复：逐条复用单条恢复（各自加锁、文件移动互相独立）。
/// resource-groups-changed 由单条内部各自发出，前端监听方按最终一次刷新即可。
#[tauri::command]
pub fn restore_trash_items(
    app: AppHandle,
    ids: Vec<String>,
) -> Result<RestoreBatchSummary, String> {
    let mut summary = RestoreBatchSummary {
        restored: 0,
        relinked: 0,
        metadata_only: 0,
        failed: Vec::new(),
    };
    for id in &ids {
        match restore_trash_item_internal(&app, id) {
            Ok(RestoreOutcome::Restored) => summary.restored += 1,
            Ok(RestoreOutcome::Relinked) => summary.relinked += 1,
            Ok(RestoreOutcome::MetadataOnly) => summary.metadata_only += 1,
            Err(error) => summary.failed.push(format!("{id}: {error}")),
        }
    }
    Ok(summary)
}

/// 在桶目录内定位主文件：主文件直接位于桶根；防御式向下找一层
/// （attachments 目录除外）。恢复与条目实体判定共用同一口径。
fn find_file_in_bucket(bucket: &Path, file_name: &OsStr) -> Option<PathBuf> {
    let mut dir: PathBuf = bucket.to_path_buf();
    loop {
        let candidate = dir.join(file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
        let entries = dir.read_dir().ok()?;
        let mut next = None;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path.file_name().map(|n| n != "attachments").unwrap_or(false) {
                next = Some(path);
                break;
            }
        }
        dir = next?;
    }
}

/// 移回主文件到原位（调用方已判定原位不存在）。返回是否实际移动
/// （None = 历史桶内没有该文件，无需移动）。仅供迁移完成前的历史
/// 桶遗留条目恢复使用。
fn move_trash_files_back(
    trash_abs: Option<&Path>,
    original_path: &str,
) -> Result<Option<PathBuf>, String> {
    let original = PathBuf::from(original_path);
    let Some(file_name) = original.file_name() else {
        return Ok(None);
    };
    let Some(source) = trash_abs.and_then(|bucket| find_file_in_bucket(bucket, file_name)) else {
        return Ok(None);
    };

    if let Some(parent) = original.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建原分组目录失败: {e}"))?;
    }
    if !original.exists() {
        std::fs::rename(&source, &original).map_err(|e| format!("恢复文件失败: {e}"))?;
        return Ok(Some(original));
    }
    // 原位被占用时视同恢复（调用方判定树第 1 步已先行处理，此处仅防御）：
    // 不覆盖占用文件，桶内副本保留待用户在系统侧处理。
    Ok(None)
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

/// id 级联改写：落位路径变化时同步 record_json 里的 id（reinsert 的
/// INSERT OR REPLACE 以 id 定位行），api_key_labels 由 reinsert 依据
/// JSON 内的 id 自动落新键。
fn rewrite_json_id(record_json: &str, new_id: &str) -> Result<String, String> {
    let mut value: serde_json::Value =
        serde_json::from_str(record_json).map_err(|e| format!("解析记录失败: {e}"))?;
    if let Some(object) = value.as_object_mut() {
        object.insert("id".to_string(), serde_json::Value::from(new_id));
    }
    serde_json::to_string(&value).map_err(|e| format!("序列化记录失败: {e}"))
}

/// 彻底删除：ids 为空表示清空全部。文件删除尽力而为——系统回收站内
/// 按原始路径清除全部匹配条目（可能已被用户在系统侧清空），历史回收
/// 桶遗留一并清理；trash_items 行必删。
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
    let rows: Vec<(String, String, String, String, String)> = match ids {
        Some(ids) => {
            let mut out = Vec::new();
            for id in ids {
                if let Ok(row) = conn.query_row(
                    "SELECT id, original_path, record_json, record_id, trash_dir FROM trash_items WHERE id = ?1",
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
                ) {
                    out.push(row);
                }
            }
            out
        }
        None => {
            let mut stmt = conn
                .prepare("SELECT id, original_path, record_json, record_id, trash_dir FROM trash_items")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        }
    };
    drop(conn);
    let roots = resource_library_roots(app);
    // 历史回收桶遗留（迁移完成前的旧条目）随彻底删除一并清理；迁移后
    // 的新条目从不落桶，remove_dir_all 对不存在目录是静默 no-op。
    let purge_bases: Vec<PathBuf> = roots
        .iter()
        .flat_map(|root| {
            [
                root.as_path().to_path_buf(),
                sibling_trash_base(root),
            ]
        })
        .collect();
    let ops = trash_backend();
    // 系统回收站批量清除：一次枚举覆盖全部原始路径（best-effort——条目
    // 可能已被用户在系统侧清空，失败仅留痕不阻断记录行清理）。
    let mut bin_targets: Vec<PathBuf> = rows
        .iter()
        .map(|(_, original_path, ..)| original_path)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .collect();
    bin_targets.sort();
    bin_targets.dedup();
    if !bin_targets.is_empty() {
        if let Err(error) = ops.purge_batch(&bin_targets) {
            log::warn!("从系统回收站彻底清除失败: {error}");
        }
    }
    for (id, _original_path, record_json, record_id, trash_dir) in rows {
        for base in &purge_bases {
            let _ = std::fs::remove_dir_all(base.join(&trash_dir));
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

/// 清理截止时间：天数用饱和乘法换算毫秒——trash_retention 虽尚未在设置
/// 页暴露，但设置键已存在，极端值在普通乘法下会溢出（debug 构建 panic，
/// release 回绕成小值导致回收站被全量清空）。饱和后截止时间远早于任何
/// trashed_ms，保守方向等于不清理。
fn trash_cutoff_ms(now_ms: i64, days: i64) -> i64 {
    now_ms.saturating_sub(days.saturating_mul(86_400_000))
}

/// 过期清理：随保留期清理任务（启动 + 每小时）执行。
pub(crate) fn purge_expired_trash<R: Runtime>(app: &AppHandle<R>) {
    let days = trash_retention_days(app);
    let cutoff_ms = trash_cutoff_ms(chrono::Utc::now().timestamp_millis(), days);
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

    #[test]
    fn trash_cutoff_saturates_extreme_retention_days() {
        let now = 1_789_000_000_000_i64;
        assert_eq!(trash_cutoff_ms(now, 30), now - 30 * 86_400_000);
        // 极端大值不溢出：截止时间远早于任何真实 trashed_ms（等于不清理）。
        assert!(trash_cutoff_ms(now, i64::MAX) < now - 365 * 86_400_000);
        assert!(trash_cutoff_ms(now, i64::MAX) < 1_000_000_000_000);
    }
}
