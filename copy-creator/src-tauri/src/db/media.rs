// 媒体域：图片 base64、缩略图解码与磁盘缓存、视频封面帧缓存。
// 从 db/mod.rs 机械搬迁；实现与行为不变，共享助手经 super::* 引用。
use super::*;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn get_image_base64(app: AppHandle, path: String) -> Result<String, String> {
    let image_path = resolve_storage_path(&app, &path)?;
    // 安全边界：只读应用管理目录内的图片，拒绝越界绝对路径。
    if !is_app_managed_path(&app, &image_path) {
        return Err("图片路径越界".to_string());
    }
    let bytes = std::fs::read(&image_path).map_err(|e| format!("read image file: {}", e))?;

    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub async fn get_image_thumbnail(
    app: AppHandle,
    path: String,
    max_size: u32,
) -> Result<String, String> {
    // 图片解码是重 CPU 操作，必须离开主线程：同步命令在主线程执行，
    // 大图串行解码会直接冻结 UI（切换资源区卡顿的主因之一）。
    tokio::task::spawn_blocking(move || get_image_thumbnail_blocking(app, path, max_size))
        .await
        .map_err(|e| format!("thumbnail task join: {e}"))?
}

pub(crate) fn get_image_thumbnail_blocking(
    app: AppHandle,
    path: String,
    max_size: u32,
) -> Result<String, String> {
    let image_path = resolve_storage_path(&app, &path)?;
    // 安全边界：同 get_image_base64，拒绝应用管理目录之外的绝对路径。
    if !is_app_managed_path(&app, &image_path) {
        return Err("图片路径越界".to_string());
    }
    let base_dir = image_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| get_storage_dir(&app));

    // 应用存储图沿用剪贴板捕获时写在原图旁 thumbs/ 的预生成缩略图；
    // 外部绝对路径（资源库等用户目录）不得写入派生文件——thumbs/ 曾被
    // 资源发现误收录为内容。缓存统一进应用缓存目录，键含路径与修改时间。
    let thumb_path = if Path::new(&path).is_absolute() {
        let metadata =
            std::fs::metadata(&image_path).map_err(|e| format!("stat image: {e}"))?;
        let modified_secs = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let key = format!(
            "{:016x}-{}-{}",
            fnv1a64(path.as_bytes()),
            metadata.len(),
            modified_secs
        );
        app.path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .join("external-image-thumbs")
            .join(format!("{key}.png"))
    } else {
        // Try pre-generated thumbnail first (saved during clipboard capture)
        let thumb_dir = image_path.parent().unwrap_or(&base_dir).join("thumbs");
        let filename = image_path.file_name().ok_or("invalid path")?;
        thumb_dir.join(filename)
    };

    let thumb_bytes = if thumb_path.exists() {
        std::fs::read(&thumb_path).map_err(|e| format!("read thumbnail: {}", e))?
    } else {
        // Fallback: generate thumbnail from full image
        let bytes = std::fs::read(&image_path).map_err(|e| format!("read image file: {}", e))?;
        let img = image::load_from_memory(&bytes).map_err(|e| format!("decode image: {}", e))?;
        let (w, h) = (img.width(), img.height());
        let scale = if w > max_size || h > max_size {
            max_size as f32 / w.max(h) as f32
        } else {
            1.0
        };
        let thumb = if scale < 1.0 {
            let new_w = (w as f32 * scale) as u32;
            let new_h = (h as f32 * scale) as u32;
            img.resize(new_w, new_h, image::imageops::FilterType::Triangle)
        } else {
            img
        };
        let mut buf = std::io::Cursor::new(Vec::new());
        thumb
            .write_to(&mut buf, image::ImageFormat::Png)
            .map_err(|e| format!("encode thumbnail: {}", e))?;
        let data = buf.into_inner();
        // Save for future use
        if let Some(thumb_dir) = thumb_path.parent() {
            std::fs::create_dir_all(thumb_dir).ok();
        }
        let _ = std::fs::write(&thumb_path, &data);
        data
    };

    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&thumb_bytes))
}

pub(crate) fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 视频海报缓存路径：与图片缩略图同策略（路径哈希 + 大小 + 修改时间），
/// 集中存放在应用缓存目录，永不写入用户库。
pub(crate) fn video_poster_cache_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("stat video: {e}"))?;
    let modified_secs = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let key = format!(
        "{:016x}-{}-{}",
        fnv1a64(path.as_bytes()),
        metadata.len(),
        modified_secs
    );
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("video-posters")
        .join(format!("{key}.jpg")))
}

/// 读取已持久化的视频海报（base64 JPEG）。未生成返回空串，调用方回退
/// 现场抽帧流程。
#[tauri::command]
pub async fn load_resource_video_poster(app: AppHandle, path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let cache_path = video_poster_cache_path(&app, &path)?;
        if !cache_path.exists() {
            return Ok(String::new());
        }
        let bytes = std::fs::read(cache_path).map_err(|e| format!("read poster: {e}"))?;
        use base64::Engine;
        Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
    })
    .await
    .map_err(|e| format!("poster task join: {e}"))?
}

/// 持久化前端抽帧得到的海报（data:image/jpeg;base64,...）。此后列表展示
/// 该视频只加载这张图，不再挂 <video> 加载元数据与寻帧。
#[tauri::command]
pub async fn save_resource_video_poster(
    app: AppHandle,
    path: String,
    data_url: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let base64_part = data_url
            .strip_prefix("data:image/jpeg;base64,")
            .ok_or("poster dataUrl 格式不符")?;
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64_part)
            .map_err(|e| format!("decode poster: {e}"))?;
        let cache_path = video_poster_cache_path(&app, &path)?;
        if let Some(dir) = cache_path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        std::fs::write(cache_path, &bytes).map_err(|e| format!("write poster: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("poster task join: {e}"))?
}

// 缓存条目超限后按修改时间裁剪最旧的一批，防止缩略图目录无限增长。
pub(crate) fn trim_resource_thumbnail_cache(cache_dir: &Path) {
    const MAX_ENTRIES: usize = 1000;
    const TRIM_TO: usize = 800;
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "png"))
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect();
    if files.len() <= MAX_ENTRIES {
        return;
    }
    files.sort_by_key(|(modified, _)| *modified);
    let excess = files.len() - TRIM_TO;
    for (_, path) in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
}

/// 为任意本地图片文件生成缩略图（base64 PNG）。与 `get_image_thumbnail`
/// 不同，本命令面向资源库里用户自选路径的图片文件：缓存集中存放在应用
/// 缓存目录，key 由"路径哈希 + 文件大小 + 修改时间"组成，文件被覆盖后
/// 自动失效。解码失败（svg/heic 等格式）交由前端回退原图。
/// 解码经 spawn_blocking 在线程池执行，不阻塞主线程（大库切换流畅的前提）。
#[tauri::command]
pub async fn get_resource_file_thumbnail(
    app: AppHandle,
    path: String,
    max_size: u32,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || get_resource_file_thumbnail_blocking(app, path, max_size))
        .await
        .map_err(|e| format!("thumbnail task join: {e}"))?
}

pub(crate) fn get_resource_file_thumbnail_blocking(
    app: AppHandle,
    path: String,
    max_size: u32,
) -> Result<String, String> {
    // 统一路径解析：绝对路径原样（资源库/外部文件），存储相对路径按存储目录
    // 展开（剪切板图片记录的 content 即此形态）。
    let image_path = resolve_storage_path(&app, &path)?;
    let metadata = std::fs::metadata(&image_path).map_err(|e| format!("stat image: {e}"))?;
    let modified_secs = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let key = format!(
        "{:016x}-{}-{}",
        fnv1a64(path.as_bytes()),
        metadata.len(),
        modified_secs
    );

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("resource-thumbs");
    let cache_path = cache_dir.join(format!("{key}.png"));

    let thumb_bytes = if let Ok(bytes) = std::fs::read(&cache_path) {
        bytes
    } else {
        let bytes = std::fs::read(&image_path).map_err(|e| format!("read image file: {e}"))?;
        let img = image::load_from_memory(&bytes).map_err(|e| format!("decode image: {e}"))?;
        let (w, h) = (img.width(), img.height());
        let thumb = if w > max_size || h > max_size {
            let scale = max_size as f32 / w.max(h) as f32;
            img.resize(
                (w as f32 * scale) as u32,
                (h as f32 * scale) as u32,
                image::imageops::FilterType::Triangle,
            )
        } else {
            img
        };
        let mut buf = std::io::Cursor::new(Vec::new());
        thumb
            .write_to(&mut buf, image::ImageFormat::Png)
            .map_err(|e| format!("encode thumbnail: {e}"))?;
        let data = buf.into_inner();
        std::fs::create_dir_all(&cache_dir).ok();
        let _ = std::fs::write(&cache_path, &data);
        trim_resource_thumbnail_cache(&cache_dir);
        data
    };

    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&thumb_bytes))
}
