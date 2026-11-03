// OpenAI 兼容 images API 协议（URL 组装 / 请求体 / 响应解析 / HTTP 执行）（自 ai.rs 零改动拆分，2026-11-03 阶段 9a）。
use super::*;

pub(super) fn openai_api_url(base_url: &str, path: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.to_lowercase().ends_with("/v1") {
        format!("{base}{path}")
    } else {
        format!("{base}/v1{path}")
    }
}

/// Gemini base URL 拼接（geminiBaseUrl）：以 /v1 或 /v1beta 结尾则保留。
pub(super) fn openai_generations_body(model: &str, prompt: &str, n: u32, quality: Option<&str>, size: Option<&str>) -> Value {
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
pub(super) fn parse_openai_payload(payload: &Value) -> Result<Vec<String>, String> {
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

pub(super) async fn request_openai(
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
        parse_openai_payload(&payload)
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::test_support::spawn_mock;
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
}
