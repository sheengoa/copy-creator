//! 画布加载/保存节点的文件对话框与产物导出。
//!
//! 加载节点：允许从任意路径引用媒体文件（用户经系统对话框明确选择，
//! 选择即登记媒体服务运行时授权清单——只引用不复制，资源库加载走
//! ProjectFilePickerDialog）；保存节点：产物可入库（import_file_into_library
//! 复制登记）或另存到任意路径（纯复制）。

use serde_json::json;
use tauri::AppHandle;
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
