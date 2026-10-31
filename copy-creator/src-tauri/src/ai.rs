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

// ── 尺寸规则（lib/media-size.ts + image.ts 尺寸函数的等价翻译） ──

const IMAGE_SIZE_STEP: u32 = 16;
const IMAGE_MIN_PIXELS: u64 = 655_360;
const IMAGE_MAX_PIXELS: u64 = 8_294_400;
const IMAGE_MAX_EDGE: u32 = 3840;
const IMAGE_MAX_RATIO: f64 = 3.0;
const IMAGE_OUTPUT_FORMAT: &str = "png";

/// 尺寸预设表（media-size.ts imageSizePresets）：比例 → "宽x高"。
const SIZE_PRESETS_1K: &[(&str, &str)] = &[
    ("1:1", "1024x1024"), ("2:3", "1024x1536"), ("3:2", "1536x1024"),
    ("4:3", "1024x768"), ("3:4", "768x1024"), ("16:9", "1536x864"),
    ("9:16", "864x1536"), ("21:9", "2016x864"), ("9:21", "864x2016"),
];
const SIZE_PRESETS_2K: &[(&str, &str)] = &[
    ("1:1", "2048x2048"), ("2:3", "1360x2048"), ("3:2", "2048x1360"),
    ("4:3", "2048x1536"), ("3:4", "1536x2048"), ("16:9", "2048x1152"),
    ("9:16", "1152x2048"), ("21:9", "2688x1152"), ("9:21", "1152x2688"),
];
const SIZE_PRESETS_4K: &[(&str, &str)] = &[
    ("1:1", "2880x2880"), ("2:3", "2336x3520"), ("3:2", "3520x2336"),
    ("4:3", "3312x2480"), ("3:4", "2480x3312"), ("16:9", "3840x2160"),
    ("9:16", "2160x3840"), ("21:9", "3840x1648"), ("9:21", "1648x3840"),
];

/// Gemini 原生支持的宽高比清单与 quality → imageSize 映射。
const GEMINI_SUPPORTED_RATIOS: &[&str] = &[
    "1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9",
];
const GEMINI_IMAGE_SIZE_BY_QUALITY: &[(&str, &str)] = &[
    ("low", "1K"), ("medium", "2K"), ("high", "4K"), ("standard", "1K"), ("hd", "2K"),
];

fn quality_base(quality: &str) -> Option<u32> {
    match quality {
        "low" | "standard" => Some(1024),
        "medium" | "hd" => Some(2048),
        "high" => Some(2880),
        _ => None,
    }
}

/// quality 归一：1k→low、2k→medium、4k→high；非法值丢弃（image.ts normalizeQuality）。
fn normalize_quality(quality: &str) -> Option<&'static str> {
    let value = quality.trim().to_lowercase();
    let normalized = match value.as_str() {
        "1k" => "low",
        "2k" => "medium",
        "4k" => "high",
        other => other,
    };
    match normalized {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "standard" => Some("standard"),
        "hd" => Some("hd"),
        _ => None,
    }
}

/// "w:h" → 正数比例，无宽高比上限（parseRatioValue）——Gemini 候选清单
/// 含 4:1/8:1 等超宽比，须用此版本。
fn parse_ratio_value(value: &str) -> Result<(f64, f64), String> {
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() != 2 {
        return Err("尺寸格式无效，应为 宽:高 或 宽x高".to_string());
    }
    let w: f64 = parts[0].trim().parse().map_err(|_| "尺寸格式无效，应为 宽:高 或 宽x高".to_string())?;
    let h: f64 = parts[1].trim().parse().map_err(|_| "尺寸格式无效，应为 宽:高 或 宽x高".to_string())?;
    if !w.is_finite() || !h.is_finite() || w <= 0.0 || h <= 0.0 {
        return Err("图片比例必须为正数".to_string());
    }
    Ok((w, h))
}

/// 用户输入比例：在 parse_ratio_value 基础上加 3:1 上限（parseImageRatio）。
fn parse_ratio(value: &str) -> Result<(f64, f64), String> {
    let (w, h) = parse_ratio_value(value)?;
    if w.max(h) / w.min(h) > IMAGE_MAX_RATIO {
        return Err(format!("图片宽高比不能超过 {IMAGE_MAX_RATIO}:1"));
    }
    Ok((w, h))
}

/// "WxH" → 整数尺寸；非该形态返回 None（parseImageDimensions）。
fn parse_dimensions(value: &str) -> Option<(u32, u32)> {
    let v = value.trim();
    let (w, h) = v.split_once('x').or_else(|| v.split_once('X'))?;
    let w: u32 = w.parse().ok()?;
    let h: u32 = h.parse().ok()?;
    Some((w, h))
}

/// 像素尺寸合法性（validateImageSize）：16 步长、最大边、比例、像素范围。
fn validate_size(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("图片尺寸必须为正数".to_string());
    }
    if width % IMAGE_SIZE_STEP != 0 || height % IMAGE_SIZE_STEP != 0 {
        return Err(format!("图片尺寸必须是 {IMAGE_SIZE_STEP} 的倍数"));
    }
    if width.max(height) > IMAGE_MAX_EDGE {
        return Err(format!("图片最大边不能超过 {IMAGE_MAX_EDGE}px"));
    }
    if width.max(height) as f64 / width.min(height) as f64 > IMAGE_MAX_RATIO {
        return Err(format!("图片宽高比不能超过 {IMAGE_MAX_RATIO}:1"));
    }
    let pixels = width as u64 * height as u64;
    if !(IMAGE_MIN_PIXELS..=IMAGE_MAX_PIXELS).contains(&pixels) {
        return Err(format!(
            "图片像素数需在 {} 到 {} 之间",
            IMAGE_MIN_PIXELS, IMAGE_MAX_PIXELS
        ));
    }
    Ok(())
}

fn preset_lookup(scale: &[(&str, &str)], ratio: &str) -> Option<String> {
    scale.iter().find(|(r, _)| *r == ratio).map(|(_, v)| v.to_string())
}

/// "quality + 比例" → 显式像素 "WxH"（resolveSize）：先查预设表，未命中按
/// 目标像素开方求长边，16 步长取整；无 quality 时短边固定 1024。
fn resolve_size(quality: Option<&str>, ratio: &str) -> Result<String, String> {
    let (rw, rh) = parse_ratio(ratio)?;
    let scale: &[(&str, &str)] = match quality {
        Some("high") => SIZE_PRESETS_4K,
        Some("medium") | Some("hd") => SIZE_PRESETS_2K,
        _ => SIZE_PRESETS_1K,
    };
    if let Some(preset) = preset_lookup(scale, ratio) {
        return Ok(preset);
    }
    let base_pixels = quality.and_then(quality_base);
    let is_landscape = rw >= rh;
    let long_ratio = if is_landscape { rw / rh } else { rh / rw };
    let (long_side, short_side) = if let Some(base) = base_pixels {
        let target = base as f64 * base as f64;
        let long_raw = (target * long_ratio).sqrt();
        let long = (long_raw / IMAGE_SIZE_STEP as f64).floor() as u32 * IMAGE_SIZE_STEP;
        let short = ((long as f64 / long_ratio) / IMAGE_SIZE_STEP as f64).round() as u32 * IMAGE_SIZE_STEP;
        (long, short)
    } else {
        let short: u32 = 1024;
        let long = ((short as f64 * long_ratio) / IMAGE_SIZE_STEP as f64).round() as u32 * IMAGE_SIZE_STEP;
        (long, short)
    };
    let (w, h) = if is_landscape { (long_side, short_side) } else { (short_side, long_side) };
    validate_size(w, h)?;
    Ok(format!("{w}x{h}"))
}

/// 请求尺寸归一（resolveRequestSize）：空/auto → None；"WxH" → 校验原样；
/// 含 ":" → 按比例换算；其余报错。
fn resolve_request_size(quality: Option<&str>, size: &str) -> Result<Option<String>, String> {
    let value = size.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("auto") {
        return Ok(None);
    }
    if let Some((w, h)) = parse_dimensions(value) {
        validate_size(w, h)?;
        return Ok(Some(format!("{w}x{h}")));
    }
    if value.contains(':') {
        return Ok(Some(resolve_size(quality, value)?));
    }
    Err("尺寸格式无效，应为 宽:高 或 宽x高".to_string())
}

/// Gemini 支持清单里取最接近的宽高比（closestGeminiAspectRatio）。
fn closest_gemini_aspect_ratio(value: &str) -> Result<String, String> {
    let (tw, th) = parse_ratio_value(value)?;
    let target = tw / th;
    let mut best = GEMINI_SUPPORTED_RATIOS[0];
    let mut best_diff = f64::MAX;
    for item in GEMINI_SUPPORTED_RATIOS {
        let (w, h) = parse_ratio_value(item)?;
        let diff = (w / h - target).abs();
        if diff < best_diff {
            best_diff = diff;
            best = item;
        }
    }
    Ok(best.to_string())
}

/// 尺寸 → Gemini imageSize 档位（resolveGeminiImageSize）：quality 映射优先；
/// 否则预设表命中取档，再否则按最大边阈值分档。
fn resolve_gemini_image_size(quality: Option<&str>, dims: Option<(u32, u32)>) -> Option<String> {
    if let Some(q) = quality.and_then(normalize_quality) {
        return GEMINI_IMAGE_SIZE_BY_QUALITY
            .iter()
            .find(|(k, _)| *k == q)
            .map(|(_, v)| v.to_string());
    }
    let (w, h) = dims?;
    let size = format!("{w}x{h}");
    for (scale, table) in [("1K", SIZE_PRESETS_1K), ("2K", SIZE_PRESETS_2K), ("4K", SIZE_PRESETS_4K)] {
        if table.iter().any(|(_, v)| *v == size) {
            return Some(scale.to_string());
        }
    }
    let edge = w.max(h);
    Some(
        if edge <= 768 {
            "512"
        } else if edge <= 1536 {
            "1K"
        } else if edge <= 3072 {
            "2K"
        } else {
            "4K"
        }
        .to_string(),
    )
}

/// 仅 Gemini 3 系支持 imageSize（supportsGeminiImageSize）。
fn supports_gemini_image_size(model: &str) -> bool {
    let v = model.to_lowercase();
    v.contains("gemini-3") || v.contains("3.1") || v.contains("3-pro")
}

/// Gemini generationConfig.imageConfig 组装（resolveGeminiImageConfig）。
fn gemini_image_config(size: &str, model: &str) -> Value {
    let dims = parse_dimensions(size);
    let ratio = dims.map(|(w, h)| format!("{w}:{h}")).unwrap_or_else(|| size.to_string());
    let aspect_ratio = if !size.trim().is_empty() && !size.trim().eq_ignore_ascii_case("auto") {
        closest_gemini_aspect_ratio(&ratio).ok()
    } else {
        None
    };
    let image_size = if supports_gemini_image_size(model) {
        resolve_gemini_image_size(None, dims)
    } else {
        None
    };
    let mut image = serde_json::Map::new();
    if let Some(ar) = aspect_ratio {
        image.insert("aspectRatio".into(), json!(ar));
    }
    if let Some(is) = image_size {
        image.insert("imageSize".into(), json!(is));
    }
    if image.is_empty() {
        json!({})
    } else {
        json!({ "imageConfig": image })
    }
}

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

// ── 请求组装（纯函数，单测对象） ──

/// OpenAI base URL 拼接（buildApiUrl）：去尾斜杠；不以 /v1 结尾则补 /v1。
fn openai_api_url(base_url: &str, path: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.to_lowercase().ends_with("/v1") {
        format!("{base}{path}")
    } else {
        format!("{base}/v1{path}")
    }
}

/// Gemini base URL 拼接（geminiBaseUrl）：以 /v1 或 /v1beta 结尾则保留。
fn gemini_base_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let lower = base.to_lowercase();
    if lower.ends_with("/v1") || lower.ends_with("/v1beta") {
        base.to_string()
    } else {
        format!("{base}/v1beta")
    }
}

/// Gemini model 名归一（geminiModelName）：去 models/ 前缀。
fn gemini_model_name(model: &str) -> String {
    model.trim().trim_start_matches("models/").to_string()
}

/// 参考图提示词组装（buildImageReferencePromptText，中文文案按应用主语言固定）。
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
fn openai_generations_body(model: &str, prompt: &str, n: u32, quality: Option<&str>, size: Option<&str>) -> Value {
    let mut body = json!({
        "model": model,
        "prompt": prompt,
        "n": n,
        "output_format": IMAGE_OUTPUT_FORMAT,
    });
    let obj = body.as_object_mut().unwrap();
    if let Some(q) = quality {
        obj.insert("quality".into(), json!(q));
    }
    if let Some(s) = size {
        obj.insert("size".into(), json!(s));
    }
    if !model.contains("gpt-image") {
        obj.insert("response_format".into(), json!("b64_json"));
    }
    body
}

/// OpenAI 响应解析（parseImagePayload）：data|images|results 数组，元素取
/// b64_json 或 url；code!=0 走 msg；空结果区分未知格式与无图。
fn parse_openai_payload(payload: &Value) -> Result<Vec<String>, String> {
    if let Some(code) = payload.get("code").and_then(|v| v.as_i64()) {
        if code != 0 {
            let msg = read_api_error_message(payload);
            return Err(if msg.is_empty() { "请求失败".to_string() } else { msg });
        }
    }
    let list = payload
        .get("data")
        .or_else(|| payload.get("images"))
        .or_else(|| payload.get("results"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let images: Vec<String> = list
        .iter()
        .filter_map(|item| {
            if let Some(b64) = item.get("b64_json").and_then(|v| v.as_str()) {
                if !b64.is_empty() {
                    return Some(format!("data:image/png;base64,{b64}"));
                }
            }
            if let Some(url) = item.get("url").and_then(|v| v.as_str()) {
                if !url.is_empty() {
                    return Some(url.to_string());
                }
            }
            None
        })
        .collect();
    if images.is_empty() {
        let raw_keys: Vec<String> = payload
            .as_object()
            .map(|m| m.keys().filter(|k| !matches!(k.as_str(), "code" | "msg" | "error")).cloned().collect())
            .unwrap_or_default();
        return Err(if raw_keys.is_empty() {
            "接口没有返回任何图片".to_string()
        } else {
            format!("无法识别的图片响应格式，字段：{}", raw_keys.join(", "))
        });
    }
    Ok(images)
}

/// Gemini 响应解析（parseGeminiImagePayload + validateGeminiPayload）：
/// candidates[].content.parts[] 取 inlineData（两种命名）或 fileData.fileUri。
fn parse_gemini_payload(payload: &Value) -> Result<Vec<String>, String> {
    if let Some(msg) = payload.pointer("/error/message").and_then(|v| v.as_str()) {
        return Err(msg.to_string());
    }
    if let Some(reason) = payload.pointer("/promptFeedback/blockReason").and_then(|v| v.as_str()) {
        return Err(format!("Gemini 拒绝了该请求（{reason}）"));
    }
    let mut images = Vec::new();
    if let Some(candidates) = payload.get("candidates").and_then(|v| v.as_array()) {
        for cand in candidates {
            if let Some(parts) = cand.pointer("/content/parts").and_then(|v| v.as_array()) {
                for part in parts {
                    let inline = part.get("inlineData").or_else(|| part.get("inline_data"));
                    if let Some(inline) = inline {
                        let mime = inline
                            .get("mimeType")
                            .or_else(|| inline.get("mime_type"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("image/png");
                        if let Some(data) = inline.get("data").and_then(|v| v.as_str()) {
                            if !data.is_empty() {
                                images.push(format!("data:{mime};base64,{data}"));
                                continue;
                            }
                        }
                    }
                    if let Some(uri) = part.pointer("/fileData/fileUri").and_then(|v| v.as_str()) {
                        if !uri.is_empty() {
                            images.push(uri.to_string());
                        }
                    }
                }
            }
        }
    }
    if images.is_empty() {
        return Err("Gemini 没有返回图片".to_string());
    }
    Ok(images)
}

// ── 配置与上游收集 ──

struct AiSettings {
    provider: String,
    openai_base: String,
    openai_key: String,
    gemini_base: String,
    gemini_key: String,
    model: String,
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
    let provider = match read_setting(conn, "ai_provider").as_str() {
        "gemini" => "gemini".to_string(),
        _ => "openai".to_string(),
    };
    let timeout = read_setting(conn, "ai_timeout").parse::<u64>().unwrap_or(60).clamp(5, 600);
    let openai_base = {
        let b = read_setting(conn, "ai_openai_base");
        if b.trim().is_empty() { "https://api.openai.com".to_string() } else { b }
    };
    let gemini_base = {
        let b = read_setting(conn, "ai_gemini_base");
        if b.trim().is_empty() { "https://generativelanguage.googleapis.com".to_string() } else { b }
    };
    AiSettings {
        provider,
        openai_base,
        openai_key: read_setting(conn, "ai_openai_key"),
        gemini_base,
        gemini_key: read_setting(conn, "ai_gemini_key"),
        model: read_setting(conn, "ai_model"),
        timeout_secs: timeout,
    }
}

struct UpstreamInput {
    prompt: String,
    references: Vec<PathBuf>,
}

/// 生成输入收集（方案 3.6）：上游按连线创建顺序——text→提示词换行拼接，
/// ref→资源路径，image→主图路径；note 与空路径跳过。
fn collect_upstream(conn: &rusqlite::Connection, node_id: &str) -> Result<UpstreamInput, String> {
    let mut prompt_parts: Vec<String> = Vec::new();
    let mut references: Vec<PathBuf> = Vec::new();
    let rows: Vec<(String, String, String)> = conn
        .prepare(
            "SELECT n.id, n.type, n.metadata FROM canvas_connections c \
             JOIN canvas_nodes n ON n.id = c.from_node \
             WHERE c.to_node = ?1 ORDER BY c.created_at ASC, c.id ASC",
        )
        .and_then(|mut stmt| {
            stmt.query_map(params![node_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .map_err(|e| e.to_string())?;
    for (_id, node_type, meta_raw) in rows {
        match node_type.as_str() {
            "text" => {
                if let NodeMeta::Text { content } = parse_node_meta_lenient("text", &meta_raw) {
                    if !content.trim().is_empty() {
                        prompt_parts.push(content);
                    }
                }
            }
            "ref" => {
                let path: String = conn
                    .query_row(
                        "SELECT resource_path FROM canvas_nodes WHERE id = ?1",
                        params![&_id],
                        |row| row.get(0),
                    )
                    .unwrap_or_default();
                if !path.trim().is_empty() {
                    references.push(PathBuf::from(path));
                }
            }
            "image" => {
                if let NodeMeta::Image { images, .. } = parse_node_meta_lenient("image", &meta_raw) {
                    let primary = images.iter().find(|i| i.primary).or_else(|| images.first());
                    if let Some(img) = primary {
                        if !img.resource_path.trim().is_empty() {
                            references.push(PathBuf::from(img.resource_path.clone()));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(UpstreamInput { prompt: prompt_parts.join("\n"), references })
}

/// 库内相对路径 → 绝对路径（resource_path 与工程域同为相对库根软路径）。
fn resolve_library_path(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    let root = crate::db::get_resource_library_dir(app);
    let cleaned = rel.trim().replace('\\', "/");
    if cleaned.is_empty() {
        return Err("参考图路径为空".to_string());
    }
    let abs = root.join(&cleaned);
    if !abs.exists() {
        return Err(format!("参考图不存在：{cleaned}"));
    }
    Ok(abs)
}

fn file_to_data_url(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取参考图失败：{e}"))?;
    let mime = match path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        _ => "image/png",
    };
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

fn data_url_decode(data_url: &str) -> Result<(String, Vec<u8>), String> {
    let rest = data_url
        .strip_prefix("data:")
        .ok_or_else(|| "非 data URL，需先下载".to_string())?;
    let (meta, data) = rest.split_once(";base64,").ok_or_else(|| "非 base64 data URL".to_string())?;
    let mime = meta.split(';').next().unwrap_or("image/png").to_string();
    let bytes = BASE64.decode(data).map_err(|e| format!("图片 base64 解码失败：{e}"))?;
    Ok((mime, bytes))
}

// ── 执行层：并发 + 逐张回传 + 取消 + 产物入库 ──

/// 进行中生成的取消开关：request_id → Notify。
fn cancel_registry() -> &'static Mutex<HashMap<String, Arc<tokio::sync::Notify>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

struct ImageTaskResult {
    slot: usize,
    data_url: Option<String>,
    error: Option<String>,
}

async fn request_openai(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    model: &str,
    prompt: &str,
    reference_paths: &[PathBuf],
    n: u32,
    quality: Option<&str>,
    size: Option<&str>,
    notify: Arc<tokio::sync::Notify>,
) -> Result<Vec<String>, String> {
    if reference_paths.is_empty() {
        let body = openai_generations_body(model, prompt, n, quality, size);
        let fut = client
            .post(openai_api_url(base, "/images/generations"))
            .bearer_auth(key)
            .json(&body)
            .send();
        let resp = tokio::select! {
            r = fut => r.map_err(|e| format!("请求失败：{e}"))?,
            _ = notify.notified() => return Err("__cancelled__".to_string()),
        };
        let status = resp.status().as_u16();
        let payload: Value = resp.json().await.map_err(|e| format!("响应解析失败：{e}"))?;
        if !(200..300).contains(&status) {
            let msg = read_api_error_message(&payload);
            return Err(if msg.is_empty() {
                status_error(status).unwrap_or_else(|| "请求失败".to_string())
            } else {
                msg
            });
        }
        parse_openai_payload(&payload)
    } else {
        // 参考图编辑：multipart /images/edits；提示词带参考图编号前缀；
        // 多文件字段名 image[]，单文件 image（sheengo 同规则）。
        let mut form = reqwest::multipart::Form::new()
            .text("model", model.to_string())
            .text("prompt", prompt.to_string())
            .text("n", n.to_string())
            .text("output_format", IMAGE_OUTPUT_FORMAT);
        if !model.contains("gpt-image") {
            form = form.text("response_format", "b64_json");
        }
        if let Some(q) = quality {
            form = form.text("quality", q.to_string());
        }
        if let Some(s) = size {
            form = form.text("size", s.to_string());
        }
        let field = if reference_paths.len() > 1 { "image[]" } else { "image" };
        for path in reference_paths {
            let bytes = std::fs::read(path).map_err(|e| format!("读取参考图失败：{e}"))?;
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "reference.png".to_string());
            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(file_name)
                .mime_str("image/png").map_err(|e| e.to_string())?;
            form = form.part(field.to_string(), part);
        }
        let fut = client
            .post(openai_api_url(base, "/images/edits"))
            .bearer_auth(key)
            .multipart(form)
            .send();
        let resp = tokio::select! {
            r = fut => r.map_err(|e| format!("请求失败：{e}"))?,
            _ = notify.notified() => return Err("__cancelled__".to_string()),
        };
        let status = resp.status().as_u16();
        let payload: Value = resp.json().await.map_err(|e| format!("响应解析失败：{e}"))?;
        if !(200..300).contains(&status) {
            let msg = read_api_error_message(&payload);
            return Err(if msg.is_empty() {
                status_error(status).unwrap_or_else(|| "请求失败".to_string())
            } else {
                msg
            });
        }
        parse_openai_payload(&payload)
    }
}

async fn request_gemini(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    model: &str,
    prompt: &str,
    reference_data_urls: &[String],
    size: &str,
    notify: Arc<tokio::sync::Notify>,
) -> Result<Vec<String>, String> {
    let mut parts = vec![json!({ "text": prompt })];
    for data_url in reference_data_urls {
        let rest = data_url.strip_prefix("data:").unwrap_or_default();
        let (meta, data) = rest.split_once(";base64,").unwrap_or(("image/png", ""));
        parts.push(json!({ "inlineData": { "mimeType": meta, "data": data } }));
    }
    let body = {
        let mut gen_config = json!({ "responseModalities": ["TEXT", "IMAGE"] });
        let image_cfg = gemini_image_config(size, model);
        if let Some(cfg) = image_cfg.get("imageConfig").cloned() {
            gen_config["imageConfig"] = cfg;
        }
        json!({
            "contents": [{ "role": "user", "parts": parts }],
            "generationConfig": gen_config,
        })
    };
    let url = format!(
        "{}/models/{}:generateContent",
        gemini_base_url(base),
        gemini_model_name(model)
    );
    let fut = client
        .post(url)
        .header("x-goog-api-key", key)
        .json(&body)
        .send();
    let resp = tokio::select! {
        r = fut => r.map_err(|e| format!("请求失败：{e}"))?,
        _ = notify.notified() => return Err("__cancelled__".to_string()),
    };
    let status = resp.status().as_u16();
    let payload: Value = resp.json().await.map_err(|e| format!("响应解析失败：{e}"))?;
    if !(200..300).contains(&status) {
        let msg = read_api_error_message(&payload);
        return Err(if msg.is_empty() {
            status_error(status).unwrap_or_else(|| "请求失败".to_string())
        } else {
            msg
        });
    }
    parse_gemini_payload(&payload)
}

/// 生成入口（方案 3.4）：收集上游 → 双协议请求（并发上限 4）→ 逐张回传 →
/// 全部完成后一次性落库。requestId 供前端取消。
#[tauri::command]
pub async fn ai_generate_image(app: AppHandle, canvas_id: String, node_id: String) -> Result<Value, String> {
    use tokio::sync::{Notify, Semaphore};

    // 配置与节点状态同步读取（短锁），随后进入异步请求阶段。
    let (settings, node_meta, node_title, upstream) = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let settings = load_ai_settings(&conn);
        let row: (String, String, Option<String>) = conn
            .query_row(
                "SELECT type, metadata, title FROM canvas_nodes WHERE id = ?1 AND canvas_id = ?2",
                params![node_id, canvas_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|_| format!("节点不存在：{node_id}"))?;
        if row.0 != "image" {
            return Err("只有图片节点可以生成".to_string());
        }
        let upstream = collect_upstream(&conn, &node_id)?;
        (settings, parse_node_meta_lenient("image", &row.1), row.2.unwrap_or_default(), upstream)
    };
    let NodeMeta::Image { params: node_params, status, .. } = &node_meta else {
        return Err("节点 metadata 类型异常".to_string());
    };
    // 双保险（方案 3.4 成本防护）：前端进度条目可能因窗口刷新等丢失，
    // UI 层拦不住对同一节点的并发二次发起——这里按落库状态兜底拒绝。
    if *status == ImageNodeStatus::Generating {
        return Err("该节点正在生成中，请等它完成或先取消".to_string());
    }

    let model = if node_params.model.trim().is_empty() { settings.model.trim().to_string() } else { node_params.model.trim().to_string() };
    if model.is_empty() {
        return Err("未配置模型：请到 设置 → AI 生图 填写默认模型，或在节点参数里指定".to_string());
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
            "kind": "image",
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

    // 参考图准备：Gemini 走 dataUrl；OpenAI edits 直接传文件路径。
    let mut reference_paths = Vec::new();
    for rel in &upstream.references {
        reference_paths.push(resolve_library_path(&app, rel.to_string_lossy().as_ref())?);
    }
    let reference_data_urls: Vec<String> = if settings.provider == "gemini" {
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

    let provider = settings.provider.clone();
    let openai_base = settings.openai_base.clone();
    let openai_key = settings.openai_key.clone();
    let gemini_base = settings.gemini_base.clone();
    let gemini_key = settings.gemini_key.clone();
    let model_for_task = model.clone();
    let prompt_for_task = prompt.clone();
    let size_raw_for_task = size_raw.clone();
    let refs_for_task = reference_paths.clone();
    let refs_data_for_task = reference_data_urls.clone();
    let request_size_for_task = request_size.clone();

    let semaphore = Arc::new(Semaphore::new(4));
    let mut handles = Vec::new();
    for slot in 0..count as usize {
        let client = client.clone();
        let provider = provider.clone();
        let model = model_for_task.clone();
        let prompt = prompt_for_task.clone();
        let size_raw = size_raw_for_task.clone();
        let request_size = request_size_for_task.clone();
        let reference_paths = refs_for_task.clone();
        let reference_data_urls = refs_data_for_task.clone();
        let openai_base = openai_base.clone();
        let openai_key = openai_key.clone();
        let gemini_base = gemini_base.clone();
        let gemini_key = gemini_key.clone();
        let notify = notify.clone();
        let semaphore = semaphore.clone();
        let app2 = app.clone();
        let node_id2 = node_id.clone();
        let request_id2 = request_id.clone();
        handles.push(tokio::spawn(async move {
            let _permit = semaphore.acquire().await;
            let result = if provider == "gemini" {
                request_gemini(&client, &gemini_base, &gemini_key, &model, &prompt, &reference_data_urls, &size_raw, notify.clone()).await
            } else {
                // 每槽位独立请求（n=1 × count 次）：与单请求 n=count 等价，
                // 换来逐张回传的进度粒度。
                request_openai(&client, &openai_base, &openai_key, &model, &prompt, &reference_paths, 1, None, request_size.as_deref(), notify.clone()).await
            };
            match result {
                Ok(images) => {
                    let data_url = images.into_iter().next();
                    if let Some(url) = &data_url {
                        let _ = app2.emit(
                            "canvas-generation-progress",
                            json!({ "requestId": request_id2, "nodeId": node_id2, "slot": slot, "dataUrl": url }),
                        );
                    }
                    ImageTaskResult { slot, data_url, error: None }
                }
                Err(e) if e == "__cancelled__" => ImageTaskResult { slot, data_url: None, error: Some("__cancelled__".to_string()) },
                Err(e) => {
                    let _ = app2.emit(
                        "canvas-generation-progress",
                        json!({ "requestId": request_id2, "nodeId": node_id2, "slot": slot, "error": e }),
                    );
                    ImageTaskResult { slot, data_url: None, error: Some(e) }
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
    let error_msg = if errors.is_empty() {
        String::new()
    } else if cancelled {
        format!("已取消（保留 {} 张已完成）", saved.len())
    } else {
        let first = errors[0].clone();
        if saved.is_empty() {
            first
        } else {
            format!("{}/{} 张成功：{}", saved.len(), count, first)
        }
    };

    let final_meta = json!({
        "kind": "image",
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

// ── 测试：尺寸映射 / 请求组装 / 错误解析 / mock 服务器 ──

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};

    #[test]
    fn size_mapping_rules() {
        // auto/空 → 不带 size
        assert_eq!(resolve_request_size(None, ""), Ok(None));
        assert_eq!(resolve_request_size(None, "auto"), Ok(None));
        // 显式像素：合法原样、非法报错
        assert_eq!(resolve_request_size(None, "1024x1024"), Ok(Some("1024x1024".to_string())));
        assert!(resolve_request_size(None, "1023x1024").is_err()); // 步长
        assert!(resolve_request_size(None, "4096x4096").is_err()); // 最大边
        // 比例 → 像素：预设表命中
        assert_eq!(resolve_size(Some("high"), "1:1").unwrap(), "2880x2880");
        assert_eq!(resolve_size(None, "16:9").unwrap(), "1536x864");
        // 无 quality 无预设：短边 1024 分支（比例 5:4 → 长边 1280）
        assert_eq!(resolve_size(None, "5:4").unwrap(), "1280x1024");
    }

    #[test]
    fn gemini_image_config_rules() {
        // auto → 无 imageConfig
        assert_eq!(gemini_image_config("auto", "gemini-2.5-flash-image"), json!({}));
        // 比例归一到最近支持项（3:5=0.6 → 9:16=0.5625 比 2:3=0.667 更近；
        // 5:4 本身在支持清单内）
        let cfg = gemini_image_config("3:5", "gemini-2.5-flash-image");
        assert_eq!(cfg["imageConfig"]["aspectRatio"], "9:16");
        let cfg54 = gemini_image_config("5:4", "gemini-2.5-flash-image");
        assert_eq!(cfg54["imageConfig"]["aspectRatio"], "5:4");
        // imageSize 仅 3 系模型带，且仅当 size 是像素形态（比例输入
        // dimensions=null → undefined，sheengo 同行为）
        let cfg3 = gemini_image_config("1024x1024", "gemini-3-pro-image");
        assert_eq!(cfg3["imageConfig"]["imageSize"], "1K");
        let cfg3r = gemini_image_config("1:1", "gemini-3-pro-image");
        assert!(cfg3r["imageConfig"].get("imageSize").is_none());
        let cfg2 = gemini_image_config("1024x1024", "gemini-2.5-flash-image");
        assert!(cfg2["imageConfig"].get("imageSize").is_none());
    }

    #[test]
    fn openai_body_rules() {
        // gpt-image 不带 response_format；其他模型带 b64_json
        let gpt = openai_generations_body("gpt-image-1", "p", 2, None, Some("1024x1024"));
        assert!(gpt.get("response_format").is_none());
        assert_eq!(gpt["n"], 2);
        let other = openai_generations_body("dall-e-3", "p", 1, None, None);
        assert_eq!(other["response_format"], "b64_json");
        assert_eq!(other["output_format"], "png");
    }

    #[test]
    fn reference_prompt_rules() {
        assert_eq!(build_reference_prompt(" 画一只猫 ", 0), "画一只猫");
        let with_ref = build_reference_prompt("画一只猫", 2);
        assert!(with_ref.starts_with("参考图片编号：图片1、图片2。"));
        assert!(with_ref.ends_with("\n\n画一只猫"));
    }

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

    /// 极简 mock HTTP 服务器：读全请求（头 + content-length body）再响应，
    /// 可服务多个连接——读一次就关会在请求分片到达时触发 RST 丢响应。
    fn spawn_mock(status: u16, body: &'static str) -> String {
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

    #[tokio::test]
    async fn openai_request_against_mock() {
        let body = r#"{"data":[{"b64_json":"QUJD"}]}"#;
        let base = spawn_mock(200, body);
        let client = reqwest::Client::new();
        let images = request_openai(
            &client,
            &base,
            "sk-test",
            "dall-e-3",
            "a cat",
            &[],
            1,
            None,
            None,
            Arc::new(tokio::sync::Notify::new()),
        )
        .await
        .unwrap();
        assert_eq!(images, vec!["data:image/png;base64,QUJD"]);
    }

    #[tokio::test]
    async fn openai_auth_error_against_mock() {
        let base = spawn_mock(401, r#"{"error":{"message":"bad key"}}"#);
        let client = reqwest::Client::new();
        let err = request_openai(
            &client,
            &base,
            "sk-bad",
            "dall-e-3",
            "a cat",
            &[],
            1,
            None,
            None,
            Arc::new(tokio::sync::Notify::new()),
        )
        .await
        .unwrap_err();
        assert_eq!(err, "bad key");
    }

    #[tokio::test]
    async fn gemini_request_against_mock() {
        let body = r#"{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"QUJD"}}]}}]}"#;
        let base = spawn_mock(200, body);
        let client = reqwest::Client::new();
        let images = request_gemini(
            &client,
            &base,
            "g-key",
            "gemini-2.5-flash-image",
            "a cat",
            &[],
            "auto",
            Arc::new(tokio::sync::Notify::new()),
        )
        .await
        .unwrap();
        assert_eq!(images, vec!["data:image/png;base64,QUJD"]);
    }
}

