// 画布 AI 生图（画布区方案 3.4）：Rust 全转发，Key 存 SQLite 不进前端。
// 协议行为逐条翻译自 sheengo-canvas web/src/services/api/image.ts（921 行）
// 及其依赖 lib/media-size.ts、lib/image-reference-prompt.ts，一期范围：
// OpenAI 兼容 images API（generations + edits multipart）、Gemini 原生
// generateContent（无官方 n 参数 → Rust 侧并发多请求）、尺寸/比例映射、
// 错误语义；不搬流式 SSE / function calling / 自定义脚本 / 生视频音频。
// 成本防护：失败不自动重试（重试一律前端手动）；取消时已完成张数保留。
use crate::db::{parse_node_meta_lenient, DbState, ImageNodeStatus, NodeMeta};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

mod cancel;
mod protocol_gemini;
mod protocol_openai;
mod scheduling;
mod sizing;
mod upstream;

// 子模块职责拆分（阶段 9a）：兄弟模块互相只经父模块可见性协作——
// 此处统一 use 再由各子模块 use super::* 传递。
use cancel::{cancel_registry, ImageTaskResult};
use protocol_gemini::{gemini_base_url, gemini_model_name, request_gemini};
use protocol_openai::{openai_api_url, openai_generations_body, request_openai};
use scheduling::{
    classify_failure, load_scheduling, mark_channel_failure, ordered_channel_targets,
    record_channel_latency,
};
use sizing::{gemini_image_config, resolve_request_size, IMAGE_OUTPUT_FORMAT};
// 仅跨模块单测引用（payload/base_url 解析规则测试在本模块）。
#[cfg(test)]
use protocol_gemini::parse_gemini_payload;
#[cfg(test)]
use protocol_openai::parse_openai_payload;
use upstream::{collect_upstream, data_url_decode, file_to_data_url, resolve_library_path};

// ── 错误语义（readApiErrorMessage + readStatusError 等价翻译） ──

/// 递归抽取 API 错误消息：msg / message / error(string|{message}) / detail；
/// 字符串值若是序列化 JSON 再解一层；空对象视为无消息。
fn read_api_error_message(value: &Value) -> String {
    match value {
        Value::String(s) => {
            if let Ok(parsed) = serde_json::from_str::<Value>(s) {
                if parsed.is_object() {
                    let inner = read_api_error_message(&parsed);
                    if !inner.is_empty() {
                        return inner;
                    }
                    return s.clone();
                }
            }
            s.clone()
        }
        Value::Object(map) => {
            for key in ["msg", "message", "error", "detail"] {
                if let Some(v) = map.get(key) {
                    let msg = match v {
                        Value::String(_) => read_api_error_message(v),
                        Value::Object(_) if key == "error" => read_api_error_message(v),
                        _ => String::new(),
                    };
                    if !msg.is_empty() {
                        return msg;
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

/// HTTP 状态 → 固定文案（readStatusError）。
fn status_error(status: u16) -> Option<String> {
    match status {
        401 | 403 => Some("认证失败，请检查 API Key".to_string()),
        429 => Some("请求过于频繁（限流），请稍后再试".to_string()),
        404 => Some("接口不存在（404），请检查 Base URL".to_string()),
        502 => Some("网关错误（502）".to_string()),
        503 => Some("服务繁忙（503），请稍后再试".to_string()),
        _ => Some(format!("请求失败（HTTP {status}）")),
    }
}

/// reqwest 顶层错误只有「error sending request for url (...)」，真正的
/// 原因（超时 / 连接被拒 / 连接被重置——代理链路抖动时全是这几类）藏在
/// source 链里；不展开的话节点错误提示是一句废话，用户无从判断该重试
/// 还是该查代理（2026-11-01 生成报错排查即此因）。
fn reqwest_cause(e: &reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(err) = source {
        msg.push_str("：");
        msg.push_str(&err.to_string());
        source = err.source();
    }
    msg
}

// ── 请求组装（纯函数，单测对象） ──

/// OpenAI base URL 拼接（buildApiUrl）：去尾斜杠；不以 /v1 结尾则补 /v1。
fn build_reference_prompt(prompt: &str, count: usize) -> String {
    let text = prompt.trim();
    if count == 0 {
        return text.to_string();
    }
    let labels: Vec<String> = (1..=count).map(|i| format!("图片{i}")).collect();
    format!(
        "参考图片编号：{}。请按这些编号理解提示词中的图片引用。\n\n{}",
        labels.join("、"),
        text
    )
}

/// OpenAI /images/generations 请求体：gpt-image 系不带 response_format。
// ── 配置与上游收集 ──

/// 生成请求的通用设置。渠道化之后（画布设置页）供应商/密钥都挂在
/// ai_channels 上，这里只剩超时；旧 ai_provider/ai_openai_* 键仅由
/// 迁移逻辑读取一次，不再参与运行时。
struct AiSettings {
    timeout_secs: u64,
}

/// 持锁直读 settings（get_setting_sync 会自己拿锁，持锁调用会死锁——
/// 与 text_version.rs 同一教训）。
fn read_setting(conn: &rusqlite::Connection, key: &str) -> String {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .unwrap_or_default()
}

fn load_ai_settings(conn: &rusqlite::Connection) -> AiSettings {
    let timeout = read_setting(conn, "ai_timeout").parse::<u64>().unwrap_or(60).clamp(5, 600);
    AiSettings { timeout_secs: timeout }
}

struct UpstreamInput {
    prompt: String,
    references: Vec<PathBuf>,
}

// ── 渠道读取与测速（画布设置页「测速」按钮） ──
// 测速 = 按渠道协议发一次真实的最小生图请求并计完整耗时（发起 → 响应
// 收完），与 new-api 的渠道测速同思路：只测真实生图链路，延迟才有调度
// 意义；成功后丢弃响应体，不落产物。失败只记录错误文案，不自动停用——
// 停用仅由真实生成的鉴权/欠费错误触发（见 generate 的故障处理）。

struct AiChannelRow {
    id: String,
    protocol: String,
    base_url: String,
    api_key: String,
    model: String,
    enabled: bool,
    status: String,
}

fn load_channel(conn: &rusqlite::Connection, channel_id: &str) -> Result<AiChannelRow, String> {
    conn.query_row(
        "SELECT id, protocol, base_url, api_key, model, enabled, status \
         FROM ai_channels WHERE id = ?1",
        params![channel_id],
        |row| {
            Ok(AiChannelRow {
                id: row.get(0)?,
                protocol: row.get(1)?,
                base_url: row.get(2)?,
                api_key: row.get(3)?,
                model: row.get(4)?,
                enabled: row.get::<_, i64>(5)? != 0,
                status: row.get(6)?,
            })
        },
    )
    .map_err(|_| format!("渠道不存在：{channel_id}"))
}

/// 测速/生成共用的渠道模型解析：渠道配置的模型优先，空则回落全局默认。
fn channel_model_or_global(channel_model: &str, global_model: &str) -> Result<String, String> {
    let model = if channel_model.trim().is_empty() { global_model.trim().to_string() } else { channel_model.trim().to_string() };
    if model.is_empty() {
        return Err("渠道未配置模型且没有全局默认模型：请在渠道或默认值里填写模型".to_string());
    }
    Ok(model)
}

fn record_channel_test_result(
    conn: &rusqlite::Connection,
    channel_id: &str,
    result: &Result<u64, String>,
) {
    let now = crate::db::canvas_now();
    let update = match result {
        Ok(latency_ms) => conn.execute(
            "UPDATE ai_channels SET last_latency_ms = ?1, last_tested_at = ?2, \
             status = 'normal', last_error = '', updated_at = ?2 WHERE id = ?3",
            params![*latency_ms as i64, now, channel_id],
        ),
        Err(message) => conn.execute(
            "UPDATE ai_channels SET last_error = ?1, updated_at = ?2 WHERE id = ?3",
            params![message, now, channel_id],
        ),
    };
    if let Err(error) = update {
        log::error!("写入渠道测速结果失败: {error}");
    }
}


/// 单渠道测速：真实发一次最小生图请求并计完整耗时。手动停用（enabled=0）
/// 的渠道也允许测速——「先测通再启用」与「重新测速并恢复」都依赖它；
/// 测速成功只恢复故障状态，不代替用户打开手动开关。
#[tauri::command]
pub async fn ai_test_channel(app: AppHandle, channel_id: String) -> Result<Value, String> {
    // 配置读取（短锁），网络阶段不持锁。
    let (channel, model, timeout_secs) = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let channel = load_channel(&conn, &channel_id)?;
        let global_model = read_setting(&conn, "ai_model");
        let model = channel_model_or_global(&channel.model, &global_model)?;
        let timeout = read_setting(&conn, "ai_timeout").parse::<u64>().unwrap_or(60).clamp(5, 600);
        (channel, model, timeout)
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))?;

    let result: Result<u64, String> = if channel.protocol == "gemini" {
        let parts = vec![json!({ "text": "a cute cat" })];
        let body = json!({
            "contents": [{ "role": "user", "parts": parts }],
            "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] },
        });
        let url = format!(
            "{}/models/{}:generateContent",
            gemini_base_url(&channel.base_url),
            gemini_model_name(&model)
        );
        let started = std::time::Instant::now();
        let fut = client
            .post(&url)
            .header("x-goog-api-key", &channel.api_key)
            .json(&body)
            .send();
        let resp = fut.await.map_err(|e| format!("请求失败：{}", reqwest_cause(&e)))?;
        let status = resp.status().as_u16();
        let payload: Value = resp.bytes().await
            .map_err(|e| format!("响应读取失败：{e}"))
            .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|e| format!("响应解析失败：{e}")))?;
        if !(200..300).contains(&status) {
            let msg = read_api_error_message(&payload);
            Err(if msg.is_empty() {
                status_error(status).unwrap_or_else(|| format!("请求失败（HTTP {status}）"))
            } else {
                msg
            })
        } else {
            Ok(started.elapsed().as_millis() as u64)
        }
    } else {
        let body = openai_generations_body(&model, "a cute cat", 1, None, Some("1024x1024"));
        let url = openai_api_url(&channel.base_url, "/images/generations");
        let started = std::time::Instant::now();
        let resp = client
            .post(&url)
            .bearer_auth(&channel.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("请求失败：{}", reqwest_cause(&e)))?;
        let status = resp.status().as_u16();
        let payload: Value = resp.bytes().await
            .map_err(|e| format!("响应读取失败：{e}"))
            .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|e| format!("响应解析失败：{e}")))?;
        if !(200..300).contains(&status) {
            let msg = read_api_error_message(&payload);
            Err(if msg.is_empty() {
                status_error(status).unwrap_or_else(|| format!("请求失败（HTTP {status}）"))
            } else {
                msg
            })
        } else {
            Ok(started.elapsed().as_millis() as u64)
        }
    };

    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        record_channel_test_result(&conn, &channel.id, &result);
    }

    match result {
        Ok(latency_ms) => Ok(json!({ "ok": true, "latencyMs": latency_ms })),
        Err(message) => Ok(json!({ "ok": false, "error": message })),
    }
}
// ── 执行层：并发 + 逐张回传 + 取消 + 产物入库 ──

/// 进行中生成的取消开关：request_id → Notify。
/// 生成入口（方案 3.4）：收集上游 → 双协议请求（并发上限 4）→ 逐张回传 →
/// 全部完成后一次性落库。requestId 供前端取消。
#[tauri::command]
pub async fn ai_generate_image(app: AppHandle, canvas_id: String, node_id: String) -> Result<Value, String> {
    use tokio::sync::{Notify, Semaphore};

    // 配置与节点状态同步读取（短锁），随后进入异步请求阶段。
    // 渠道调度：按策略排出尝试顺序；节点参数模型非空时覆盖所有渠道模型。
    let (settings, sched, targets, node_meta, node_title, upstream, node_type) = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let settings = load_ai_settings(&conn);
        let sched = load_scheduling(&conn);
        let row: (String, String, Option<String>) = conn
            .query_row(
                "SELECT type, metadata, title FROM canvas_nodes WHERE id = ?1 AND canvas_id = ?2",
                params![node_id, canvas_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|_| format!("节点不存在：{node_id}"))?;
        // v2 节点体系创建入口只产 gen_image（旧 image 类型为迁移宽容读
        // 保留，创建已拒绝）——校验按行内实际类型放行，元数据也按同一
        // 类型解析；回写 kind 必须随类型列，否则宽容读全部落默认值
        // （2026-11-01：按旧 "image" 硬校验把 gen_image 节点全拒成
        // 「只有图片节点可以生成」）。
        let node_type = row.0;
        if node_type != "gen_image" && node_type != "image" {
            return Err("只有图片节点可以生成".to_string());
        }
        let node_meta = parse_node_meta_lenient(&node_type, &row.1);
        let node_model = match &node_meta {
            NodeMeta::Image { params, .. } | NodeMeta::GenImage { params, .. } => {
                params.model.trim().to_string()
            }
            _ => String::new(),
        };
        let mut targets = ordered_channel_targets(&conn, &sched)?;
        if !node_model.is_empty() {
            for target in &mut targets {
                target.model = node_model.clone();
            }
        }
        let upstream = collect_upstream(&conn, &node_id)?;
        (settings, sched, targets, node_meta, row.2.unwrap_or_default(), upstream, node_type)
    };
    let (NodeMeta::Image { params: node_params, status, .. }
    | NodeMeta::GenImage { params: node_params, status, .. }) = &node_meta
    else {
        return Err("节点 metadata 类型异常".to_string());
    };
    // 双保险（方案 3.4 成本防护）：前端进度条目可能因窗口刷新等丢失，
    // UI 层拦不住对同一节点的并发二次发起——这里按落库状态兜底拒绝。
    if *status == ImageNodeStatus::Generating {
        return Err("该节点正在生成中，请等它完成或先取消".to_string());
    }

    if targets.iter().all(|t| t.model.trim().is_empty()) {
        return Err("未配置模型：请到 设置 → 画布 的渠道或默认值里填写模型，或在节点参数里指定".to_string());
    }
    if upstream.prompt.trim().is_empty() {
        return Err("没有提示词来源：请连线至少一个非空文本节点".to_string());
    }
    let count = node_params.count.clamp(1, 15);
    let size_raw = node_params.size.trim().to_string();
    let quality: Option<&str> = None; // 一期画布不暴露 quality，保持与 auto 等价

    // 请求尺寸归一（OpenAI 分支需要显式像素；Gemini 分支用原值进 imageConfig）。
    let request_size = resolve_request_size(quality, &size_raw)?;

    let request_id = uuid::Uuid::new_v4().to_string();
    let notify = Arc::new(Notify::new());
    cancel_registry().lock().unwrap().insert(request_id.clone(), notify.clone());

    // 状态机：generating 立即回传（前端显示进行中）。
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let meta = json!({
            "kind": node_type.as_str(),
            "params": node_params,
            "status": "generating",
            "error": "",
            "images": [],
        });
        conn.execute(
            "UPDATE canvas_nodes SET metadata = ?1, updated_at = ?2 WHERE id = ?3",
            params![serde_json::to_string(&meta).map_err(|e| e.to_string())?, crate::db::canvas_now(), node_id],
        )
        .map_err(|e| e.to_string())?;
    }
    let _ = app.emit("canvas-changed", ());
    // requestId 提前回传：本命令阻塞到全部槽位完成才 resolve，等待中的
    // 取消按钮拿不到返回值——前端监听此事件把句柄回填进发起时建的占位
    // 进度条目。
    let _ = app.emit(
        "canvas-generation-started",
        json!({ "requestId": request_id.clone(), "nodeId": node_id.clone() }),
    );

    // 参考图准备：Gemini 走 dataUrl；OpenAI edits 直接传文件路径。
    // 混合协议渠道并存时只要任一目标走 Gemini，就预转一份 dataUrl。
    let mut reference_paths = Vec::new();
    for rel in &upstream.references {
        reference_paths.push(resolve_library_path(&app, rel.to_string_lossy().as_ref())?);
    }
    let any_gemini = targets.iter().any(|t| t.protocol == "gemini");
    let reference_data_urls: Vec<String> = if any_gemini {
        let mut urls = Vec::new();
        for path in &reference_paths {
            urls.push(file_to_data_url(path)?);
        }
        urls
    } else {
        Vec::new()
    };

    // Prompt：OpenAI edits 参考图带编号前缀；Gemini 把参考图放进 parts、
    // 提示词同样带前缀（对齐 requestEdit 的 buildImageReferencePromptText）。
    let prompt = if reference_paths.is_empty() {
        upstream.prompt.trim().to_string()
    } else {
        build_reference_prompt(&upstream.prompt, reference_paths.len())
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(settings.timeout_secs))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))?;

    let prompt_for_task = prompt.clone();
    let size_raw_for_task = size_raw.clone();
    let refs_for_task = reference_paths.clone();
    let refs_data_for_task = reference_data_urls.clone();
    let request_size_for_task = request_size.clone();
    let targets_for_task = Arc::new(targets);
    let sched_for_task = Arc::new(sched);

    let semaphore = Arc::new(Semaphore::new(sched_for_task.concurrency.max(1) as usize));
    let mut handles = Vec::new();
    for slot in 0..count as usize {
        let client = client.clone();
        let targets = targets_for_task.clone();
        let sched = sched_for_task.clone();
        let prompt = prompt_for_task.clone();
        let size_raw = size_raw_for_task.clone();
        let request_size = request_size_for_task.clone();
        let reference_paths = refs_for_task.clone();
        let reference_data_urls = refs_data_for_task.clone();
        let notify = notify.clone();
        let semaphore = semaphore.clone();
        let app2 = app.clone();
        let node_id2 = node_id.clone();
        let request_id2 = request_id.clone();
        handles.push(tokio::spawn(async move {
            let _permit = semaphore.acquire().await;
            let started = std::time::Instant::now();
            // 每槽位独立请求（n=1 × count 次）：与单请求 n=count 等价，
            // 换来逐张回传的进度粒度。渠道按调度顺序尝试；失败（非取消）
            // 先分类标记（鉴权停用 / 限流冷却），开启 failover 才换下一
            // 渠道重试，否则维持「失败不自动重试」语义。
            let mut attempt = 0usize;
            let mut last_error = String::new();
            let mut data_url: Option<String> = None;
            let mut used_channel: Option<String> = None;
            while attempt < targets.len() {
                let target = &targets[attempt];
                let result = if target.protocol == "gemini" {
                    request_gemini(&client, &target.base_url, &target.api_key, &target.model, &prompt, &reference_data_urls, &size_raw, notify.clone()).await
                } else {
                    request_openai(&client, &target.base_url, &target.api_key, &target.model, &prompt, &reference_paths, 1, None, request_size.as_deref(), notify.clone()).await
                };
                match result {
                    Ok(mut images) => {
                        data_url = images.drain(..).next();
                        used_channel = Some(target.name.clone());
                        {
                            let state = app2.state::<DbState>();
                            let lock = state.conn.lock();
                            if let Ok(conn) = lock.as_ref() {
                                record_channel_latency(conn, &target.id, started.elapsed().as_millis() as u64);
                            }
                        }
                        break;
                    }
                    Err(e) if e == "__cancelled__" => {
                        last_error = e;
                        break;
                    }
                    Err(e) => {
                        {
                            let state = app2.state::<DbState>();
                            let lock = state.conn.lock();
                            if let Ok(conn) = lock.as_ref() {
                                let kind = classify_failure(&e);
                                mark_channel_failure(conn, &target.id, kind, &sched, &e);
                            }
                        }
                        last_error = e;
                        attempt += 1;
                        if !sched.failover {
                            break;
                        }
                    }
                }
            }
            match data_url {
                Some(url) => {
                    let _ = app2.emit(
                        "canvas-generation-progress",
                        json!({ "requestId": request_id2, "nodeId": node_id2, "slot": slot, "dataUrl": url }),
                    );
                    ImageTaskResult { slot, data_url: Some(url), error: None, channel: used_channel }
                }
                None if last_error == "__cancelled__" => ImageTaskResult { slot, data_url: None, error: Some("__cancelled__".to_string()), channel: used_channel },
                None => {
                    let error = if used_channel.is_some() {
                        format!("[{}] {}", used_channel.clone().unwrap_or_default(), last_error)
                    } else {
                        last_error
                    };
                    let _ = app2.emit(
                        "canvas-generation-progress",
                        json!({ "requestId": request_id2, "nodeId": node_id2, "slot": slot, "error": error }),
                    );
                    ImageTaskResult { slot, data_url: None, error: Some(error), channel: used_channel }
                }
            }
        }));
    }
    let mut results = Vec::new();
    for handle in handles {
        results.push(handle.await.map_err(|e| format!("生成任务异常：{e}"))?);
    }
    cancel_registry().lock().unwrap().remove(&request_id);

    // 逐张回传在任务内已完成（成功即 emit base64）；此处汇总并落库。
    results.sort_by_key(|r| r.slot);
    let cancelled = results.iter().any(|r| r.error.as_deref() == Some("__cancelled__"));
    let successes: Vec<&ImageTaskResult> = results.iter().filter(|r| r.data_url.is_some()).collect();
    let mut errors: Vec<String> = results
        .iter()
        .filter_map(|r| r.error.clone())
        .filter(|e| e.as_str() != "__cancelled__")
        .collect();

    // 产物落托管暂存目录（不再自动入库，2026-10-31 节点体系 v2）：由
    // 「保存图像」节点决定去向（canvas_save_to_library 入库 / 另存到
    // 任意路径）。托管目录在应用管理目录内，媒体服务白名单直接放行；
    // resource_path 记绝对路径（保存/预览节点直接用）。
    let canvas_name: String = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row("SELECT name FROM canvases WHERE id = ?1", params![canvas_id], |row| row.get(0))
            .unwrap_or_else(|_| "画布".to_string())
    };
    let node_name = if node_title.trim().is_empty() { "图片".to_string() } else { node_title.trim().to_string() };
    let gen_dir = {
        let dir = crate::db::get_storage_dir(&app).join("canvas-gen");
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建产物目录失败：{e}"))?;
        dir
    };
    let mut saved: Vec<Value> = Vec::new();
    for (idx, ok) in successes.iter().enumerate() {
        let data_url = ok.data_url.clone().unwrap();
        let (mime, bytes) = match data_url_decode(&data_url) {
            Ok(v) => v,
            Err(e) => {
                errors.push(e);
                continue;
            }
        };
        let ext = if mime.contains("jpeg") { "jpg" } else if mime.contains("webp") { "webp" } else { "png" };
        let file = gen_dir.join(format!("{}-{}.{}", uuid::Uuid::new_v4(), idx, ext));
        std::fs::write(&file, &bytes).map_err(|e| format!("写入产物失败：{e}"))?;
        let dims = image::io::Reader::open(&file)
            .and_then(|r| r.with_guessed_format())
            .map_err(|e| e.to_string())
            .and_then(|r| r.into_dimensions().map_err(|e| e.to_string()))
            .map(|d| (d.0 as i64, d.1 as i64))
            .unwrap_or((0, 0));
        saved.push(json!({
            "width": dims.0, "height": dims.1,
            "bytes": bytes.len() as i64,
            "resource_path": file.to_string_lossy(),
            "primary": idx == 0,
        }));
    }

    let status = if saved.is_empty() {
        "error"
    } else if cancelled || !errors.is_empty() {
        // 部分成功：保留已完成张数，状态标 error 并附原因（不自动重试）。
        "error"
    } else {
        "done"
    };
    let error_msg = if cancelled {
        // 取消无论是否伴随槽位错误都要给出原因：状态落 error 且保留部分
        // 产物，节点上需要一行说明（前端灰字展示），否则像凭空失败。
        format!("已取消（保留 {} 张已完成）", saved.len())
    } else if errors.is_empty() {
        String::new()
    } else {
        let first = errors[0].clone();
        if saved.is_empty() {
            first
        } else {
            format!("{}/{} 张成功：{}", saved.len(), count, first)
        }
    };

    let final_meta = json!({
        "kind": node_type.as_str(),
        "params": node_params,
        "status": status,
        "error": error_msg,
        "images": saved,
    });
    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE canvas_nodes SET metadata = ?1, updated_at = ?2 WHERE id = ?3",
            params![serde_json::to_string(&final_meta).map_err(|e| e.to_string())?, crate::db::canvas_now(), node_id],
        )
        .map_err(|e| e.to_string())?;
        crate::db::bump_canvas_updated_at(&conn, &canvas_id)?;
    }
    let _ = app.emit("canvas-changed", ());
    Ok(json!({
        "requestId": request_id,
        "status": status,
        "error": error_msg,
        "images": saved,
        "cancelled": cancelled,
        "canvasName": canvas_name,
        "nodeName": node_name,
    }))
}

/// 取消生成（方案 3.4）：已完成的张数正常保留，由生成汇总逻辑落库。
#[tauri::command]
pub fn ai_cancel_generation(request_id: String) -> Result<(), String> {
    if let Some(notify) = cancel_registry().lock().unwrap().get(&request_id) {
        notify.notify_waiters();
    }
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn error_message_rules() {
        let v: Value = serde_json::from_str(r#"{"error": {"message": "kquota"}}"#).unwrap();
        assert_eq!(read_api_error_message(&v), "kquota");
        let nested: Value = serde_json::from_str(r#"{"msg": "{\"error\":{\"message\":\"inner\"}}"}"#).unwrap();
        assert_eq!(read_api_error_message(&nested), "inner");
        assert_eq!(status_error(401).unwrap().contains("认证"), true);
        assert_eq!(status_error(429).unwrap().contains("限流"), true);
    }

    #[test]
    fn payload_parsing_rules() {
        let ok: Value = serde_json::from_str(r#"{"data":[{"b64_json":"QUJD"}]}"#).unwrap();
        assert_eq!(parse_openai_payload(&ok).unwrap(), vec!["data:image/png;base64,QUJD"]);
        let code_err: Value = serde_json::from_str(r#"{"code": 1001, "msg": "bad key"}"#).unwrap();
        assert_eq!(parse_openai_payload(&code_err).unwrap_err(), "bad key");
        let empty: Value = serde_json::from_str(r#"{"data": []}"#).unwrap();
        // 空数组在 JS 里为真值 → data 被选中 → 走「未知格式」分支（sheengo 同行为）
        assert!(parse_openai_payload(&empty).unwrap_err().contains("无法识别"));
        let no_keys: Value = serde_json::from_str(r#"{"foo": 1}"#).unwrap();
        assert!(parse_openai_payload(&no_keys).unwrap_err().contains("无法识别"));
        let bare: Value = serde_json::from_str(r#"{}"#).unwrap();
        assert!(parse_openai_payload(&bare).unwrap_err().contains("没有返回任何图片"));
        let gem: Value = serde_json::from_str(
            r#"{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"QUJD"}}]}}]}"#,
        )
        .unwrap();
        assert_eq!(parse_gemini_payload(&gem).unwrap(), vec!["data:image/png;base64,QUJD"]);
        let blocked: Value = serde_json::from_str(r#"{"promptFeedback":{"blockReason":"SAFETY"}}"#).unwrap();
        assert!(parse_gemini_payload(&blocked).unwrap_err().contains("SAFETY"));
    }

    #[test]
    fn base_url_rules() {
        assert_eq!(openai_api_url("https://api.openai.com", "/images/generations"), "https://api.openai.com/v1/images/generations");
        assert_eq!(openai_api_url("https://relay.example.com/v1/", "/images/edits"), "https://relay.example.com/v1/images/edits");
        assert_eq!(gemini_base_url("https://generativelanguage.googleapis.com"), "https://generativelanguage.googleapis.com/v1beta");
        assert_eq!(gemini_base_url("https://proxy.example.com/v1beta"), "https://proxy.example.com/v1beta");
        assert_eq!(gemini_model_name("models/gemini-2.5-flash"), "gemini-2.5-flash");
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! 协议单测共用：极简 mock HTTP 服务器。
    use std::io::{Read as _, Write as _};

    /// 极简 mock HTTP 服务器：读全请求（头 + content-length body）再响应，
    /// 可服务多个连接——读一次就关会在请求分片到达时触发 RST 丢响应。
    pub(super) fn spawn_mock(status: u16, body: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for _ in 0..4 {
                let Ok((mut stream, _)) = listener.accept() else { break };
                let mut buf: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                let headers = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                                let cl: usize = headers
                                    .lines()
                                    .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
                                    .unwrap_or(0);
                                if buf.len() >= pos + 4 + cl {
                                    break;
                                }
                            }
                        }
                    }
                }
                let resp = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{addr}")
    }

}
