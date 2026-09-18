// 数据备份：整库导出为 zip（data.db 快照 + 存储附件 + 可选资源库）。
// 导入分两步解压：data.db 与存储附件先落暂存目录并完成逐表行数、外键
// 校验，全部通过后资源库条目才就地落位（临时文件 + 原子改名）——校验
// 失败不触碰现有库；通过后写 storage_path 由重启链式切换。校验强度对齐
// db/migrate.rs（逐表行数一致才切换）；缩略图与视频海报等再生缓存按
// "整树 − 缓存黑名单"排除（缺失时自动再生，见 db/media.rs）。
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

    // 先写同目录隐藏临时文件、成功后落位：导出中途失败（取消/磁盘满）
    // 只清临时件，不再摧毁目标路径上已有的旧备份。临时件与目标同目录，
    // rename 不跨文件系统。
    let staging_zip = target_zip.with_file_name(format!(
        ".copy-creator-exporting-{}",
        target_zip
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("backup.zip")
    ));
    let export_result = (|| -> Result<u64, String> {
        let file = File::create(&staging_zip).map_err(|e| format!("创建导出文件失败: {e}"))?;
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
        // 落位：Windows 不允许 rename 覆盖已存在文件，先移除旧目标；
        // 此前全部写入都发生在临时件上，旧备份在失败路径下完好。
        if target_zip.exists() {
            std::fs::remove_file(target_zip).map_err(|e| format!("替换旧备份失败: {e}"))?;
        }
        std::fs::rename(&staging_zip, target_zip).map_err(|e| format!("落位备份文件失败: {e}"))?;
        Ok(processed as u64)
    })();

    let _ = std::fs::remove_file(&snapshot);
    if export_result.is_err() {
        // 失败/取消只清临时件，目标路径上已有的旧备份保持原样。
        let _ = std::fs::remove_file(&staging_zip);
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

/// 导入备份：data.db 与存储附件先解压到应用数据目录下的暂存目录并完成
/// 逐表行数、外键校验，全部通过后资源库条目才就地落位到恢复位置（先
/// 临时文件再原子改名），最后写 storage_path（新库与当前库双写，重启后
/// db_path 链式跟随）。任一步失败不碰现有数据——暂存目录即刻清理，库
/// 落位发生在全部校验之后，只有落位中途的 I/O 故障才可能留下部分已
/// 恢复的库文件。
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
    // 暂存目录名带 uuid：毫秒时间戳在并行测试（共享 mock app_data_dir）
    // 与程序化连续导入下可能撞名，互相覆盖/清理对方的暂存库。
    let restore_dir = data_dir.join(format!(
        "restore-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        uuid::Uuid::new_v4().simple()
    ));
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
        // 第一步：data.db 与存储附件落暂存目录，随后立即校验。库文件是
        // 就地覆盖式恢复，绝不能在校验之前落位——否则行数/外键校验失败
        // 时，用户的现有库已被部分覆盖且无法回滚。
        extract_main_entries(app, &mut archive, &restore_dir, cancel)?;
        validate_staged_db(&restore_dir.join(DB_NAME), &manifest)?;
        // 第二步：全部校验通过后，库条目才解压到恢复位置。
        if let Some(dir) = &library_dir {
            extract_library_entries(app, &mut archive, dir, cancel)?;
        }
        Ok(())
    })();

    let apply_result = extract_result.and_then(|()| {
        finalize_staged_import(
            app,
            &restore_dir.join(DB_NAME),
            &restore_dir,
            library_dir.as_deref(),
        )
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

/// 写单个 zip 条目到目标路径（父目录自动创建）。
fn write_zip_entry(
    entry: &mut impl std::io::Read,
    dest: &Path,
    name: &str,
) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let mut out = File::create(dest).map_err(|e| format!("写入 {name} 失败: {e}"))?;
    std::io::copy(entry, &mut out).map_err(|e| format!("写入 {name} 失败: {e}"))?;
    Ok(())
}

/// 第一步解压：data.db 与存储附件落暂存目录；资源库条目留给
/// extract_library_entries 在校验通过后处理。
fn extract_main_entries<R: Runtime>(
    app: &AppHandle<R>,
    archive: &mut ZipArchive<BufReader<File>>,
    restore_dir: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let mut processed = 0usize;
    for index in 0..archive.len() {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        let mut entry =
            archive.by_index(index).map_err(|e| format!("读取条目失败: {e}"))?;
        if entry.is_dir() || entry.name().ends_with('/') {
            continue;
        }
        let name = entry.name().to_string();
        if is_unsafe_entry_name(&name) {
            return Err(format!("备份内包含非法路径条目：{name}"));
        }
        if name == MANIFEST_NAME || name.starts_with(LIBRARY_PREFIX) {
            continue;
        }
        write_zip_entry(&mut entry, &restore_dir.join(&name), &name)?;
        processed += 1;
        if processed % 500 == 0 {
            push_progress(app, "import", processed);
        }
    }
    Ok(())
}

/// 第二步解压：资源库条目就地落位。逐文件先写 `.copy-creator-importing-`
/// 隐藏临时文件再原子改名——临时文件命中扫描忽略规则，写一半的文件不会
/// 短暂出现在资源列表；临时文件与目标同目录，rename 不跨文件系统。
fn extract_library_entries<R: Runtime>(
    app: &AppHandle<R>,
    archive: &mut ZipArchive<BufReader<File>>,
    library_dir: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let mut processed = 0usize;
    for index in 0..archive.len() {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        let mut entry =
            archive.by_index(index).map_err(|e| format!("读取条目失败: {e}"))?;
        if entry.is_dir() || entry.name().ends_with('/') {
            continue;
        }
        let name = entry.name().to_string();
        let Some(rest) = name.strip_prefix(LIBRARY_PREFIX) else {
            continue;
        };
        if is_unsafe_entry_name(&name) || rest.is_empty() {
            return Err(format!("备份内包含非法路径条目：{name}"));
        }
        let dest = library_dir.join(rest);
        let Some(file_name) = dest.file_name().and_then(|n| n.to_str()) else {
            return Err(format!("备份内包含非法路径条目：{name}"));
        };
        let tmp = dest.with_file_name(format!(".copy-creator-importing-{file_name}"));
        let placed = write_zip_entry(&mut entry, &tmp, &name).and_then(|()| {
            std::fs::rename(&tmp, &dest).map_err(|e| format!("落位 {name} 失败: {e}"))
        });
        if let Err(error) = placed {
            let _ = std::fs::remove_file(&tmp);
            return Err(error);
        }
        processed += 1;
        if processed % 500 == 0 {
            push_progress(app, "import", processed);
        }
    }
    Ok(())
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

/// 校验暂存库：外键检查 + 逐表行数对照 manifest。备份若带有当前版本
/// 不认识的表，说明出自更新的应用版本（format_version 相同也可能加表），
/// 明确报版本过新，不落入误导性的「行数不符」。
fn validate_staged_db(staged_db: &Path, manifest: &BackupManifest) -> Result<(), String> {
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
    for table in manifest.table_counts.keys() {
        if !MIGRATED_BUSINESS_TABLES.contains(&table.as_str()) {
            return Err(format!(
                "备份包含当前版本不支持的表（{table}），可能来自更新版本的应用，请先升级应用"
            ));
        }
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
    Ok(())
}

/// 校验通过后的收尾：写暂存库与本机当前库的 storage_path（重启后
/// db_path 链式跟随）与资源库位置。快捷键设置原样保留，重启自动重新注册。
fn finalize_staged_import<R: Runtime>(
    app: &AppHandle<R>,
    staged_db: &Path,
    restore_dir: &Path,
    library_dir: Option<&Path>,
) -> Result<(), String> {
    let staged = open_connection(staged_db)?;
    // 恢复了库就用恢复位置；没恢复库则保留导入方当前的库位置（未自定义
    // 时写空值回落默认目录）——绝不沿用备份创建机器上的路径，否则重启
    // 后会对陌生路径自动建空目录，本机资源库看起来「凭空清空」。
    let resource_library_path = match library_dir {
        Some(dir) => dir.to_string_lossy().to_string(),
        None => crate::db::get_setting_sync(app, "resource_library_path").unwrap_or_default(),
    };
    // 新库的 storage_path 指回暂存目录自身（导出机器上的旧路径已失效）。
    upsert_setting(&staged, "storage_path", &restore_dir.to_string_lossy())?;
    upsert_setting(&staged, "resource_library_path", &resource_library_path)?;
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

    // 这批测试的 mock 应用共享同一个真实 app_data_dir（tauri mock 不隔离
    // 路径，恢复暂存目录都落在 ~/.local/share）：导入/导出类用例必须串行，
    // 否则会互相读到对方正在写的数据。
    static BACKUP_IO_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

        let _io = BACKUP_IO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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

    // ── 守护测试辅助：手工构造 zip 备份（可控制清单行数与库条目）──

    fn seeded_db_file(path: &Path) {
        use crate::db::ensure_schema;
        let conn = rusqlite::Connection::open(path).unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO clipboard_records (id, type, content, created_at)
             VALUES ('r1', 'text', 'hello', '2026-09-01T00:00:00Z')",
            [],
        )
        .unwrap();
    }

    fn write_manual_backup_zip(
        zip_path: &Path,
        db_path: &Path,
        table_counts: serde_json::Value,
        library_entry: Option<(&str, &[u8])>,
    ) {
        let file = File::create(zip_path).unwrap();
        let mut writer = ZipWriter::new(file);
        let manifest = serde_json::json!({
            "format_version": FORMAT_VERSION,
            "app_version": env!("CARGO_PKG_VERSION"),
            "exported_at": "2026-09-18T00:00:00Z",
            "includes_library": library_entry.is_some(),
            "library_path": "",
            "table_counts": table_counts,
        });
        writer
            .start_file(MANIFEST_NAME, zip_file_options())
            .unwrap();
        writer
            .write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        writer.start_file(DB_NAME, zip_file_options()).unwrap();
        std::io::copy(&mut File::open(db_path).unwrap(), &mut writer).unwrap();
        if let Some((name, content)) = library_entry {
            writer.start_file(name, zip_file_options()).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap();
    }

    /// 校验失败的导入不得触碰库恢复位置：行数不符必须在库条目落位之前
    /// 暴露——恢复位置里的现有文件原样保留、备份内的库条目不出现、
    /// 暂存目录清理干净。（回归锚点：库条目曾与 data.db 同批解压，校验
    /// 失败时现有库已被部分覆盖且无法回滚。）
    #[test]
    fn failed_validation_leaves_library_target_untouched() {
        use crate::db::{ensure_schema, DbState};
        use std::sync::Mutex;
        use tauri::Manager;

        let _io = BACKUP_IO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let app = tauri::test::mock_app();
        let work = std::env::temp_dir().join(format!(
            "copy-creator-backup-guard-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&work).unwrap();

        let db_path = work.join("src.db");
        seeded_db_file(&db_path);
        let zip_path = work.join("bad.zip");
        write_manual_backup_zip(
            &zip_path,
            &db_path,
            serde_json::json!({ "clipboard_records": 99 }),
            Some(("library/sentinel.txt", b"evil".as_slice())),
        );

        // 恢复位置已有同名文件（哨兵）：若库条目在校验前落位，它会被覆盖。
        let target = work.join("lib");
        std::fs::create_dir_all(&target).unwrap();
        let sentinel = target.join("sentinel.txt");
        std::fs::write(&sentinel, b"keep").unwrap();

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        app.manage(DbState {
            conn: Mutex::new(conn),
        });
        let handle = app.handle().clone();

        let data_dir = handle.path().app_data_dir().unwrap();
        let count_restore_dirs = |dir: &Path| {
            std::fs::read_dir(dir)
                .map(|entries| {
                    entries
                        .flatten()
                        .filter(|entry| entry.file_name().to_string_lossy().starts_with("restore-"))
                        .count()
                })
                .unwrap_or(0)
        };
        let restores_before = count_restore_dirs(&data_dir);

        let error = import_backup_internal(
            &handle,
            &zip_path,
            Some(target.to_string_lossy().as_ref()),
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(error.contains("行数不符"), "实际错误: {error}");
        assert_eq!(
            std::fs::read(&sentinel).unwrap(),
            b"keep",
            "校验失败时库恢复位置被提前覆盖"
        );
        assert_eq!(
            count_restore_dirs(&data_dir),
            restores_before,
            "失败导入留下暂存目录"
        );

        let _ = std::fs::remove_dir_all(&work);
    }

    /// 备份清单带有当前版本不认识的表（format_version 相同但出自更新
    /// 版本的应用）时，明确报版本过新，而非误导性的「行数不符」。
    #[test]
    fn unknown_table_in_manifest_reports_newer_version() {
        use crate::db::{ensure_schema, DbState};
        use std::sync::Mutex;
        use tauri::Manager;

        let _io = BACKUP_IO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let app = tauri::test::mock_app();
        let work = std::env::temp_dir().join(format!(
            "copy-creator-backup-future-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&work).unwrap();

        let db_path = work.join("src.db");
        seeded_db_file(&db_path);
        let zip_path = work.join("future.zip");
        write_manual_backup_zip(
            &zip_path,
            &db_path,
            serde_json::json!({ "clipboard_records": 1, "future_table": 7 }),
            None,
        );

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        app.manage(DbState {
            conn: Mutex::new(conn),
        });

        let error = import_backup_internal(
            app.handle(),
            &zip_path,
            None,
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(error.contains("请先升级应用"), "实际错误: {error}");

        let _ = std::fs::remove_dir_all(&work);
    }

    /// 备份不含资源库时，导入后的库位置沿用导入方当前设置，绝不沿用
    /// 备份创建机器上的路径（否则重启后会对陌生路径自动建空目录，本机
    /// 资源库看起来「凭空清空」）；本机未自定义时写空值回落默认目录。
    #[test]
    fn import_without_library_keeps_local_library_path() {
        use crate::db::{ensure_schema, DbState};
        use rusqlite::params;
        use std::sync::Mutex;
        use tauri::Manager;

        let _io = BACKUP_IO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let app = tauri::test::mock_app();
        let work = std::env::temp_dir().join(format!(
            "copy-creator-backup-libpath-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&work).unwrap();

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        // storage_path 必须种子到小型工作目录：缺省时 get_storage_dir
        // 回退整个 app_data_dir，mock 应用的 app_data_dir 是真实的
        // ~/.local/share，导出会去压缩 GB 级无关数据。
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('storage_path', ?1)",
            params![work.join("storage").to_string_lossy().as_ref()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('resource_library_path', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![work.join("backup-machine-lib").to_string_lossy().as_ref()],
        )
        .unwrap();
        app.manage(DbState {
            conn: Mutex::new(conn),
        });
        let handle = app.handle().clone();

        let zip_path = work.join("nolib.zip");
        export_backup_internal(&handle, &zip_path, false, &AtomicBool::new(false)).unwrap();

        // 模拟导入方的本机设置与备份创建机器不同。
        {
            let state = handle.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "UPDATE settings SET value = ?1 WHERE key = 'resource_library_path'",
                params![work.join("local-lib").to_string_lossy().as_ref()],
            )
            .unwrap();
        }
        let summary =
            import_backup_internal(&handle, &zip_path, None, &AtomicBool::new(false)).unwrap();
        let restore_dir = summary["restore_dir"].as_str().unwrap().to_string();
        let staged = open_connection(Path::new(&restore_dir).join(DB_NAME).as_path()).unwrap();
        let lib: String = staged
            .query_row(
                "SELECT value FROM settings WHERE key = 'resource_library_path'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            Path::new(&lib),
            work.join("local-lib").as_path(),
            "库位置沿用本机设置而非备份里的路径"
        );
        drop(staged);

        // 本机未自定义（键删除）时回落空值（默认目录语义）。
        let zip_path2 = work.join("nolib2.zip");
        export_backup_internal(&handle, &zip_path2, false, &AtomicBool::new(false)).unwrap();
        {
            let state = handle.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute("DELETE FROM settings WHERE key = 'resource_library_path'", [])
                .unwrap();
        }
        let summary2 =
            import_backup_internal(&handle, &zip_path2, None, &AtomicBool::new(false)).unwrap();
        let staged2 = open_connection(
            Path::new(summary2["restore_dir"].as_str().unwrap())
                .join(DB_NAME)
                .as_path(),
        )
        .unwrap();
        let lib2: String = staged2
            .query_row(
                "SELECT value FROM settings WHERE key = 'resource_library_path'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(lib2, "", "未自定义时应写空值回落默认目录");
        // 导入成功会保留暂存目录（重启切换语义），测试自行清理。
        let _ = std::fs::remove_dir_all(&restore_dir);
        let _ = std::fs::remove_dir_all(summary2["restore_dir"].as_str().unwrap_or(""));

        let _ = std::fs::remove_dir_all(&work);
    }

    /// 导出失败（取消/磁盘满）不得摧毁目标路径上已有的旧备份：写入走
    /// 同目录临时文件，成功后才落位。（回归锚点：曾直接截断目标文件，
    /// 同一路径二次导出失败时旧备份一并丢失。）
    #[test]
    fn failed_export_preserves_existing_backup() {
        use crate::db::{ensure_schema, DbState};
        use std::sync::Mutex;
        use tauri::Manager;

        let app = tauri::test::mock_app();
        let work = std::env::temp_dir().join(format!(
            "copy-creator-backup-export-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&work).unwrap();

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('storage_path', ?1)",
            rusqlite::params![work.join("storage").to_string_lossy().as_ref()],
        )
        .unwrap();
        app.manage(DbState {
            conn: Mutex::new(conn),
        });
        let handle = app.handle().clone();

        // 存储目录放一个文件：取消标志进入遍历即生效。
        std::fs::create_dir_all(work.join("storage")).unwrap();
        std::fs::write(work.join("storage").join("a.png"), b"png").unwrap();

        let zip_path = work.join("backup.zip");
        export_backup_internal(&handle, &zip_path, false, &AtomicBool::new(false)).unwrap();
        let original = std::fs::read(&zip_path).unwrap();

        let cancel = AtomicBool::new(true);
        assert!(
            export_backup_internal(&handle, &zip_path, false, &cancel).is_err(),
            "预置取消标志的导出应当失败"
        );
        assert_eq!(
            std::fs::read(&zip_path).unwrap(),
            original,
            "导出失败摧毁了目标路径上已有的旧备份"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&work)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".copy-creator-exporting-")
            })
            .collect();
        assert!(leftovers.is_empty(), "失败的导出残留了临时文件");

        let _ = std::fs::remove_dir_all(&work);
    }
}
