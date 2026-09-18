// 数据备份：整库导出为 zip（data.db 快照 + 存储附件 + 可选资源库），
// 导入解压到暂存目录并逐表校验，通过后写 storage_path 由重启链式切换。
// 校验强度对齐 db/migrate.rs（逐表行数一致才切换）；缩略图与视频海报等
// 再生缓存按"整树 − 缓存黑名单"排除（缺失时自动再生，见 db/media.rs）。
use crate::db::{
    get_resource_library_dir, get_storage_dir, paths_overlap, DbState, MIGRATED_BUSINESS_TABLES,
};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// 当前导出的取消标记：导出命令启动时登记，取消命令置位并摘除。
#[derive(Default)]
pub struct BackupState {
    export_cancelled: Mutex<Option<Arc<AtomicBool>>>,
}

impl BackupState {
    fn begin_export(&self) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        *self.export_cancelled.lock().unwrap() = Some(flag.clone());
        flag
    }

    /// 摘除并置位当前导出的取消标记；返回是否有导出在进行。
    fn cancel_export(&self) -> bool {
        match self.export_cancelled.lock().unwrap().take() {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct BackupManifest {
    pub format_version: u32,
    pub app_version: String,
    pub exported_at: String,
    pub includes_library: bool,
    pub library_path: String,
    pub table_counts: std::collections::BTreeMap<String, u64>,
}

const FORMAT_VERSION: u32 = 1;
const MANIFEST_NAME: &str = "manifest.json";
const DB_NAME: &str = "data.db";
const LIBRARY_PREFIX: &str = "library/";

/// 存储树内不需要备份的条目：db 伴随文件（快照由 VACUUM INTO 生成，
/// wal/shm/journal 不入包）、缩略图与视频海报缓存（缺失时自动再生）。
/// 黑名单按路径段匹配，不误伤名字恰好含 "thumbs" 的用户文件。
fn is_regenerable(relative: &str) -> bool {
    let mut components = Path::new(relative).components();
    match components.next() {
        Some(first) => {
            let name = first.as_os_str().to_string_lossy();
            if name == "video-posters" || name.starts_with("data.db") {
                return true;
            }
        }
        None => return false,
    }
    components.any(|part| part.as_os_str() == "thumbs")
}

/// 拒绝 zip 条目名中的路径穿越：导入只允许落在目标根目录之内。
fn is_unsafe_entry_name(name: &str) -> bool {
    name.starts_with('/')
        || name.starts_with('\\')
        || name.contains(':')
        || Path::new(name).components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}

/// 逐表行数统计。宽容策略：表不存在按 0 计——导入旧版本备份时，
/// 以备份自带的 manifest 为准逐表核对，多出来的新表不参与比对。
fn count_tables(conn: &rusqlite::Connection) -> Result<std::collections::BTreeMap<String, u64>, String> {
    let mut counts = std::collections::BTreeMap::new();
    for table in MIGRATED_BUSINESS_TABLES {
        let count: u64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .unwrap_or(0);
        counts.insert((*table).to_string(), count);
    }
    Ok(counts)
}

fn push_progress<R: Runtime>(app: &AppHandle<R>, phase: &str, processed: usize) {
    let _ = app.emit(
        "backup-progress",
        serde_json::json!({ "phase": phase, "processed": processed }),
    );
}

fn zip_file_options() -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644)
}

fn add_dir_to_zip<R: Runtime>(
    app: &AppHandle<R>,
    writer: &mut ZipWriter<File>,
    dir: &Path,
    zip_prefix: &str,
    cancel: &AtomicBool,
    processed: &mut usize,
) -> Result<(), String> {
    for entry in WalkDir::new(dir).into_iter().filter_map(Result::ok) {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(dir)
            .map_err(|e| format!("计算相对路径失败: {e}"))?
            .to_string_lossy()
            .replace('\\', "/");
        if is_regenerable(&relative) {
            continue;
        }
        writer
            .start_file(format!("{zip_prefix}{relative}"), zip_file_options())
            .map_err(|e| format!("写入压缩条目 {relative} 失败: {e}"))?;
        let mut source = File::open(path).map_err(|e| format!("打开 {relative} 失败: {e}"))?;
        std::io::copy(&mut source, writer).map_err(|e| format!("写入 {relative} 失败: {e}"))?;
        *processed += 1;
        if *processed % 200 == 0 {
            push_progress(app, "export", *processed);
        }
    }
    Ok(())
}

/// 导出整库为 zip。data.db 用 VACUUM INTO 生成紧凑一致快照；
/// 存储目录整树打包（缓存黑名单除外）；资源库可选。
pub fn export_backup_internal<R: Runtime>(
    app: &AppHandle<R>,
    target_zip: &Path,
    include_library: bool,
    cancel: &AtomicBool,
) -> Result<u64, String> {
    if let Some(parent) = target_zip.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建导出目录失败: {e}"))?;
        }
    }

    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let table_counts = count_tables(&conn)?;

    // VACUUM INTO 要求目标文件不存在。
    let snapshot = std::env::temp_dir()
        .join(format!("copy-creator-backup-{}", uuid::Uuid::new_v4()));
    conn.execute("VACUUM INTO ?1", [snapshot.to_string_lossy().as_ref()])
        .map_err(|e| format!("生成数据库快照失败: {e}"))?;
    drop(conn);

    let export_result = (|| -> Result<u64, String> {
        let file = File::create(target_zip).map_err(|e| format!("创建导出文件失败: {e}"))?;
        let mut writer = ZipWriter::new(file);

        {
            let mut snapshot_file =
                File::open(&snapshot).map_err(|e| format!("读取快照失败: {e}"))?;
            writer
                .start_file(DB_NAME, zip_file_options())
                .map_err(|e| format!("写入压缩条目 {DB_NAME} 失败: {e}"))?;
            std::io::copy(&mut snapshot_file, &mut writer)
                .map_err(|e| format!("写入 {DB_NAME} 失败: {e}"))?;
        }

        let mut processed = 0usize;
        let storage_dir = get_storage_dir(app);
        add_dir_to_zip(app, &mut writer, &storage_dir, "", cancel, &mut processed)?;

        let library_dir = get_resource_library_dir(app);
        if include_library {
            add_dir_to_zip(
                app,
                &mut writer,
                &library_dir,
                LIBRARY_PREFIX,
                cancel,
                &mut processed,
            )?;
        }

        let manifest = BackupManifest {
            format_version: FORMAT_VERSION,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            exported_at: chrono::Utc::now().to_rfc3339(),
            includes_library: include_library,
            library_path: library_dir.to_string_lossy().to_string(),
            table_counts,
        };
        writer
            .start_file(MANIFEST_NAME, zip_file_options())
            .map_err(|e| format!("写入压缩条目 {MANIFEST_NAME} 失败: {e}"))?;
        let json =
            serde_json::to_vec_pretty(&manifest).map_err(|e| format!("序列化清单失败: {e}"))?;
        writer
            .write_all(&json)
            .map_err(|e| format!("写入 {MANIFEST_NAME} 失败: {e}"))?;

        writer.finish().map_err(|e| format!("完成压缩包失败: {e}"))?;
        Ok(processed as u64)
    })();

    let _ = std::fs::remove_file(&snapshot);
    if export_result.is_err() {
        // 失败/取消不残留半截压缩包。
        let _ = std::fs::remove_file(target_zip);
    }
    export_result
}

/// 读取 zip 清单，供导入前向用户展示概要。
pub fn preview_backup_internal(zip_path: &Path) -> Result<BackupManifest, String> {
    let file = File::open(zip_path).map_err(|e| format!("打开备份文件失败: {e}"))?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("读取压缩包失败: {e}"))?;
    let mut entry = archive
        .by_name(MANIFEST_NAME)
        .map_err(|_| "压缩包内没有 manifest.json，不是有效的 Copy Creator 备份".to_string())?;
    let mut json = Vec::new();
    entry
        .read_to_end(&mut json)
        .map_err(|e| format!("读取清单失败: {e}"))?;
    serde_json::from_slice(&json).map_err(|e| format!("解析清单失败: {e}"))
}

fn open_connection(path: &Path) -> Result<rusqlite::Connection, String> {
    let conn =
        rusqlite::Connection::open(path).map_err(|e| format!("打开 {} 失败: {e}", path.display()))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// 解压到应用数据目录下的暂存目录：附件与库文件落位、逐表行数校验、
/// 外键检查，全部通过后才改写 storage_path（新库与当前库双写，重启后
/// db_path 链式跟随）。任一步失败不碰现有数据，暂存目录即刻清理。
pub fn import_backup_internal<R: Runtime>(
    app: &AppHandle<R>,
    zip_path: &Path,
    restore_library_to: Option<&str>,
    cancel: &AtomicBool,
) -> Result<serde_json::Value, String> {
    let manifest = preview_backup_internal(zip_path)?;
    if manifest.format_version > FORMAT_VERSION {
        return Err(format!(
            "备份格式版本过新（{} > {}），请先升级应用",
            manifest.format_version, FORMAT_VERSION
        ));
    }
    let library_dir: Option<PathBuf> = restore_library_to
        .map(|raw| PathBuf::from(raw.trim()))
        .filter(|path| !path.as_os_str().is_empty());
    if manifest.includes_library && library_dir.is_none() {
        return Err("备份包含资源库，请选择库恢复位置".to_string());
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("定位应用数据目录失败: {e}"))?;
    let restore_dir = data_dir.join(format!("restore-{}", chrono::Utc::now().timestamp_millis()));
    // 库恢复位置在落盘前校验：与当前存储目录或本轮流暂存目录（重启后
    // 即新存储目录）互相嵌套会让后续导出双份打包、watcher 与全量对账
    // 互相纠缠——与 set_resource_library_path 的重叠约束同一口径。
    if let Some(dir) = &library_dir {
        let storage_dir = get_storage_dir(app);
        reject_overlapping_library_target(&storage_dir, &restore_dir, dir)?;
    }
    std::fs::create_dir_all(&restore_dir).map_err(|e| format!("创建暂存目录失败: {e}"))?;
    if let Some(dir) = &library_dir {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建资源库恢复目录失败: {e}"))?;
    }

    let extract_result = (|| -> Result<(), String> {
        let file = File::open(zip_path).map_err(|e| format!("打开备份文件失败: {e}"))?;
        let mut archive = ZipArchive::new(BufReader::new(file))
            .map_err(|e| format!("读取压缩包失败: {e}"))?;
        let mut processed = 0usize;
        for index in 0..archive.len() {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".to_string());
            }
            let mut entry =
                archive.by_index(index).map_err(|e| format!("读取条目失败: {e}"))?;
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().to_string();
            if name.ends_with('/') {
                continue;
            }
            if is_unsafe_entry_name(&name) {
                return Err(format!("备份内包含非法路径条目：{name}"));
            }
            if name == MANIFEST_NAME {
                continue;
            }
            let dest = if name == DB_NAME {
                target_restore_path(&restore_dir, DB_NAME)
            } else if let Some(rest) = name.strip_prefix(LIBRARY_PREFIX) {
                let Some(library_dir) = &library_dir else {
                    continue;
                };
                library_dir.join(rest)
            } else {
                target_restore_path(&restore_dir, &name)
            };
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
            }
            let mut out = File::create(&dest).map_err(|e| format!("写入 {name} 失败: {e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("写入 {name} 失败: {e}"))?;
            processed += 1;
            if processed % 500 == 0 {
                push_progress(app, "import", processed);
            }
        }
        Ok(())
    })();

    let staged_db = restore_dir.join(DB_NAME);
    let apply_result = extract_result.and_then(|()| {
        apply_staged_import(app, &staged_db, &restore_dir, library_dir.as_deref(), &manifest)
    });

    if let Err(error) = apply_result {
        // 失败/取消不碰现有数据，暂存目录整体回滚。
        let _ = std::fs::remove_dir_all(&restore_dir);
        return Err(error);
    }

    Ok(serde_json::json!({
        "restore_dir": restore_dir.to_string_lossy(),
        "library_restored_to": library_dir.map(|d| d.to_string_lossy().to_string()),
    }))
}

fn target_restore_path(restore_dir: &Path, name: &str) -> PathBuf {
    restore_dir.join(name)
}

/// 库恢复位置不得与存储目录（当前的或导入切换后的暂存目录）互相嵌套。
fn reject_overlapping_library_target(
    storage_dir: &Path,
    restore_dir: &Path,
    library_dir: &Path,
) -> Result<(), String> {
    if paths_overlap(storage_dir, library_dir) || paths_overlap(restore_dir, library_dir) {
        return Err("资源库恢复位置不能与存储目录重叠，请另选目录".to_string());
    }
    Ok(())
}

/// 校验暂存库（行数 + 外键），通过后写两处 storage_path。
fn apply_staged_import<R: Runtime>(
    app: &AppHandle<R>,
    staged_db: &Path,
    restore_dir: &Path,
    library_dir: Option<&Path>,
    manifest: &BackupManifest,
) -> Result<(), String> {
    if !staged_db.exists() {
        return Err("备份内没有 data.db，不是有效的 Copy Creator 备份".to_string());
    }
    let staged = open_connection(staged_db)?;
    // foreign_key_check 仅对违规行返回结果：有行即失败。
    let has_violation: bool = staged
        .query_row("PRAGMA foreign_key_check", [], |_| Ok(true))
        .unwrap_or(false);
    if has_violation {
        return Err("备份库外键校验未通过".to_string());
    }
    let actual = count_tables(&staged)?;
    for (table, expected) in &manifest.table_counts {
        let found = actual.get(table).copied().unwrap_or(0);
        if found != *expected {
            return Err(format!(
                "备份校验失败：{table} 行数不符（期望 {expected}，实际 {found}）"
            ));
        }
    }
    // 新库的 storage_path 指回暂存目录自身（导出机器上的旧路径已失效）；
    // 资源库恢复位置一并写入。快捷键设置原样保留，重启自动重新注册。
    upsert_setting(&staged, "storage_path", &restore_dir.to_string_lossy())?;
    if let Some(dir) = library_dir {
        upsert_setting(&staged, "resource_library_path", &dir.to_string_lossy())?;
    }
    drop(staged);

    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    upsert_setting(&conn, "storage_path", &restore_dir.to_string_lossy())
}

fn upsert_setting(conn: &rusqlite::Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )
    .map_err(|e| format!("写入设置 {key} 失败: {e}"))?;
    Ok(())
}

// ── Tauri 命令 ──────────────────────────────────────────────

#[tauri::command]
pub async fn export_backup(
    app: AppHandle,
    target_zip: String,
    include_library: bool,
) -> Result<u64, String> {
    let cancel = app.state::<BackupState>().begin_export();
    let target = PathBuf::from(&target_zip);
    tokio::task::spawn_blocking(move || {
        export_backup_internal(&app, &target, include_library, &cancel)
    })
    .await
    .map_err(|e| format!("导出任务失败: {e}"))?
}

#[tauri::command]
pub fn cancel_backup_export(app: AppHandle) -> bool {
    app.state::<BackupState>().cancel_export()
}

/// 选择备份导出位置（保存对话框，默认文件名带时间戳）。
#[tauri::command]
pub async fn select_backup_save_path(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Zip", &["zip"])
        .set_file_name(
            chrono::Local::now().format("copy-creator-backup-%Y%m%d-%H%M%S.zip").to_string(),
        )
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    dialog_path(rx).await
}

/// 选择要导入的备份 zip 文件。
#[tauri::command]
pub async fn select_backup_zip_path(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Zip", &["zip"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    dialog_path(rx).await
}

async fn dialog_path(
    rx: std::sync::mpsc::Receiver<Option<tauri_plugin_dialog::FilePath>>,
) -> Result<String, String> {
    let result =
        tokio::task::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(120)))
            .await
            .map_err(|e| format!("task error: {e}"))?;
    match result {
        Ok(Some(path)) => Ok(path.to_string()),
        Ok(None) => Err("cancelled".to_string()),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err("timeout".to_string()),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err("cancelled".to_string()),
    }
}

#[tauri::command]
pub async fn preview_backup(zip_path: String) -> Result<BackupManifest, String> {
    tokio::task::spawn_blocking(move || preview_backup_internal(Path::new(&zip_path)))
        .await
        .map_err(|e| format!("读取任务失败: {e}"))?
}

#[tauri::command]
pub async fn import_backup(
    app: AppHandle,
    zip_path: String,
    restore_library_to: Option<String>,
) -> Result<serde_json::Value, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let path = PathBuf::from(&zip_path);
    tokio::task::spawn_blocking(move || {
        import_backup_internal(&app, &path, restore_library_to.as_deref(), &cancel)
    })
    .await
    .map_err(|e| format!("导入任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_json_roundtrip_preserves_counts() {
        let mut counts = std::collections::BTreeMap::new();
        counts.insert("clipboard_records".to_string(), 12u64);
        counts.insert("phrases".to_string(), 3u64);
        let manifest = BackupManifest {
            format_version: FORMAT_VERSION,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            exported_at: "2026-09-18T00:00:00Z".to_string(),
            includes_library: true,
            library_path: "/tmp/lib".to_string(),
            table_counts: counts,
        };
        let json = serde_json::to_vec(&manifest).unwrap();
        let parsed: BackupManifest = serde_json::from_slice(&json).unwrap();
        assert_eq!(parsed.format_version, FORMAT_VERSION);
        assert!(parsed.includes_library);
        assert_eq!(parsed.table_counts.get("phrases"), Some(&3));
    }

    #[test]
    fn regenerable_caches_and_db_sidecars_are_excluded() {
        assert!(is_regenerable("images/thumbs/abc.png"));
        assert!(is_regenerable("quick-input-files/uuid/thumbs/x.png"));
        assert!(is_regenerable("video-posters/key.jpg"));
        assert!(is_regenerable("data.db"));
        assert!(is_regenerable("data.db-wal"));
        assert!(is_regenerable("data.db-shm"));
        assert!(!is_regenerable("images/abc.png"));
        assert!(!is_regenerable("quick-input-files/uuid/report.pdf"));
        assert!(!is_regenerable("stash-images/uuid/image-1.png"));
        // 黑名单按路径段匹配：名字含 thumbs 的用户文件不误伤。
        assert!(!is_regenerable("images/thumbs.png"));
    }

    #[test]
    fn unsafe_entry_names_are_rejected() {
        assert!(is_unsafe_entry_name("../evil.txt"));
        assert!(is_unsafe_entry_name("a/../../evil.txt"));
        assert!(is_unsafe_entry_name("/abs.txt"));
        assert!(is_unsafe_entry_name("C:\\evil.txt"));
        assert!(!is_unsafe_entry_name("images/ok.png"));
        assert!(!is_unsafe_entry_name("library/组/文件.txt"));
    }

    /// 库恢复位置与当前存储目录或导入暂存目录（重启后即新存储目录）
    /// 互相嵌套都应拒绝，普通独立目录放行。
    #[test]
    fn library_restore_target_may_not_overlap_storage() {
        let storage = Path::new("E:/data/storage");
        let restore = Path::new("E:/appdata/restore-1");
        let inside_storage = Path::new("E:/data/storage/lib");
        let inside_restore = restore.join("lib");
        let independent = Path::new("E:/libraries/main");
        assert!(reject_overlapping_library_target(storage, restore, inside_storage).is_err());
        assert!(reject_overlapping_library_target(storage, restore, &inside_restore).is_err());
        assert!(reject_overlapping_library_target(storage, restore, storage).is_err());
        assert!(reject_overlapping_library_target(storage, restore, independent).is_ok());
    }

    /// 真实 round-trip：导出 → 当前库被改乱 → 导入 → 暂存库数据与导出前
    /// 一致，storage_path 双写指向暂存目录（对齐计划验收场景）。
    #[test]
    fn export_import_roundtrip_restores_data_and_points_storage_path() {
        use crate::db::{ensure_schema, DbState};
        use rusqlite::params;
        use std::sync::Mutex;
        use tauri::Manager;

        let app = tauri::test::mock_app();
        let work = std::env::temp_dir().join(format!(
            "copy-creator-backup-roundtrip-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&work).unwrap();

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO clipboard_records (id, type, content, created_at)
             VALUES ('r1', 'text', '你好', '2026-09-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('storage_path', ?1)",
            params![work.join("storage").to_string_lossy().as_ref()],
        )
        .unwrap();
        conn.execute(
            // ensure_schema 的种子默认值里已有 theme 键，这里用 upsert 覆盖。
            "INSERT INTO settings (key, value) VALUES ('theme', 'dark')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .unwrap();
        app.manage(DbState {
            conn: Mutex::new(conn),
        });
        let handle = app.handle().clone();

        let zip_path = work.join("backup.zip");
        export_backup_internal(&handle, &zip_path, false, &AtomicBool::new(false)).unwrap();

        let manifest = preview_backup_internal(&zip_path).unwrap();
        assert_eq!(manifest.table_counts.get("clipboard_records"), Some(&1));

        // 导出后当前库被改乱：记录被删。
        {
            let state = handle.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute("DELETE FROM clipboard_records", []).unwrap();
        }

        // 库恢复位置与存储目录互相嵌套应在解压前被拒绝（此时 storage_path
        // 尚未被成功导入改写，指向 work/storage）。
        let nested = work.join("storage").join("nested-library");
        assert!(
            import_backup_internal(
                &handle,
                &zip_path,
                Some(nested.to_string_lossy().as_ref()),
                &AtomicBool::new(false),
            )
            .is_err(),
            "库恢复位置选在存储目录内应被拒绝"
        );

        let summary =
            import_backup_internal(&handle, &zip_path, None, &AtomicBool::new(false)).unwrap();
        let restore_dir = summary["restore_dir"].as_str().unwrap().to_string();
        // 当前库 storage_path 已指向暂存目录，重启后 db_path 链式跟随。
        {
            let state = handle.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            let stored: String = conn
                .query_row(
                    "SELECT value FROM settings WHERE key = 'storage_path'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(stored.contains("restore-"));
        }

        // 暂存库恢复出导出时的数据与设置。
        let staged = open_connection(Path::new(&restore_dir).join(DB_NAME).as_path()).unwrap();
        let restored_count: u64 = staged
            .query_row("SELECT COUNT(*) FROM clipboard_records", [], |row| row.get(0))
            .unwrap();
        assert_eq!(restored_count, 1);
        let theme: String = staged
            .query_row("SELECT value FROM settings WHERE key = 'theme'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(theme, "dark");
        let staged_storage: String = staged
            .query_row(
                "SELECT value FROM settings WHERE key = 'storage_path'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(Path::new(&staged_storage), Path::new(&restore_dir));

        let _ = std::fs::remove_dir_all(&work);
    }
}
