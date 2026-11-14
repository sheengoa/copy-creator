// 系统文件对话框统一骨架：tauri-plugin-dialog 回调经通道转发、
// spawn_blocking 带超时收尾。此前 backup / canvas_media / resource /
// phrase 四域各持有一份骨架（超时 60/120s 不一、错误映射「对话框等待
// 失败/选择文件失败/timeout」三套文案各写各的），收口于此；调用方只
// 声明对话框构造（过滤器/默认文件名/模式），取消/超时三态统一映射。

use std::sync::mpsc::Sender;
use std::time::Duration;
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, FilePath};

/// 对话框未应答的安全超时：用户可能离开工位不回来，超时按取消处理。
const DIALOG_TIMEOUT: Duration = Duration::from_secs(120);

/// 弹出文件对话框并等待结果：configure 收 builder 所有权完成配置并以
/// save_file/pick_file/pick_folder 收尾（builder 方法为按值链式，回调里
/// 转发 tx）。返回路径字符串；取消/通道断开 → "cancelled"，超时 →
/// "timeout"（前端对 cancelled 静默处理，其余按错误提示）。
pub(crate) async fn dialog_path<R, F>(app: &AppHandle<R>, configure: F) -> Result<String, String>
where
    R: Runtime,
    F: FnOnce(tauri_plugin_dialog::FileDialogBuilder<R>, Sender<Option<FilePath>>),
{
    let (tx, rx) = std::sync::mpsc::channel();
    configure(app.dialog().file(), tx);
    let result = tokio::task::spawn_blocking(move || rx.recv_timeout(DIALOG_TIMEOUT))
        .await
        .map_err(|e| format!("task error: {e}"))?;
    match result {
        Ok(Some(path)) => Ok(path.to_string()),
        Ok(None) => Err("cancelled".to_string()),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err("timeout".to_string()),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err("cancelled".to_string()),
    }
}
