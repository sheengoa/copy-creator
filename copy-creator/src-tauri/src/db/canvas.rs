// 画布域（自由生图工作流）：多画布 + 四类节点（text/image/ref/note）+
// 节点级连线三表。与工程域同惯例：媒体文件留在资源库文件系统，本域只存
// 实体与关系，节点的 resource_path 是相对库根软路径，删除画布/节点不碰
// 文件。连线语义（画布区方案 v2）：多入线、按类型分组累积——text 多线按
// created_at 拼接为提示词，ref/图片多线累积为参考图；UNIQUE 只防同源重复
// 平行线，无「顶掉」（v1 的输入位唯一顶掉语义已废止）。
use super::*;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

/// 画布域 schema：由 ensure_schema 统一执行（幂等），与工程域批次分离
/// 保持域内聚；三表同时登记进 MIGRATED_BUSINESS_TABLES，否则整库存储
/// 迁移（换存储目录）会漏搬画布数据。
pub(crate) const CANVAS_SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS canvases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    viewport_x REAL NOT NULL DEFAULT 0,
    viewport_y REAL NOT NULL DEFAULT 0,
    viewport_k REAL NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS canvas_nodes (
    id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    pos_x REAL NOT NULL DEFAULT 0,
    pos_y REAL NOT NULL DEFAULT 0,
    width REAL,
    height REAL,
    metadata TEXT NOT NULL DEFAULT '{}',
    resource_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (canvas_id) REFERENCES canvases(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_canvas_nodes_canvas ON canvas_nodes(canvas_id);

CREATE TABLE IF NOT EXISTS canvas_connections (
    id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL,
    from_node TEXT NOT NULL,
    to_node TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (canvas_id, from_node, to_node),
    FOREIGN KEY (canvas_id) REFERENCES canvases(id) ON DELETE CASCADE,
    FOREIGN KEY (from_node) REFERENCES canvas_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (to_node) REFERENCES canvas_nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_canvas_connections_canvas ON canvas_connections(canvas_id);
";

// ── 节点 metadata 严格类型 ──────────────────────────────────

/// 节点 metadata 按节点类型分变体（方案 3.2）：拒绝自由袋子腐化；字段
/// 增删靠 serde default 幂等升级（旧 JSON 缺字段补默认值），与 ensure_column
/// 同哲学。TS 侧类型与此一一对应。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum NodeMeta {
    Text {
        content: String,
    },
    Note {
        content: String,
    },
    /// 参考图节点：路径在节点行 resource_path 上，metadata 暂无额外字段；
    /// 留空变体保位，后续字段走 serde default 升级。
    Ref {},
    Image {
        #[serde(default)]
        params: ImageGenParams,
        #[serde(default)]
        status: ImageNodeStatus,
        #[serde(default)]
        error: String,
        #[serde(default)]
        images: Vec<GeneratedImage>,
    },
}

/// 图片节点生成状态机（阶段 2 逐格填充用，一期仅 idle/空壳）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ImageNodeStatus {
    #[default]
    Idle,
    Generating,
    Done,
    Error,
}

/// 图片节点自身生成参数（上游连线才是提示词主来源，这里是节点参数面板
/// 的补充项）。字段全 default，阶段 2 增字段不破坏旧 JSON。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub(crate) struct ImageGenParams {
    pub model: String,
    pub size: String,
    pub count: i64,
}

impl Default for ImageGenParams {
    fn default() -> Self {
        ImageGenParams { model: String::new(), size: String::new(), count: 1 }
    }
}

/// 单张生成备选（方案 3.5）：宽高/字节为展示与排序用元数据，
/// resource_path 相对库根，primary 即主图语义（下游引用取主图）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub(crate) struct GeneratedImage {
    pub width: i64,
    pub height: i64,
    pub bytes: i64,
    pub resource_path: String,
    pub primary: bool,
}

impl Default for GeneratedImage {
    fn default() -> Self {
        GeneratedImage { width: 0, height: 0, bytes: 0, resource_path: String::new(), primary: false }
    }
}

impl NodeMeta {
    /// 节点类型的默认 metadata（建节点未传 metadata 时）；未知类型在此
    /// 一并拒绝。
    pub(crate) fn default_for(node_type: &str) -> Result<NodeMeta, String> {
        match node_type {
            "text" => Ok(NodeMeta::Text { content: String::new() }),
            "note" => Ok(NodeMeta::Note { content: String::new() }),
            "ref" => Ok(NodeMeta::Ref {}),
            "image" => Ok(NodeMeta::Image {
                params: ImageGenParams::default(),
                status: ImageNodeStatus::Idle,
                error: String::new(),
                images: Vec::new(),
            }),
            other => Err(format!("未知节点类型：{other}")),
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            NodeMeta::Text { .. } => "text",
            NodeMeta::Note { .. } => "note",
            NodeMeta::Ref { .. } => "ref",
            NodeMeta::Image { .. } => "image",
        }
    }
}

/// 读路径宽容解析：kind 与类型列不符 / JSON 损坏 / 字段缺失时回退该类型
/// 默认值——历史脏数据不阻断加载（对齐工程域幂等升级哲学）。
pub(crate) fn parse_node_meta_lenient(node_type: &str, raw: &str) -> NodeMeta {
    let default = match NodeMeta::default_for(node_type) {
        Ok(default) => default,
        Err(_) => return NodeMeta::Text { content: String::new() },
    };
    match serde_json::from_str::<NodeMeta>(raw) {
        Ok(meta) if meta.kind() == node_type => meta,
        _ => default,
    }
}

/// 写路径严格解析：空串给默认值；kind 与类型列不符直接报错，不让脏
/// metadata 落库。
fn parse_node_meta_strict(node_type: &str, raw: &str) -> Result<NodeMeta, String> {
    if raw.trim().is_empty() {
        return NodeMeta::default_for(node_type);
    }
    let meta: NodeMeta =
        serde_json::from_str(raw).map_err(|e| format!("metadata JSON 解析失败：{e}"))?;
    if meta.kind() != node_type {
        return Err(format!(
            "metadata 类型 {} 与节点类型 {node_type} 不符",
            meta.kind()
        ));
    }
    Ok(meta)
}

// ── 行映射 ──────────────────────────────────────────────────

const CANVAS_COLS: &str = "id, name, viewport_x, viewport_y, viewport_k, created_at, updated_at";
const NODE_COLS: &str =
    "id, canvas_id, type, title, pos_x, pos_y, width, height, metadata, resource_path, created_at, updated_at";
const CONNECTION_COLS: &str = "id, canvas_id, from_node, to_node, created_at";

fn canvas_row(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "name": row.get::<_, String>(1)?,
        "viewport_x": row.get::<_, f64>(2)?,
        "viewport_y": row.get::<_, f64>(3)?,
        "viewport_k": row.get::<_, f64>(4)?,
        "created_at": row.get::<_, String>(5)?,
        "updated_at": row.get::<_, String>(6)?,
    }))
}

fn node_row(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    let node_type: String = row.get(2)?;
    let raw_meta: String = row.get(8)?;
    let meta = parse_node_meta_lenient(&node_type, &raw_meta);
    let meta_value = serde_json::to_value(&meta)
        .unwrap_or_else(|_| serde_json::json!({ "kind": node_type.clone() }));
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "canvas_id": row.get::<_, String>(1)?,
        "type": node_type,
        "title": row.get::<_, String>(3)?,
        "pos_x": row.get::<_, f64>(4)?,
        "pos_y": row.get::<_, f64>(5)?,
        "width": row.get::<_, Option<f64>>(6)?,
        "height": row.get::<_, Option<f64>>(7)?,
        "metadata": meta_value,
        "resource_path": row.get::<_, String>(9)?,
        "created_at": row.get::<_, String>(10)?,
        "updated_at": row.get::<_, String>(11)?,
    }))
}

fn connection_row(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "canvas_id": row.get::<_, String>(1)?,
        "from_node": row.get::<_, String>(2)?,
        "to_node": row.get::<_, String>(3)?,
        "created_at": row.get::<_, String>(4)?,
    }))
}

pub(crate) fn canvas_now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn emit_canvas_changed<R: Runtime>(app: &AppHandle<R>) {
    // 对齐 project-changed：画布数据前端整体订阅、统一重取，粗粒度事件
    // 即可；视口/批量布局落盘不 emit（见各命令注释）。
    let _ = app.emit("canvas-changed", ());
}

pub(crate) fn bump_canvas_updated_at(conn: &Connection, canvas_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE canvases SET updated_at = ?1 WHERE id = ?2",
        params![canvas_now(), canvas_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── 内层函数（命令薄壳 + 测试直连） ─────────────────────────

pub(crate) fn list_canvases(conn: &Connection) -> Result<Vec<serde_json::Value>, String> {
    query_all_params(
        conn,
        &format!(
            "SELECT {CANVAS_COLS}, \
             (SELECT COUNT(*) FROM canvas_nodes WHERE canvas_id = canvases.id) AS node_count, \
             (SELECT COUNT(*) FROM canvas_connections WHERE canvas_id = canvases.id) AS connection_count \
             FROM canvases ORDER BY updated_at DESC, created_at DESC, id DESC"
        ),
        &[],
        |row| {
            let mut value = canvas_row(row)?;
            value["node_count"] = serde_json::json!(row.get::<_, i64>(7)?);
            value["connection_count"] = serde_json::json!(row.get::<_, i64>(8)?);
            Ok(value)
        },
    )
}

pub(crate) fn get_canvas_graph(conn: &Connection, canvas_id: &str) -> Result<serde_json::Value, String> {
    let canvas = conn
        .query_row(
            &format!("SELECT {CANVAS_COLS} FROM canvases WHERE id = ?1"),
            params![canvas_id],
            canvas_row,
        )
        .map_err(|e| format!("画布不存在或查询失败：{e}"))?;
    let nodes = query_all_params(
        conn,
        &format!("SELECT {NODE_COLS} FROM canvas_nodes WHERE canvas_id = ?1 ORDER BY created_at ASC, id ASC"),
        &[&canvas_id],
        node_row,
    )?;
    let connections = query_all_params(
        conn,
        &format!("SELECT {CONNECTION_COLS} FROM canvas_connections WHERE canvas_id = ?1 ORDER BY created_at ASC, id ASC"),
        &[&canvas_id],
        connection_row,
    )?;
    Ok(serde_json::json!({ "canvas": canvas, "nodes": nodes, "connections": connections }))
}

pub(crate) fn create_canvas(conn: &Connection, name: &str) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    let name = if name.is_empty() { "未命名画布".to_string() } else { name };
    let id = uuid::Uuid::new_v4().to_string();
    let now = canvas_now();
    conn.execute(
        "INSERT INTO canvases (id, name, viewport_x, viewport_y, viewport_k, created_at, updated_at) \
         VALUES (?1, ?2, 0, 0, 1, ?3, ?4)",
        params![id, name, now, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "id": id, "name": name,
        "viewport_x": 0.0, "viewport_y": 0.0, "viewport_k": 1.0,
        "created_at": now, "updated_at": now, "node_count": 0, "connection_count": 0,
    }))
}

pub(crate) fn rename_canvas(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("画布名不能为空".to_string());
    }
    let changed = conn
        .execute(
            "UPDATE canvases SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, canvas_now(), id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("画布不存在：{id}"));
    }
    Ok(())
}

pub(crate) fn delete_canvas(conn: &Connection, id: &str) -> Result<(), String> {
    let changed = conn
        .execute("DELETE FROM canvases WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("画布不存在：{id}"));
    }
    Ok(())
}

/// 视口恢复：随滚动防抖高频调用，不 bump updated_at（画布列表按
/// updated_at 倒序，视口挪动不该重排 chips）。
pub(crate) fn set_viewport(conn: &Connection, id: &str, x: f64, y: f64, k: f64) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE canvases SET viewport_x = ?1, viewport_y = ?2, viewport_k = ?3 WHERE id = ?4",
            params![x, y, k, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("画布不存在：{id}"));
    }
    Ok(())
}

pub(crate) fn create_node(
    conn: &Connection,
    canvas_id: &str,
    node_type: &str,
    title: &str,
    pos_x: f64,
    pos_y: f64,
    width: Option<f64>,
    height: Option<f64>,
    resource_path: &str,
    metadata_raw: &str,
) -> Result<serde_json::Value, String> {
    // 显式校验归属，FK 报错信息不友好。
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM canvases WHERE id = ?1",
            params![canvas_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists == 0 {
        return Err(format!("画布不存在：{canvas_id}"));
    }
    let meta = parse_node_meta_strict(node_type, metadata_raw)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = canvas_now();
    let resource_path = normalize_project_path(resource_path);
    conn.execute(
        "INSERT INTO canvas_nodes \
         (id, canvas_id, type, title, pos_x, pos_y, width, height, metadata, resource_path, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            id,
            canvas_id,
            node_type,
            title.trim(),
            pos_x,
            pos_y,
            width,
            height,
            serde_json::to_string(&meta).map_err(|e| e.to_string())?,
            resource_path,
            now,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;
    bump_canvas_updated_at(conn, canvas_id)?;
    conn.query_row(
        &format!("SELECT {NODE_COLS} FROM canvas_nodes WHERE id = ?1"),
        params![id],
        node_row,
    )
    .map_err(|e| e.to_string())
}

pub(crate) fn update_node(
    conn: &Connection,
    id: &str,
    title: Option<String>,
    metadata_raw: Option<String>,
    resource_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let (node_type, canvas_id): (String, String) = conn
        .query_row(
            "SELECT type, canvas_id FROM canvas_nodes WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| format!("节点不存在：{id}"))?;
    if let Some(raw) = &metadata_raw {
        // 严格解析（抛错即不落库）；解析通过后整列覆写。
        parse_node_meta_strict(&node_type, raw)?;
    }
    if let Some(title) = &title {
        conn.execute(
            "UPDATE canvas_nodes SET title = ?1 WHERE id = ?2",
            params![title.trim(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(raw) = &metadata_raw {
        conn.execute(
            "UPDATE canvas_nodes SET metadata = ?1 WHERE id = ?2",
            params![raw.trim(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(path) = &resource_path {
        // 相对库根软路径，归一正斜杠（对齐工程域惯例）。
        conn.execute(
            "UPDATE canvas_nodes SET resource_path = ?1 WHERE id = ?2",
            params![normalize_project_path(path), id],
        )
        .map_err(|e| e.to_string())?;
    }
    bump_canvas_updated_at(conn, &canvas_id)?;
    conn.query_row(
        &format!("SELECT {NODE_COLS} FROM canvas_nodes WHERE id = ?1"),
        params![id],
        node_row,
    )
    .map_err(|e| e.to_string())
}

/// 布局批量落盘（防抖批量保存的落点）：位置/尺寸覆盖写，不 bump
/// updated_at、不 emit——与工程画布 saveCanvasLayout 同惯例，纯布局
/// 挪动不该触发全局重取，也不该重排画布列表。
pub(crate) fn save_layout(
    conn: &Connection,
    canvas_id: &str,
    nodes: &[serde_json::Value],
) -> Result<(), String> {
    for node in nodes {
        let id = node
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("布局条目缺 id")?;
        let pos_x = node.get("pos_x").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let pos_y = node.get("pos_y").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let width = node.get("width").and_then(|v| v.as_f64());
        let height = node.get("height").and_then(|v| v.as_f64());
        conn.execute(
            "UPDATE canvas_nodes SET pos_x = ?1, pos_y = ?2, width = ?3, height = ?4 \
             WHERE id = ?5 AND canvas_id = ?6",
            params![pos_x, pos_y, width, height, id, canvas_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn delete_node(conn: &Connection, id: &str) -> Result<(), String> {
    let canvas_id: String = conn
        .query_row(
            "SELECT canvas_id FROM canvas_nodes WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| format!("节点不存在：{id}"))?;
    // 连线两端 FK ON DELETE CASCADE：删节点先自动清相关连线。
    conn.execute("DELETE FROM canvas_nodes WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    bump_canvas_updated_at(conn, &canvas_id)?;
    Ok(())
}

/// 建连线（多入线语义，无顶掉）：同源重复由 UNIQUE + INSERT OR IGNORE
/// 去重，返回落库后的那行（新建或既有）。两端节点必须同画布。
pub(crate) fn connect(
    conn: &Connection,
    canvas_id: &str,
    from_node: &str,
    to_node: &str,
) -> Result<serde_json::Value, String> {
    if from_node == to_node {
        return Err("不能把节点连到自己".to_string());
    }
    let ends: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM canvas_nodes WHERE canvas_id = ?1 AND id IN (?2, ?3)",
            params![canvas_id, from_node, to_node],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if ends != 2 {
        return Err("连线两端节点不存在或不属于该画布".to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT OR IGNORE INTO canvas_connections (id, canvas_id, from_node, to_node, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, canvas_id, from_node, to_node, canvas_now()],
    )
    .map_err(|e| e.to_string())?;
    bump_canvas_updated_at(conn, canvas_id)?;
    conn.query_row(
        &format!(
            "SELECT {CONNECTION_COLS} FROM canvas_connections \
             WHERE canvas_id = ?1 AND from_node = ?2 AND to_node = ?3"
        ),
        params![canvas_id, from_node, to_node],
        connection_row,
    )
    .map_err(|e| e.to_string())
}

/// 摘线换目标 = 改写 to_node（方案 3.3 改造点 3，无顶掉）。目标已存在
/// 同源连线时合并：删除被移动的线，保留既有线（返回既有行）。
pub(crate) fn rewire(conn: &Connection, id: &str, to_node: &str) -> Result<serde_json::Value, String> {
    let (canvas_id, from_node, old_to): (String, String, String) = conn
        .query_row(
            "SELECT canvas_id, from_node, to_node FROM canvas_connections WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| format!("连线不存在：{id}"))?;
    if to_node == old_to {
        // 换回原目标：无操作，原样返回。
        return conn
            .query_row(
                &format!("SELECT {CONNECTION_COLS} FROM canvas_connections WHERE id = ?1"),
                params![id],
                connection_row,
            )
            .map_err(|e| e.to_string());
    }
    if to_node == from_node {
        return Err("不能把节点连到自己".to_string());
    }
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM canvas_nodes WHERE canvas_id = ?1 AND id = ?2",
            params![canvas_id, to_node],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists == 0 {
        return Err("目标节点不存在或不属于该画布".to_string());
    }
    let duplicated: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM canvas_connections \
             WHERE canvas_id = ?1 AND from_node = ?2 AND to_node = ?3 AND id != ?4",
            params![canvas_id, from_node, to_node, id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if duplicated > 0 {
        conn.execute("DELETE FROM canvas_connections WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        bump_canvas_updated_at(conn, &canvas_id)?;
        return conn
            .query_row(
                &format!(
                    "SELECT {CONNECTION_COLS} FROM canvas_connections \
                     WHERE canvas_id = ?1 AND from_node = ?2 AND to_node = ?3"
                ),
                params![canvas_id, from_node, to_node],
                connection_row,
            )
            .map_err(|e| e.to_string());
    }
    conn.execute(
        "UPDATE canvas_connections SET to_node = ?1 WHERE id = ?2",
        params![to_node, id],
    )
    .map_err(|e| e.to_string())?;
    bump_canvas_updated_at(conn, &canvas_id)?;
    conn.query_row(
        &format!("SELECT {CONNECTION_COLS} FROM canvas_connections WHERE id = ?1"),
        params![id],
        connection_row,
    )
    .map_err(|e| e.to_string())
}

pub(crate) fn delete_connection(conn: &Connection, id: &str) -> Result<(), String> {
    let canvas_id: String = conn
        .query_row(
            "SELECT canvas_id FROM canvas_connections WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| format!("连线不存在：{id}"))?;
    conn.execute("DELETE FROM canvas_connections WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    bump_canvas_updated_at(conn, &canvas_id)?;
    Ok(())
}

// ── Tauri 命令薄壳 ─────────────────────────────────────────

#[tauri::command]
pub fn canvas_list(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    list_canvases(&conn)
}

#[tauri::command]
pub fn canvas_get(app: AppHandle, canvas_id: String) -> Result<serde_json::Value, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    get_canvas_graph(&conn, &canvas_id)
}

#[tauri::command]
pub fn canvas_create(app: AppHandle, name: String) -> Result<serde_json::Value, String> {
    let value = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        create_canvas(&conn, &name)?
    };
    emit_canvas_changed(&app);
    Ok(value)
}

#[tauri::command]
pub fn canvas_rename(app: AppHandle, id: String, name: String) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        rename_canvas(&conn, &id, &name)?;
    }
    emit_canvas_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn canvas_delete(app: AppHandle, id: String) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        delete_canvas(&conn, &id)?;
    }
    emit_canvas_changed(&app);
    Ok(())
}

/// 视口防抖高频写：不 emit（对齐工程画布布局命令不 emit 惯例）。
#[tauri::command]
pub fn canvas_set_viewport(app: AppHandle, id: String, x: f64, y: f64, k: f64) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    set_viewport(&conn, &id, x, y, k)
}

#[tauri::command]
pub fn canvas_create_node(
    app: AppHandle,
    canvas_id: String,
    node_type: String,
    title: String,
    pos_x: f64,
    pos_y: f64,
    width: Option<f64>,
    height: Option<f64>,
    resource_path: String,
    metadata: String,
) -> Result<serde_json::Value, String> {
    let value = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        create_node(&conn, &canvas_id, &node_type, &title, pos_x, pos_y, width, height, &resource_path, &metadata)?
    };
    emit_canvas_changed(&app);
    Ok(value)
}

#[tauri::command]
pub fn canvas_update_node(
    app: AppHandle,
    id: String,
    title: Option<String>,
    metadata: Option<String>,
    resource_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let value = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        update_node(&conn, &id, title, metadata, resource_path)?
    };
    emit_canvas_changed(&app);
    Ok(value)
}

/// 布局批量落盘：不 emit（见 save_layout 注释）。
#[tauri::command]
pub fn canvas_save_layout(
    app: AppHandle,
    canvas_id: String,
    nodes: Vec<serde_json::Value>,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    save_layout(&conn, &canvas_id, &nodes)
}

#[tauri::command]
pub fn canvas_delete_node(app: AppHandle, id: String) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        delete_node(&conn, &id)?;
    }
    emit_canvas_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn canvas_connect(
    app: AppHandle,
    canvas_id: String,
    from_node: String,
    to_node: String,
) -> Result<serde_json::Value, String> {
    let value = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        connect(&conn, &canvas_id, &from_node, &to_node)?
    };
    emit_canvas_changed(&app);
    Ok(value)
}

#[tauri::command]
pub fn canvas_rewire(app: AppHandle, id: String, to_node: String) -> Result<serde_json::Value, String> {
    let value = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        rewire(&conn, &id, &to_node)?
    };
    emit_canvas_changed(&app);
    Ok(value)
}

#[tauri::command]
pub fn canvas_delete_connection(app: AppHandle, id: String) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        delete_connection(&conn, &id)?;
    }
    emit_canvas_changed(&app);
    Ok(())
}
