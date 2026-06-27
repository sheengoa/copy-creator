use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

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
    if c.len() >= 12 {
        format!("{}...{}", &c[..8], &c[c.len() - 4..])
    } else {
        c.to_string()
    }
}

fn category_sql(category: &Option<String>) -> (String, String) {
    match category.as_deref() {
        Some("text") => ("WHERE type = 'text'".to_string(), "AND type = 'text'".to_string()),
        Some("image") => ("WHERE type = 'image'".to_string(), "AND type = 'image'".to_string()),
        Some("link") => ("WHERE type = 'link'".to_string(), "AND type = 'link'".to_string()),
        Some("file") => ("WHERE type = 'file'".to_string(), "AND type = 'file'".to_string()),
        Some("apikey") => (
            "WHERE (user_api_key = 1 OR (type IN ('text', 'link') AND (content LIKE 'sk-%' OR content LIKE 'AIza%' OR content LIKE 'glpat-%' OR content LIKE 'ghp_%' OR content LIKE 'xai-%')))".to_string(),
            "AND (user_api_key = 1 OR (type IN ('text', 'link') AND (content LIKE 'sk-%' OR content LIKE 'AIza%' OR content LIKE 'glpat-%' OR content LIKE 'ghp_%' OR content LIKE 'xai-%')))".to_string(),
        ),
        _ => ("".to_string(), "".to_string()),
    }
}

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

pub struct DbState {
    pub conn: Mutex<Connection>,
}

const CLIPBOARD_CONTENT_PREVIEW_CHARS: usize = 600;
const QUICK_INPUT_FILE_LIMIT_BYTES: u64 = 50 * 1024 * 1024;

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

fn clipboard_record_json(
    id: String,
    rec_type: String,
    content: String,
    source_app: String,
    created_at: String,
    user_api_key: i64,
) -> serde_json::Value {
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

pub fn get_storage_dir(app: &AppHandle) -> PathBuf {
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

fn quick_input_files_dir(app: &AppHandle) -> PathBuf {
    let dir = get_storage_dir(app).join("quick-input-files");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn quick_input_relative_path(dir_name: &str, filename: &str) -> String {
    format!("quick-input-files/{}/{}", dir_name, filename)
}

fn is_legacy_quick_input_file_path(relative_path: &str) -> bool {
    let Some(rest) = relative_path.strip_prefix("quick-input-files/") else {
        return false;
    };
    !rest.is_empty() && !rest.contains('/')
}

fn quick_input_absolute_path(app: &AppHandle, relative_path: &str) -> PathBuf {
    get_storage_dir(app).join(relative_path)
}

fn remove_quick_input_file(app: &AppHandle, relative_path: &str) {
    if relative_path.starts_with("quick-input-files/") {
        let path = quick_input_absolute_path(app, relative_path);
        let _ = std::fs::remove_file(&path);
        if let Some(parent) = path.parent() {
            if parent != quick_input_files_dir(app) {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }
}

fn copy_quick_input_file(app: &AppHandle, source_path: &str) -> Result<(String, u64), String> {
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
    Ok((quick_input_relative_path(&dir_name, original_filename), size))
}

fn legacy_quick_input_target_path(relative_path: &str, source_path: &str) -> Option<String> {
    if !is_legacy_quick_input_file_path(relative_path) {
        return None;
    }

    let stored_name = relative_path.strip_prefix("quick-input-files/")?;
    let dir_name = std::path::Path::new(stored_name).file_stem()?.to_str()?;
    let original_filename = std::path::Path::new(source_path).file_name()?.to_str()?;
    if original_filename.is_empty() {
        return None;
    }

    Some(quick_input_relative_path(dir_name, original_filename))
}

fn migrate_legacy_quick_input_file_names(app: &AppHandle) {
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
        let mut stmt = match conn.prepare(
            "SELECT id, content, source_path FROM phrases WHERE input_type = 'file'",
        ) {
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
        let old_path = storage_dir.join(&old_relative_path);
        let new_path = storage_dir.join(&new_relative_path);
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

pub fn init_db(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let path = db_path(app);
    let conn = Connection::open(&path)?;

    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8000;",
    )?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS clipboard_records (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            source_app TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            user_api_key INTEGER DEFAULT 0
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

    app.manage(DbState {
        conn: Mutex::new(conn),
    });
    migrate_legacy_quick_input_file_names(app);

    Ok(())
}

pub fn prune_old_records(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let days;
    let image_contents: Vec<String>;

    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;

        let retention: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'clipboard_retention'",
                [],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| "1month".to_string());

        days = match retention.as_str() {
            "1week" => 7,
            "3months" => 90,
            _ => 30,
        };

        // Collect image records before deletion for file cleanup
        {
            let mut stmt = conn.prepare(
                "SELECT content FROM clipboard_records WHERE type = 'image' AND datetime(created_at) < datetime('now', ?1)",
            )?;
            let rows = stmt.query_map(params![format!("-{} days", days)], |row| {
                row.get::<_, String>(0)
            })?;
            image_contents = rows.filter_map(|r| r.ok()).collect();
        }

        conn.execute(
            "DELETE FROM clipboard_records WHERE datetime(created_at) < datetime('now', ?1)",
            params![format!("-{} days", days)],
        )?;
    }

    // Clean up image files and thumbnails only if no remaining records reference them.
    // Content-hash filenames mean multiple records can share the same file on disk.
    let base_dir = get_storage_dir(app);
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    for content in &image_contents {
        let still_referenced: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM clipboard_records WHERE content = ?1",
                params![content],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if still_referenced {
            continue;
        }
        let file_path = base_dir.join(content);
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

// ---- Tauri Commands ----

#[tauri::command]
pub fn get_clipboard_records(
    app: AppHandle,
    search: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    category: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let off = offset.unwrap_or(0);

    let cat_filter = category_sql(&category);

    let mut records: Vec<serde_json::Value> = Vec::new();

    if let Some(q) = search {
        let escaped = q
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let sql = format!(
            "SELECT id, type, content, source_app, created_at, user_api_key FROM clipboard_records
             WHERE content LIKE '%' || ?1 || '%' ESCAPE '\\' {} ORDER BY sort_order DESC LIMIT ?2 OFFSET ?3",
            cat_filter.1
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![escaped, lim, off], |row| {
                Ok(clipboard_record_json(
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            records.push(row.map_err(|e| e.to_string())?);
        }
    } else {
        let sql = format!(
            "SELECT id, type, content, source_app, created_at, user_api_key FROM clipboard_records
             {} ORDER BY sort_order DESC LIMIT ?1 OFFSET ?2",
            cat_filter.0
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![lim, off], |row| {
                Ok(clipboard_record_json(
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            records.push(row.map_err(|e| e.to_string())?);
        }
    }

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

    let records = records
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
        .collect();

    Ok(records)
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

#[tauri::command]
pub fn delete_all_clipboard_records(app: AppHandle) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM clipboard_records", [])
        .map_err(|e| e.to_string())?;
    let _ = app.emit("clipboard-cleared", ());
    Ok(())
}

#[tauri::command]
pub fn delete_records_by_type(app: AppHandle, record_type: String) -> Result<(), String> {
    let image_contents: Vec<String>;

    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;

        // Collect image paths before deletion for file cleanup
        if record_type == "image" {
            let mut stmt = conn
                .prepare("SELECT content FROM clipboard_records WHERE type = ?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![record_type], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|e| e.to_string())?;
            image_contents = rows.filter_map(|r| r.ok()).collect();
        } else {
            image_contents = Vec::new();
        }

        conn.execute(
            "DELETE FROM clipboard_records WHERE type = ?1",
            rusqlite::params![record_type],
        )
        .map_err(|e| e.to_string())?;
    }

    // Clean up image files if no remaining records reference them
    if !image_contents.is_empty() {
        let base_dir = get_storage_dir(&app);
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        for content in &image_contents {
            let still_referenced: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM clipboard_records WHERE content = ?1",
                    rusqlite::params![content],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            if still_referenced {
                continue;
            }
            let file_path = base_dir.join(content);
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
    }

    // Notify frontend that records have changed (partial update — not clipboard-cleared)
    Ok(())
}

#[tauri::command]
pub fn delete_clipboard_record(app: AppHandle, id: String) -> Result<(), String> {
    let image_content: Option<String> = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;

        let record: Option<(String, String)> = conn
            .query_row(
                "SELECT type, content FROM clipboard_records WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .ok();

        conn.execute("DELETE FROM clipboard_records WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;

        let _ = app.emit("clipboard-deleted", &id);

        match record {
            Some((t, c)) if t == "image" => Some(c),
            _ => None,
        }
    };

    if let Some(content) = image_content {
        let file_path = get_storage_dir(&app).join(&content);
        let _ = std::fs::remove_file(&file_path);
        if let Some(filename) = file_path.file_name() {
            let thumb_path = file_path
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("thumbs")
                .join(filename);
            let _ = std::fs::remove_file(&thumb_path);
        }
    }

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
pub fn delete_phrase(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let old_file: Option<String> = conn
        .query_row(
            "SELECT content FROM phrases WHERE id = ?1 AND input_type = 'file'",
            params![&id],
            |row| row.get(0),
        )
        .ok();
    conn.execute("DELETE FROM phrases WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    drop(conn);
    if let Some(path) = old_file {
        remove_quick_input_file(&app, &path);
    }
    Ok(())
}

#[tauri::command]
pub fn get_translation_history(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let l = limit.unwrap_or(100);
    let mut stmt = conn
        .prepare(
            "SELECT id, source_text, target_text, source_lang, target_lang, engine, created_at
             FROM translation_history ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![l], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "source_text": row.get::<_, String>(1)?,
                "target_text": row.get::<_, String>(2)?,
                "source_lang": row.get::<_, String>(3)?,
                "target_lang": row.get::<_, String>(4)?,
                "engine": row.get::<_, String>(5)?,
                "created_at": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut history = Vec::new();
    for row in rows {
        history.push(row.map_err(|e| e.to_string())?);
    }
    Ok(history)
}

#[tauri::command]
pub fn clear_translation_history(app: AppHandle) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM translation_history", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

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

pub fn get_setting_sync(app: &AppHandle, key: &str) -> Option<String> {
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
pub fn get_image_base64(app: AppHandle, path: String) -> Result<String, String> {
    let mut base_dir = get_storage_dir(&app);
    base_dir.push(&path);

    let bytes = std::fs::read(&base_dir).map_err(|e| format!("read image file: {}", e))?;

    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub fn get_image_thumbnail(app: AppHandle, path: String, max_size: u32) -> Result<String, String> {
    let base_dir = get_storage_dir(&app);
    let image_path = base_dir.join(&path);

    // Try pre-generated thumbnail first (saved during clipboard capture)
    let thumb_dir = image_path.parent().unwrap_or(&base_dir).join("thumbs");
    let filename = image_path.file_name().ok_or("invalid path")?;
    let thumb_path = thumb_dir.join(filename);

    let thumb_bytes = if thumb_path.exists() {
        std::fs::read(&thumb_path).map_err(|e| format!("read thumbnail: {}", e))?
    } else {
        // Fallback: generate thumbnail from full image
        let bytes = std::fs::read(&image_path).map_err(|e| format!("read image file: {}", e))?;
        let img = image::load_from_memory(&bytes).map_err(|e| format!("decode image: {}", e))?;
        let (w, h) = (img.width(), img.height());
        let scale = if w > max_size || h > max_size {
            max_size as f32 / w.max(h) as f32
        } else {
            1.0
        };
        let thumb = if scale < 1.0 {
            let new_w = (w as f32 * scale) as u32;
            let new_h = (h as f32 * scale) as u32;
            img.resize(new_w, new_h, image::imageops::FilterType::Triangle)
        } else {
            img
        };
        let mut buf = std::io::Cursor::new(Vec::new());
        thumb
            .write_to(&mut buf, image::ImageFormat::Png)
            .map_err(|e| format!("encode thumbnail: {}", e))?;
        let data = buf.into_inner();
        // Save for future use
        std::fs::create_dir_all(&thumb_dir).ok();
        let _ = std::fs::write(&thumb_path, &data);
        data
    };

    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&thumb_bytes))
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

fn set_setting_inner(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
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
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    for (key, value) in &settings {
        if key == "storage_path" {
            return migrate_storage(&app, value);
        }
    }
    for (key, value) in &settings {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn migrate_storage(app: &AppHandle, new_path: &str) -> Result<(), String> {
    let custom_dir = PathBuf::from(new_path);
    std::fs::create_dir_all(&custom_dir).map_err(|e| format!("create dir: {}", e))?;
    let custom_db = custom_dir.join("data.db");

    // Collect all settings from current DB
    let settings: Vec<(String, String)> = {
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
        rows.filter_map(|r| r.ok()).collect()
    };

    // Create new DB with schema and settings at target location
    let new_conn = Connection::open(&custom_db).map_err(|e| format!("open new db: {}", e))?;

    new_conn
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS clipboard_records (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                source_app TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                user_api_key INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_clipboard_created_at ON clipboard_records(created_at);
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
            CREATE INDEX IF NOT EXISTS idx_translation_created_at ON translation_history(created_at);
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            DROP TABLE IF EXISTS api_key_labels;
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
            ",
        )
        .map_err(|e| format!("create schema: {}", e))?;

    // Copy settings to new DB
    {
        let mut stmt = new_conn
            .prepare("INSERT INTO settings (key, value) VALUES (?1, ?2)")
            .map_err(|e| e.to_string())?;
        for (k, v) in &settings {
            if k != "storage_path" && k != "shortcut_key" {
                stmt.execute(params![k, v]).map_err(|e| e.to_string())?;
            }
        }
        stmt.execute(params!["storage_path", new_path])
            .map_err(|e| e.to_string())?;
        stmt.execute(params!["shortcut_key", ""])
            .map_err(|e| e.to_string())?;
    }

    // Update old DB's storage_path (for chain-following on restart) and switch connection
    {
        let state = app.state::<DbState>();
        let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('storage_path', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
            params![new_path],
        )
        .map_err(|e| e.to_string())?;
        *conn = new_conn;
    }

    log::info!("Storage migrated to: {}", new_path);
    Ok(())
}

#[tauri::command]
pub fn get_storage_path(app: AppHandle) -> Result<String, String> {
    Ok(get_storage_dir(&app).to_string_lossy().to_string())
}

#[tauri::command]
pub fn ensure_thumbnail(app: AppHandle, path: String) -> Result<String, String> {
    let mut base = get_storage_dir(&app);
    base.push(&path);

    if !base.exists() {
        return Err("image file not found".to_string());
    }

    let filename = base
        .file_name()
        .ok_or("invalid path")?
        .to_string_lossy()
        .to_string();
    let mut thumb_dir = base.parent().ok_or("invalid path")?.to_path_buf();
    thumb_dir.push("thumbs");
    std::fs::create_dir_all(&thumb_dir).ok();
    let thumb_path = thumb_dir.join(&filename);

    if thumb_path.exists() {
        return Ok(thumb_path.to_string_lossy().to_string());
    }

    let bytes = std::fs::read(&base).map_err(|e| format!("read image: {}", e))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("decode image: {}", e))?;

    let (w, h) = (img.width(), img.height());
    let max_thumb: u32 = 200;
    let scale = if w > max_thumb || h > max_thumb {
        max_thumb as f32 / w.max(h) as f32
    } else {
        1.0
    };

    let thumb = if scale < 1.0 {
        img.resize(
            (w as f32 * scale) as u32,
            (h as f32 * scale) as u32,
            image::imageops::FilterType::Triangle,
        )
    } else {
        img
    };

    let mut buf = std::io::Cursor::new(Vec::new());
    thumb
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("encode thumbnail: {}", e))?;

    std::fs::write(&thumb_path, buf.into_inner()).map_err(|e| format!("write thumbnail: {}", e))?;

    Ok(thumb_path.to_string_lossy().to_string())
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

// === API Key Label Commands ===

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

fn list_labels_internal(conn: &Connection) -> Result<Vec<serde_json::Value>, String> {
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

// ── Reorder Commands ──────────────────────────────────────────

#[tauri::command]
pub fn reorder_clipboard_records(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let n = ids.len();

    if ids.is_empty() {
        return Ok(());
    }

    let mut case_clauses = String::new();
    let mut id_list = String::new();
    for (i, id) in ids.iter().enumerate() {
        let escaped = id.replace('\'', "''");
        case_clauses.push_str(&format!(" WHEN '{}' THEN {}", escaped, (n - i) * 10));
        if i > 0 {
            id_list.push(',');
        }
        id_list.push_str(&format!("'{}'", escaped));
    }

    let sql = format!(
        "UPDATE clipboard_records SET sort_order = CASE id{} END WHERE id IN ({})",
        case_clauses, id_list,
    );

    conn.execute(&sql, []).map_err(|e| e.to_string())?;
    log::info!("reorder_clipboard_records: {} items", ids.len());
    Ok(())
}

#[tauri::command]
pub fn reorder_phrase_groups(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let n = ids.len();

    if ids.is_empty() {
        return Ok(());
    }

    let mut case_clauses = String::new();
    let mut id_list = String::new();
    for (i, id) in ids.iter().enumerate() {
        let escaped = id.replace('\'', "''");
        case_clauses.push_str(&format!(" WHEN '{}' THEN {}", escaped, (n - i) * 10));
        if i > 0 {
            id_list.push(',');
        }
        id_list.push_str(&format!("'{}'", escaped));
    }

    conn.execute(
        &format!(
            "UPDATE phrase_groups SET sort_order = CASE id{} END WHERE id IN ({})",
            case_clauses, id_list
        ),
        [],
    )
    .map_err(|e| e.to_string())?;

    let _ = app.emit("phrase-groups-changed", ());
    log::info!("reorder_phrase_groups: {} items", ids.len());
    Ok(())
}

#[tauri::command]
pub fn reorder_phrases(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let n = ids.len();

    if ids.is_empty() {
        return Ok(());
    }

    let mut case_clauses = String::new();
    let mut id_list = String::new();
    for (i, id) in ids.iter().enumerate() {
        let escaped = id.replace('\'', "''");
        case_clauses.push_str(&format!(" WHEN '{}' THEN {}", escaped, (n - i) * 10));
        if i > 0 {
            id_list.push(',');
        }
        id_list.push_str(&format!("'{}'", escaped));
    }

    conn.execute(
        &format!(
            "UPDATE phrases SET sort_order = CASE id{} END WHERE id IN ({})",
            case_clauses, id_list
        ),
        [],
    )
    .map_err(|e| e.to_string())?;

    log::info!("reorder_phrases: {} items", ids.len());
    Ok(())
}

#[cfg(test)]
mod quick_input_file_tests {
    use super::{
        is_legacy_quick_input_file_path, legacy_quick_input_target_path,
        quick_input_relative_path,
    };

    #[test]
    fn quick_input_relative_path_preserves_original_filename() {
        assert_eq!(
            quick_input_relative_path("preset-1", "example.md"),
            "quick-input-files/preset-1/example.md"
        );
    }

    #[test]
    fn legacy_quick_input_file_path_is_single_file_under_root() {
        assert!(is_legacy_quick_input_file_path(
            "quick-input-files/3fcb74c0-4738-4230-a5bc-51067b34ec0b.md"
        ));
        assert!(!is_legacy_quick_input_file_path(
            "quick-input-files/preset-1/example.md"
        ));
    }

    #[test]
    fn legacy_quick_input_target_path_uses_original_filename() {
        assert_eq!(
            legacy_quick_input_target_path(
                "quick-input-files/3fcb74c0-4738-4230-a5bc-51067b34ec0b.md",
                "/home/ao/docs/original.md"
            ),
            Some(
                "quick-input-files/3fcb74c0-4738-4230-a5bc-51067b34ec0b/original.md"
                    .to_string()
            )
        );
    }
}
