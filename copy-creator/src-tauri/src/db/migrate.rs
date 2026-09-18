// 存储位置迁移域：整库迁移（业务表复制 + 附件目录搬迁）与存储路径命令。
// 从 db/mod.rs 机械搬迁；实现与行为不变，共享助手经 super::* 引用。
use super::*;
use rusqlite::params;
use tauri::{AppHandle, Manager};

pub(crate) fn migrate_storage(app: &AppHandle, new_path: &str) -> Result<(), String> {
    let custom_dir = PathBuf::from(new_path);

    // 旧存储目录在切换前解析（此刻 settings 仍指向旧位置）。
    let old_storage_dir = get_storage_dir(app);

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

    // 完整迁移：业务数据逐表复制 + 附件目录搬迁 + 行数校验，全部成功后
    // 才在下方切换连接；中途失败时旧库不受影响，重试会先清掉半成品新库。
    let new_conn = migrate_storage_data(
        &old_storage_dir.join("data.db"),
        &old_storage_dir,
        &custom_dir,
    )?;

    // Copy settings to new DB（ensure_schema 已种子化默认设置，旧值
    // 必须以 REPLACE 覆盖种子，否则与种子键冲突报 UNIQUE 约束错误）
    {
        let mut stmt = new_conn
            .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)")
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

/// 迁移涉及的业务表（settings 由命令层单独复制：storage_path/shortcut_key
/// 有特殊处理）。表名为内部常量，不来自用户输入。
pub(crate) const MIGRATED_BUSINESS_TABLES: [&str; 7] = [
    "clipboard_records",
    "phrase_groups",
    "phrases",
    "translation_history",
    "api_key_labels",
    "toast_shown",
    // 回收站条目（0.4.0 起）：trash_dir 是相对库根的路径，存储迁移不改
    // 库根，搬表即可保持可恢复。
    "trash_items",
];

/// 存储迁移的数据搬运核心：在 new_dir 建新库（PRAGMA + ensure_schema 与
/// 主库同源），旧库逐表按"两库共同列"复制并校验行数一致，附件目录跟随
/// 搬迁；任一步失败即返回 Err，调用方不得切换连接。返回打开的新连接。
pub(crate) fn migrate_storage_data(
    old_db: &Path,
    old_storage_dir: &Path,
    new_dir: &Path,
) -> Result<Connection, String> {
    if !old_db.exists() {
        return Err(format!("旧数据库不存在: {}", old_db.display()));
    }
    let new_db = new_dir.join("data.db");
    // 上次迁移失败可能残留半成品库：重建前清掉，保证重试幂等。
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(PathBuf::from(format!("{}{}", new_db.display(), suffix)));
    }
    std::fs::create_dir_all(new_dir).map_err(|e| format!("create dir: {}", e))?;

    let new_conn = Connection::open(&new_db).map_err(|e| format!("open new db: {}", e))?;
    new_conn
        .execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8000; PRAGMA foreign_keys=ON;",
        )
        .map_err(|e| format!("set pragmas: {}", e))?;
    ensure_schema(&new_conn).map_err(|e| format!("create schema: {}", e))?;

    // 旧库以别名接入后逐表复制。复制期间临时关闭新连接的外键：旧库若存
    // 在历史孤儿行（外键约束启用前的遗留），严格校验会让整个迁移失败；
    // 数据保真优先，孤儿行原样保留进新库。
    new_conn
        .execute("PRAGMA foreign_keys=OFF", [])
        .map_err(|e| format!("toggle foreign_keys: {}", e))?;
    new_conn
        .execute(
            "ATTACH DATABASE ?1 AS migrate_src",
            params![old_db.to_string_lossy()],
        )
        .map_err(|e| format!("attach old db: {}", e))?;
    for table in MIGRATED_BUSINESS_TABLES {
        // 0.4.0 起新增的表在旧库可能不存在：PRAGMA table_info 对缺表返回
        // 空列集，会被共同列交集判成"没有共同列"而报错，整个迁移失败。
        // 源库缺表时跳过复制与校验，新库保留 ensure_schema 建出的空表。
        let source_has_table: bool = new_conn
            .query_row(
                "SELECT COUNT(*) FROM migrate_src.sqlite_master
                 WHERE type = 'table' AND name = ?1",
                params![table],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| count > 0)
            .unwrap_or(false);
        if !source_has_table {
            log::info!("migrate_storage: 源库无 {table} 表，跳过");
            continue;
        }
        let copied = copy_table_across_databases(&new_conn, table)?;
        let old_count: i64 = new_conn
            .query_row(
                &format!("SELECT COUNT(*) FROM migrate_src.{table}"),
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("count {table}: {}", e))?;
        let new_count: i64 = new_conn
            .query_row(
                &format!("SELECT COUNT(*) FROM main.{table}"),
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("count {table}: {}", e))?;
        if old_count != new_count {
            return Err(format!(
                "迁移校验失败：{table} 旧库 {old_count} 行，新库 {new_count} 行"
            ));
        }
        log::info!("migrate_storage: {table} 复制 {copied} 行");
    }
    new_conn
        .execute("DETACH DATABASE migrate_src", [])
        .map_err(|e| format!("detach old db: {}", e))?;
    // 复制完成，恢复外键约束（与主库同配置）。
    new_conn
        .execute("PRAGMA foreign_keys=ON", [])
        .map_err(|e| format!("restore foreign_keys: {}", e))?;

    // 附件（images/thumbs）与快捷输入文件跟随搬迁；数据库文件由 ATTACH
    // 直接读取、settings 在命令层复制，均不在搬迁范围。旧目录保留作备份。
    copy_storage_dir_tree(old_storage_dir, new_dir)?;

    Ok(new_conn)
}

/// 把 migrate_src 里的同名表复制到 main，返回复制的行数。按两库共同列
/// 交集复制：历史 ALTER 演进可能让两库列序不同，`SELECT *` 不可靠。
pub(crate) fn copy_table_across_databases(conn: &Connection, table: &str) -> Result<usize, String> {
    let columns_of = |database: &str| -> Result<Vec<String>, String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA {database}.table_info({table})"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    };
    let new_columns = columns_of("main")?;
    let old_columns = columns_of("migrate_src")?;
    let shared: Vec<String> = new_columns
        .into_iter()
        .filter(|column| old_columns.contains(column))
        .collect();
    if shared.is_empty() {
        return Err(format!("迁移失败：{table} 两库没有共同列"));
    }
    let column_list = shared
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute(
        &format!(
            "INSERT INTO main.{table} ({column_list}) SELECT {column_list} FROM migrate_src.{table}"
        ),
        [],
    )
    .map_err(|e| format!("复制 {table} 失败: {}", e))
}

/// 递归搬迁目录内容到目标目录（data.db/-wal/-shm 除外，同名文件覆盖）。
pub(crate) fn copy_storage_dir_tree(src: &Path, dest: &Path) -> Result<(), String> {
    for entry in
        std::fs::read_dir(src).map_err(|e| format!("read dir {}: {}", src.display(), e))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if matches!(
            name.to_str(),
            Some("data.db") | Some("data.db-wal") | Some("data.db-shm")
        ) {
            continue;
        }
        let target = dest.join(&name);
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|e| format!("create dir {}: {}", target.display(), e))?;
            copy_storage_dir_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &target)
                .map_err(|e| format!("复制 {}: {}", entry.path().display(), e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_storage_path(app: AppHandle) -> Result<String, String> {
    Ok(get_storage_dir(&app).to_string_lossy().to_string())
}
