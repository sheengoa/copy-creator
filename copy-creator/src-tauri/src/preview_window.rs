// 独立内容预览窗口：主窗口媒体展开与径向菜单展开按钮共用的弹窗。
// 系统标题栏、可拖拽调整大小；窗口常驻隐藏、复用，内容经事件下发。

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

pub const PREVIEW_WINDOW_LABEL: &str = "content-preview";
const PREVIEW_WIDTH: f64 = 760.0;
const PREVIEW_HEIGHT: f64 = 560.0;
const PREVIEW_MIN_WIDTH: f64 = 420.0;
const PREVIEW_MIN_HEIGHT: f64 = 320.0;

/// 启动时创建隐藏的预览窗口（带系统标题栏，可拖拽调整大小）。
pub fn init_preview_window(app: &AppHandle) -> tauri::Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let window = WebviewWindowBuilder::new(
        app,
        PREVIEW_WINDOW_LABEL,
        WebviewUrl::App("index.html?preview=1".into()),
    )
    .title("预览")
    .inner_size(PREVIEW_WIDTH, PREVIEW_HEIGHT)
    .min_inner_size(PREVIEW_MIN_WIDTH, PREVIEW_MIN_HEIGHT)
    .visible(false)
    .resizable(true)
    .build()?;
    // 系统关闭按钮按「隐藏」处理：窗口常驻复用，避免下次打开重建 WebView。
    let hidden_window = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hidden_window.hide();
        }
    });
    log::info!("Content preview window created");
    Ok(())
}

/// 以鼠标指针为中心弹出预览窗口；title 同时写入系统标题栏。
#[tauri::command]
pub fn open_preview_window(
    app: AppHandle,
    title: String,
    segments: Value,
) -> Result<(), String> {
    let preview = app
        .get_webview_window(PREVIEW_WINDOW_LABEL)
        .ok_or_else(|| "预览窗口未初始化".to_string())?;

    let cursor = app.cursor_position().map_err(|error| error.to_string())?;
    let outer = preview
        .outer_size()
        .map_err(|error| error.to_string())?;
    let half_width = (outer.width / 2) as i32;
    let half_height = (outer.height / 2) as i32;
    let mut x = cursor.x as i32 - half_width;
    let mut y = cursor.y as i32 - half_height;

    // 钳制到鼠标所在显示器范围内，避免窗口一半留在屏幕外。
    let monitor = app
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                cursor.x >= position.x as f64
                    && cursor.x < (position.x + size.width as i32) as f64
                    && cursor.y >= position.y as f64
                    && cursor.y < (position.y + size.height as i32) as f64
            })
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let position = monitor.position();
        let size = monitor.size();
        x = x.clamp(position.x, position.x + size.width as i32 - outer.width as i32);
        y = y.clamp(position.y, position.y + size.height as i32 - outer.height as i32);
    }
    preview
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;

    preview
        .set_title(&title)
        .map_err(|error| error.to_string())?;
    let emit_result = app.emit_to(PREVIEW_WINDOW_LABEL, "preview-content", PreviewPayload {
        title,
        segments,
    });
    match &emit_result {
        Ok(()) => log::info!("[preview_window] preview-content emitted to {PREVIEW_WINDOW_LABEL}"),
        Err(error) => log::warn!("[preview_window] emit failed: {error}"),
    }
    emit_result.map_err(|error| error.to_string())?;
    preview.show().map_err(|error| error.to_string())?;
    let _ = preview.set_focus();
    Ok(())
}

#[derive(serde::Serialize, Clone)]
struct PreviewPayload {
    title: String,
    segments: Value,
}

/// 隐藏预览窗口（ESC / 复用语义的收起）。
#[tauri::command]
pub fn hide_preview_window(app: AppHandle) -> Result<(), String> {
    if let Some(preview) = app.get_webview_window(PREVIEW_WINDOW_LABEL) {
        preview.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}
