//! 画布加载/保存节点的文件对话框与产物导出。
//!
//! 加载节点：允许从任意路径引用媒体文件（用户经系统对话框明确选择，
//! 选择即登记媒体服务运行时授权清单——只引用不复制，资源库加载走
//! ProjectFilePickerDialog）；保存节点：产物可入库（import_file_into_library
//! 复制登记）或另存到任意路径（纯复制）。

use serde_json::json;
use std::hash::{Hash, Hasher};
use tauri::AppHandle;
use tauri::Manager;
use tauri::Runtime;
use tauri_plugin_dialog::DialogExt;

/// 对话框回调 → 通道 → 阻塞等待的通用骨架（对齐 select_resource_trace_file：
/// 命令为 async，避免在主线程阻塞等待用户操作）。
async fn await_dialog<T: Send + 'static>(
    receiver: std::sync::mpsc::Receiver<T>,
) -> Result<T, String> {
    tokio::task::spawn_blocking(move || {
        receiver.recv_timeout(std::time::Duration::from_secs(120))
    })
    .await
    .map_err(|e| format!("task error: {e}"))?
    .map_err(|e| format!("对话框等待失败: {e}"))
}

/// 加载节点「从电脑选择」：任意路径媒体文件，选择即登记媒体服务授权
/// （只引用预览，不复制入库）。取消返回 cancelled（前端静默）。
#[tauri::command]
pub async fn canvas_pick_media_file(app: AppHandle) -> Result<serde_json::Value, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_file(move |path| {
        let _ = tx.send(path);
    });
    match await_dialog(rx).await? {
        Some(path) => {
            let path_string = path.to_string();
            let meta = std::fs::metadata(std::path::PathBuf::from(&path_string))
                .map_err(|e| format!("读取文件失败: {e}"))?;
            if !meta.is_file() {
                return Err("请选择一个文件".to_string());
            }
            crate::media_server::authorize_external_file(&path_string);
            Ok(json!({ "path": path_string }))
        }
        None => Err("cancelled".to_string()),
    }
}

/// 加载节点拖入文件：与系统对话框选择同语义（明确来源），登记媒体
/// 服务运行时授权后即可预览。
#[tauri::command]
pub fn canvas_authorize_media(path: String) -> Result<(), String> {
    let meta = std::fs::metadata(std::path::PathBuf::from(path.trim()))
        .map_err(|e| format!("读取文件失败: {e}"))?;
    if !meta.is_file() {
        return Err("请拖入一个文件".to_string());
    }
    crate::media_server::authorize_external_file(path.trim());
    Ok(())
}

/// 保存节点「另存为…」：系统保存对话框，返回目标路径（用户取消返回
/// 空串——另存是显式动作，取消不算错误）。
#[tauri::command]
pub async fn canvas_pick_save_path(
    app: AppHandle,
    default_name: String,
) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_file_name(default_name.trim())
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    match await_dialog(rx).await? {
        Some(path) => Ok(path.to_string()),
        None => Ok(String::new()),
    }
}

/// 保存节点多产物「另存到…」：系统文件夹选择对话框（取消返回空串）。
#[tauri::command]
pub async fn canvas_pick_save_dir(app: AppHandle) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    match await_dialog(rx).await? {
        Some(path) => Ok(path.to_string()),
        None => Ok(String::new()),
    }
}

/// 解析产物来源：库内相对路径拼资源库根，绝对路径原样（库内产物与
/// 已加载外部文件都是绝对语义）。
fn resolve_source<R: Runtime>(app: &AppHandle<R>, source_path: &str) -> Result<std::path::PathBuf, String> {
    let value = source_path.trim();
    if value.is_empty() {
        return Err("产物路径为空".to_string());
    }
    let path = std::path::PathBuf::from(value);
    if path.is_absolute() {
        return Ok(path);
    }
    Ok(crate::db::get_resource_library_dir(app).join(value.trim_start_matches(['/', '\\'])))
}

/// 保存节点「保存到资源库」：产物复制入库并登记资源记录（幂等），
/// 返回库内相对路径/媒体类型/文件名。
#[tauri::command]
pub fn canvas_save_to_library(
    app: AppHandle,
    source_path: String,
) -> Result<serde_json::Value, String> {
    let source = resolve_source(&app, &source_path)?;
    let (relative, kind, name) =
        crate::db::import_file_into_library(&app, source.to_string_lossy().as_ref())?;
    Ok(json!({ "file_path": relative, "kind": kind, "name": name }))
}

/// 保存节点「另存到…」：产物纯复制到用户选择的目标路径（库内/外部
/// 路径产物都适用）；目标已存在时覆盖（另存是用户显式动作）。
#[tauri::command]
pub fn canvas_export_to_path(
    app: AppHandle,
    source_path: String,
    target: String,
) -> Result<(), String> {
    let source = resolve_source(&app, &source_path)?;
    if !source.is_file() {
        return Err(format!("产物文件不存在：{}", source.display()));
    }
    let target = target.trim();
    if target.is_empty() {
        return Err("目标路径为空".to_string());
    }
    std::fs::copy(&source, target).map_err(|e| format!("导出失败: {e}"))?;
    Ok(())
}

/// ffmpeg 可执行文件解析（视频首帧/尾帧节点 2026-11-01）：先找应用
/// 资源目录 ffmpeg/（打包布局），找不到再退回 PATH（开发机便利）。
/// 二进制不进 git 仓库——resources/ffmpeg/README.txt 有放置说明。
fn resolve_ffmpeg<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    let bin = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    if let Ok(res_dir) = app.path().resource_dir() {
        let bundled = res_dir.join("ffmpeg").join(bin);
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(bin);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err("未找到 ffmpeg：请将 ffmpeg 可执行文件放入应用资源目录 ffmpeg/ 下，或加入 PATH 后重启应用".to_string())
}

/// 视频抽帧（视频首帧/尾帧节点 2026-11-01）：ffmpeg 提取单帧写入
/// canvas-gen 产物目录（与生成产物同源），返回绝对路径供节点行
/// resource_path 引用（下游 save/preview/合集/参考图聚合通用分支）。
/// which = "first"（第 1 帧）| "last"（结尾处最后一帧，从末尾反向
/// 半秒寻帧，不依赖时长元数据的准确性）。
#[tauri::command]
pub async fn canvas_extract_video_frame(
    app: AppHandle,
    path: String,
    which: String,
) -> Result<serde_json::Value, String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("未加载视频".to_string());
    }
    canvas_authorize_media(path.clone())?;
    let ffmpeg = resolve_ffmpeg(&app)?;
    let which = match which.as_str() {
        "first" => "first",
        "last" => "last",
        other => return Err(format!("未知抽帧位置：{other}")),
    };
    let out_dir = crate::db::get_storage_dir(&app).join("canvas-gen");
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建产物目录失败：{e}"))?;
        let out = out_dir.join(format!("{}-{which}.png", uuid::Uuid::new_v4()));
        let mut cmd = std::process::Command::new(&ffmpeg);
        cmd.args(["-y", "-nostdin", "-hide_banner", "-loglevel", "error"]);
        if which == "last" {
            cmd.arg("-sseof").arg("-0.5");
        }
        cmd.arg("-i").arg(&path);
        cmd.args(["-update", "1", "-frames:v", "1"]);
        cmd.arg(&out);
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::null());
        let output = cmd
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("启动 ffmpeg 失败：{e}"))?;
        if !output.status.success() {
            let tail = String::from_utf8_lossy(&output.stderr);
            let tail = tail
                .lines()
                .filter(|l| !l.trim().is_empty())
                .rev()
                .take(2)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("；");
            return Err(format!(
                "ffmpeg 抽帧失败：{}",
                if tail.is_empty() { "未知错误".to_string() } else { tail }
            ));
        }
        let written = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        if written == 0 {
            return Err("ffmpeg 未产出帧文件（视频可能没有视频轨）".to_string());
        }
        Ok(json!({ "path": out.to_string_lossy() }))
    })
    .await
    .map_err(|e| format!("抽帧任务中断：{e}"))?
}

// ── 视频工具节点（2026-11-02）：缩略图时间轴 / 任意抽帧 / GIF / 音轨 ──

/// 运行 ffmpeg 并校验退出码：失败时取 stderr 末两行拼真实原因（与
/// canvas_extract_video_frame 同一显示语义——代理链路错误要能定位根因）。
fn run_ffmpeg_checked(cmd: &mut std::process::Command, what: &str) -> Result<(), String> {
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::piped());
    let output = cmd
        .output()
        .map_err(|e| format!("启动 ffmpeg 失败：{e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let tail = String::from_utf8_lossy(&output.stderr);
    let tail = tail
        .lines()
        .filter(|l| !l.trim().is_empty())
        .rev()
        .take(2)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("；");
    Err(format!(
        "{what}：{}",
        if tail.is_empty() { "未知错误".to_string() } else { tail }
    ))
}

/// 从 ffmpeg -i 的 stderr 文本解析 `Duration: HH:MM:SS.cc`（纯函数便于
/// 单测）；解析不到或非有限值返回 None（多半不是视频文件）。
fn parse_ffmpeg_duration(text: &str) -> Option<f64> {
    let line = text.lines().find(|l| l.contains("Duration:"))?;
    let seg = line.split("Duration:").nth(1)?.split(',').next()?.trim();
    let mut parts = seg.split(':');
    let h: f64 = parts.next()?.trim().parse().ok()?;
    let m: f64 = parts.next()?.trim().parse().ok()?;
    let s: f64 = parts.next()?.trim().parse().ok()?;
    if !(h.is_finite() && m.is_finite() && s.is_finite()) {
        return None;
    }
    Some((h * 3600.0 + m * 60.0 + s).max(0.0))
}

/// GIF 时长钳制（纯函数）：0.5–10s，非法值（NaN）按默认 3.0s。
fn clamp_gif_duration(duration_secs: f64) -> f64 {
    if !duration_secs.is_finite() {
        return 3.0;
    }
    duration_secs.clamp(0.5, 10.0)
}

/// 缩略图时间轴（视频工具节点 2026-11-02）：ffmpeg 批量抽 10 张小图铺
/// 轨道——选点/选区直接在画面上拖，不依赖前端解码（HEVC/MKV 照样能选）。
/// 产物按「源路径+修改时间+大小」哈希缓存于 canvas-gen/strip-*（meta.json
/// 记录时长与缩略图，源更换自动重建），返回 { duration, thumbnails }。
#[tauri::command]
pub async fn canvas_video_timeline(
    app: AppHandle,
    path: String,
) -> Result<serde_json::Value, String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("未加载视频".to_string());
    }
    canvas_authorize_media(path.clone())?;
    let ffmpeg = resolve_ffmpeg(&app)?;
    let out_root = crate::db::get_storage_dir(&app).join("canvas-gen");
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        const STRIP_COUNT: usize = 10;
        let meta = std::fs::metadata(&path).map_err(|e| format!("读取视频失败：{e}"))?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        format!("{path}:{mtime}:{}", meta.len()).hash(&mut hasher);
        let strip_dir = out_root.join(format!("strip-{:016x}", hasher.finish()));

        // 缓存命中：meta.json 有效即直接返回（换视频/重录后哈希变，自动重建）。
        let meta_file = strip_dir.join("meta.json");
        if let Ok(text) = std::fs::read_to_string(&meta_file) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if v["duration"].as_f64().unwrap_or(0.0) > 0.0
                    && v["thumbnails"].as_array().map(|a| !a.is_empty()).unwrap_or(false)
                {
                    return Ok(v);
                }
            }
        }

        // 时长：ffmpeg -i 无输出文件立即退出（exit 1 属预期），Duration 在 stderr。
        let mut probe = std::process::Command::new(&ffmpeg);
        probe.args(["-nostdin", "-hide_banner", "-i"]).arg(&path);
        probe.stdin(std::process::Stdio::null());
        probe.stdout(std::process::Stdio::null());
        probe.stderr(std::process::Stdio::piped());
        let probe_out = probe
            .output()
            .map_err(|e| format!("启动 ffmpeg 失败：{e}"))?;
        let duration = parse_ffmpeg_duration(&String::from_utf8_lossy(&probe_out.stderr))
            .ok_or_else(|| "无法读取视频时长（可能不是视频文件）".to_string())?;
        if duration <= 0.0 {
            return Err("视频时长为 0，无法生成时间轴".to_string());
        }

        // 生成到临时目录，完成后整体改名落位（meta.json 随目录一起原子
        // 出现）——并发请求同一视频不互相撕裂。meta.json 必须等落位后再
        // 写：strip_dir 在改名前并不存在。
        let tmp_dir = out_root.join(format!(
            "strip-{:016x}.tmp-{}",
            hasher.finish(),
            uuid::Uuid::new_v4()
        ));
        // 失败运行可能遗留同源临时目录（ffmpeg 中断、落位前报错退出），
        // 清掉一小时前的陈旧残留；活跃生成的目录 mtime 持续更新，不受影响。
        let stale_prefix = format!("strip-{:016x}.tmp-", hasher.finish());
        if let Ok(entries) = std::fs::read_dir(&out_root) {
            let stale_before = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
            for entry in entries.flatten() {
                if !entry.file_name().to_string_lossy().starts_with(&stale_prefix) {
                    continue;
                }
                if let Ok(m) = entry.metadata().and_then(|m| m.modified()) {
                    if m < stale_before {
                        let _ = std::fs::remove_dir_all(entry.path());
                    }
                }
            }
        }
        std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建产物目录失败：{e}"))?;
        let step = duration / STRIP_COUNT as f64;
        let mut cmd = std::process::Command::new(&ffmpeg);
        cmd.args(["-y", "-nostdin", "-hide_banner", "-loglevel", "error"]);
        cmd.arg("-i").arg(&path);
        cmd.args([
            "-vf",
            &format!("fps={STRIP_COUNT}/{:.3},scale=80:-2", duration),
            "-frames:v",
            &STRIP_COUNT.to_string(),
            "-start_number",
            "0",
        ]);
        cmd.arg(tmp_dir.join("strip-%02d.png"));
        run_ffmpeg_checked(&mut cmd, "ffmpeg 生成缩略图时间轴失败")?;

        // 实际产出几张记几张（超短视频可能不足 10 张）；路径直接记落位
        // 后的最终位置，改名后即生效。
        let mut thumbnails: Vec<serde_json::Value> = Vec::new();
        for i in 0..STRIP_COUNT {
            if !tmp_dir.join(format!("strip-{i:02}.png")).is_file() {
                break;
            }
            thumbnails.push(json!({
                "t": (i as f64 * step).min(duration),
                "path": strip_dir.join(format!("strip-{i:02}.png")).to_string_lossy(),
            }));
        }
        if thumbnails.is_empty() {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return Err("ffmpeg 未产出缩略图（视频可能没有视频轨）".to_string());
        }
        // 整体改名落位；目标已存在（并发先完成）则放弃本次产物，直接用
        // 已落位目录里的同名图（同源同参，内容一致）。
        if std::fs::rename(&tmp_dir, &strip_dir).is_err() {
            let _ = std::fs::remove_dir_all(&tmp_dir);
        }
        if !strip_dir.is_dir() {
            return Err("时间轴缓存目录落位失败".to_string());
        }
        // meta.json 此时才可写（目录已存在）；缓存自此完整，下次命中直接
        // 返回，不再走 ffmpeg。
        let value = json!({ "duration": duration, "thumbnails": thumbnails });
        std::fs::write(&meta_file, serde_json::to_string(&value).unwrap_or_default())
            .map_err(|e| format!("写入时间轴缓存失败：{e}"))?;
        Ok(value)
    })
    .await
    .map_err(|e| format!("时间轴任务中断：{e}"))?
}

/// 任意时刻抽帧（视频抽帧节点 2026-11-02）：播放头时间 secs 输入侧快
/// seek 后精确解码单帧，产物写 canvas-gen 并返回绝对路径。
#[tauri::command]
pub async fn canvas_seek_video_frame(
    app: AppHandle,
    path: String,
    secs: f64,
) -> Result<serde_json::Value, String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("未加载视频".to_string());
    }
    canvas_authorize_media(path.clone())?;
    let ffmpeg = resolve_ffmpeg(&app)?;
    let secs = if secs.is_finite() { secs.max(0.0) } else { 0.0 };
    let out_dir = crate::db::get_storage_dir(&app).join("canvas-gen");
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建产物目录失败：{e}"))?;
        let out = out_dir.join(format!("{}-seek.png", uuid::Uuid::new_v4()));
        let mut cmd = std::process::Command::new(&ffmpeg);
        cmd.args(["-y", "-nostdin", "-hide_banner", "-loglevel", "error"]);
        cmd.arg("-ss").arg(format!("{secs:.3}"));
        cmd.arg("-i").arg(&path);
        cmd.args(["-update", "1", "-frames:v", "1"]);
        cmd.arg(&out);
        run_ffmpeg_checked(&mut cmd, "ffmpeg 抽帧失败")?;
        let written = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        if written == 0 {
            return Err("ffmpeg 未产出帧文件（视频可能没有视频轨）".to_string());
        }
        Ok(json!({ "path": out.to_string_lossy() }))
    })
    .await
    .map_err(|e| format!("抽帧任务中断：{e}"))?
}

/// 视频转 GIF（视频转 GIF 节点 2026-11-02）：选区起点 + 时长（后端再钳
/// 制 0.5–10s），palettegen/paletteuse 两遍保画质，固定 12fps、宽 480 等比。
#[tauri::command]
pub async fn canvas_convert_video_gif(
    app: AppHandle,
    path: String,
    start: f64,
    duration: f64,
) -> Result<serde_json::Value, String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("未加载视频".to_string());
    }
    canvas_authorize_media(path.clone())?;
    let ffmpeg = resolve_ffmpeg(&app)?;
    let start = if start.is_finite() { start.max(0.0) } else { 0.0 };
    let duration = clamp_gif_duration(duration);
    let out_dir = crate::db::get_storage_dir(&app).join("canvas-gen");
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建产物目录失败：{e}"))?;
        let out = out_dir.join(format!("{}.gif", uuid::Uuid::new_v4()));
        let mut cmd = std::process::Command::new(&ffmpeg);
        cmd.args(["-y", "-nostdin", "-hide_banner", "-loglevel", "error"]);
        cmd.arg("-ss").arg(format!("{start:.3}"));
        cmd.arg("-t").arg(format!("{duration:.3}"));
        cmd.arg("-i").arg(&path);
        cmd.args([
            "-filter_complex",
            "[0:v]fps=12,scale=480:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
            "-loop",
            "0",
        ]);
        cmd.arg(&out);
        run_ffmpeg_checked(&mut cmd, "ffmpeg 转 GIF 失败")?;
        let written = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        if written == 0 {
            return Err("ffmpeg 未产出 GIF 文件".to_string());
        }
        Ok(json!({ "path": out.to_string_lossy() }))
    })
    .await
    .map_err(|e| format!("转 GIF 任务中断：{e}"))?
}

/// 视频抽音轨（视频抽音轨节点 2026-11-02）：选区起点 + 时长（≤0 为整段），
/// format = "mp3"（libmp3lame 重编码，兼容性最好）| "aac"（原声直拷 .m4a，
/// 无损更快，源音轨非 AAC 时由 ffmpeg 报真实错误）。
#[tauri::command]
pub async fn canvas_extract_audio(
    app: AppHandle,
    path: String,
    start: f64,
    duration: f64,
    format: String,
) -> Result<serde_json::Value, String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("未加载视频".to_string());
    }
    canvas_authorize_media(path.clone())?;
    let ffmpeg = resolve_ffmpeg(&app)?;
    let start = if start.is_finite() { start.max(0.0) } else { 0.0 };
    let whole = !(duration.is_finite() && duration > 0.0);
    let duration = if whole { 0.0 } else { duration };
    let ext = match format.as_str() {
        "aac" => "m4a",
        // 空串按 mp3（metadata 默认值）。
        "" | "mp3" => "mp3",
        other => return Err(format!("未知音频格式：{other}")),
    };
    let out_dir = crate::db::get_storage_dir(&app).join("canvas-gen");
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建产物目录失败：{e}"))?;
        let out = out_dir.join(format!("{}.{ext}", uuid::Uuid::new_v4()));
        let mut cmd = std::process::Command::new(&ffmpeg);
        cmd.args(["-y", "-nostdin", "-hide_banner", "-loglevel", "error"]);
        cmd.arg("-ss").arg(format!("{start:.3}"));
        if !whole {
            cmd.arg("-t").arg(format!("{duration:.3}"));
        }
        cmd.arg("-i").arg(&path);
        cmd.arg("-vn");
        if ext == "m4a" {
            cmd.args(["-acodec", "copy"]);
        } else {
            cmd.args(["-c:a", "libmp3lame", "-q:a", "2"]);
        }
        cmd.arg(&out);
        run_ffmpeg_checked(&mut cmd, "ffmpeg 抽音轨失败")?;
        let written = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        if written == 0 {
            return Err("ffmpeg 未产出音频文件（视频可能没有音轨）".to_string());
        }
        Ok(json!({ "path": out.to_string_lossy() }))
    })
    .await
    .map_err(|e| format!("抽音轨任务中断：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffmpeg_duration_parsing_rules() {
        // 标准 ffmpeg -i 输出（含 start/duration/bitrage 行）
        let text = "Input #0, mov,mp4:\n  Duration: 00:01:23.45, start: 0.000000, bitrate: 1234 kb/s\n  Stream #0:0: Video: h264";
        assert_eq!(parse_ffmpeg_duration(text), Some(83.45));
        // 恰好一小时 + 无小数秒
        assert_eq!(parse_ffmpeg_duration("Duration: 01:00:00.00"), Some(3600.0));
        // 无 Duration 行 / 非数字 / 负值归零
        assert_eq!(parse_ffmpeg_duration("no duration here"), None);
        assert_eq!(parse_ffmpeg_duration("Duration: xx:00:00.00"), None);
        assert_eq!(parse_ffmpeg_duration("Duration: 00:00:-5.00"), Some(0.0));
    }

    #[test]
    fn gif_duration_clamp_rules() {
        // 选区限幅 0.5–10s；NaN 回退默认 3.0s
        assert_eq!(clamp_gif_duration(3.0), 3.0);
        assert_eq!(clamp_gif_duration(0.1), 0.5);
        assert_eq!(clamp_gif_duration(30.0), 10.0);
        assert_eq!(clamp_gif_duration(f64::NAN), 3.0);
    }
}
