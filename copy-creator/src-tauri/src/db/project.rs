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
    output_asset_id TEXT,
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
    reference_paths TEXT NOT NULL DEFAULT '[]',
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
    canvas_x REAL,
    canvas_y REAL,
    FOREIGN KEY (episode_id) REFERENCES project_episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_scenes_episode ON project_scenes(episode_id);

CREATE TABLE IF NOT EXISTS project_shots (
    id TEXT PRIMARY KEY,
    scene_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    dialogue TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'none',
    camera TEXT NOT NULL DEFAULT '',
    duration TEXT NOT NULL DEFAULT '',
    sort_order REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    canvas_x REAL,
    canvas_y REAL,
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
    gen_params TEXT NOT NULL DEFAULT '',
    audio_role TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    canvas_x REAL,
    canvas_y REAL,
    canvas_w REAL
);
CREATE INDEX IF NOT EXISTS idx_project_assets_episode ON project_assets(episode_id);
CREATE INDEX IF NOT EXISTS idx_project_assets_shot ON project_assets(shot_id);

-- 工程画布的手动工作流连线（生成链走 gen_from_asset，不入本表）。
CREATE TABLE IF NOT EXISTS project_asset_links (
    id TEXT PRIMARY KEY,
    from_asset TEXT NOT NULL,
    to_asset TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (from_asset, to_asset),
    FOREIGN KEY (from_asset) REFERENCES project_assets(id) ON DELETE CASCADE,
    FOREIGN KEY (to_asset) REFERENCES project_assets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_asset_links_from ON project_asset_links(from_asset);
CREATE INDEX IF NOT EXISTS idx_project_asset_links_to ON project_asset_links(to_asset);

-- 片段（AI 分段生成的视频分段）：一集拆成多个片段分别生成，按
-- sort_order 拼接成本集成片；产出视频为可空外键（未生成为 NULL）。
CREATE TABLE IF NOT EXISTS project_segments (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL,
    asset_id TEXT,
    sort_order REAL NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    canvas_x REAL,
    canvas_y REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (episode_id) REFERENCES project_episodes(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES project_assets(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_project_segments_episode ON project_segments(episode_id);

-- 片段输入口的连线（角色/场景/道具/脚本/其他 → 片段）：来源可以是库
-- 资料、剧本或素材（脚本/其他口），片段→片段的续生成线也走本表
-- （from_kind='segment'）；素材间参考线仍走 project_asset_links。
CREATE TABLE IF NOT EXISTS project_node_links (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL,
    from_kind TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_segment TEXT NOT NULL,
    to_port TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (from_kind, from_id, to_segment, to_port),
    FOREIGN KEY (episode_id) REFERENCES project_episodes(id) ON DELETE CASCADE,
    FOREIGN KEY (to_segment) REFERENCES project_segments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_node_links_to ON project_node_links(to_segment);

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

CREATE TABLE IF NOT EXISTS project_episode_locations (
    episode_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    PRIMARY KEY (episode_id, location_id),
    FOREIGN KEY (episode_id) REFERENCES project_episodes(id) ON DELETE CASCADE,
    FOREIGN KEY (location_id) REFERENCES project_locations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_episode_props (
    episode_id TEXT NOT NULL,
    prop_id TEXT NOT NULL,
    PRIMARY KEY (episode_id, prop_id),
    FOREIGN KEY (episode_id) REFERENCES project_episodes(id) ON DELETE CASCADE,
    FOREIGN KEY (prop_id) REFERENCES project_props(id) ON DELETE CASCADE
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
        "output_asset_id": row.get::<_, Option<String>>(9)?,
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
        "reference_paths": row.get::<_, String>(6)?,
        "created_at": row.get::<_, String>(7)?,
        "updated_at": row.get::<_, String>(8)?,
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
    let canvas_x: Option<f64> = row.get(8)?;
    let canvas_y: Option<f64> = row.get(9)?;
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "episode_id": row.get::<_, String>(1)?,
        "location_id": row.get::<_, String>(2)?,
        "heading": row.get::<_, String>(3)?,
        "sort_order": row.get::<_, f64>(4)?,
        "note": row.get::<_, String>(5)?,
        "created_at": row.get::<_, String>(6)?,
        "updated_at": row.get::<_, String>(7)?,
        "canvas_x": canvas_x,
        "canvas_y": canvas_y,
    }))
}

fn shot_row(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    let canvas_x: Option<f64> = row.get(11)?;
    let canvas_y: Option<f64> = row.get(12)?;
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "scene_id": row.get::<_, String>(1)?,
        "episode_id": row.get::<_, String>(2)?,
        "description": row.get::<_, String>(3)?,
        "dialogue": row.get::<_, String>(4)?,
        "status": row.get::<_, String>(5)?,
        "camera": row.get::<_, String>(6)?,
        "duration": row.get::<_, String>(7)?,
        "sort_order": row.get::<_, f64>(8)?,
        "created_at": row.get::<_, String>(9)?,
        "updated_at": row.get::<_, String>(10)?,
        "canvas_x": canvas_x,
        "canvas_y": canvas_y,
    }))
}

fn asset_row(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    let canvas_x: Option<f64> = row.get(12)?;
    let canvas_y: Option<f64> = row.get(13)?;
    let canvas_w: Option<f64> = row.get(14)?;
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "file_path": row.get::<_, String>(1)?,
        "kind": row.get::<_, String>(2)?,
        "name": row.get::<_, String>(3)?,
        "shot_id": row.get::<_, String>(4)?,
        "episode_id": row.get::<_, String>(5)?,
        "gen_from_asset": row.get::<_, String>(6)?,
        "gen_from_prompt": row.get::<_, String>(7)?,
        "gen_params": row.get::<_, String>(8)?,
        "audio_role": row.get::<_, String>(9)?,
        "created_at": row.get::<_, String>(10)?,
        "updated_at": row.get::<_, String>(11)?,
        "canvas_x": canvas_x,
        "canvas_y": canvas_y,
        "canvas_w": canvas_w,
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
const SEGMENT_COLS: &str =
    "id, episode_id, asset_id, sort_order, note, canvas_x, canvas_y, created_at, updated_at";

fn segment_row(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "episode_id": row.get::<_, String>(1)?,
        "asset_id": row.get::<_, Option<String>>(2)?,
        "sort_order": row.get::<_, f64>(3)?,
        "note": row.get::<_, String>(4)?,
        "canvas_x": row.get::<_, Option<f64>>(5)?,
        "canvas_y": row.get::<_, Option<f64>>(6)?,
        "created_at": row.get::<_, String>(7)?,
        "updated_at": row.get::<_, String>(8)?,
    }))
}

const EPISODE_COLS: &str =
    "id, show_id, number, title, status, script_path, sort_order, created_at, updated_at, output_asset_id";
const CHARACTER_COLS: &str =
    "id, name, role_tag, bio, prompt, avatar_path, reference_paths, created_at, updated_at";
const LOCATION_COLS: &str =
    "id, name, int_ext, time_hint, bio, prompt, ref_path, created_at, updated_at";
const PROP_COLS: &str = "id, name, bio, prompt, ref_path, created_at, updated_at";
const SCENE_COLS: &str =
    "id, episode_id, location_id, heading, sort_order, note, created_at, updated_at, canvas_x, canvas_y";
const SHOT_COLS: &str =
    "id, scene_id, episode_id, description, dialogue, status, camera, duration, sort_order, created_at, updated_at, canvas_x, canvas_y";
const ASSET_COLS: &str =
    "id, file_path, kind, name, shot_id, episode_id, gen_from_asset, gen_from_prompt, gen_params, audio_role, created_at, updated_at, canvas_x, canvas_y, canvas_w";
const PROMPT_COLS: &str = "id, title, content, category, file_path, created_at, updated_at";

fn query_all(
    conn: &Connection,
    sql: &str,
    map: fn(&rusqlite::Row) -> rusqlite::Result<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, String> {
    // 空参数字面量走 rusqlite 的 ensure_parameter_count(0)：SQL 里一旦
    // 出现 ?N 占位符即报 InvalidParameterCount。带参查询必须用
    // query_all_params；此断言让误用在测试期就爆出来。
    debug_assert!(
        !sql.contains('?'),
        "query_all 仅限无参数 SQL，带参请用 query_all_params：{sql}"
    );
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// query_all 的带参版本：参数按位置绑定（SQL 用 ?1 ?2 … 编号占位符）。
fn query_all_params(
    conn: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
    map: fn(&rusqlite::Row) -> rusqlite::Result<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params, map)
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

// project_shows 的备注（note）列 UI 无编辑入口，不再暴露只写 note 的
// 旧命令；改名走 project_rename_show。

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
    episodes_list_inner(&conn, &show_id)
}

pub(crate) fn episodes_list_inner(
    conn: &Connection,
    show_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let mut episodes = query_all_params(
        conn,
        &format!(
            "SELECT {EPISODE_COLS} FROM project_episodes \
             WHERE show_id = ?1 \
             ORDER BY sort_order ASC, number ASC, created_at ASC",
        ),
        params![&show_id],
        episode_row,
    )?;
    // 镜头统计与出场角色各一次全剧批量查回（按集分组），避免逐集
    // 3 次往返的 N+1；查询量与集数无关，只随全剧镜头/关联总数增长。
    let mut shot_stats: std::collections::HashMap<String, (i64, i64)> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT episode_id, COUNT(*), \
                 SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) \
                 FROM project_shots \
                 WHERE episode_id IN (SELECT id FROM project_episodes WHERE show_id = ?1) \
                 GROUP BY episode_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![&show_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (episode_id, total, done) = row.map_err(|e| e.to_string())?;
            shot_stats.insert(episode_id, (total, done));
        }
    }
    let mut cast: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT episode_id, character_id FROM project_episode_characters \
                 WHERE episode_id IN (SELECT id FROM project_episodes WHERE show_id = ?1) \
                 ORDER BY rowid ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![&show_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (episode_id, character_id) = row.map_err(|e| e.to_string())?;
            cast.entry(episode_id).or_default().push(character_id);
        }
    }
    let mut episode_locations: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT episode_id, location_id FROM project_episode_locations \
                 WHERE episode_id IN (SELECT id FROM project_episodes WHERE show_id = ?1) \
                 ORDER BY rowid ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![&show_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (episode_id, location_id) = row.map_err(|e| e.to_string())?;
            episode_locations
                .entry(episode_id)
                .or_default()
                .push(location_id);
        }
    }
    for episode in episodes.iter_mut() {
        let episode_id = episode["id"].as_str().unwrap_or_default().to_string();
        let (shot_count, done_shot_count) = shot_stats.get(&episode_id).copied().unwrap_or((0, 0));
        episode["character_ids"] =
            serde_json::json!(cast.get(&episode_id).cloned().unwrap_or_default());
        episode["location_ids"] =
            serde_json::json!(episode_locations.get(&episode_id).cloned().unwrap_or_default());
        episode["shot_count"] = serde_json::json!(shot_count);
        episode["done_shot_count"] = serde_json::json!(done_shot_count);
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

/// 本集出场场景关联（画布场景节点的数据源，对齐出场角色模式）。
#[tauri::command]
pub fn project_set_episode_locations(
    app: AppHandle,
    episode_id: String,
    location_ids: Vec<String>,
) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        replace_links(
            &conn,
            "project_episode_locations",
            "episode_id",
            "location_id",
            &episode_id,
            &location_ids,
        )?;
    }
    emit_project_changed(&app);
    Ok(())
}

/// 本集出场道具关联（画布道具节点的数据源；镜头挂靠的道具按并集并存）。
#[tauri::command]
pub fn project_set_episode_props(
    app: AppHandle,
    episode_id: String,
    prop_ids: Vec<String>,
) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        replace_links(
            &conn,
            "project_episode_props",
            "episode_id",
            "prop_id",
            &episode_id,
            &prop_ids,
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
    reference_paths: String,
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
             (id, name, role_tag, bio, prompt, avatar_path, reference_paths, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, name, role_tag, bio, prompt, avatar_path, reference_paths, &now, &now],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(serde_json::json!({
        "id": id, "name": name, "role_tag": role_tag, "bio": bio,
        "prompt": prompt, "avatar_path": avatar_path,
        "reference_paths": reference_paths,
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
    reference_paths: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("角色名不能为空".to_string());
    }
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE project_characters SET name = ?1, role_tag = ?2, bio = ?3, prompt = ?4, avatar_path = ?5, reference_paths = ?6, updated_at = ?7 WHERE id = ?8",
            params![name, role_tag, bio, prompt, normalize_project_path(&avatar_path), reference_paths, project_now(), id],
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
    status: String,
    camera: String,
    duration: String,
) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE project_shots SET description = ?1, dialogue = ?2, status = ?3, camera = ?4, duration = ?5, updated_at = ?6 WHERE id = ?7",
            params![description, dialogue, status, camera, duration, project_now(), id],
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

/// 把库外文件复制进资源库根（「未分组」）：重名自动加「 (1)」序号，与
/// 追溯重链/回收站恢复同一约定。纯文件操作不持锁，大文件复制不阻塞
/// 其他命令；复制非移动，原文件保留。返回库内目标路径。
pub(crate) fn copy_into_library_root(
    root: &std::path::Path,
    source: &std::path::Path,
) -> std::io::Result<std::path::PathBuf> {
    let file_name = source
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "源路径没有文件名"))?;
    let mut dest = root.join(file_name);
    if dest.exists() {
        let stem = source
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default();
        let extension = source
            .extension()
            .map(|ext| ext.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut placed = false;
        for index in 1..=999u32 {
            let candidate_name = if extension.is_empty() {
                format!("{stem} ({index})")
            } else {
                format!("{stem} ({index}).{extension}")
            };
            let candidate = root.join(candidate_name);
            if !candidate.exists() {
                dest = candidate;
                placed = true;
                break;
            }
        }
        if !placed {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "库内存在大量同名文件，无法自动命名",
            ));
        }
    }
    std::fs::copy(source, &dest)?;
    Ok(dest)
}

/// 库外文件入库：复制进库根「未分组」（重名加「 (n)」序号）→ watcher
/// 同款登记资源记录并 bump 修订号；已在库内的路径原样返回不复制。
/// 工程导入（project_import_asset）与通用选择器（import_resource_file）
/// 共用；本函数不落工程档案——挂靠归属是调用方的事。
/// 返回 (相对路径, 媒体类型, 文件名)。
pub(crate) fn import_file_into_library<R: Runtime>(
    app: &AppHandle<R>,
    source_path: &str,
) -> Result<(String, String, String), String> {
    let source = std::path::PathBuf::from(source_path.trim());
    if !source.is_file() {
        return Err("请选择一个文件".to_string());
    }
    let root = get_resource_library_dir(app);
    // 库内判断用小写前缀（Windows 大小写不敏感口径，与前端
    // relativeLibraryPath 一致）；dest 由 root.join 构造，strip_prefix 必成。
    let in_library = source
        .to_string_lossy()
        .to_lowercase()
        .starts_with(&(root.to_string_lossy().to_lowercase() + "/"));
    let dest = if in_library {
        source.clone()
    } else {
        copy_into_library_root(&root, &source).map_err(|error| format!("导入文件失败: {error}"))?
    };
    // watcher 同款登记：为新文件补建资源记录（幂等，已有记录跳过）；
    // 再 bump 修订号让文件视图的心跳立刻感知，不必等监听器。
    settle_external_resource_changes(app, &[dest.clone()]);
    bump_resource_library_revision();

    let relative = normalize_project_path(
        dest.strip_prefix(&root)
            .map_err(|_| "目标路径不在资源库内".to_string())?
            .to_string_lossy()
            .as_ref(),
    );
    if relative.is_empty() {
        return Err("目标路径无效".to_string());
    }
    let kind = crate::media_kind::media_kind_for_path(&dest).as_str().to_string();
    let name = dest
        .file_name()
        .map(|file_name| file_name.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok((relative, kind, name))
}

/// 通用选择器的「从电脑导入」：只入库不挂靠，返回库内相对路径/媒体
/// 类型/文件名，调用方（三库回填、挂靠薄壳）自行决定后续。
#[tauri::command]
pub fn import_resource_file(
    app: AppHandle,
    source_path: String,
) -> Result<serde_json::Value, String> {
    let (relative, kind, name) = import_file_into_library(&app, &source_path)?;
    Ok(serde_json::json!({ "file_path": relative, "kind": kind, "name": name }))
}

/// 从电脑导入文件并挂靠：库外文件复制进库根「未分组」→ watcher 同款
/// 登记资源记录 → 按当前集/镜头落工程档案，一次调用完成。已在库内的
/// 路径不复制直接挂靠（容错；正常路径由挂靠列表完成）。挂靠仍是
/// file_path UNIQUE upsert，重复导入/挂靠改归属不新建行。
#[tauri::command]
pub fn project_import_asset(
    app: AppHandle,
    source_path: String,
    episode_id: String,
    shot_id: String,
) -> Result<serde_json::Value, String> {
    let (relative, kind, name) = import_file_into_library(&app, &source_path)?;
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
            params![id, relative, kind, name, shot_id, episode_id, &now, &now],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    // 与 project_link_asset 同口径：即时返回也带 missing 标。root 在本
    // 函数开头已解析，无重入锁问题。
    let root = get_resource_library_dir(&app);
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut asset = query_row_with_param(
        &conn,
        &format!("SELECT {ASSET_COLS} FROM project_assets WHERE file_path = ?1"),
        &[&relative],
        asset_row,
    )?;
    asset["missing"] = serde_json::json!(!root.join(&relative).exists());
    Ok(asset)
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
    emit_project_changed(&app);
    // 返回值补 missing 标：ProjectAsset 类型要求该字段（overview 逐档案
    // 检测的同口径），挂靠/导入的即时返回也要带，免得类型谎报。先解析
    // 库根（内部要锁 conn 读设置），再锁连接取行。
    let library_root = get_resource_library_dir(&app);
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut asset = query_row_with_param(
        &conn,
        &format!("SELECT {ASSET_COLS} FROM project_assets WHERE file_path = ?1"),
        &[&path],
        asset_row,
    )?;
    asset["missing"] = serde_json::json!(!library_root.join(&path).exists());
    Ok(asset)
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
    gen_params: String,
    audio_role: String,
) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE project_assets SET kind = ?1, name = ?2, episode_id = ?3, shot_id = ?4, \
                gen_from_asset = ?5, gen_from_prompt = ?6, gen_params = ?7, audio_role = ?8, updated_at = ?9 WHERE id = ?10",
            params![
                kind,
                name,
                episode_id,
                shot_id,
                gen_from_asset,
                gen_from_prompt,
                gen_params,
                audio_role,
                project_now(),
                id
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

/// 摘除工程档案（只删记录，资源库文件不动）。工作流连线随档案两端
/// 一并清理（外键 CASCADE 已覆盖，显式删除兜底历史库未启外键的场景）。
#[tauri::command]
pub fn project_unlink_asset(app: AppHandle, id: String) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM project_asset_links WHERE from_asset = ?1 OR to_asset = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM project_assets WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    emit_project_changed(&app);
    Ok(())
}

// ── 工程画布 ────────────────────────────────────────────────
// 节点/分组框坐标与手动连线是「看」的持久化形态：保存走批量静默命令
// （不 emit project-changed，画布自身已是事实来源，避免拖一下整树重取）。

/// 批量保存画布布局：素材节点（x/y/宽）、空镜头卡（x/y）、场景分组
/// 框（x/y）。坐标为世界像素；未提供的条目不动。NULL 坐标（未摆放）
/// 由前端自动布局，无需在此清除。
#[tauri::command]
pub fn project_save_canvas_layout(
    app: AppHandle,
    payload: serde_json::Value,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    canvas_layout_inner(&conn, &payload)
}

pub(crate) fn canvas_layout_inner(
    conn: &Connection,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let now = project_now();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if let Some(assets) = payload.get("assets").and_then(|v| v.as_array()) {
        for item in assets {
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let x = item.get("x").and_then(|v| v.as_f64());
            let y = item.get("y").and_then(|v| v.as_f64());
            let w = item.get("w").and_then(|v| v.as_f64());
            tx.execute(
                "UPDATE project_assets \
                 SET canvas_x = ?2, canvas_y = ?3, canvas_w = ?4, updated_at = ?5 \
                 WHERE id = ?1",
                params![id, x, y, w, &now],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    if let Some(shots) = payload.get("shots").and_then(|v| v.as_array()) {
        for item in shots {
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let x = item.get("x").and_then(|v| v.as_f64());
            let y = item.get("y").and_then(|v| v.as_f64());
            tx.execute(
                "UPDATE project_shots SET canvas_x = ?2, canvas_y = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, x, y, &now],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    if let Some(scenes) = payload.get("scenes").and_then(|v| v.as_array()) {
        for item in scenes {
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let x = item.get("x").and_then(|v| v.as_f64());
            let y = item.get("y").and_then(|v| v.as_f64());
            tx.execute(
                "UPDATE project_scenes SET canvas_x = ?2, canvas_y = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, x, y, &now],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    if let Some(segments) = payload.get("segments").and_then(|v| v.as_array()) {
        for item in segments {
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let x = item.get("x").and_then(|v| v.as_f64());
            let y = item.get("y").and_then(|v| v.as_f64());
            tx.execute(
                "UPDATE project_segments SET canvas_x = ?2, canvas_y = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, x, y, &now],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 手动连出一条工作流参考线（重复连线幂等忽略）。
#[tauri::command]
pub fn project_link_assets(
    app: AppHandle,
    from_asset: String,
    to_asset: String,
    label: String,
) -> Result<serde_json::Value, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    link_assets_inner(&conn, &from_asset, &to_asset, &label)
}

/// 设置本集成片输出的来源：裸素材 id 或 "shot:<id>"；None/空串为清除。
#[tauri::command]
pub fn project_set_episode_output(
    app: AppHandle,
    id: String,
    output_asset_id: Option<String>,
) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        set_episode_output_inner(&conn, &id, output_asset_id.as_deref())?;
    }
    emit_project_changed(&app);
    Ok(())
}

pub(crate) fn set_episode_output_inner(
    conn: &Connection,
    id: &str,
    output_asset_id: Option<&str>,
) -> Result<(), String> {
    let value = output_asset_id.unwrap_or("").trim();
    if !value.is_empty() {
        let episode_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM project_episodes WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if episode_exists == 0 {
            return Err("集不存在".to_string());
        }
        // 来源可以是某素材，也可以是某镜头（"shot:<id>"，取其视频产出）。
        if let Some(shot_id) = value.strip_prefix("shot:") {
            let shot_exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM project_shots WHERE id = ?1",
                    params![shot_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if shot_exists == 0 {
                return Err("镜头不存在".to_string());
            }
        } else {
            let asset_exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM project_assets WHERE id = ?1",
                    params![value],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if asset_exists == 0 {
                return Err("素材档案不存在".to_string());
            }
        }
    }
    conn.execute(
        "UPDATE project_episodes SET output_asset_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![if value.is_empty() { None } else { Some(value) }, project_now(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── 片段工作流（AI 分段生成 → 按序拼接成片） ────────────────

/// 新建一个空片段，排到本集拼接序列末尾。
#[tauri::command]
pub fn project_add_segment(
    app: AppHandle,
    episode_id: String,
) -> Result<serde_json::Value, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let segment = add_segment_inner(&conn, &episode_id)?;
    emit_project_changed(&app);
    Ok(segment)
}

pub(crate) fn add_segment_inner(
    conn: &Connection,
    episode_id: &str,
) -> Result<serde_json::Value, String> {
    let episode_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM project_episodes WHERE id = ?1",
            params![episode_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if episode_exists == 0 {
        return Err("集不存在".to_string());
    }
    let max_order: f64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) FROM project_segments WHERE episode_id = ?1",
            params![episode_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = project_now();
    conn.execute(
        "INSERT INTO project_segments (id, episode_id, asset_id, sort_order, note, canvas_x, canvas_y, created_at, updated_at) \
         VALUES (?1, ?2, NULL, ?3, '', NULL, NULL, ?4, ?4)",
        params![id, episode_id, max_order + 1.0, &now],
    )
    .map_err(|e| e.to_string())?;
    query_row_with_param(
        conn,
        &format!("SELECT {SEGMENT_COLS} FROM project_segments WHERE id = ?1"),
        &[&id],
        segment_row,
    )
}

/// 删除片段（输入口连线随外键级联消失）。
#[tauri::command]
pub fn project_remove_segment(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    remove_segment_inner(&conn, &id)?;
    emit_project_changed(&app);
    Ok(())
}

pub(crate) fn remove_segment_inner(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM project_segments WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 片段在拼接序列中前移/后移一位（与相邻片段交换 sort_order）。
#[tauri::command]
pub fn project_move_segment(app: AppHandle, id: String, direction: i64) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    move_segment_inner(&conn, &id, direction)?;
    emit_project_changed(&app);
    Ok(())
}

pub(crate) fn move_segment_inner(
    conn: &Connection,
    id: &str,
    direction: i64,
) -> Result<(), String> {
    if direction != -1 && direction != 1 {
        return Err("方向只能是 -1（前移）或 1（后移）".to_string());
    }
    let (episode_id, sort_order): (String, f64) = conn
        .query_row(
            "SELECT episode_id, sort_order FROM project_segments WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "片段不存在".to_string())?;
    // 相邻片段按拼接序取（排序口径与 overview 一致）：前移找排序更小
    // 的前一个，后移找排序更大的后一个。
    let neighbor: Option<String> = if direction == -1 {
        conn.query_row(
            "SELECT id FROM project_segments \
             WHERE episode_id = ?1 AND sort_order < ?2 \
             ORDER BY sort_order DESC, created_at DESC, id DESC LIMIT 1",
            params![episode_id, sort_order],
            |row| row.get(0),
        )
        .ok()
    } else {
        conn.query_row(
            "SELECT id FROM project_segments \
             WHERE episode_id = ?1 AND sort_order > ?2 \
             ORDER BY sort_order ASC, created_at ASC, id ASC LIMIT 1",
            params![episode_id, sort_order],
            |row| row.get(0),
        )
        .ok()
    };
    let neighbor_id = neighbor.ok_or_else(|| "已经在序列边缘".to_string())?;
    let neighbor_order: f64 = conn
        .query_row(
            "SELECT sort_order FROM project_segments WHERE id = ?1",
            params![&neighbor_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE project_segments SET sort_order = ?1, updated_at = ?2 WHERE id = ?3",
        params![neighbor_order, project_now(), id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE project_segments SET sort_order = ?1, updated_at = ?2 WHERE id = ?3",
        params![sort_order, project_now(), &neighbor_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 挂靠片段产出视频（可清除；素材不存在拒绝）。
#[tauri::command]
pub fn project_set_segment_asset(
    app: AppHandle,
    id: String,
    asset_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    set_segment_asset_inner(&conn, &id, asset_id.as_deref())?;
    emit_project_changed(&app);
    Ok(())
}

pub(crate) fn set_segment_asset_inner(
    conn: &Connection,
    id: &str,
    asset_id: Option<&str>,
) -> Result<(), String> {
    let value = asset_id.unwrap_or("").trim();
    if !value.is_empty() {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM project_assets WHERE id = ?1",
                params![value],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists == 0 {
            return Err("素材档案不存在".to_string());
        }
    }
    conn.execute(
        "UPDATE project_segments SET asset_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![if value.is_empty() { None } else { Some(value) }, project_now(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 片段备注（卡头名称；空串回落为默认名）。
#[tauri::command]
pub fn project_set_segment_note(
    app: AppHandle,
    id: String,
    note: String,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE project_segments SET note = ?1, updated_at = ?2 WHERE id = ?3",
        params![note.trim(), project_now(), &id],
    )
    .map_err(|e| e.to_string())?;
    emit_project_changed(&app);
    Ok(())
}

/// 片段输入口连线：来源 = 库资料 / 剧本 / 素材 / 另一片段（续生成），
/// 幂等；from_kind 与来源 id 必须真实存在。
#[tauri::command]
pub fn project_link_node(
    app: AppHandle,
    episode_id: String,
    from_kind: String,
    from_id: String,
    to_segment: String,
    to_port: String,
) -> Result<serde_json::Value, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let link = link_node_inner(
        &conn,
        &episode_id,
        &from_kind,
        &from_id,
        &to_segment,
        &to_port,
    )?;
    emit_project_changed(&app);
    Ok(link)
}

pub(crate) fn link_node_inner(
    conn: &Connection,
    episode_id: &str,
    from_kind: &str,
    from_id: &str,
    to_segment: &str,
    to_port: &str,
) -> Result<serde_json::Value, String> {
    const FROM_KINDS: [&str; 7] = ["asset", "character", "location", "prop", "script", "segment", "shot"];
    const TO_PORTS: [&str; 5] = ["character", "location", "prop", "script", "other"];
    if !FROM_KINDS.contains(&from_kind) {
        return Err(format!("未知连线来源类型：{from_kind}"));
    }
    if !TO_PORTS.contains(&to_port) {
        return Err(format!("未知片段输入口：{to_port}"));
    }
    let segment_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM project_segments WHERE id = ?1 AND episode_id = ?2",
            params![to_segment, episode_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if segment_exists == 0 {
        return Err("片段不存在".to_string());
    }
    // 剧本来源以集为锚（from_id = episode_id），要求该集已挂接剧本；
    // 其余来源逐一查表确认存在。
    let exists_in = |table: &str| -> Result<bool, String> {
        Ok(conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE id = ?1"),
                params![from_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())?
            > 0)
    };
    let source_exists = match from_kind {
        "asset" => exists_in("project_assets")?,
        "character" => exists_in("project_characters")?,
        "location" => exists_in("project_locations")?,
        "prop" => exists_in("project_props")?,
        "segment" => exists_in("project_segments")?,
        "shot" => exists_in("project_shots")?,
        "script" => {
            if from_id != episode_id {
                return Err("剧本来源的 from_id 必须为集 id".to_string());
            }
            let script_path: String = conn
                .query_row(
                    "SELECT script_path FROM project_episodes WHERE id = ?1",
                    params![episode_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            !script_path.trim().is_empty()
        }
        _ => false,
    };
    if !source_exists {
        return Err("连线来源不存在".to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT OR IGNORE INTO project_node_links \
         (id, episode_id, from_kind, from_id, to_segment, to_port, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, episode_id, from_kind, from_id, to_segment, to_port, project_now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "id": id,
        "from_kind": from_kind,
        "from_id": from_id,
        "to_segment": to_segment,
        "to_port": to_port,
    }))
}

/// 摘除一条片段输入口连线。
#[tauri::command]
pub fn project_unlink_node(
    app: AppHandle,
    from_kind: String,
    from_id: String,
    to_segment: String,
    to_port: String,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM project_node_links \
         WHERE from_kind = ?1 AND from_id = ?2 AND to_segment = ?3 AND to_port = ?4",
        params![from_kind, from_id, to_segment, to_port],
    )
    .map_err(|e| e.to_string())?;
    emit_project_changed(&app);
    Ok(())
}

pub(crate) fn link_assets_inner(
    conn: &Connection,
    from_asset: &str,
    to_asset: &str,
    label: &str,
) -> Result<serde_json::Value, String> {
    if from_asset == to_asset {
        return Err("不能连接素材自身".to_string());
    }
    // 两端必须都是当前库内的工程档案（防跨集脏边由 overview 过滤兜底）。
    let exists = |id: &str| -> Result<bool, String> {
        Ok(conn
            .query_row("SELECT COUNT(*) FROM project_assets WHERE id = ?1", params![id], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|e| e.to_string())?
            > 0)
    };
    if !exists(from_asset)? || !exists(to_asset)? {
        return Err("素材档案不存在".to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = project_now();
    conn.execute(
        "INSERT OR IGNORE INTO project_asset_links (id, from_asset, to_asset, label, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, from_asset, to_asset, label.trim(), &now],
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "id": id,
        "from_asset": from_asset,
        "to_asset": to_asset,
        "label": label.trim(),
    }))
}

/// 摘除一条手动连线（按两端素材定位，忽略方向与创建顺序）。
#[tauri::command]
pub fn project_unlink_assets(
    app: AppHandle,
    from_asset: String,
    to_asset: String,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    unlink_assets_inner(&conn, &from_asset, &to_asset)
}

pub(crate) fn unlink_assets_inner(
    conn: &Connection,
    from_asset: &str,
    to_asset: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM project_asset_links \
         WHERE (from_asset = ?1 AND to_asset = ?2) OR (from_asset = ?2 AND to_asset = ?1)",
        params![from_asset, to_asset],
    )
    .map_err(|e| e.to_string())?;
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
        Some(category) => query_all_params(
            &conn,
            &format!(
                "SELECT {PROMPT_COLS} FROM project_prompts \
                 WHERE category = ?1 ORDER BY created_at DESC, id ASC",
            ),
            params![category],
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
/// 素材）、集级散件素材。前端打开一集只需这一次往返。素材档案带
/// missing 标记（文件是否还在当前资源库根下）：库里删了文件时工程侧
/// 悬空档案可见，而不是等点开详情图挂了才发现。
#[tauri::command]
pub fn project_get_episode_overview(
    app: AppHandle,
    episode_id: String,
) -> Result<serde_json::Value, String> {
    // 先解析库根（内部也要锁 conn 读设置），再锁库连接做聚合。
    let library_root = get_resource_library_dir(&app);
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    episode_overview_inner(&conn, &episode_id, &library_root)
}

pub(crate) fn episode_overview_inner(
    conn: &Connection,
    episode_id: &str,
    library_root: &std::path::Path,
) -> Result<serde_json::Value, String> {
    let episode = query_row_with_param(
        conn,
        &format!("SELECT {EPISODE_COLS} FROM project_episodes WHERE id = ?1"),
        &[&episode_id],
        episode_row,
    )?;

    let character_ids = episode_character_ids(conn, episode_id)?;
    let mut characters = Vec::with_capacity(character_ids.len());
    for character_id in &character_ids {
        let character = query_row_with_param(
            conn,
            &format!("SELECT {CHARACTER_COLS} FROM project_characters WHERE id = ?1"),
            &[character_id],
            character_row,
        );
        if let Ok(character) = character {
            characters.push(character);
        }
    }

    // 本集出场场景（画布场景节点的数据源，与出场角色同模式）。
    let location_ids: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT location_id FROM project_episode_locations \
                 WHERE episode_id = ?1 ORDER BY rowid ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![episode_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    let mut locations = Vec::with_capacity(location_ids.len());
    for location_id in &location_ids {
        let location = query_row_with_param(
            conn,
            &format!("SELECT {LOCATION_COLS} FROM project_locations WHERE id = ?1"),
            &[location_id],
            location_row,
        );
        if let Ok(location) = location {
            locations.push(location);
        }
    }
    let mut episode = episode;
    episode["location_ids"] = serde_json::json!(location_ids);

    // 本集出场道具 = 集级关联 ∪ 镜头挂靠并集（画布道具节点数据源）。
    let mut prop_ids: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT prop_id FROM project_episode_props \
                 WHERE episode_id = ?1 ORDER BY rowid ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![episode_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT sp.prop_id FROM project_shot_props sp \
                 JOIN project_shots s ON s.id = sp.shot_id \
                 WHERE s.episode_id = ?1 ORDER BY sp.rowid ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![episode_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let prop_id = row.map_err(|e| e.to_string())?;
            if !prop_ids.contains(&prop_id) {
                prop_ids.push(prop_id);
            }
        }
    }
    let mut props = Vec::with_capacity(prop_ids.len());
    for prop_id in &prop_ids {
        let prop = query_row_with_param(
            conn,
            &format!("SELECT {PROP_COLS} FROM project_props WHERE id = ?1"),
            &[prop_id],
            prop_row,
        );
        if let Ok(prop) = prop {
            props.push(prop);
        }
    }
    episode["prop_ids"] = serde_json::json!(prop_ids);

    let mut scenes = query_all_params(
        conn,
        &format!(
            "SELECT {SCENE_COLS} FROM project_scenes \
             WHERE episode_id = ?1 ORDER BY sort_order ASC, created_at ASC",
        ),
        params![&episode_id],
        scene_row,
    )?;
    // 镜头出镜/道具关系与素材各一次全集批量查回（按镜头分组），避免
    // 每镜头 3 次往返的 N+1；素材一次按集拿全，集级散件同批过滤。
    let mut per_scene_shots: Vec<Vec<serde_json::Value>> = Vec::new();
    for scene in scenes.iter_mut() {
        let scene_id = scene["id"].as_str().unwrap_or_default().to_string();
        if let Some(location_id) = scene["location_id"].as_str() {
            if !location_id.is_empty() {
                let location = query_row_with_param(
                    conn,
                    &format!("SELECT {LOCATION_COLS} FROM project_locations WHERE id = ?1"),
                    &[&location_id],
                    location_row,
                );
                scene["location"] = location.unwrap_or(serde_json::Value::Null);
            }
        }
        per_scene_shots.push(query_all_params(
            conn,
            &format!(
                "SELECT {SHOT_COLS} FROM project_shots \
                 WHERE scene_id = ?1 ORDER BY sort_order ASC, created_at ASC",
            ),
            params![&scene_id],
            shot_row,
        )?);
        scene["shots"] = serde_json::json!([]);
    }

    let mut shot_characters: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT shot_id, character_id FROM project_shot_characters \
                 WHERE shot_id IN (SELECT id FROM project_shots WHERE scene_id IN \
                 (SELECT id FROM project_scenes WHERE episode_id = ?1)) ORDER BY rowid ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![&episode_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (shot_id, character_id) = row.map_err(|e| e.to_string())?;
            shot_characters.entry(shot_id).or_default().push(character_id);
        }
    }
    let mut shot_props: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT shot_id, prop_id FROM project_shot_props \
                 WHERE shot_id IN (SELECT id FROM project_shots WHERE scene_id IN \
                 (SELECT id FROM project_scenes WHERE episode_id = ?1)) ORDER BY rowid ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![&episode_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (shot_id, prop_id) = row.map_err(|e| e.to_string())?;
            shot_props.entry(shot_id).or_default().push(prop_id);
        }
    }
    let mut assets_by_shot: std::collections::HashMap<String, Vec<serde_json::Value>> =
        std::collections::HashMap::new();
    let mut loose_assets: Vec<serde_json::Value> = Vec::new();
    {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {ASSET_COLS} FROM project_assets \
                 WHERE episode_id = ?1 ORDER BY created_at ASC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![episode_id], asset_row)
            .map_err(|e| e.to_string())?;
        for row in rows {
            let mut asset = row.map_err(|e| e.to_string())?;
            // 缺失检测按当前库根解析相对路径；库根迁移后按新根判，
            // 与「文件引用相对库根」的存储惯例一致。
            let file_path = asset["file_path"].as_str().unwrap_or_default();
            asset["missing"] = serde_json::json!(!library_root.join(file_path).exists());
            let shot_id = asset["shot_id"].as_str().unwrap_or_default().to_string();
            if shot_id.is_empty() {
                loose_assets.push(asset);
            } else {
                assets_by_shot.entry(shot_id).or_default().push(asset);
            }
        }
    }

    for (scene, mut shots) in scenes.iter_mut().zip(per_scene_shots) {
        for shot in shots.iter_mut() {
            let shot_id = shot["id"].as_str().unwrap_or_default().to_string();
            shot["character_ids"] = serde_json::json!(
                shot_characters.get(&shot_id).cloned().unwrap_or_default()
            );
            shot["prop_ids"] = serde_json::json!(
                shot_props.get(&shot_id).cloned().unwrap_or_default()
            );
            shot["assets"] = serde_json::json!(
                assets_by_shot.get(&shot_id).cloned().unwrap_or_default()
            );
        }
        scene["shots"] = serde_json::json!(shots);
    }

    // 手动工作流连线：只取本集素材之间的边（两端都属当前集），供画布
    // 一次渲染；生成链（gen_from_asset）由前端从素材数据直接推导。
    let links = query_all_params(
        conn,
        "SELECT l.id, l.from_asset, l.to_asset, l.label \
         FROM project_asset_links l \
         JOIN project_assets a1 ON a1.id = l.from_asset \
         JOIN project_assets a2 ON a2.id = l.to_asset \
         WHERE a1.episode_id = ?1 AND a2.episode_id = ?1 \
         ORDER BY l.created_at ASC, l.id ASC",
        params![episode_id],
        |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "from_asset": row.get::<_, String>(1)?,
                "to_asset": row.get::<_, String>(2)?,
                "label": row.get::<_, String>(3)?,
            }))
        },
    )?;

    // 片段（按拼接序）与片段输入口连线：片段产出的视频素材整对象带出
    // （缺失检测与素材口径一致），画布直接渲染缩略与连线。
    let mut segments = query_all_params(
        conn,
        &format!(
            "SELECT {SEGMENT_COLS} FROM project_segments \
             WHERE episode_id = ?1 ORDER BY sort_order ASC, created_at ASC, id ASC"
        ),
        params![episode_id],
        segment_row,
    )?;
    for segment in segments.iter_mut() {
        if let Some(asset_id) = segment["asset_id"].as_str() {
            let asset = query_row_with_param(
                conn,
                &format!("SELECT {ASSET_COLS} FROM project_assets WHERE id = ?1"),
                &[&asset_id.to_string()],
                asset_row,
            );
            if let Ok(mut asset) = asset {
                let file_path = asset["file_path"].as_str().unwrap_or_default().to_string();
                asset["missing"] =
                    serde_json::json!(!library_root.join(&file_path).exists());
                segment["asset"] = asset;
            }
        }
    }
    let node_links = query_all_params(
        conn,
        "SELECT id, from_kind, from_id, to_segment, to_port \
         FROM project_node_links WHERE episode_id = ?1 \
         ORDER BY created_at ASC, id ASC",
        params![episode_id],
        |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "from_kind": row.get::<_, String>(1)?,
                "from_id": row.get::<_, String>(2)?,
                "to_segment": row.get::<_, String>(3)?,
                "to_port": row.get::<_, String>(4)?,
            }))
        },
    )?;

    Ok(serde_json::json!({
        "episode": episode,
        "characters": characters,
        "locations": locations,
        "props": props,
        "scenes": scenes,
        "loose_assets": loose_assets,
        "links": links,
        "segments": segments,
        "node_links": node_links,
    }))
}

// ── 工程搜索 ────────────────────────────────────────────────

/// 跨表搜索工程实体（剧/集/角色/场景/道具/提示词）：LIKE 逐表扫描。
/// 工程数据为个人创作库量级（百级），LIKE 足够且免维护 FTS 影子表；
/// 关键词经 to_lowercase 后与 lower(列) 比较（大小写不敏感，中文不受
/// 影响）；提示词额外搜内容正文。
#[tauri::command]
pub fn project_search(app: AppHandle, query: String) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    project_search_inner(&conn, &query)
}

pub(crate) fn project_search_inner(
    conn: &Connection,
    query: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let keyword = query.trim().to_lowercase();
    if keyword.is_empty() {
        return Ok(Vec::new());
    }
    // LIKE 通配符按字面匹配：用户搜「100%」「a_b」不被当模式。
    let escaped = keyword
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{escaped}%");
    let mut results: Vec<serde_json::Value> = Vec::new();

    // (kind, 表, 匹配列, 附加描述列, 取列)：统一产出 kind/title/id 及跳转
    // 所需外键。附加列是名称之外的描述性正文（角色的 bio、提示词的
    // content），SQL 片段为内部常量拼接，不来自用户输入。
    let tables: [(&str, &str, &str, &str, &str); 6] = [
        ("show", "project_shows", "name", "note", "id, name AS title"),
        ("episode", "project_episodes", "title", "", "id, title, show_id"),
        (
            "character",
            "project_characters",
            "name",
            "bio",
            "id, name AS title",
        ),
        (
            "location",
            "project_locations",
            "name",
            "bio",
            "id, name AS title",
        ),
        ("prop", "project_props", "name", "bio", "id, name AS title"),
        (
            "prompt",
            "project_prompts",
            "title",
            "content",
            "id, title, content",
        ),
    ];
    for (kind, table, column, extra_column, select) in tables {
        // 描述列额外参与匹配（剧的备注/角色地点道具的简介/提示词正文）。
        let content_clause = if extra_column.is_empty() {
            String::new()
        } else {
            format!(" OR lower({extra_column}) LIKE ?1 ESCAPE '\\'")
        };
        let sql = format!(
            "SELECT '{kind}' AS kind, {select} FROM {table} \
             WHERE lower({column}) LIKE ?1 ESCAPE '\\'{content_clause} LIMIT 20"
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
