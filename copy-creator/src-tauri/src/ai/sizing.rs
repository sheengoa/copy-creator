// 画布 AI 生图：尺寸规则（lib/media-size.ts + image.ts 尺寸函数的等价翻译）（自 ai.rs 零改动拆分，2026-11-03 阶段 9a）。
use super::*;

// ── 尺寸规则（lib/media-size.ts + image.ts 尺寸函数的等价翻译） ──

const IMAGE_SIZE_STEP: u32 = 16;
const IMAGE_MIN_PIXELS: u64 = 655_360;
const IMAGE_MAX_PIXELS: u64 = 8_294_400;
const IMAGE_MAX_EDGE: u32 = 3840;
const IMAGE_MAX_RATIO: f64 = 3.0;
pub(super) const IMAGE_OUTPUT_FORMAT: &str = "png";

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
pub(super) fn resolve_size(quality: Option<&str>, ratio: &str) -> Result<String, String> {
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
pub(super) fn resolve_request_size(quality: Option<&str>, size: &str) -> Result<Option<String>, String> {
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
pub(super) fn gemini_image_config(size: &str, model: &str) -> Value {
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


#[cfg(test)]
mod tests {
    use super::*;
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
}
