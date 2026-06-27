mod autostart;
mod clipboard;
mod db;
mod ipc;
mod paste;
mod shortcut;
mod translator;
mod tray;

use tauri::Manager;

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
                        let key = format!("{}", shortcut);
                        if shortcut::is_main_shortcut(&key) {
                            shortcut::toggle_window(app);
                        } else if shortcut::is_radial_shortcut(&key) {
                            shortcut::show_radial_menu(app);
                        } else {
                            log::info!("[shortcut] unknown shortcut pressed: {}", key);
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
            let current_theme = db::get_setting_sync(app.handle(), "theme")
                .unwrap_or_else(|| "light".to_string());
            log::info!("Starting with theme: {}", current_theme);

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

            app.handle().manage(tray::TrayState { tray: std::sync::Mutex::new(None) });
            tray::create_tray(app.handle())?;

            shortcut::init_radial_menu_state(app.handle());

            // Start Unix-socket IPC so external scripts can control the app
            // (used with Ubuntu Settings → Keyboard → Custom Shortcuts)
            let ipc_socket = ipc::start_ipc_server(app.handle().clone());
            log::info!("IPC socket ready — use: echo show | nc -U {}", ipc_socket.display());

            // Create hidden radial menu popup window
            {
                use tauri::WebviewWindowBuilder;
                use tauri::WebviewUrl;
                let _ = WebviewWindowBuilder::new(
                    app,
                    "radial-menu",
                    WebviewUrl::App("index.html?radial=1".into()),
                )
                .title("")
                .inner_size(300.0, 420.0)
                .decorations(false)
                .transparent(false)
                .always_on_top(true)
                .visible(false)
                .shadow(false)
                .skip_taskbar(true)
                .resizable(false)
                .build()?;
                log::info!("Radial menu popup window created (opaque, rounded via CSS)");
            }

            if let Ok(key) = db::get_setting(app.handle().clone(), "shortcut_key".to_string()) {
                if !key.is_empty() {
                    *shortcut::MAIN_SHORTCUT_KEY.lock().unwrap() = key.clone();
                    if let Err(e) = shortcut::register_keyboard_shortcut(app.handle(), &key) {
                        log::warn!("Failed to register keyboard shortcut '{}': {}", key, e);
                    }
                }
            }

            // Register radial menu shortcut
            if let Ok(key) = db::get_setting(app.handle().clone(), "shortcut_radial".to_string()) {
                if !key.is_empty() {
                    *shortcut::RADIAL_SHORTCUT_KEY.lock().unwrap() = key.clone();
                    if let Err(e) = shortcut::register_keyboard_shortcut(app.handle(), &key) {
                        log::warn!("Failed to register radial shortcut '{}': {}", key, e);
                    }
                }
            }

            // Show main window when not auto-started (after all init is done)
            if !is_autostart {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::get_clipboard_records,
            db::get_clipboard_record_content,
            db::delete_all_clipboard_records,
            db::delete_records_by_type,
            db::delete_clipboard_record,
            db::get_phrase_groups,
            db::create_phrase_group,
            db::update_phrase_group,
            db::delete_phrase_group,
            db::get_phrases,
            db::create_phrase,
            db::create_file_phrase,
            db::update_phrase,
            db::update_file_phrase,
            db::delete_phrase,
            db::select_quick_input_file,
            db::get_quick_input_file_limit,
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
            paste::paste_file,
            db::get_image_base64,
            db::get_image_thumbnail,
            db::ensure_thumbnail,
            db::get_storage_path,
            db::select_storage_folder,
            translator::translate,
            shortcut::update_shortcut,
            shortcut::update_radial_shortcut,
            shortcut::set_radial_menu_enabled,
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
            db::reorder_phrases,
            toggle_always_on_top,
            autostart::set_autostart,
            autostart::is_autostart_enabled,
            autostart::validate_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
