// 粘贴创建窗口域（A2 拆分）：尺寸记忆 / 几何计算 / 显示与打开。
// 从 shortcut.rs 机械搬迁；实现与行为不变。
use tauri::{AppHandle, Emitter, Manager};
use crate::radial_window::{get_cursor_position, raise_always_on_top, raise_visible_popup_windows};
#[cfg(target_os = "windows")]
use crate::win_hook;

// 窗口尺寸均含透明阴影边距（见文件顶部"窗口层级约定"注释）。
const CLIPBOARD_CREATE_DEFAULT_WIDTH: f64 = 560.0 + 2.0 * crate::WINDOW_SHADOW_MARGIN;
const CLIPBOARD_CREATE_DEFAULT_HEIGHT: f64 = 520.0 + 2.0 * crate::WINDOW_SHADOW_MARGIN;
const CLIPBOARD_CREATE_MIN_WIDTH: f64 = 480.0 + 2.0 * crate::WINDOW_SHADOW_MARGIN;
const CLIPBOARD_CREATE_MIN_HEIGHT: f64 = 380.0 + 2.0 * crate::WINDOW_SHADOW_MARGIN;

#[derive(Debug, PartialEq)]
struct ClipboardCreateGeometry {
    width: f64,
    height: f64,
    x: i32,
    y: i32,
}

fn saved_dimension(value: Option<String>, fallback: f64) -> f64 {
    value
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn calculate_clipboard_create_geometry(
    cursor_x: i32,
    cursor_y: i32,
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
    scale_factor: f64,
    saved_width: f64,
    saved_height: f64,
) -> ClipboardCreateGeometry {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let max_width = (work_width as f64 / scale).max(CLIPBOARD_CREATE_MIN_WIDTH);
    let max_height = (work_height as f64 / scale).max(CLIPBOARD_CREATE_MIN_HEIGHT);
    let width = saved_width.clamp(CLIPBOARD_CREATE_MIN_WIDTH, max_width);
    let height = saved_height.clamp(CLIPBOARD_CREATE_MIN_HEIGHT, max_height);
    let physical_width = (width * scale).round() as i32;
    let physical_height = (height * scale).round() as i32;
    let max_x = work_x
        .saturating_add(work_width as i32)
        .saturating_sub(physical_width)
        .max(work_x);
    let max_y = work_y
        .saturating_add(work_height as i32)
        .saturating_sub(physical_height)
        .max(work_y);

    ClipboardCreateGeometry {
        width,
        height,
        x: cursor_x
            .saturating_sub(physical_width / 2)
            .clamp(work_x, max_x),
        y: cursor_y.saturating_sub(40).clamp(work_y, max_y),
    }
}

pub fn show_clipboard_create(
    app: &AppHandle,
    group_name: Option<String>,
    storage_mode: Option<String>,
) {
    let window = match app.get_webview_window("clipboard-create") {
        Some(w) => w,
        None => {
            log::warn!("[show_clipboard_create] clipboard-create window not found");
            return;
        }
    };

    // 已显示则隐藏（toggle 行为）
    if window.is_visible().unwrap_or(false) {
        log::info!("[show_clipboard_create] already visible, hiding");
        let _ = window.hide();
        return;
    }

    let (cursor_x, cursor_y) = get_cursor_position();
    let saved_width = saved_dimension(
        crate::db::get_setting_sync(app, "clipboard_create_width"),
        CLIPBOARD_CREATE_DEFAULT_WIDTH,
    );
    let saved_height = saved_dimension(
        crate::db::get_setting_sync(app, "clipboard_create_height"),
        CLIPBOARD_CREATE_DEFAULT_HEIGHT,
    );
    // `get_cursor_position` 返回的是 X11 根窗口的物理坐标。直接从可用屏幕
    // 的物理几何中选择目标屏幕，避免高 DPI 下 `monitor_from_point` 的坐标
    // 语义与鼠标坐标不一致，导致窗口落到旧屏幕或固定位置。
    let monitor = window
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                let cursor_x = i64::from(cursor_x);
                let cursor_y = i64::from(cursor_y);
                let left = i64::from(position.x);
                let top = i64::from(position.y);
                let right = left.saturating_add(i64::from(size.width));
                let bottom = top.saturating_add(i64::from(size.height));
                cursor_x >= left && cursor_x < right && cursor_y >= top && cursor_y < bottom
            })
        })
        .or_else(|| {
            window
                .monitor_from_point(cursor_x as f64, cursor_y as f64)
                .ok()
                .flatten()
        })
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());

    let geometry = monitor.as_ref().map_or(
        ClipboardCreateGeometry {
            width: saved_width.max(CLIPBOARD_CREATE_MIN_WIDTH),
            height: saved_height.max(CLIPBOARD_CREATE_MIN_HEIGHT),
            x: cursor_x
                .saturating_sub((saved_width.max(CLIPBOARD_CREATE_MIN_WIDTH) / 2.0).round() as i32)
                .max(0),
            y: cursor_y.saturating_sub(40).max(0),
        },
        |monitor| {
            let work_area = monitor.work_area();
            calculate_clipboard_create_geometry(
                cursor_x,
                cursor_y,
                work_area.position.x,
                work_area.position.y,
                work_area.size.width,
                work_area.size.height,
                monitor.scale_factor(),
                saved_width,
                saved_height,
            )
        },
    );

    if let Err(error) = window.set_size(tauri::LogicalSize::new(geometry.width, geometry.height)) {
        log::warn!("[show_clipboard_create] set_size failed: {error}");
    }
    if let Err(error) = window.set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y)) {
        log::warn!("[show_clipboard_create] set_position failed: {error}");
    }

    // 读取主题
    let theme = crate::db::get_setting_sync(app, "theme").unwrap_or_else(|| "light".to_string());

    // 抬升并激活（含 X11 pager 激活），确保新建窗口位于主窗口之上；
    // 主窗口持有焦点时普通抬升会被 mutter 焦点约束压制。
    raise_always_on_top(&window);
    // Windows: 后台进程的 set_focus 会被前台锁拒绝，强制接管前台保证
    // 窗口可立即键入（见 win_hook::force_focus_window）。
    #[cfg(target_os = "windows")]
    win_hook::force_focus_window(&window);
    // 新建窗口打开时可能抢到置顶窗口的堆叠顺序，恢复两个弹窗的固定顺序。
    raise_visible_popup_windows(app);

    let _ = app.emit(
        "clipboard-create-show",
        serde_json::json!({
            "theme": theme,
            "group_name": group_name,
            "storage_mode": storage_mode,
        }),
    );

    log::info!(
        "[show_clipboard_create] shown at ({}, {}) theme={}",
        geometry.x,
        geometry.y,
        theme
    );
}

#[tauri::command]
pub fn open_clipboard_create(
    app: AppHandle,
    group_name: Option<String>,
    storage_mode: Option<String>,
) -> Result<(), String> {
    show_clipboard_create(&app, group_name, storage_mode);
    Ok(())
}

#[cfg(test)]
mod clipboard_create_geometry_tests {
    use super::*;

    #[test]
    fn uses_default_size_near_cursor() {
        assert_eq!(
            calculate_clipboard_create_geometry(
                1000,
                500,
                0,
                0,
                1920,
                1080,
                1.0,
                CLIPBOARD_CREATE_DEFAULT_WIDTH,
                CLIPBOARD_CREATE_DEFAULT_HEIGHT,
            ),
            ClipboardCreateGeometry {
                width: 600.0,
                height: 560.0,
                x: 700,
                y: 460
            }
        );
    }

    #[test]
    fn keeps_saved_size_inside_all_work_area_edges() {
        assert_eq!(
            calculate_clipboard_create_geometry(1800, 1000, 0, 0, 1920, 1080, 1.0, 800.0, 700.0),
            ClipboardCreateGeometry {
                width: 800.0,
                height: 700.0,
                x: 1120,
                y: 380
            }
        );
    }

    #[test]
    fn converts_saved_logical_size_for_scaled_monitor() {
        assert_eq!(
            calculate_clipboard_create_geometry(1280, 720, 0, 0, 2560, 1440, 2.0, 1000.0, 800.0),
            ClipboardCreateGeometry {
                width: 1000.0,
                height: 720.0,
                x: 280,
                y: 0
            }
        );
    }

    #[test]
    fn supports_negative_monitor_coordinates() {
        assert_eq!(
            calculate_clipboard_create_geometry(
                -1800, 100, -1920, 0, 1920, 1080, 1.0, 560.0, 520.0
            ),
            ClipboardCreateGeometry {
                width: 560.0,
                height: 520.0,
                x: -1920,
                y: 60
            }
        );
    }
}

