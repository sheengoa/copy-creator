// 画布 AI 渠道域：生图服务渠道（多组 Base URL + Key）的存储与 CRUD。
// 一个渠道条目 = 名称 + 协议（openai 兼容 | gemini）+ Base URL + Key +
// 可选模型 + 每张价格；测速结果与故障状态（延迟 / 自动停用 / 限流冷却）
// 也挂在条目上，供画布设置页展示与生成时调度（ai.rs）。Key 明文本机
// 存储（与既有 google_api_key 同级安全），仅以掩码回传前端，编辑留空
// 表示不修改。
use super::*;
use rusqlite::params;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

// ── schema（ensure_schema 调用，幂等） ──

pub(crate) const AI_CHANNEL_SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS ai_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT DEFAULT '',
    price REAL,
    currency TEXT DEFAULT '$',
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'normal',
    last_error TEXT DEFAULT '',
    last_latency_ms INTEGER,
    last_tested_at TEXT DEFAULT '',
    cooldown_until_ms INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
";

/// 调度与故障处理的 settings 种子（通用键值，前端经 set_settings_batch
/// 直写，Rust 生成时按同键读取）。
pub(crate) const AI_SCHEDULING_SETTING_SEED_SQL: &str = "
INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_strategy', 'balance');
INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_balance_price_weight', '40');
INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_failover', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_auto_disable_auth', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_rate_limit_cooldown', '300');
INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_concurrency', '4');
INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_manual_channel_id', '');
";

/// 旧单渠道配置迁移（幂等：ai_channels 非空即跳过）：把 ai_openai_* /
/// ai_gemini_* 的 Base URL + Key 各转成一条渠道，原 provider 对应的渠道
/// 排前；旧全局模型 ai_model 挂到 OpenAI 渠道（Gemini 模型命名体系不同，
/// 留空走全局默认）。
pub(crate) fn migrate_legacy_ai_channels(conn: &Connection) {
    let count: i64 = match conn.query_row("SELECT COUNT(*) FROM ai_channels", [], |row| row.get(0)) {
        Ok(v) => v,
        Err(error) => {
            log::error!("读取渠道条数失败，跳过旧配置迁移: {error}");
            return;
        }
    };
    if count > 0 {
        return;
    }
    let read = |key: &str| -> String {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .unwrap_or_default()
    };
    let provider = read("ai_provider");
    // (协议, 默认名, 官方默认 Base URL, Key 设置键, Base URL 设置键)
    let legacy: [(&str, &str, &str, &str, &str); 2] = [
        ("openai", "OpenAI 兼容", "https://api.openai.com", "ai_openai_key", "ai_openai_base"),
        ("gemini", "Gemini", "https://generativelanguage.googleapis.com", "ai_gemini_key", "ai_gemini_base"),
    ];
    let ordered: Vec<(&(&str, &str, &str, &str, &str), i64)> = if provider == "gemini" {
        vec![(&legacy[1], 0), (&legacy[0], 1)]
    } else {
        vec![(&legacy[0], 0), (&legacy[1], 1)]
    };
    let now = canvas_now();
    let mut migrated = 0usize;
    for ((protocol, name, default_base, key_setting, base_setting), order) in ordered {
        let key = read(key_setting);
        if key.trim().is_empty() {
            continue;
        }
        let base = {
            let b = read(base_setting);
            if b.trim().is_empty() { default_base.to_string() } else { b }
        };
        let model = if *protocol == "openai" { read("ai_model") } else { String::new() };
        if let Err(error) = conn.execute(
            "INSERT INTO ai_channels (id, name, protocol, base_url, api_key, model, price, currency, enabled, status, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, '$', 1, 'normal', ?7, ?8, ?8)",
            params![uuid::Uuid::new_v4().to_string(), name, protocol, base, key, model, order, now],
        ) {
            log::error!("迁移旧 {protocol} 渠道配置失败: {error}");
            continue;
        }
        migrated += 1;
    }
    if migrated > 0 {
        log::info!("已把旧 AI 生图配置迁移为 {migrated} 条渠道");
    }
}

// ── 行读取 ──

fn row_to_channel(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    let api_key: String = row.get(4)?;
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "name": row.get::<_, String>(1)?,
        "protocol": row.get::<_, String>(2)?,
        "baseUrl": row.get::<_, String>(3)?,
        "apiKeyPreview": make_key_preview(&api_key),
        "apiKeySet": !api_key.trim().is_empty(),
        "model": row.get::<_, String>(5)?,
        "price": row.get::<_, Option<f64>>(6)?,
        "currency": row.get::<_, String>(7)?,
        "enabled": row.get::<_, i64>(8)? != 0,
        "status": row.get::<_, String>(9)?,
        "lastError": row.get::<_, String>(10)?,
        "lastLatencyMs": row.get::<_, Option<i64>>(11)?,
        "lastTestedAt": row.get::<_, String>(12)?,
        "cooldownUntilMs": row.get::<_, i64>(13)?,
        "sortOrder": row.get::<_, i64>(14)?,
    }))
}

const CHANNEL_COLS: &str =
    "id, name, protocol, base_url, api_key, model, price, currency, enabled, status, \
     last_error, last_latency_ms, last_tested_at, cooldown_until_ms, sort_order";

fn list_channels_internal(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {CHANNEL_COLS} FROM ai_channels ORDER BY sort_order ASC, created_at ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_channel)
        .map_err(|e| e.to_string())?;
    let mut channels = Vec::new();
    for row in rows {
        channels.push(row.map_err(|e| e.to_string())?);
    }
    Ok(channels)
}

fn normalize_protocol(protocol: &str) -> Result<String, String> {
    match protocol.trim().to_lowercase().as_str() {
        "openai" => Ok("openai".to_string()),
        "gemini" => Ok("gemini".to_string()),
        _ => Err("协议类型无效，应为 openai 或 gemini".to_string()),
    }
}

fn normalize_price(price: Option<f64>) -> Result<Option<f64>, String> {
    match price {
        None => Ok(None),
        Some(v) if v.is_finite() && v >= 0.0 => Ok(Some(v)),
        Some(v) => Err(format!("价格无效：{v}")),
    }
}

// ── CRUD 命令 ──

#[tauri::command]
pub fn list_ai_channels(app: AppHandle) -> Result<Vec<Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    list_channels_internal(&conn)
}

#[tauri::command]
pub fn create_ai_channel(
    app: AppHandle,
    name: String,
    protocol: String,
    base_url: String,
    api_key: String,
    model: String,
    price: Option<f64>,
    currency: String,
) -> Result<Value, String> {
    let protocol = normalize_protocol(&protocol)?;
    let name = name.trim().to_string();
    let name = if name.is_empty() {
        if protocol == "gemini" { "Gemini".to_string() } else { "OpenAI 兼容".to_string() }
    } else {
        name
    };
    let base_url = base_url.trim().to_string();
    if base_url.is_empty() {
        return Err("Base URL 不能为空".to_string());
    }
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("API Key 不能为空".to_string());
    }
    let price = normalize_price(price)?;
    let currency = currency.trim().to_string();
    let currency = if currency.is_empty() { "$".to_string() } else { currency };
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = canvas_now();
    conn.execute(
        "INSERT INTO ai_channels (id, name, protocol, base_url, api_key, model, price, currency, enabled, status, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, 'normal',
                 COALESCE((SELECT MAX(sort_order) FROM ai_channels), -1) + 1, ?9, ?9)",
        params![id, name, protocol, base_url, api_key, model.trim(), price, currency, now],
    )
    .map_err(|e| e.to_string())?;
    list_channels_internal(&conn)?.into_iter().find(|c| c["id"] == json!(id)).ok_or_else(|| "渠道创建后读取失败".to_string())
}

#[tauri::command]
pub fn update_ai_channel(
    app: AppHandle,
    id: String,
    name: String,
    protocol: String,
    base_url: String,
    api_key: Option<String>,
    model: String,
    price: Option<f64>,
    currency: String,
) -> Result<Value, String> {
    let protocol = normalize_protocol(&protocol)?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("渠道名称不能为空".to_string());
    }
    let base_url = base_url.trim().to_string();
    if base_url.is_empty() {
        return Err("Base URL 不能为空".to_string());
    }
    let price = normalize_price(price)?;
    let currency = currency.trim().to_string();
    let currency = if currency.is_empty() { "$".to_string() } else { currency };
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    // 现值读取：判断协议/URL 是否变更（变更则测速与故障状态失效重置）、
    // Key 是否留空（留空 = 不修改）。
    let (old_protocol, old_base_url): (String, String) = conn
        .query_row(
            "SELECT protocol, base_url FROM ai_channels WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| format!("渠道不存在：{id}"))?;
    let endpoint_changed = old_protocol != protocol || old_base_url != base_url;
    let key_clause = match api_key.as_deref().map(str::trim) {
        Some(k) if !k.is_empty() => ", api_key = ?6",
        _ => "",
    };
    let sql = format!(
        "UPDATE ai_channels SET name = ?1, protocol = ?2, base_url = ?3, model = ?4, price = ?5, currency = ?7,
         last_latency_ms = {reset_latency}, last_tested_at = {reset_tested}, status = 'normal', last_error = '', cooldown_until_ms = 0,
         updated_at = ?8{key_clause} WHERE id = ?9",
        reset_latency = if endpoint_changed { "NULL" } else { "last_latency_ms" },
        reset_tested = if endpoint_changed { "''" } else { "last_tested_at" },
    );
    let key_value = api_key.unwrap_or_default();
    let now = canvas_now();
    let affected = if key_clause.is_empty() {
        conn.execute(&sql, params![name, protocol, base_url, model.trim(), price, currency, now, id])
    } else {
        conn.execute(&sql, params![name, protocol, base_url, model.trim(), price, currency, now, key_value, id])
    };
    affected.map_err(|e| e.to_string())?;
    list_channels_internal(&conn)?.into_iter().find(|c| c["id"] == json!(id)).ok_or_else(|| "渠道更新后读取失败".to_string())
}

#[tauri::command]
pub fn delete_ai_channel(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM ai_channels WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 渠道排序：按前端传入的 id 顺序重写 sort_order（拖拽排序）。
#[tauri::command]
pub fn reorder_ai_channels(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let state = app.state::<DbState>();
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE ai_channels SET sort_order = ?1, updated_at = ?2 WHERE id = ?3",
            params![index as i64, canvas_now(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_ai_channel_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    // 手动重新启用视为用户确认渠道可用：清除自动停用状态与错误文案
    //（测速记录保留，仍按历史延迟参与调度）。
    conn.execute(
        "UPDATE ai_channels SET enabled = ?1,
         status = CASE WHEN ?1 = 1 THEN 'normal' ELSE status END,
         last_error = CASE WHEN ?1 = 1 THEN '' ELSE last_error END,
         updated_at = ?2 WHERE id = ?3",
        params![enabled as i64, canvas_now(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
