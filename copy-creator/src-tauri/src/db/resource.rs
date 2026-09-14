// 资源库域：库同步/发现、列表、分组树与增删改移、备注与文本内容。
// 从 db/mod.rs 机械搬迁；实现与行为不变，共享助手经 super::* 引用。
use super::*;
use rusqlite::params;
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[tauri::command]
pub fn read_resource_text_preview(app: AppHandle, path: String) -> Result<String, String> {
    let path = resolve_resource_file_path(&app, &path)?;
    read_resource_text_preview_file(path)
}

/// 粘贴场景的文本文件大小上限；预览是给人看的用 1 MB，粘贴是完整使用
/// 内容，放宽到 10 MB，超出仍按文件粘贴。
pub(crate) const RESOURCE_TEXT_PASTE_LIMIT_BYTES: u64 = 10 * 1024 * 1024;

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

/// 资源列表查询的中间行：只承载过滤与排序所需的标量字段。完整 JSON 组装
/// 与文件 stat 延迟到分页之后，仅对返回页（≤limit 行）执行——原先全量
/// 构建 JSON + 逐行 stat，数万文件的库每次查询都是十万级系统调用。
pub(crate) struct ResourceRow {
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

pub(crate) fn resource_record_value(
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

pub(crate) fn get_resource_records_inner<R: Runtime>(
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

#[tauri::command]
pub fn get_resource_library_path(app: AppHandle) -> Result<String, String> {
    Ok(get_resource_library_dir(&app).to_string_lossy().to_string())
}

pub(crate) fn validate_resource_library_path(app: &AppHandle, value: &str) -> Result<PathBuf, String> {
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

pub(crate) fn paths_overlap(left: &Path, right: &Path) -> bool {
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

pub(crate) fn set_resource_library_path_blocking(app: AppHandle, path: String) -> Result<String, String> {
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

pub(crate) fn resource_record_paths_in_folder<R: Runtime>(
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

pub(crate) fn update_resource_record_paths<R: Runtime>(
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

pub(crate) fn resource_group_count_map<R: Runtime>(
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
pub(crate) fn resource_group_total_under(counts: &HashMap<String, u64>, folder: &str) -> u64 {
    let nested_prefix = format!("{folder}/");
    counts
        .iter()
        .filter(|(key, _)| key.as_str() == folder || key.starts_with(&nested_prefix))
        .map(|(_, value)| value)
        .sum()
}

pub(crate) fn is_ignored_resource_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name == ".copy-creator" || name.starts_with('.'))
}

pub(crate) fn resource_directory_relative_path(root: &Path, directory: &Path) -> Option<String> {
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

pub(crate) fn resource_folder_tree(
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
pub(crate) const RESOURCE_GROUP_ORDER_KEY: &str = "resource_group_order";

pub(crate) fn read_resource_group_order(conn: &Connection) -> Vec<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![RESOURCE_GROUP_ORDER_KEY],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
    .unwrap_or_default()
}

pub(crate) fn write_resource_group_order(conn: &Connection, order: &[String]) -> Result<(), String> {
    let value = serde_json::to_string(order).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![RESOURCE_GROUP_ORDER_KEY, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn sort_resource_directories(
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
pub(crate) fn rewrite_resource_group_order<R: Runtime>(
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
pub(crate) fn rewrite_group_order_prefix(order: &mut [String], old_prefix: &str, new_prefix: &str) {
    let nested_prefix = format!("{old_prefix}/");
    for path in order.iter_mut() {
        if path.as_str() == old_prefix {
            *path = new_prefix.to_string();
        } else if let Some(rest) = path.strip_prefix(&nested_prefix) {
            *path = format!("{new_prefix}/{rest}");
        }
    }
}

pub(crate) fn remove_group_order_prefix(order: &mut Vec<String>, prefix: &str) {
    let nested_prefix = format!("{prefix}/");
    order.retain(|path| path.as_str() != prefix && !path.starts_with(&nested_prefix));
}

#[tauri::command]
pub fn reorder_resource_groups(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    reorder_resource_groups_inner(&app, ids)
}

pub(crate) fn reorder_resource_groups_inner<R: Runtime>(
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

pub(crate) fn get_resource_groups_inner<R: Runtime>(
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

pub(crate) fn create_resource_group_inner<R: Runtime>(
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

pub(crate) fn update_resource_group_inner<R: Runtime>(
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

pub(crate) fn rollback_moved_resource_files(moved: &[(PathBuf, PathBuf, Option<String>)]) {
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

pub(crate) fn rewrite_moved_resource_markdown_links(content: &str, from: &Path, group_path: &Path) -> String {
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

pub(crate) fn delete_resource_group_inner<R: Runtime>(app: &AppHandle<R>, name: String) -> Result<(), String> {
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

pub(crate) const RESOURCE_RENAME_MAX_LEN: usize = 120;

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

pub(crate) fn rename_resource_file_inner<R: Runtime>(
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

pub(crate) fn move_resource_records_inner<R: Runtime>(
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
pub(crate) fn rewrite_folder_markdown_links(
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

pub(crate) fn move_resource_group_inner<R: Runtime>(
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

pub(crate) const RESOURCE_NOTE_MAX_LEN: usize = 1000;

/// 保存资源备注。资源库中自动发现、尚未入库的文件在首次备注时补建记录，
/// 使备注跟随记录持久化并可参与搜索。
#[tauri::command]
pub fn set_resource_note(app: AppHandle, id: String, note: String) -> Result<String, String> {
    set_resource_note_inner(&app, id, note)
}

pub(crate) fn set_resource_note_inner<R: Runtime>(
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
pub(crate) fn resource_record_row_exists<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<bool, String> {
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
