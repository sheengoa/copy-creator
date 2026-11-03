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
    groups TEXT NOT NULL DEFAULT '[]',
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
    to_port TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (canvas_id, from_node, to_node),
    FOREIGN KEY (canvas_id) REFERENCES canvases(id) ON DELETE CASCADE,
    FOREIGN KEY (from_node) REFERENCES canvas_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (to_node) REFERENCES canvas_nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_canvas_connections_canvas ON canvas_connections(canvas_id);
";

mod meta;
mod store;

pub(crate) use meta::*;
pub(crate) use store::*;

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
    to_port: String,
) -> Result<serde_json::Value, String> {
    let value = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        connect(&conn, &canvas_id, &from_node, &to_node, &to_port)?
    };
    emit_canvas_changed(&app);
    Ok(value)
}

#[tauri::command]
pub fn canvas_rewire(
    app: AppHandle,
    id: String,
    to_node: String,
    to_port: String,
) -> Result<serde_json::Value, String> {
    let value = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        rewire(&conn, &id, &to_node, &to_port)?
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

#[tauri::command]
pub fn canvas_set_groups(app: AppHandle, id: String, groups: String) -> Result<serde_json::Value, String> {
    let value = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        set_groups(&conn, &id, &groups)?
    };
    // 不 emit canvas-changed：分组是打组/解组单发动作，前端本地已更新；
    // emit 会触发图谱整体重取，反而可能拉回尚未防抖落盘的成员位置。
    Ok(value)
}
