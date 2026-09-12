// 独立内容预览窗口：主窗口媒体展开与径向菜单展开按钮共用的弹窗。
// 与新建窗口同款自绘窗口：无边框透明 + CSS 圆角阴影 + 自绘标题栏，
// 可拖拽移动、拖边缘调整大小；窗口常驻隐藏、复用，内容经事件下发。

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

use crate::WINDOW_SHADOW_MARGIN;

pub const PREVIEW_WINDOW_LABEL: &str = "content-preview";
const PREVIEW_WIDTH: f64 = 720.0;
const PREVIEW_HEIGHT: f64 = 540.0;
const PREVIEW_MIN_WIDTH: f64 = 420.0;
const PREVIEW_MIN_HEIGHT: f64 = 320.0;

/// 启动时创建隐藏的预览窗口（自绘标题栏，可调整大小）。
pub fn init_preview_window(app: &AppHandle) -> tauri::Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let window = WebviewWindowBuilder::new(
        app,
        PREVIEW_WINDOW_LABEL,
        WebviewUrl::App("index.html?preview=1".into()),
    )
    .title("预览")
    .inner_size(
        PREVIEW_WIDTH + 2.0 * WINDOW_SHADOW_MARGIN,
        PREVIEW_HEIGHT + 2.0 * WINDOW_SHADOW_MARGIN,
    )
    .min_inner_size(
        PREVIEW_MIN_WIDTH + 2.0 * WINDOW_SHADOW_MARGIN,
        PREVIEW_MIN_HEIGHT + 2.0 * WINDOW_SHADOW_MARGIN,
    )
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible(false)
    .shadow(false)
    .skip_taskbar(true)
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

/// 在鼠标所在显示器居中弹出预览窗口；标题写入自绘标题栏（经事件下发）。
#[tauri::command]
pub fn open_preview_window(app: AppHandle, title: String, segments: Value) -> Result<(), String> {
    let preview = app
        .get_webview_window(PREVIEW_WINDOW_LABEL)
        .ok_or_else(|| "预览窗口未初始化".to_string())?;

    let cursor = app.cursor_position().map_err(|error| error.to_string())?;
    let outer = preview.outer_size().map_err(|error| error.to_string())?;

    // 居中于鼠标所在显示器（多显示器时跟随用户当前位置），失败时回退主显示器。
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
        let x = position.x + (size.width as i32 - outer.width as i32) / 2;
        let y = position.y + (size.height as i32 - outer.height as i32) / 2;
        preview
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|error| error.to_string())?;
    }

    app.emit_to(PREVIEW_WINDOW_LABEL, "preview-content", PreviewPayload {
        title,
        segments,
    })
    .map_err(|error| error.to_string())?;
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
