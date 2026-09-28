use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

pub struct TrayState {
    pub tray: Mutex<Option<tauri::tray::TrayIcon>>,
}

fn build_tray_menu(
    app: &AppHandle,
    lang: &str,
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let (show_text, quit_text) = if lang == "en" {
        ("Show Window", "Quit")
    } else {
        ("显示窗口", "退出")
    };
    let paused = crate::db::get_setting_sync(app, "clipboard_paused").as_deref() == Some("1");
    let pause_text = match (lang == "en", paused) {
        (true, true) => "Resume Capture",
        (true, false) => "Pause Capture",
        (false, true) => "恢复采集",
        (false, false) => "暂停采集",
    };

    let show = MenuItemBuilder::with_id("show", show_text).build(app)?;
    let toggle_pause = MenuItemBuilder::with_id("toggle_pause", pause_text).build(app)?;
    let quit = MenuItemBuilder::with_id("quit", quit_text).build(app)?;
    MenuBuilder::new(app)
        .item(&show)
        .item(&toggle_pause)
        .separator()
        .item(&quit)
        .build()
        .map_err(Into::into)
}

/// 重建托盘菜单（语言或采集暂停态变化后调用）；托盘未就绪时静默跳过。
fn refresh_tray_menu(app: &AppHandle) -> Result<(), String> {
    let lang = crate::db::get_setting_sync(app, "language").unwrap_or_else(|| "zh-CN".to_string());
    let menu = build_tray_menu(app, &lang).map_err(|e| e.to_string())?;

    let state = app.state::<TrayState>();
    let tray_guard = state.tray.lock().map_err(|e| e.to_string())?;
    if let Some(tray) = tray_guard.as_ref() {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn create_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let lang = crate::db::get_setting_sync(app, "language").unwrap_or_else(|| "zh-CN".to_string());
    let menu = build_tray_menu(app, &lang)?;

    let icon_bytes = include_bytes!("../icons/icon.png");
    let img = image::load_from_memory(icon_bytes)
        .expect("Failed to decode tray icon")
        .into_rgba8();
    let (w, h) = img.dimensions();
    let icon = tauri::image::Image::new_owned(img.into_raw(), w, h);

    let tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("Copy Creator")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                crate::show_main_window(app, "tray-menu", false);
            }
            "toggle_pause" => {
                let current = crate::db::get_setting_sync(app, "clipboard_paused")
                    .as_deref()
                    == Some("1");
                let next = !current;
                let _ = crate::db::set_setting_inner(app, "clipboard_paused", if next { "1" } else { "0" });
                log::info!("tray: capture paused={next}");
                let _ = refresh_tray_menu(app);
                // 主窗口提示条与设置页开关跟随（径向/新建窗口无此消费方）。
                let _ = app.emit("clipboard-pause-changed", serde_json::json!({ "paused": next }));
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
            {
                if button_state != tauri::tray::MouseButtonState::Down {
                    return;
                }
                if button == tauri::tray::MouseButton::Left {
                    let app = tray.app_handle();
                    if let Some(window) = app.get_webview_window("main") {
                        if window.is_visible().unwrap_or(false) {
                            window.hide().ok();
                        } else {
                            crate::show_main_window(app, "tray-click", false);
                        }
                    }
                }
            }
        })
        .build(app)?;

    let state = app.state::<TrayState>();
    *state.tray.lock().unwrap() = Some(tray);

    Ok(())
}

#[tauri::command]
pub fn update_tray_language(app: AppHandle) -> Result<(), String> {
    refresh_tray_menu(&app)
}
