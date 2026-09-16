// 剪切板记录域：列表查询、内容更新、删除、使用记录与置顶。
// 从 db/mod.rs 机械搬迁；实现与行为不变，共享助手经 super::* 引用。
use super::*;
use rusqlite::params;
use tauri::{AppHandle, Emitter, Manager, Runtime};

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
               AND NOT (storage_mode = 'resource')
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
pub(crate) fn clipboard_order_clause(sort_by: Option<&str>) -> &'static str {
    match sort_by {
        Some("count") => "(COALESCE(use_count, 0) = 0) ASC, use_count DESC,
                MAX(COALESCE(touched_ms, 0), sort_order) DESC",
        Some("recent") => "MAX(COALESCE(touched_ms, 0), sort_order) DESC",
        _ => "sort_order DESC",
    }
}

pub(crate) fn get_clipboard_records_inner<R: Runtime>(
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
pub(crate) fn enrich_api_key_records(
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
             WHERE storage_mode = 'resource'
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
pub(crate) fn emit_usage_updated<R: Runtime>(app: &AppHandle<R>, ids: &[String], touched: bool) {
    if touched {
        let _ = app.emit("clipboard-record-updated", ids);
    }
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

/// 判断路径是否已被应用记录在案：剪切板记录（content / resource_path /
/// attachments 元素）或文件快捷输入的源路径（phrases.source_path，用户
/// 挑选文件时的原始位置），精确匹配、英文字母不区分大小写。媒体服务
/// 白名单的补充例外：这些记录可以指向管理目录之外的任意位置，展示与
/// 粘贴它们本就是应用既有能力（paste 路径同样无目录限制）；媒体服务据
/// 此前提放行"记录在案"的路径。必须是全等比较——子串匹配会让注入者用
/// 短路径轻松命中记录，白名单形同虚设。
pub(crate) fn is_recorded_file_path<R: Runtime>(app: &AppHandle<R>, path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    let path_eq = |candidate: &str| {
        candidate.eq_ignore_ascii_case(path)
    };
    let state = app.state::<DbState>();
    let Ok(conn) = state.conn.lock() else {
        return false;
    };
    let content_hit = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM clipboard_records
                 WHERE content = ?1 COLLATE NOCASE OR resource_path = ?1 COLLATE NOCASE)
              + EXISTS(SELECT 1 FROM phrases
                 WHERE input_type = 'file' AND source_path = ?1 COLLATE NOCASE)",
            params![path],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0);
    if content_hit > 0 {
        return true;
    }
    let attachments_in_db = || -> Result<Vec<String>, rusqlite::Error> {
        let mut stmt = conn.prepare(
            "SELECT attachments FROM clipboard_records WHERE attachments IS NOT NULL AND attachments != '[]'",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect()
    };
    let Ok(attachments_rows) = attachments_in_db() else {
        return false;
    };
    attachments_rows.iter().any(|attachments| {
        serde_json::from_str::<Vec<String>>(attachments)
            .map(|paths| paths.iter().any(|item| path_eq(item)))
            .unwrap_or(false)
    })
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

pub(crate) fn delete_external_resource_file<R: Runtime>(
    _app: &AppHandle<R>,
    path: &Path,
) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|error| format!("删除资源文件失败: {error}"))
}

pub(crate) struct StagedExternalResourceFile {
    id: String,
    original_path: PathBuf,
    staged_path: PathBuf,
}

pub(crate) fn stage_external_resource_files<R: Runtime>(
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

pub(crate) fn restore_staged_external_resource_files(staged: &[StagedExternalResourceFile]) {
    for file in staged.iter().rev() {
        if file.staged_path.exists() {
            let _ = std::fs::rename(&file.staged_path, &file.original_path);
        }
    }
}

pub(crate) fn finalize_staged_external_resource_files<R: Runtime>(
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

pub(crate) fn delete_clipboard_records_internal<R: Runtime>(
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
pub fn move_clipboard_records_to_top(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    move_rows_to_top(&conn, "clipboard_records", &ids)?;
    log::info!("move_clipboard_records_to_top: {} items", ids.len());
    Ok(())
}
