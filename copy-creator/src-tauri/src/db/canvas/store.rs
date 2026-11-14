// 画布域存储层：行映射 + 内层 CRUD（命令薄壳与测试直连；自 db/canvas.rs零改动拆分，2026-11-03 阶段 9b）。
use super::*;

// ── 行映射 ──────────────────────────────────────────────────

const CANVAS_COLS: &str =
    "id, name, viewport_x, viewport_y, viewport_k, created_at, updated_at, groups";
const NODE_COLS: &str =
    "id, canvas_id, type, title, pos_x, pos_y, width, height, metadata, resource_path, created_at, updated_at";
const CONNECTION_COLS: &str = "id, canvas_id, from_node, to_node, to_port, created_at";

fn canvas_row(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    // groups 旧库经 ensure_column 幂等补列后必有默认 '[]'；损坏 JSON 按
    // 空组处理（画布不可因脏数据打不开）。
    let raw_groups: String = row.get(7)?;
    let groups: serde_json::Value =
        serde_json::from_str(&raw_groups).unwrap_or_else(|_| serde_json::json!([]));
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "name": row.get::<_, String>(1)?,
        "viewport_x": row.get::<_, f64>(2)?,
        "viewport_y": row.get::<_, f64>(3)?,
        "viewport_k": row.get::<_, f64>(4)?,
        "created_at": row.get::<_, String>(5)?,
        "updated_at": row.get::<_, String>(6)?,
        "groups": groups,
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
        "to_port": row.get::<_, String>(4)?,
        "created_at": row.get::<_, String>(5)?,
    }))
}

pub(super) fn emit_canvas_changed<R: Runtime>(app: &AppHandle<R>) {
    // 对齐 project-changed：画布数据前端整体订阅、统一重取，粗粒度事件
    // 即可；视口/批量布局落盘不 emit（见各命令注释）。
    let _ = app.emit("canvas-changed", ());
}

pub(crate) fn bump_canvas_updated_at(conn: &Connection, canvas_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE canvases SET updated_at = ?1 WHERE id = ?2",
        params![now_rfc3339(), canvas_id],
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
            value["node_count"] = serde_json::json!(row.get::<_, i64>(8)?);
            value["connection_count"] = serde_json::json!(row.get::<_, i64>(9)?);
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
    let now = now_rfc3339();
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
        // groups 列默认 '[]'，返回行与其他读取路径（canvas_row）字段对齐，
        // 前端不必对新建画布做 null 特判。
        "groups": [],
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
            params![name, now_rfc3339(), id],
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
    if NodeMeta::is_legacy_type(node_type) {
        return Err(format!("旧节点类型 {node_type} 已迁移，不允许创建"));
    }
    let meta = parse_node_meta_strict(node_type, metadata_raw)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339();
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

/// 画布节点引用的媒体路径全集（resource_path + metadata.video_path）：
/// 媒体服务启动扫描用——外部文件（盘选/拖入）的授权曾只存内存，升级或
/// 重启后历史引用全部 404，按节点引用自愈补登记，免逐个重选。
pub(crate) fn canvas_referenced_media_paths<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let state = app.state::<DbState>();
    let Ok(conn) = state.conn.lock() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let Ok(mut stmt) = conn.prepare("SELECT resource_path, metadata FROM canvas_nodes") else {
        return out;
    };
    let Ok(mut rows) = stmt.query([]) else {
        return out;
    };
    while let Ok(Some(row)) = rows.next() {
        let Ok(resource) = row.get::<_, String>(0) else { continue };
        if !resource.trim().is_empty() {
            out.push(resource);
        }
        let Ok(meta) = row.get::<_, String>(1) else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&meta) else { continue };
        if let Some(video) = value.get("video_path").and_then(|v| v.as_str()) {
            if !video.trim().is_empty() {
                out.push(video.to_string());
            }
        }
    }
    out
}

/// 建连线（类型化端口语义）：to_port 记落点输入口 id（如 "text"/"image"），
/// 前端做类型匹配校验，落库只防同源重复（UNIQUE + INSERT OR IGNORE）。
/// 返回落库后的那行（新建或既有）。两端节点必须同画布。
pub(crate) fn connect(
    conn: &Connection,
    canvas_id: &str,
    from_node: &str,
    to_node: &str,
    to_port: &str,
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
        "INSERT OR IGNORE INTO canvas_connections (id, canvas_id, from_node, to_node, to_port, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, canvas_id, from_node, to_node, to_port, now_rfc3339()],
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

/// 摘线换目标 = 改写 to_node 与落点口 to_port（无顶掉）。目标已存在
/// 同源连线时合并：删除被移动的线，保留既有线（返回既有行）。
pub(crate) fn rewire(
    conn: &Connection,
    id: &str,
    to_node: &str,
    to_port: &str,
) -> Result<serde_json::Value, String> {
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
        "UPDATE canvas_connections SET to_node = ?1, to_port = ?2 WHERE id = ?3",
        params![to_node, to_port, id],
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

/// 节点分组（Ctrl+G，ComfyUI Group 对应物）：画布级 JSON 列存储。
/// 组框无独立坐标——框自适应成员包围盒（前端渲染时算），成员删除后
/// 前端按存活成员剪枝，这里只做透传校验。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct CanvasNodeGroup {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub members: Vec<String>,
}

/// 分组整体写入（Ctrl+G 打组/解组都是全量替换，无并发编辑者）。
pub(crate) fn set_groups(
    conn: &Connection,
    id: &str,
    groups_json: &str,
) -> Result<serde_json::Value, String> {
    let parsed: Vec<CanvasNodeGroup> = serde_json::from_str(groups_json)
        .map_err(|e| format!("groups JSON 不合法：{e}"))?;
    let normalized = serde_json::to_string(&parsed).map_err(|e| e.to_string())?;
    let changed = conn
        .execute(
            "UPDATE canvases SET groups = ?1, updated_at = ?2 WHERE id = ?3",
            params![normalized, now_rfc3339(), id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("画布不存在：{id}"));
    }
    Ok(serde_json::json!({ "id": id, "groups": parsed }))
}
