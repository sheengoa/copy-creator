// Gemini 原生 generateContent 协议（URL/模型名 / 响应解析 / HTTP 执行）（自 ai.rs 零改动拆分，2026-11-03 阶段 9a）。
use super::*;

pub(super) fn gemini_base_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let lower = base.to_lowercase();
    if lower.ends_with("/v1") || lower.ends_with("/v1beta") {
        base.to_string()
    } else {
        format!("{base}/v1beta")
    }
}

/// Gemini model 名归一（geminiModelName）：去 models/ 前缀。
pub(super) fn gemini_model_name(model: &str) -> String {
    model.trim().trim_start_matches("models/").to_string()
}

/// 参考图提示词组装（buildImageReferencePromptText，中文文案按应用主语言固定）。
pub(super) fn parse_gemini_payload(payload: &Value) -> Result<Vec<String>, String> {
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


pub(super) async fn request_gemini(
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
        r = fut => r.map_err(|e| format!("请求失败：{}", reqwest_cause(&e)))?,
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


#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::test_support::spawn_mock;
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
