use rusqlite::params;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[cfg(target_os = "linux")]
use gtk::{
    gdk,
    glib::Propagation,
    prelude::{DeviceExt, DragContextExtManual, FileExt, SeatExt, WidgetExt, WidgetExtManual},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RadialDragSource {
    Clipboard,
    Phrase,
}

fn canonical_file_path(path: PathBuf) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(&path)
        .map_err(|error| format!("拖拽文件不存在: {} ({error})", path.display()))?;
    if !path.is_file() {
        return Err(format!("拖拽目标不是文件: {}", path.display()));
    }
    Ok(path)
}

fn stored_file_path(app: &AppHandle, path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        crate::db::get_storage_dir(app).join(path)
    }
}

fn clipboard_drag_paths(app: &AppHandle, id: &str) -> Result<Vec<PathBuf>, String> {
    let (record_type, content, attachments) = {
        let state = app.state::<crate::db::DbState>();
        let conn = state.conn.lock().map_err(|error| error.to_string())?;
        conn.query_row(
            "SELECT type, content, attachments FROM clipboard_records WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|error| format!("剪切板记录不存在: {error}"))?
    };

    let attachment_paths = serde_json::from_str::<Vec<String>>(&attachments)
        .map_err(|error| format!("解析图片附件失败: {error}"))?;
    if let Some(path) = attachment_paths.first() {
        return Ok(vec![canonical_file_path(stored_file_path(app, path))?]);
    }

    match record_type.as_str() {
        "image" => Ok(vec![canonical_file_path(stored_file_path(app, &content))?]),
        "file" => Ok(vec![canonical_file_path(PathBuf::from(content))?]),
        _ => Err("只有图片和文件内容支持系统文件拖拽".to_string()),
    }
}

fn phrase_drag_paths(app: &AppHandle, id: &str) -> Result<Vec<PathBuf>, String> {
    let (input_type, content) = {
        let state = app.state::<crate::db::DbState>();
        let conn = state.conn.lock().map_err(|error| error.to_string())?;
        conn.query_row(
            "SELECT input_type, content FROM phrases WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|error| format!("快捷输入不存在: {error}"))?
    };

    if input_type != "file" {
        return Err("只有文件快捷输入支持系统文件拖拽".to_string());
    }

    Ok(vec![canonical_file_path(stored_file_path(app, &content))?])
}

fn resolve_drag_paths(
    app: &AppHandle,
    source: RadialDragSource,
    id: &str,
) -> Result<Vec<PathBuf>, String> {
    match source {
        RadialDragSource::Clipboard => clipboard_drag_paths(app, id),
        RadialDragSource::Phrase => phrase_drag_paths(app, id),
    }
}

fn path_from_hint(app: &AppHandle, path: String) -> Result<PathBuf, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("拖拽文件路径为空".to_string());
    }
    Ok(stored_file_path(app, path))
}

fn finish_radial_drag(
    app: &AppHandle,
    result: drag::DragResult,
    cursor_position: drag::CursorPosition,
) {
    log::info!(
        "[radial_drag] result={result:?}, cursor=({}, {})",
        cursor_position.x,
        cursor_position.y
    );
    if let Some(radial) = app.get_webview_window("radial-menu") {
        let _ = radial.hide();
    }
    let _ = app.emit("radial-drag-finished", ());
}

#[cfg(target_os = "linux")]
struct LinuxDragCandidate {
    path: PathBuf,
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct LinuxDragState {
    candidate: Option<LinuxDragCandidate>,
    active: bool,
}

#[cfg(target_os = "linux")]
static LINUX_DRAG_STATE: OnceLock<Arc<Mutex<LinuxDragState>>> = OnceLock::new();

#[cfg(target_os = "linux")]
static LINUX_DRAG_SOURCE_INSTALLED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "linux")]
fn linux_drag_state() -> &'static Arc<Mutex<LinuxDragState>> {
    LINUX_DRAG_STATE.get_or_init(|| Arc::new(Mutex::new(LinuxDragState::default())))
}

#[cfg(target_os = "linux")]
fn activate_linux_drag(path: PathBuf) -> Result<(), String> {
    let state = linux_drag_state();
    let mut state = state.lock().map_err(|error| error.to_string())?;

    if state.active {
        return Err("文件拖动已在进行中".to_string());
    }

    state.candidate = Some(LinuxDragCandidate { path });
    state.active = true;
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_drag_is_ready() -> bool {
    let state = linux_drag_state();
    state
        .lock()
        .map(|state| state.active && state.candidate.is_some())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn finish_linux_drag() -> bool {
    let state = linux_drag_state();
    let Ok(mut state) = state.lock() else {
        return false;
    };
    if !state.active {
        return false;
    }
    state.active = false;
    state.candidate = None;
    true
}

#[cfg(target_os = "linux")]
fn cursor_position(window: &gtk::ApplicationWindow) -> drag::CursorPosition {
    let Some(pointer) = window
        .display()
        .default_seat()
        .and_then(|seat| seat.pointer())
    else {
        log::warn!("[radial_drag] 获取拖动结束位置失败，使用默认位置");
        return drag::CursorPosition { x: 0, y: 0 };
    };
    let (_, x, y) = pointer.position();
    drag::CursorPosition { x, y }
}

#[cfg(target_os = "linux")]
fn install_linux_drag_source(
    app: &AppHandle,
    window: &gtk::ApplicationWindow,
) -> Result<(), String> {
    if LINUX_DRAG_SOURCE_INSTALLED.load(Ordering::Acquire) {
        return Ok(());
    }

    // 只配置文件目标，不让 GTK 自己根据全窗口鼠标移动自动启动拖动。
    // 前端越过拖动阈值后会调用一次 start_radial_file_drag，避免与 IPC
    // 候选准备产生竞态，也保证菜单中每个 DOM 区域使用同一条启动路径。
    window.drag_source_set(gdk::ModifierType::empty(), &[], gdk::DragAction::COPY);
    window.drag_source_add_uri_targets();

    let data_state = linux_drag_state().clone();
    window.connect_drag_data_get(move |_, _, data, _, _| {
        let path = data_state.lock().ok().and_then(|state| {
            state
                .candidate
                .as_ref()
                .map(|candidate| candidate.path.clone())
        });
        let Some(path) = path.and_then(|path| canonical_file_path(path).ok()) else {
            log::warn!("[radial_drag] 拖动数据请求时文件已不可用");
            return;
        };

        let uri = gtk::gio::File::for_path(&path).uri().to_string();
        let target = data.target().name();
        let set_uris_result = data.set_uris(&[uri.as_str()]);
        log::debug!(
            "[radial_drag] drag_data_get target={} uri={} set_uris={}",
            target,
            uri,
            set_uris_result
        );
    });

    let begin_app = app.clone();
    window.connect_drag_begin(move |_, context| {
        if !linux_drag_is_ready() {
            // GTK 的拖动源挂在顶层窗口上，文本和空白区域也会进入这里；
            // 没有前端候选时立即取消，避免误拖出上一次文件。
            context.drag_cancel();
            return;
        }

        log::debug!("[radial_drag] GTK native drag started");
        let app_for_hide = begin_app.clone();
        gtk::glib::idle_add_once(move || {
            if let Some(radial) = app_for_hide.get_webview_window("radial-menu") {
                let _ = radial.hide();
            }
        });
    });

    let failed_app = app.clone();
    window.connect_drag_failed(move |window, _, _| {
        if finish_linux_drag() {
            finish_radial_drag(
                &failed_app,
                drag::DragResult::Cancel,
                cursor_position(window),
            );
        }
        Propagation::Stop
    });

    let ended_app = app.clone();
    window.connect_drag_end(move |window, context| {
        if !finish_linux_drag() {
            return;
        }
        let result = if context.drag_drop_succeeded() {
            drag::DragResult::Dropped
        } else {
            drag::DragResult::Cancel
        };
        finish_radial_drag(&ended_app, result, cursor_position(window));
    });

    LINUX_DRAG_SOURCE_INSTALLED.store(true, Ordering::Release);
    log::info!("[radial_drag] GTK native file drag source installed");
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn install_radial_file_drag_source(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Result<(), String> {
    let gtk_window = window
        .gtk_window()
        .map_err(|error| format!("获取 GTK 窗口失败: {error}"))?;
    install_linux_drag_source(app, &gtk_window)
}

#[cfg(not(target_os = "linux"))]
fn start_platform_drag(
    window: &WebviewWindow,
    paths: Vec<PathBuf>,
    icon_path: PathBuf,
    app: AppHandle,
) -> Result<(), String> {
    let callback_app = app.clone();
    let callback = move |result: drag::DragResult, cursor_position: drag::CursorPosition| {
        finish_radial_drag(&callback_app, result, cursor_position);
    };

    let item = drag::DragItem::Files(paths);
    let image = drag::Image::File(icon_path);
    drag::start_drag(window, item, image, callback, drag::Options::default())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn start_radial_file_drag(
    app: AppHandle,
    window: WebviewWindow,
    source: RadialDragSource,
    id: String,
    path: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let path = match path.filter(|path| !path.trim().is_empty()) {
            Some(path) => path_from_hint(&app, path)?,
            None => resolve_drag_paths(&app, source, &id)?
                .into_iter()
                .next()
                .ok_or_else(|| "没有可拖拽的文件".to_string())?,
        };
        let path = canonical_file_path(path)?;
        let gtk_window = window
            .gtk_window()
            .map_err(|error| format!("获取 GTK 窗口失败: {error}"))?;
        let target_list = gtk_window
            .drag_source_get_target_list()
            .ok_or_else(|| "Linux 文件拖动目标未初始化".to_string())?;

        activate_linux_drag(path)?;
        if gtk_window
            .drag_begin_with_coordinates(
                &target_list,
                gdk::DragAction::COPY,
                gdk::ffi::GDK_BUTTON1_MASK as i32,
                None,
                -1,
                -1,
            )
            .is_none()
        {
            finish_linux_drag();
            return Err("启动 Linux 文件拖动失败".to_string());
        }
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    {
        let paths = match path.filter(|path| !path.trim().is_empty()) {
            Some(path) => vec![canonical_file_path(path_from_hint(&app, path)?)?],
            None => resolve_drag_paths(&app, source, &id)?,
        };
        let icon_path = paths
            .first()
            .cloned()
            .ok_or_else(|| "没有可拖拽的文件".to_string())?;
        start_platform_drag(&window, paths, icon_path, app)
    }
}
