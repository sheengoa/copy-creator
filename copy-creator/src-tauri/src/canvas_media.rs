//! 画布加载/保存节点的文件对话框与产物导出。
//!
//! 加载节点：允许从任意路径引用媒体文件（用户经系统对话框明确选择，
//! 选择即登记媒体服务运行时授权清单——只引用不复制，资源库加载走
//! ProjectFilePickerDialog）；保存节点：产物可入库（import_file_into_library
//! 复制登记）或另存到任意路径（纯复制）。

use serde_json::json;
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
