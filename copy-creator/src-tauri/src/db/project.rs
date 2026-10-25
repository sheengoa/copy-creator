// 工程域（AI 视频制作）：剧/集/场景/镜头四层结构、全局角色/场景/道具
// 三库、素材档案与提示词的 CRUD。媒体与剧本文件留在资源库文件系统，
// 本域只存实体与关系：文件引用一律相对库根（与 trash_items 同惯例，
// 存储位置迁移后不失效），删除工程数据不碰文件。
// 软引用说明：project_assets 的 shot_id/episode_id/gen_from_* 与
// project_scenes.location_id 刻意不设外键——被引用对象删除时，引用方
// 应保留并降级（素材退为散件、场景实例只剩标题），而不是级联消失；
// SQLite 的 ON DELETE SET DEFAULT 会因 '' 非法父行拒绝 DELETE，故
// 降级由应用层在删除命令内显式 UPDATE（见 detach_assets_before_delete）。
use super::*;
use rusqlite::params;
use tauri::{AppHandle, Emitter, Runtime};

/// 工程域 schema：由 ensure_schema 统一执行（幂等），与主库 batch 分离
/// 保持本域自成一体；新表同时登记进 MIGRATED_BUSINESS_TABLES，否则
/// 整库存储迁移（换存储目录）会漏搬工程数据。
pub(crate) const PROJECT_SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS project_shows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_episodes (
    id TEXT PRIMARY KEY,
    show_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'none',
    script_path TEXT NOT NULL DEFAULT '',
    sort_order REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (show_id) REFERENCES project_shows(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_episodes_show ON project_episodes(show_id);

CREATE TABLE IF NOT EXISTS project_characters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role_tag TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    avatar_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_locations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    int_ext TEXT NOT NULL DEFAULT '',
    time_hint TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    ref_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_props (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    ref_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_scenes (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL,
    location_id TEXT NOT NULL DEFAULT '',
    heading TEXT NOT NULL DEFAULT '',
    sort_order REAL NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (episode_id) REFERENCES project_episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_scenes_episode ON project_scenes(episode_id);

CREATE TABLE IF NOT EXISTS project_shots (
    id TEXT PRIMARY KEY,
    scene_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    dialogue TEXT NOT NULL DEFAULT '',
    sort_order REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (scene_id) REFERENCES project_scenes(id) ON DELETE CASCADE,
    FOREIGN KEY (episode_id) REFERENCES project_episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_shots_scene ON project_shots(scene_id);
CREATE INDEX IF NOT EXISTS idx_project_shots_episode ON project_shots(episode_id);

CREATE TABLE IF NOT EXISTS project_assets (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'file',
    name TEXT NOT NULL DEFAULT '',
    shot_id TEXT NOT NULL DEFAULT '',
    episode_id TEXT NOT NULL DEFAULT '',
    gen_from_asset TEXT NOT NULL DEFAULT '',
    gen_from_prompt TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_assets_episode ON project_assets(episode_id);
CREATE INDEX IF NOT EXISTS idx_project_assets_shot ON project_assets(shot_id);

CREATE TABLE IF NOT EXISTS project_prompts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_episode_characters (
    episode_id TEXT NOT NULL,
    character_id TEXT NOT NULL,
    PRIMARY KEY (episode_id, character_id),
    FOREIGN KEY (episode_id) REFERENCES project_episodes(id) ON DELETE CASCADE,
    FOREIGN KEY (character_id) REFERENCES project_characters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_shot_characters (
    shot_id TEXT NOT NULL,
    character_id TEXT NOT NULL,
    PRIMARY KEY (shot_id, character_id),
    FOREIGN KEY (shot_id) REFERENCES project_shots(id) ON DELETE CASCADE,
    FOREIGN KEY (character_id) REFERENCES project_characters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_shot_props (
    shot_id TEXT NOT NULL,
    prop_id TEXT NOT NULL,
    PRIMARY KEY (shot_id, prop_id),
    FOREIGN KEY (shot_id) REFERENCES project_shots(id) ON DELETE CASCADE,
    FOREIGN KEY (prop_id) REFERENCES project_props(id) ON DELETE CASCADE
);
";

fn project_now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 文件引用统一为相对库根的正斜杠路径；Windows 下拖入/复制得到的反斜杠
/// 路径归一后才能与唯一约束、文件视图定位一致。
pub(crate) fn normalize_project_path(path: &str) -> String {
    path.trim().replace('\\', "/")
}

fn emit_project_changed<R: Runtime>(app: &AppHandle<R>) {
    // 工程数据前端整体订阅、统一重取，粗粒度事件即可；后续若有性能
    // 需要再按域拆细（对齐 resource-groups-changed 的做法）。
    let _ = app.emit("project-changed", ());
}

// ── 行映射 ──────────────────────────────────────────────────

fn show_row(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "name": row.get::<_, String>(1)?,
        "note": row.get::<_, String>(2)?,
        "created_at": row.get::<_, String>(3)?,
        "updated_at": row.get::<_, String>(4)?,
    }))
}

fn episode_row(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "show_id": row.get::<_, String>(1)?,
        "number": row.get::<_, i64>(2)?,
        "title": row.get::<_, String>(3)?,
        "status": row.get::<_, String>(4)?,
        "script_path": row.get::<_, String>(5)?,
        "sort_order": row.get::<_, f64>(6)?,
        "created_at": row.get::<_, String>(7)?,
        "updated_at": row.get::<_, String>(8)?,
    }))
}

fn character_row(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "name": row.get::<_, String>(1)?,
        "role_tag": row.get::<_, String>(2)?,
        "bio": row.get::<_, String>(3)?,
        "prompt": row.get::<_, String>(4)?,
        "avatar_path": row.get::<_, String>(5)?,
        "created_at": row.get::<_, String>(6)?,
        "updated_at": row.get::<_, String>(7)?,
    }))
}

fn location_row(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "name": row.get::<_, String>(1)?,
        "int_ext": row.get::<_, String>(2)?,
        "time_hint": row.get::<_, String>(3)?,
        "bio": row.get::<_, String>(4)?,
        "prompt": row.get::<_, String>(5)?,
        "ref_path": row.get::<_, String>(6)?,
        "created_at": row.get::<_, String>(7)?,
        "updated_at": row.get::<_, String>(8)?,
    }))
}

fn prop_row(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "name": row.get::<_, String>(1)?,
        "bio": row.get::<_, String>(2)?,
        "prompt": row.get::<_, String>(3)?,
        "ref_path": row.get::<_, String>(4)?,
        "created_at": row.get::<_, String>(5)?,
        "updated_at": row.get::<_, String>(6)?,
    }))
}

fn scene_row(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "episode_id": row.get::<_, String>(1)?,
        "location_id": row.get::<_, String>(2)?,
        "heading": row.get::<_, String>(3)?,
        "sort_order": row.get::<_, f64>(4)?,
        "note": row.get::<_, String>(5)?,
        "created_at": row.get::<_, String>(6)?,
        "updated_at": row.get::<_, String>(7)?,
    }))
}

fn shot_row(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "scene_id": row.get::<_, String>(1)?,
        "episode_id": row.get::<_, String>(2)?,
        "description": row.get::<_, String>(3)?,
        "dialogue": row.get::<_, String>(4)?,
        "sort_order": row.get::<_, f64>(5)?,
        "created_at": row.get::<_, String>(6)?,
        "updated_at": row.get::<_, String>(7)?,
    }))
}

fn asset_row(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "file_path": row.get::<_, String>(1)?,
        "kind": row.get::<_, String>(2)?,
        "name": row.get::<_, String>(3)?,
        "shot_id": row.get::<_, String>(4)?,
        "episode_id": row.get::<_, String>(5)?,
        "gen_from_asset": row.get::<_, String>(6)?,
        "gen_from_prompt": row.get::<_, String>(7)?,
        "created_at": row.get::<_, String>(8)?,
        "updated_at": row.get::<_, String>(9)?,
    }))
}

fn prompt_row(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "title": row.get::<_, String>(1)?,
        "content": row.get::<_, String>(2)?,
        "category": row.get::<_, String>(3)?,
        "file_path": row.get::<_, String>(4)?,
        "created_at": row.get::<_, String>(5)?,
        "updated_at": row.get::<_, String>(6)?,
    }))
}

const SHOW_COLS: &str = "id, name, note, created_at, updated_at";
const EPISODE_COLS: &str =
    "id, show_id, number, title, status, script_path, sort_order, created_at, updated_at";
const CHARACTER_COLS: &str = "id, name, role_tag, bio, prompt, avatar_path, created_at, updated_at";
const LOCATION_COLS: &str =
    "id, name, int_ext, time_hint, bio, prompt, ref_path, created_at, updated_at";
const PROP_COLS: &str = "id, name, bio, prompt, ref_path, created_at, updated_at";
const SCENE_COLS: &str =
    "id, episode_id, location_id, heading, sort_order, note, created_at, updated_at";
const SHOT_COLS: &str =
    "id, scene_id, episode_id, description, dialogue, sort_order, created_at, updated_at";
const ASSET_COLS: &str =
    "id, file_path, kind, name, shot_id, episode_id, gen_from_asset, gen_from_prompt, created_at, updated_at";
const PROMPT_COLS: &str = "id, title, content, category, file_path, created_at, updated_at";

fn query_all(
    conn: &Connection,
    sql: &str,
    map: fn(&rusqlite::Row) -> rusqlite::Result<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// 按 ids 顺序重写 sort_order（0,1,2…）；列表稳定按序号+创建时间排序。
fn write_order(conn: &Connection, table: &str, ids: &[String]) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("UPDATE {table} SET sort_order = ?1 WHERE id = ?2"))
        .map_err(|e| e.to_string())?;
    for (index, id) in ids.iter().enumerate() {
        stmt.execute(params![index as f64, id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 关联表整组替换：前端保存的即最终名单（与原型「关联角色」的挑选
/// 交互一致），DELETE + 批量 INSERT 比增量 diff 简单且无残留。
fn replace_links(
    conn: &Connection,
    table: &str,
    owner_col: &str,
    other_col: &str,
    owner_id: &str,
    other_ids: &[String],
) -> Result<(), String> {
    conn.execute(
        &format!("DELETE FROM {table} WHERE {owner_col} = ?1"),
        params![owner_id],
    )
    .map_err(|e| e.to_string())?;
    if other_ids.is_empty() {
        return Ok(());
    }
    let mut stmt = conn
        .prepare(&format!(
            "INSERT OR IGNORE INTO {table} ({owner_col}, {other_col}) VALUES (?1, ?2)"
        ))
        .map_err(|e| e.to_string())?;
    for other_id in other_ids {
        stmt.execute(params![owner_id, other_id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── 剧 ──────────────────────────────────────────────────────

#[tauri::command]
pub fn project_list_shows(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut shows = query_all(
        &conn,
        &format!("SELECT {SHOW_COLS} FROM project_shows ORDER BY created_at ASC, id ASC"),
        show_row,
    )?;
    // 附带每剧集数，剧集树头部「短剧 · 计划 N 集」直接可用。
    for show in shows.iter_mut() {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM project_episodes WHERE show_id = ?1",
                params![show["id"].as_str().unwrap_or_default()],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        show["episode_count"] = serde_json::json!(count);
    }
    Ok(shows)
}

#[tauri::command]
pub fn project_create_show(app: AppHandle, name: String) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("剧名不能为空".to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = project_now();
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO project_shows (id, name, note, created_at, updated_at) VALUES (?1, ?2, '', ?3, ?4)",
            params![id, name, &now, &now],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(serde_json::json!({
        "id": id, "name": name, "note": "",
        "created_at": now, "updated_at": now, "episode_count": 0,
    }))
}

#[tauri::command]
pub fn project_rename_show(app: AppHandle, id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("剧名不能为空".to_string());
    }
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE project_shows SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, project_now(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn project_update_show(app: AppHandle, id: String, note: String) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE project_shows SET note = ?1, updated_at = ?2 WHERE id = ?3",
            params![note, project_now(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

/// 资源库文件改名/移动成功后同步工程素材档案：单文件相对库根路径
/// 精确替换。同步失败只记日志不阻断资源操作（档案路径过期会被
/// 「文件缺失」口径暴露，可重新挂靠修复）。
pub(crate) fn sync_project_asset_renamed<R: Runtime>(
    app: &AppHandle<R>,
    old_relative: &str,
    new_relative: &str,
) -> Result<usize, String> {
    let old = normalize_project_path(old_relative);
    let new = normalize_project_path(new_relative);
    if old.is_empty() || new.is_empty() || old == new {
        return Ok(0);
    }
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE project_assets SET file_path = ?1, updated_at = ?2 WHERE file_path = ?3",
        params![&new, project_now(), &old],
    )
    .map_err(|e| e.to_string())
}

/// 资源分组（目录）整体移动后同步：把该目录前缀下全部工程素材的
/// 路径换到新前缀。工程素材量级小，全表读出后在 Rust 端做前缀匹配，
/// 规避 SQL LIKE 对用户输入分组名的转义问题。
pub(crate) fn sync_project_assets_prefix_moved<R: Runtime>(
    app: &AppHandle<R>,
    old_prefix_relative: &str,
    new_prefix_relative: &str,
) -> Result<usize, String> {
    let old_prefix = normalize_project_path(old_prefix_relative)
        .trim_end_matches('/')
        .to_string();
    let new_prefix = normalize_project_path(new_prefix_relative)
        .trim_end_matches('/')
        .to_string();
    if old_prefix.is_empty() || new_prefix.is_empty() || old_prefix == new_prefix {
        return Ok(0);
    }
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let paths: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT file_path FROM project_assets")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };
    let now = project_now();
    let mut changed = 0;
    let mut stmt = conn
        .prepare("UPDATE project_assets SET file_path = ?1, updated_at = ?2 WHERE file_path = ?3")
        .map_err(|e| e.to_string())?;
    for path in paths {
        if let Some(rest) = path.strip_prefix(&old_prefix).filter(|rest| rest.starts_with('/')) {
            changed += stmt
                .execute(params![format!("{new_prefix}{rest}"), &now, &path])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(changed)
}

/// 删除镜头/场景/集/剧之前调用：把受影响的素材档案的工程归属清空
/// （shot_id/episode_id 软引用，档案与文件本身保留，降级为待重挂的
/// 散件）。SQL 片段为内部常量拼接，不来自用户输入。
pub(crate) fn detach_assets_before_delete(    conn: &Connection,
    sql: &str,
    id: &str,
) -> Result<(), String> {
    conn.execute(sql, params![project_now(), id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn project_delete_show(app: AppHandle, id: String) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        detach_assets_before_delete(
            &conn,
            "UPDATE project_assets SET shot_id = '', episode_id = '', updated_at = ?1 \
             WHERE episode_id IN (SELECT id FROM project_episodes WHERE show_id = ?2)",
            &id,
        )?;
        conn.execute("DELETE FROM project_shows WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

// ── 集 ──────────────────────────────────────────────────────

#[tauri::command]
pub fn project_list_episodes(
    app: AppHandle,
    show_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut episodes = query_all(
        &conn,
        &format!(
            "SELECT {EPISODE_COLS} FROM project_episodes \
             WHERE show_id = ?1 ORDER BY number ASC, created_at ASC",
        ),
        episode_row,
    )?;
    // 每集出场角色 id：剧集树与工作台角色行一次拿全，省去逐集往返。
    for episode in episodes.iter_mut() {
        let character_ids =
            episode_character_ids(&conn, episode["id"].as_str().unwrap_or_default())?;
        let shot_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM project_shots WHERE episode_id = ?1",
                params![episode["id"].as_str().unwrap_or_default()],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        episode["character_ids"] = serde_json::json!(character_ids);
        episode["shot_count"] = serde_json::json!(shot_count);
    }
    Ok(episodes)
}

pub(crate) fn episode_character_ids(
    conn: &Connection,
    episode_id: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT character_id FROM project_episode_characters \
             WHERE episode_id = ?1 ORDER BY rowid ASC",
        )
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map(params![episode_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(ids)
}

#[tauri::command]
pub fn project_create_episode(
    app: AppHandle,
    show_id: String,
    title: String,
) -> Result<serde_json::Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = project_now();
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO project_episodes \
             (id, show_id, number, title, status, script_path, sort_order, created_at, updated_at) \
             VALUES (?1, ?2, \
                (SELECT COALESCE(MAX(number), 0) + 1 FROM project_episodes WHERE show_id = ?2), \
             ?3, 'none', '', \
                (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM project_episodes WHERE show_id = ?2), \
             ?4, ?5)",
            params![id, show_id, title.trim(), &now, &now],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    get_episode_by_id(&app, &id)
}

fn get_episode_by_id(app: &AppHandle, id: &str) -> Result<serde_json::Value, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    query_row_with_param(
        &conn,
        &format!("SELECT {EPISODE_COLS} FROM project_episodes WHERE id = ?1"),
        &[&id],
        episode_row,
    )
}

fn query_row_with_param(
    conn: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
    map: fn(&rusqlite::Row) -> rusqlite::Result<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    stmt.query_row(params, map).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_update_episode(
    app: AppHandle,
    id: String,
    number: Option<i64>,
    title: String,
    status: String,
    script_path: String,
) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        // 集号可改（行业惯例删除后编号保留，跳号由用户手动填补）：1-999
        // 且同剧内唯一，冲突报错由前端提示。
        if let Some(number) = number {
            if !(1..=999).contains(&number) {
                return Err("集号需在 1-999 之间".to_string());
            }
            let show_id: String = conn
                .query_row(
                    "SELECT show_id FROM project_episodes WHERE id = ?1",
                    params![&id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            let conflict: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM project_episodes \
                     WHERE show_id = ?1 AND number = ?2 AND id != ?3",
                    params![&show_id, number, &id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if conflict > 0 {
                return Err(format!("第 {number} 集已存在"));
            }
            conn.execute(
                "UPDATE project_episodes SET number = ?1 WHERE id = ?2",
                params![number, &id],
            )
            .map_err(|e| e.to_string())?;
        }
        conn.execute(
            "UPDATE project_episodes SET title = ?1, status = ?2, script_path = ?3, updated_at = ?4 WHERE id = ?5",
            params![title, status, normalize_project_path(&script_path), project_now(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn project_reorder_episodes(
    app: AppHandle,
    _show_id: String,
    ids: Vec<String>,
) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        write_order(&conn, "project_episodes", &ids)?;
    }
    emit_project_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn project_delete_episode(app: AppHandle, id: String) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        detach_assets_before_delete(
            &conn,
            "UPDATE project_assets SET shot_id = '', episode_id = '', updated_at = ?1 \
             WHERE episode_id = ?2 \
                OR shot_id IN (SELECT id FROM project_shots WHERE episode_id = ?2)",
            &id,
        )?;
        conn.execute("DELETE FROM project_episodes WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn project_set_episode_characters(
    app: AppHandle,
    episode_id: String,
    character_ids: Vec<String>,
) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        replace_links(
            &conn,
            "project_episode_characters",
            "episode_id",
            "character_id",
            &episode_id,
            &character_ids,
        )?;
    }
    emit_project_changed(&app);
    Ok(())
}

// ── 全局三库：角色 / 场景 / 道具 ────────────────────────────

#[tauri::command]
pub fn project_list_characters(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut characters = query_all(
        &conn,
        &format!("SELECT {CHARACTER_COLS} FROM project_characters ORDER BY created_at ASC, id ASC"),
        character_row,
    )?;
    for character in characters.iter_mut() {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM project_episode_characters WHERE character_id = ?1",
                params![character["id"].as_str().unwrap_or_default()],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        character["episode_ref_count"] = serde_json::json!(count);
    }
    Ok(characters)
}

#[tauri::command]
pub fn project_create_character(
    app: AppHandle,
    name: String,
    role_tag: String,
    bio: String,
    prompt: String,
    avatar_path: String,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("角色名不能为空".to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = project_now();
    let avatar_path = normalize_project_path(&avatar_path);
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO project_characters \
             (id, name, role_tag, bio, prompt, avatar_path, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, name, role_tag, bio, prompt, avatar_path, &now, &now],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(serde_json::json!({
        "id": id, "name": name, "role_tag": role_tag, "bio": bio,
        "prompt": prompt, "avatar_path": avatar_path,
        "created_at": now, "updated_at": now, "episode_ref_count": 0,
    }))
}

#[tauri::command]
pub fn project_update_character(
    app: AppHandle,
    id: String,
    name: String,
    role_tag: String,
    bio: String,
    prompt: String,
    avatar_path: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("角色名不能为空".to_string());
    }
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE project_characters SET name = ?1, role_tag = ?2, bio = ?3, prompt = ?4, avatar_path = ?5, updated_at = ?6 WHERE id = ?7",
            params![name, role_tag, bio, prompt, normalize_project_path(&avatar_path), project_now(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn project_delete_character(app: AppHandle, id: String) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM project_characters WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn project_list_locations(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    query_all(
        &conn,
        &format!("SELECT {LOCATION_COLS} FROM project_locations ORDER BY created_at ASC, id ASC"),
        location_row,
    )
}

#[tauri::command]
pub fn project_create_location(
    app: AppHandle,
    name: String,
    int_ext: String,
    time_hint: String,
    bio: String,
    prompt: String,
    ref_path: String,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("场景名不能为空".to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = project_now();
    let ref_path = normalize_project_path(&ref_path);
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO project_locations \
             (id, name, int_ext, time_hint, bio, prompt, ref_path, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, name, int_ext, time_hint, bio, prompt, ref_path, &now, &now],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(serde_json::json!({
        "id": id, "name": name, "int_ext": int_ext, "time_hint": time_hint,
        "bio": bio, "prompt": prompt, "ref_path": ref_path,
        "created_at": now, "updated_at": now,
    }))
}

#[tauri::command]
pub fn project_update_location(
    app: AppHandle,
    id: String,
    name: String,
    int_ext: String,
    time_hint: String,
    bio: String,
    prompt: String,
    ref_path: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("场景名不能为空".to_string());
    }
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE project_locations SET name = ?1, int_ext = ?2, time_hint = ?3, bio = ?4, prompt = ?5, ref_path = ?6, updated_at = ?7 WHERE id = ?8",
            params![name, int_ext, time_hint, bio, prompt, normalize_project_path(&ref_path), project_now(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn project_delete_location(app: AppHandle, id: String) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM project_locations WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn project_list_props(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    query_all(
        &conn,
        &format!("SELECT {PROP_COLS} FROM project_props ORDER BY created_at ASC, id ASC"),
        prop_row,
    )
}

#[tauri::command]
pub fn project_create_prop(
    app: AppHandle,
    name: String,
    bio: String,
    prompt: String,
    ref_path: String,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("道具名不能为空".to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = project_now();
    let ref_path = normalize_project_path(&ref_path);
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO project_props \
             (id, name, bio, prompt, ref_path, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, name, bio, prompt, ref_path, &now, &now],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(serde_json::json!({
        "id": id, "name": name, "bio": bio, "prompt": prompt, "ref_path": ref_path,
        "created_at": now, "updated_at": now,
    }))
}

#[tauri::command]
pub fn project_update_prop(
    app: AppHandle,
    id: String,
    name: String,
    bio: String,
    prompt: String,
    ref_path: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("道具名不能为空".to_string());
    }
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE project_props SET name = ?1, bio = ?2, prompt = ?3, ref_path = ?4, updated_at = ?5 WHERE id = ?6",
            params![name, bio, prompt, normalize_project_path(&ref_path), project_now(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn project_delete_prop(app: AppHandle, id: String) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM project_props WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

// ── 集内场景 ────────────────────────────────────────────────

#[tauri::command]
pub fn project_list_scenes(
    app: AppHandle,
    episode_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut scenes = query_all(
        &conn,
        &format!(
            "SELECT {SCENE_COLS} FROM project_scenes \
             WHERE episode_id = ?1 ORDER BY sort_order ASC, created_at ASC",
        ),
        scene_row,
    )?;
    for scene in scenes.iter_mut() {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM project_shots WHERE scene_id = ?1",
                params![scene["id"].as_str().unwrap_or_default()],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        scene["shot_count"] = serde_json::json!(count);
        // 场景库条目（软引用）：还在则带出名称供列表直显，被删则仅剩
        // heading 自身，场景实例不受影响。
        if let Some(location_id) = scene["location_id"].as_str() {
            if !location_id.is_empty() {
                let location = query_row_with_param(
                    &conn,
                    &format!("SELECT {LOCATION_COLS} FROM project_locations WHERE id = ?1"),
                    &[&location_id],
                    location_row,
                );
                scene["location"] = location.unwrap_or(serde_json::Value::Null);
            }
        }
    }
    Ok(scenes)
}

#[tauri::command]
pub fn project_create_scene(
    app: AppHandle,
    episode_id: String,
    heading: String,
    location_id: String,
) -> Result<serde_json::Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = project_now();
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO project_scenes \
             (id, episode_id, location_id, heading, sort_order, note, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, \
                (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM project_scenes WHERE episode_id = ?2), \
             '', ?5, ?6)",
            params![id, episode_id, location_id, heading.trim(), &now, &now],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    query_row_with_param(
        &conn,
        &format!("SELECT {SCENE_COLS} FROM project_scenes WHERE id = ?1"),
        &[&id],
        scene_row,
    )
}

#[tauri::command]
pub fn project_update_scene(
    app: AppHandle,
    id: String,
    heading: String,
    location_id: String,
    note: String,
) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE project_scenes SET heading = ?1, location_id = ?2, note = ?3, updated_at = ?4 WHERE id = ?5",
            params![heading, location_id, note, project_now(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn project_reorder_scenes(
    app: AppHandle,
    _episode_id: String,
    ids: Vec<String>,
) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        write_order(&conn, "project_scenes", &ids)?;
    }
    emit_project_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn project_delete_scene(app: AppHandle, id: String) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        detach_assets_before_delete(
            &conn,
            "UPDATE project_assets SET shot_id = '', updated_at = ?1 \
             WHERE shot_id IN (SELECT id FROM project_shots WHERE scene_id = ?2)",
            &id,
        )?;
        conn.execute("DELETE FROM project_scenes WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

// ── 镜头 ────────────────────────────────────────────────────

#[tauri::command]
pub fn project_list_shots(
    app: AppHandle,
    episode_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut shots = query_all(
        &conn,
        &format!(
            "SELECT {SHOT_COLS} FROM project_shots \
             WHERE episode_id = ?1 ORDER BY sort_order ASC, created_at ASC",
        ),
        shot_row,
    )?;
    for shot in shots.iter_mut() {
        attach_shot_relations(&conn, shot)?;
    }
    Ok(shots)
}

pub(crate) fn attach_shot_relations(
    conn: &Connection,
    shot: &mut serde_json::Value,
) -> Result<(), String> {
    let shot_id = shot["id"].as_str().unwrap_or_default().to_string();
    let ids = |sql: &str| -> Result<Vec<String>, String> {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let list = stmt
            .query_map(params![shot_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(list)
    };
    shot["character_ids"] = serde_json::json!(ids(
        "SELECT character_id FROM project_shot_characters WHERE shot_id = ?1 ORDER BY rowid ASC"
    )?);
    shot["prop_ids"] = serde_json::json!(ids(
        "SELECT prop_id FROM project_shot_props WHERE shot_id = ?1 ORDER BY rowid ASC"
    )?);
    Ok(())
}

#[tauri::command]
pub fn project_create_shot(
    app: AppHandle,
    scene_id: String,
    description: String,
    dialogue: String,
) -> Result<serde_json::Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = project_now();
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        // episode_id 冗余列从所属场景取，保证按集直查与级联一致。
        conn.execute(
            "INSERT INTO project_shots \
             (id, scene_id, episode_id, description, dialogue, sort_order, created_at, updated_at) \
             VALUES (?1, ?2, (SELECT episode_id FROM project_scenes WHERE id = ?2), ?3, ?4, \
                (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM project_shots WHERE scene_id = ?2), \
             ?5, ?6)",
            params![id, scene_id, description, dialogue, &now, &now],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut shot = query_row_with_param(
        &conn,
        &format!("SELECT {SHOT_COLS} FROM project_shots WHERE id = ?1"),
        &[&id],
        shot_row,
    )?;
    attach_shot_relations(&conn, &mut shot)?;
    Ok(shot)
}

#[tauri::command]
pub fn project_update_shot(
    app: AppHandle,
    id: String,
    description: String,
    dialogue: String,
) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE project_shots SET description = ?1, dialogue = ?2, updated_at = ?3 WHERE id = ?4",
            params![description, dialogue, project_now(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn project_reorder_shots(
    app: AppHandle,
    _scene_id: String,
    ids: Vec<String>,
) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        write_order(&conn, "project_shots", &ids)?;
    }
    emit_project_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn project_delete_shot(app: AppHandle, id: String) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        detach_assets_before_delete(
            &conn,
            "UPDATE project_assets SET shot_id = '', updated_at = ?1 WHERE shot_id = ?2",
            &id,
        )?;
        conn.execute("DELETE FROM project_shots WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn project_set_shot_characters(
    app: AppHandle,
    shot_id: String,
    character_ids: Vec<String>,
) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        replace_links(
            &conn,
            "project_shot_characters",
            "shot_id",
            "character_id",
            &shot_id,
            &character_ids,
        )?;
    }
    emit_project_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn project_set_shot_props(
    app: AppHandle,
    shot_id: String,
    prop_ids: Vec<String>,
) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        replace_links(
            &conn,
            "project_shot_props",
            "shot_id",
            "prop_id",
            &shot_id,
            &prop_ids,
        )?;
    }
    emit_project_changed(&app);
    Ok(())
}

// ── 素材档案 ────────────────────────────────────────────────

#[tauri::command]
pub fn project_list_assets(
    app: AppHandle,
    episode_id: String,
    shot_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    if !shot_id.is_empty() {
        return query_all(
            &conn,
            &format!(
                "SELECT {ASSET_COLS} FROM project_assets \
                 WHERE shot_id = ?1 ORDER BY created_at ASC",
            ),
            asset_row,
        );
    }
    if !episode_id.is_empty() {
        return query_all(
            &conn,
            &format!(
                "SELECT {ASSET_COLS} FROM project_assets \
                 WHERE episode_id = ?1 ORDER BY created_at ASC",
            ),
            asset_row,
        );
    }
    query_all(
        &conn,
        &format!("SELECT {ASSET_COLS} FROM project_assets ORDER BY created_at ASC"),
        asset_row,
    )
}

/// 把资源库文件挂进工程：同一文件只有一份档案，重复挂靠时改写归属
/// （换集/换镜头）而不是新建行——file_path UNIQUE + DO UPDATE。
#[tauri::command]
pub fn project_link_asset(
    app: AppHandle,
    file_path: String,
    kind: String,
    name: String,
    episode_id: String,
    shot_id: String,
) -> Result<serde_json::Value, String> {
    let path = normalize_project_path(&file_path);
    if path.is_empty() {
        return Err("文件路径不能为空".to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = project_now();
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO project_assets \
             (id, file_path, kind, name, shot_id, episode_id, gen_from_asset, gen_from_prompt, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', '', ?7, ?8) \
             ON CONFLICT(file_path) DO UPDATE SET \
                kind = excluded.kind, name = excluded.name, \
                shot_id = excluded.shot_id, episode_id = excluded.episode_id, \
                updated_at = excluded.updated_at",
            params![id, path, kind, name, shot_id, episode_id, &now, &now],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    query_row_with_param(
        &conn,
        &format!("SELECT {ASSET_COLS} FROM project_assets WHERE file_path = ?1"),
        &[&path],
        asset_row,
    )
}

#[tauri::command]
pub fn project_update_asset(
    app: AppHandle,
    id: String,
    kind: String,
    name: String,
    episode_id: String,
    shot_id: String,
    gen_from_asset: String,
    gen_from_prompt: String,
) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE project_assets SET kind = ?1, name = ?2, episode_id = ?3, shot_id = ?4, \
                gen_from_asset = ?5, gen_from_prompt = ?6, updated_at = ?7 WHERE id = ?8",
            params![
                kind,
                name,
                episode_id,
                shot_id,
                gen_from_asset,
                gen_from_prompt,
                project_now(),
                id
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

/// 摘除工程档案（只删记录，资源库文件不动）。
#[tauri::command]
pub fn project_unlink_asset(app: AppHandle, id: String) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM project_assets WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

// ── 提示词 ──────────────────────────────────────────────────

#[tauri::command]
pub fn project_list_prompts(
    app: AppHandle,
    category: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    match category.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(category) => query_all(
            &conn,
            &format!(
                "SELECT {PROMPT_COLS} FROM project_prompts \
                 WHERE category = ?1 ORDER BY created_at DESC, id ASC",
            ),
            prompt_row,
        ),
        None => query_all(
            &conn,
            &format!("SELECT {PROMPT_COLS} FROM project_prompts ORDER BY created_at DESC, id ASC"),
            prompt_row,
        ),
    }
}

#[tauri::command]
pub fn project_create_prompt(
    app: AppHandle,
    title: String,
    content: String,
    category: String,
) -> Result<serde_json::Value, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("提示词标题不能为空".to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = project_now();
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO project_prompts (id, title, content, category, file_path, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, '', ?5, ?6)",
            params![id, title, content, category, &now, &now],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(serde_json::json!({
        "id": id, "title": title, "content": content, "category": category,
        "file_path": "", "created_at": now, "updated_at": now,
    }))
}

#[tauri::command]
pub fn project_update_prompt(
    app: AppHandle,
    id: String,
    title: String,
    content: String,
    category: String,
) -> Result<(), String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("提示词标题不能为空".to_string());
    }
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE project_prompts SET title = ?1, content = ?2, category = ?3, updated_at = ?4 WHERE id = ?5",
            params![title, content, category, project_now(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn project_delete_prompt(app: AppHandle, id: String) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM project_prompts WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

// ── 集工作台聚合 ────────────────────────────────────────────

/// 一次拿全集工作台数据：集、出场角色、场景树（含镜头与其出镜/道具/
/// 素材）、集级散件素材。前端打开一集只需这一次往返。
#[tauri::command]
pub fn project_get_episode_overview(
    app: AppHandle,
    episode_id: String,
) -> Result<serde_json::Value, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

    let episode = query_row_with_param(
        &conn,
        &format!("SELECT {EPISODE_COLS} FROM project_episodes WHERE id = ?1"),
        &[&episode_id],
        episode_row,
    )?;

    let character_ids = episode_character_ids(&conn, &episode_id)?;
    let mut characters = Vec::with_capacity(character_ids.len());
    for character_id in &character_ids {
        let character = query_row_with_param(
            &conn,
            &format!("SELECT {CHARACTER_COLS} FROM project_characters WHERE id = ?1"),
            &[character_id],
            character_row,
        );
        if let Ok(character) = character {
            characters.push(character);
        }
    }

    let mut scenes = query_all(
        &conn,
        &format!(
            "SELECT {SCENE_COLS} FROM project_scenes \
             WHERE episode_id = ?1 ORDER BY sort_order ASC, created_at ASC",
        ),
        scene_row,
    )?;
    for scene in scenes.iter_mut() {
        let scene_id = scene["id"].as_str().unwrap_or_default().to_string();
        if let Some(location_id) = scene["location_id"].as_str() {
            if !location_id.is_empty() {
                let location = query_row_with_param(
                    &conn,
                    &format!("SELECT {LOCATION_COLS} FROM project_locations WHERE id = ?1"),
                    &[&location_id],
                    location_row,
                );
                scene["location"] = location.unwrap_or(serde_json::Value::Null);
            }
        }
        let mut shots = query_all(
            &conn,
            &format!(
                "SELECT {SHOT_COLS} FROM project_shots \
                 WHERE scene_id = ?1 ORDER BY sort_order ASC, created_at ASC",
            ),
            shot_row,
        )?;
        for shot in shots.iter_mut() {
            attach_shot_relations(&conn, shot)?;
            let shot_id = shot["id"].as_str().unwrap_or_default().to_string();
            shot["assets"] = serde_json::json!(query_all(
                &conn,
                &format!(
                    "SELECT {ASSET_COLS} FROM project_assets \
                     WHERE shot_id = ?1 ORDER BY created_at ASC",
                ),
                asset_row,
            )?);
        }
        scene["shots"] = serde_json::json!(shots);
    }

    let loose_assets = query_all(
        &conn,
        &format!(
            "SELECT {ASSET_COLS} FROM project_assets \
             WHERE episode_id = ?1 AND shot_id = '' ORDER BY created_at ASC",
        ),
        asset_row,
    )?;

    Ok(serde_json::json!({
        "episode": episode,
        "characters": characters,
        "scenes": scenes,
        "loose_assets": loose_assets,
    }))
}

// ── 工程搜索 ────────────────────────────────────────────────

/// 跨表搜索工程实体（剧/集/角色/场景/道具/提示词）：LIKE 逐表扫描。
/// 工程数据为个人创作库量级（百级），LIKE 足够且免维护 FTS 影子表；
/// 关键词经 to_lowercase 后与 lower(列) 比较（大小写不敏感，中文不受
/// 影响）；提示词额外搜内容正文。
#[tauri::command]
pub fn project_search(app: AppHandle, query: String) -> Result<Vec<serde_json::Value>, String> {
    let keyword = query.trim().to_lowercase();
    if keyword.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!("%{keyword}%");
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut results: Vec<serde_json::Value> = Vec::new();

    // (kind, 表, 匹配列, 取列)：统一产出 kind/title/id 及跳转所需外键。
    let tables: [(&str, &str, &str, &str); 6] = [
        ("show", "project_shows", "name", "id, name AS title"),
        ("episode", "project_episodes", "title", "id, title, show_id"),
        ("character", "project_characters", "name", "id, name AS title"),
        ("location", "project_locations", "name", "id, name AS title"),
        ("prop", "project_props", "name", "id, name AS title"),
        (
            "prompt",
            "project_prompts",
            "title",
            "id, title, content",
        ),
    ];
    for (kind, table, column, select) in tables {
        // 提示词额外搜内容正文；其余表只搜名称/标题列。
        let content_clause = if kind == "prompt" {
            " OR lower(content) LIKE ?1"
        } else {
            ""
        };
        let sql = format!(
            "SELECT '{kind}' AS kind, {select} FROM {table} \
             WHERE lower({column}) LIKE ?1{content_clause} LIMIT 20"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        // 列名先收集成自有 Vec：闭包内借用 stmt 查列名会与 query_map 的
        // 可变借用冲突。
        let column_names: Vec<String> = (0..stmt.column_count())
            .filter_map(|index| stmt.column_name(index).ok().map(|name| name.to_string()))
            .collect();
        let rows = stmt
            .query_map(params![&pattern], |row| {
                let mut value = serde_json::Map::new();
                for (index, name) in column_names.iter().enumerate() {
                    if name == "kind" {
                        value.insert("kind".into(), serde_json::json!(kind));
                    } else if let Ok(text) = row.get::<_, Option<String>>(index) {
                        value.insert(name.clone(), serde_json::json!(text));
                    }
                }
                Ok(serde_json::Value::Object(value))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect::<Vec<_>>();
        results.extend(rows);
        if results.len() >= 50 {
            results.truncate(50);
            break;
        }
    }
    Ok(results)
}
