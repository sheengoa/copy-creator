mod autostart;
mod clipboard;
mod db;
#[cfg(target_os = "linux")]
mod ipc;
mod paste;
mod radial_drag;
mod shortcut;
mod translator;
mod tray;

use tauri::Manager;

pub(crate) fn show_main_window(app: &tauri::AppHandle, reason: &str, center: bool) {
    let Some(window) = app.get_webview_window("main") else {
        log::error!("[show_main_window] main window not found ({reason})");
        return;
    };

    log::info!("[show_main_window] showing main window ({reason})");

    let popup_visible = shortcut::has_visible_popup_window(app);
    let was_pinned = window.is_always_on_top().unwrap_or(false);
    if let Err(e) = window.set_always_on_top(true) {
        log::warn!("[show_main_window] set_always_on_top(true) failed: {e}");
    }
    if center {
        if let Err(e) = window.center() {
            log::warn!("[show_main_window] center failed: {e}");
        }
    }
    if let Err(e) = window.unminimize() {
        log::warn!("[show_main_window] unminimize failed: {e}");
    }
    if let Err(e) = window.show() {
        log::warn!("[show_main_window] show failed: {e}");
    }
    if !popup_visible {
        if let Err(e) = window.set_focus() {
            log::warn!("[show_main_window] set_focus failed: {e}");
        }
    } else {
        shortcut::raise_visible_popup_windows(app);
    }

    let app_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.set_always_on_top(was_pinned);
            if window.is_visible().unwrap_or(false) {
                if shortcut::has_visible_popup_window(&app_handle) {
                    shortcut::raise_visible_popup_windows(&app_handle);
                } else {
                    let _ = window.set_focus();
                }
            }
        } else {
            log::error!("[show_main_window] main window not found (delayed startup)");
        }
    });
}

#[tauri::command]
fn toggle_always_on_top(app: tauri::AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "window not found".to_string())?;
    let current = window.is_always_on_top().map_err(|e| e.to_string())?;
    let next = !current;
    window.set_always_on_top(next).map_err(|e| e.to_string())?;
    Ok(next)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        log::info!("[shortcut] pressed {} (id={})", shortcut, shortcut.id());
                        if shortcut::is_main_shortcut(shortcut) {
                            shortcut::toggle_window(app);
                        } else if shortcut::is_radial_shortcut(shortcut) {
                            shortcut::show_radial_menu(app);
                        } else if shortcut::is_clipboard_create_shortcut(shortcut) {
                            shortcut::show_clipboard_create(app, None, None);
                        } else {
                            log::warn!(
                                "[shortcut] unhandled shortcut pressed: {} (id={})",
                                shortcut,
                                shortcut.id()
                            );
                        }
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let is_autostart = std::env::args().any(|a| a == "--hidden");

            db::init_db(app.handle())?;
            db::prune_old_records(app.handle()).ok();

            // Restore persisted theme; DB init defaults to light, so
            // the first-ever launch will be light mode.
            let current_theme =
                db::get_setting_sync(app.handle(), "theme").unwrap_or_else(|| "light".to_string());
            log::info!("Starting with theme: {}", current_theme);

            // Restore persisted main window size. Values are logical pixels
            // saved by the frontend; clamp to tauri.conf.json's min size.
            if let Some(window) = app.get_webview_window("main") {
                let saved_width = db::get_setting_sync(app.handle(), "main_window_width")
                    .and_then(|raw| raw.parse::<f64>().ok())
                    .filter(|value| value.is_finite());
                let saved_height = db::get_setting_sync(app.handle(), "main_window_height")
                    .and_then(|raw| raw.parse::<f64>().ok())
                    .filter(|value| value.is_finite());
                if let (Some(width), Some(height)) = (saved_width, saved_height) {
                    let width = width.max(440.0);
                    let height = height.max(420.0);
                    if let Err(e) = window.set_size(tauri::LogicalSize::new(width, height)) {
                        log::warn!("restore main window size failed: {e}");
                    }
                }
            }

            // Repair autostart entry if stale or broken
            autostart::repair_autostart_if_needed();

            // Diagnose paste environment (logs + notifies if tools missing)
            paste::diagnose_paste_environment();

            // Periodic pruning every hour
            let prune_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(3600));
                db::prune_old_records(&prune_handle).ok();
            });

            clipboard::start_monitor(app.handle())?;

            app.handle().manage(tray::TrayState {
                tray: std::sync::Mutex::new(None),
            });
            tray::create_tray(app.handle())?;

            shortcut::init_radial_menu_state(app.handle());

            // Linux-only: Unix-socket IPC lets external scripts control the
            // app (Ubuntu Settings → Keyboard → Custom Shortcuts). Windows
            // relies on native global hotkeys instead.
            #[cfg(target_os = "linux")]
            {
                let ipc_socket = ipc::start_ipc_server(app.handle().clone());
                log::info!(
                    "IPC socket ready — use: echo show | nc -U {}",
                    ipc_socket.display()
                );
            }

            // Create hidden radial menu popup window
            {
                use tauri::WebviewUrl;
                use tauri::WebviewWindowBuilder;
                let _ = WebviewWindowBuilder::new(
                    app,
                    "radial-menu",
                    WebviewUrl::App("index.html?radial=1".into()),
                )
                .title("")
                .inner_size(420.0, 650.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .visible(false)
                .shadow(false)
                .skip_taskbar(true)
                .resizable(false)
                .build()?;
                log::info!("Radial menu popup window created (transparent, rounded via CSS)");
            }

            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("radial-menu") {
                radial_drag::install_radial_file_drag_source(app.handle(), &window)
                    .map_err(|error| format!("安装径向菜单文件拖动源失败: {error}"))?;
            }

            // Create hidden standalone clipboard-create popup window.
            {
                use tauri::WebviewUrl;
                use tauri::WebviewWindowBuilder;
                let _ = WebviewWindowBuilder::new(
                    app,
                    "clipboard-create",
                    WebviewUrl::App("index.html?clipboard-create=1".into()),
                )
                .title("新建")
                .inner_size(560.0, 520.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .visible(false)
                .shadow(false)
                .skip_taskbar(true)
                .resizable(true)
                .min_inner_size(480.0, 380.0)
                .build()?;
                log::info!("Clipboard create popup window created");
            }

            if let Ok(key) = db::get_setting(app.handle().clone(), "shortcut_key".to_string()) {
                let key = key.trim().to_string();
                if !key.is_empty() {
                    match shortcut::register_keyboard_shortcut(app.handle(), &key) {
                        Ok(()) => *shortcut::MAIN_SHORTCUT_KEY.lock().unwrap() = key,
                        Err(e) => {
                            log::warn!("Failed to register keyboard shortcut '{}': {}", key, e)
                        }
                    }
                }
            }

            // Register radial menu shortcut
            if let Ok(key) = db::get_setting(app.handle().clone(), "shortcut_radial".to_string()) {
                let key = key.trim().to_string();
                if !key.is_empty() {
                    match shortcut::register_keyboard_shortcut(app.handle(), &key) {
                        Ok(()) => *shortcut::RADIAL_SHORTCUT_KEY.lock().unwrap() = key,
                        Err(e) => log::warn!("Failed to register radial shortcut '{}': {}", key, e),
                    }
                }
            }

            // Register standalone clipboard create shortcut
            if let Ok(key) = db::get_setting(
                app.handle().clone(),
                "shortcut_clipboard_create".to_string(),
            ) {
                let key = key.trim().to_string();
                if !key.is_empty() {
                    match shortcut::register_keyboard_shortcut(app.handle(), &key) {
                        Ok(()) => *shortcut::CLIPBOARD_CREATE_SHORTCUT_KEY.lock().unwrap() = key,
                        Err(e) => log::warn!(
                            "Failed to register clipboard create shortcut '{}': {}",
                            key,
                            e
                        ),
                    }
                }
            }

            // Show main window when not auto-started (after all init is done)
            if !is_autostart {
                show_main_window(app.handle(), "startup", true);
            } else {
                log::info!("[show_main_window] startup hidden by --hidden");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::get_clipboard_records,
            clipboard::create_clipboard_record,
            clipboard::save_stash_record,
            clipboard::get_stash_record_images,
            clipboard::read_clipboard_image_base64,
            db::get_clipboard_record_content,
            db::update_clipboard_record,
            db::delete_clipboard_records,
            db::delete_all_clipboard_records,
            db::delete_records_by_type,
            db::delete_clipboard_record,
            db::get_phrase_groups,
            db::create_phrase_group,
            db::update_phrase_group,
            db::delete_phrase_group,
            db::get_resource_groups,
            db::create_resource_group,
            db::update_resource_group,
            db::delete_resource_group,
            db::get_phrases,
            db::create_phrase,
            db::create_file_phrase,
            db::update_phrase,
            db::update_file_phrase,
            db::delete_phrases,
            db::delete_phrase,
            db::select_quick_input_file,
            db::get_quick_input_file_limit,
            db::get_quick_input_file_info,
            db::read_quick_input_text_preview,
            db::read_clipboard_text_preview,
            db::get_translation_history,
            db::clear_translation_history,
            db::get_setting,
            db::get_all_settings,
            db::set_setting,
            db::set_setting_skip_migrate,
            db::set_settings_batch,
            paste::paste_text,
            paste::paste_text_terminal,
            paste::paste_image,
            paste::paste_image_file,
            paste::paste_stash_record,
            paste::paste_file,
            radial_drag::arm_radial_file_drag,
            radial_drag::cancel_radial_file_drag,
            radial_drag::start_radial_file_drag,
            db::get_image_base64,
            db::get_image_thumbnail,
            db::ensure_thumbnail,
            db::get_storage_path,
            db::select_storage_folder,
            db::get_resource_library_path,
            db::set_resource_library_path,
            db::select_resource_library_folder,
            translator::translate,
            shortcut::update_shortcut,
            shortcut::update_radial_shortcut,
            shortcut::update_clipboard_create_shortcut,
            shortcut::set_radial_menu_enabled,
            shortcut::open_clipboard_create,
            tray::update_tray_language,
            db::check_api_key,
            db::save_api_key_label,
            db::get_api_key_label,
            db::delete_api_key_label,
            db::list_api_key_labels,
            db::mark_expired,
            db::export_labels_json,
            db::mark_toast_shown,
            db::is_toast_shown,
            db::set_user_api_key,
            db::reorder_clipboard_records,
            db::reorder_phrase_groups,
            db::reorder_resource_groups,
            db::reorder_phrases,
            toggle_always_on_top,
            autostart::set_autostart,
            autostart::is_autostart_enabled,
            autostart::validate_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
