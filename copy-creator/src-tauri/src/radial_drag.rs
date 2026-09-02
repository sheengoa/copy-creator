use rusqlite::params;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "linux")]
use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[cfg(target_os = "linux")]
use gtk::{
    gdk,
    glib::Propagation,
    prelude::{DeviceExt, DragContextExtManual, FileExt, SeatExt, WidgetExt, WidgetExtManual},
};

#[cfg(target_os = "linux")]
const LINUX_DRAG_THRESHOLD_PX: f64 = 6.0;

#[cfg(target_os = "linux")]
const LINUX_DRAG_CANDIDATE_TTL: Duration = Duration::from_secs(10);

#[cfg(target_os = "linux")]
#[derive(Default)]
struct LinuxPointerState {
    pressed_button: Option<u32>,
    press_root_x: f64,
    press_root_y: f64,
    native_press_seen: bool,
    last_event: Option<gdk::Event>,
}

#[cfg(target_os = "linux")]
thread_local! {
    static LINUX_POINTER_STATE: RefCell<LinuxPointerState> =
        RefCell::new(LinuxPointerState::default());
}

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

fn requested_drag_path(
    app: &AppHandle,
    source: RadialDragSource,
    id: &str,
    path: Option<String>,
) -> Result<PathBuf, String> {
    let path = match path.filter(|path| !path.trim().is_empty()) {
        Some(path) => path_from_hint(app, path)?,
        None => resolve_drag_paths(app, source, id)?
            .into_iter()
            .next()
            .ok_or_else(|| "没有可拖拽的文件".to_string())?,
    };
    canonical_file_path(path)
}

fn finish_radial_drag(
    app: &AppHandle,
    result: drag::DragResult,
    cursor_position: drag::CursorPosition,
    session_id: u64,
) {
    log::info!(
        "[radial_drag] result={result:?}, session={session_id}, cursor=({}, {})",
        cursor_position.x,
        cursor_position.y
    );
    if let Some(radial) = app.get_webview_window("radial-menu") {
        let _ = radial.hide();
    }
    let _ = app.emit("radial-drag-finished", RadialDragEvent { session_id });
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
struct LinuxDragCandidate {
    path: PathBuf,
    item_id: String,
    token: LinuxDragToken,
    armed_at: Instant,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LinuxDragToken {
    session_id: u64,
    generation: u64,
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct LinuxDragState {
    next_generation: u64,
    current: Option<LinuxDragToken>,
    candidate: Option<LinuxDragCandidate>,
    dragging: bool,
}

#[derive(Clone, Debug, Serialize)]
struct RadialDragEvent {
    session_id: u64,
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
fn begin_linux_drag_session(session_id: u64) -> Result<LinuxDragToken, String> {
    let state = linux_drag_state();
    let mut state = state.lock().map_err(|error| error.to_string())?;

    if state.dragging {
        return Err("文件拖动已在进行中".to_string());
    }

    state.next_generation = state.next_generation.wrapping_add(1);
    let token = LinuxDragToken {
        session_id,
        generation: state.next_generation,
    };
    state.current = Some(token);
    state.candidate = None;
    Ok(token)
}

#[cfg(target_os = "linux")]
fn arm_linux_drag(path: PathBuf, item_id: String, token: LinuxDragToken) -> Result<(), String> {
    let state = linux_drag_state();
    let mut state = state.lock().map_err(|error| error.to_string())?;

    if state.dragging {
        return Err("文件拖动已在进行中".to_string());
    }
    if state.current != Some(token) {
        return Err("文件拖动会话已取消".to_string());
    }

    state.candidate = Some(LinuxDragCandidate {
        path,
        item_id,
        token,
        armed_at: Instant::now(),
    });
    Ok(())
}

#[cfg(target_os = "linux")]
fn claim_linux_drag() -> Option<LinuxDragCandidate> {
    let state = linux_drag_state();
    let Ok(mut state) = state.lock() else {
        return None;
    };
    if state.dragging {
        return None;
    }
    if state
        .candidate
        .as_ref()
        .is_some_and(|candidate| candidate.armed_at.elapsed() > LINUX_DRAG_CANDIDATE_TTL)
    {
        state.current = None;
        state.candidate = None;
        return None;
    }
    let candidate = state.candidate.clone()?;
    if state.current != Some(candidate.token) {
        state.candidate = None;
        return None;
    }
    state.dragging = true;
    Some(candidate)
}

#[cfg(target_os = "linux")]
fn abort_linux_drag(token: LinuxDragToken) {
    let state = linux_drag_state();
    let Ok(mut state) = state.lock() else {
        return;
    };
    if state.current == Some(token) {
        state.dragging = false;
        state.candidate = None;
        state.current = None;
    }
}

#[cfg(target_os = "linux")]
fn cancel_linux_drag(session_id: u64) -> bool {
    let state = linux_drag_state();
    let Ok(mut state) = state.lock() else {
        return false;
    };
    if state.current.map(|token| token.session_id) != Some(session_id) {
        return false;
    }
    if state.dragging {
        // 返回 true 表示 GTK 已经认领了会话，不能清理原生拖动状态。
        return true;
    }
    state.current = None;
    state.candidate = None;
    false
}

#[cfg(target_os = "linux")]
fn clear_unclaimed_linux_drag() {
    let state = linux_drag_state();
    let Ok(mut state) = state.lock() else {
        return;
    };
    if !state.dragging {
        state.current = None;
        state.candidate = None;
    }
}

#[cfg(target_os = "linux")]
fn active_linux_drag() -> Option<LinuxDragCandidate> {
    let state = linux_drag_state();
    state
        .lock()
        .ok()
        .and_then(|state| state.dragging.then(|| state.candidate.clone()).flatten())
}

#[cfg(target_os = "linux")]
fn finish_linux_drag() -> Option<LinuxDragCandidate> {
    let state = linux_drag_state();
    let Ok(mut state) = state.lock() else {
        return None;
    };
    if !state.dragging {
        return None;
    }
    state.dragging = false;
    state.current = None;
    let candidate = state.candidate.take();
    LINUX_POINTER_STATE.with(|pointer| {
        *pointer.borrow_mut() = LinuxPointerState::default();
    });
    candidate
}

#[cfg(target_os = "linux")]
fn cursor_position(window: &gtk::ApplicationWindow) -> drag::CursorPosition {
    let Some((x, y)) = pointer_root_position(window) else {
        log::warn!("[radial_drag] 获取拖动结束位置失败，使用默认位置");
        return drag::CursorPosition { x: 0, y: 0 };
    };
    drag::CursorPosition {
        x: x.round() as i32,
        y: y.round() as i32,
    }
}

#[cfg(target_os = "linux")]
fn pointer_root_position(window: &gtk::ApplicationWindow) -> Option<(f64, f64)> {
    let pointer = window
        .display()
        .default_seat()
        .and_then(|seat| seat.pointer())?;
    let (_, x, y) = pointer.position_double();
    Some((x, y))
}

#[cfg(target_os = "linux")]
fn event_root_position(event: &gdk::Event) -> Option<(f64, f64)> {
    if let Some(event) = event.downcast_ref::<gdk::EventButton>() {
        return Some(event.root());
    }
    event
        .downcast_ref::<gdk::EventMotion>()
        .map(|event| event.root())
}

#[cfg(target_os = "linux")]
fn pointer_snapshot() -> Option<(f64, f64, Option<gdk::Event>)> {
    LINUX_POINTER_STATE.with(|pointer| {
        let pointer = pointer.borrow();
        if pointer.pressed_button != Some(1) {
            return None;
        }
        Some((
            pointer.press_root_x,
            pointer.press_root_y,
            pointer.last_event.clone(),
        ))
    })
}

#[cfg(target_os = "linux")]
fn seed_linux_pointer_press(
    window: &gtk::ApplicationWindow,
    screen_x: Option<f64>,
    screen_y: Option<f64>,
    device_pixel_ratio: Option<f64>,
) {
    let (Some(screen_x), Some(screen_y)) = (screen_x, screen_y) else {
        return;
    };
    if !screen_x.is_finite() || !screen_y.is_finite() {
        return;
    }
    let scale = device_pixel_ratio
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .unwrap_or_else(|| window.scale_factor().max(1) as f64);
    let root_x = screen_x * scale;
    let root_y = screen_y * scale;
    if !root_x.is_finite() || !root_y.is_finite() {
        return;
    }

    LINUX_POINTER_STATE.with(|pointer| {
        let mut pointer = pointer.borrow_mut();
        // 原生 ButtonPress 的根坐标带有 GTK 的真实坐标系，优先保留它。
        // 如果 WebKit 子窗口吞掉了按下事件，则用前端 screenX/screenY 补齐起点。
        if pointer.pressed_button != Some(1) || !pointer.native_press_seen {
            pointer.pressed_button = Some(1);
            pointer.press_root_x = root_x;
            pointer.press_root_y = root_y;
        }
    });
}

#[cfg(target_os = "linux")]
fn record_linux_pointer_event(event: &gdk::Event) {
    match event.event_type() {
        gdk::EventType::ButtonPress
        | gdk::EventType::DoubleButtonPress
        | gdk::EventType::TripleButtonPress => {
            let Some(button_event) = event.downcast_ref::<gdk::EventButton>() else {
                return;
            };
            if button_event.button() != 1 {
                return;
            }
            let (root_x, root_y) = button_event.root();
            LINUX_POINTER_STATE.with(|pointer| {
                let mut pointer = pointer.borrow_mut();
                pointer.pressed_button = Some(1);
                pointer.press_root_x = root_x;
                pointer.press_root_y = root_y;
                pointer.native_press_seen = true;
                pointer.last_event = Some(event.clone());
            });
        }
        gdk::EventType::MotionNotify => {
            let Some(motion_event) = event.downcast_ref::<gdk::EventMotion>() else {
                return;
            };
            let button_down = motion_event
                .state()
                .contains(gdk::ModifierType::BUTTON1_MASK);
            let (root_x, root_y) = motion_event.root();
            LINUX_POINTER_STATE.with(|pointer| {
                let mut pointer = pointer.borrow_mut();
                if pointer.pressed_button.is_none() && button_down {
                    pointer.pressed_button = Some(1);
                    pointer.press_root_x = root_x;
                    pointer.press_root_y = root_y;
                    pointer.native_press_seen = false;
                }
                if pointer.pressed_button == Some(1) {
                    pointer.last_event = Some(event.clone());
                }
            });
        }
        gdk::EventType::ButtonRelease => {
            let Some(button_event) = event.downcast_ref::<gdk::EventButton>() else {
                return;
            };
            if button_event.button() != 1 {
                return;
            }
            LINUX_POINTER_STATE.with(|pointer| {
                *pointer.borrow_mut() = LinuxPointerState::default();
            });
            clear_unclaimed_linux_drag();
        }
        _ => {}
    }
}

#[cfg(target_os = "linux")]
fn try_start_linux_drag(
    window: &gtk::ApplicationWindow,
    event: Option<&gdk::Event>,
) -> Result<bool, (u64, String)> {
    let Some((start_x, start_y, saved_event)) = pointer_snapshot() else {
        return Ok(false);
    };
    let (current_x, current_y) = event
        .and_then(event_root_position)
        .or_else(|| saved_event.as_ref().and_then(event_root_position))
        .or_else(|| pointer_root_position(window))
        .unwrap_or((start_x, start_y));
    if (current_x - start_x).hypot(current_y - start_y) < LINUX_DRAG_THRESHOLD_PX {
        return Ok(false);
    }

    let Some(candidate) = claim_linux_drag() else {
        return Ok(false);
    };
    let target_list = gtk::TargetList::new(&[]);
    target_list.add_uri_targets(0);
    let drag_event = event.or(saved_event.as_ref());
    log::debug!(
        "[radial_drag] start native drag session={} item={} event={:?} time={}",
        candidate.token.session_id,
        candidate.item_id,
        drag_event.map(gdk::Event::event_type),
        drag_event.map(gdk::Event::time).unwrap_or_default()
    );
    if window
        .drag_begin_with_coordinates(&target_list, gdk::DragAction::COPY, 1, drag_event, -1, -1)
        .is_none()
    {
        abort_linux_drag(candidate.token);
        return Err((
            candidate.token.session_id,
            "启动 Linux 文件拖动失败".to_string(),
        ));
    }
    Ok(true)
}

#[cfg(target_os = "linux")]
fn install_linux_drag_source(
    app: &AppHandle,
    window: &gtk::ApplicationWindow,
) -> Result<(), String> {
    if LINUX_DRAG_SOURCE_INSTALLED.load(Ordering::Acquire) {
        return Ok(());
    }

    // 记录窗口实际收到的指针事件。候选可能在 ButtonPress 之后才由 IPC
    // 送达，因此 arm 时也会重新检查当前按键和最近一次 MotionNotify。
    window.add_events(
        gdk::EventMask::BUTTON_PRESS_MASK
            | gdk::EventMask::BUTTON_RELEASE_MASK
            | gdk::EventMask::POINTER_MOTION_MASK,
    );
    let event_app = app.clone();
    window.connect_event_after(move |window, event| {
        record_linux_pointer_event(event);
        if event.event_type() == gdk::EventType::MotionNotify {
            if let Err((session_id, error)) = try_start_linux_drag(window, Some(event)) {
                log::warn!(
                    "[radial_drag] GTK motion drag start failed session={session_id}: {error}"
                );
                finish_radial_drag(
                    &event_app,
                    drag::DragResult::Cancel,
                    cursor_position(window),
                    session_id,
                );
            }
        }
    });

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
        let Some(candidate) = active_linux_drag() else {
            // 没有前端已经认领的文件候选时，禁止空白区域或其他内容误触发拖动。
            context.drag_cancel();
            return;
        };

        log::debug!(
            "[radial_drag] GTK native drag started session={} item={}",
            candidate.token.session_id,
            candidate.item_id
        );
        let _ = begin_app.emit(
            "radial-drag-started",
            RadialDragEvent {
                session_id: candidate.token.session_id,
            },
        );
        let app_for_hide = begin_app.clone();
        gtk::glib::idle_add_once(move || {
            if let Some(radial) = app_for_hide.get_webview_window("radial-menu") {
                let _ = radial.hide();
            }
        });
    });

    let failed_app = app.clone();
    window.connect_drag_failed(move |window, _, _| {
        if let Some(candidate) = finish_linux_drag() {
            finish_radial_drag(
                &failed_app,
                drag::DragResult::Cancel,
                cursor_position(window),
                candidate.token.session_id,
            );
        }
        Propagation::Stop
    });

    let ended_app = app.clone();
    window.connect_drag_end(move |window, context| {
        let Some(candidate) = finish_linux_drag() else {
            return;
        };
        let result = if context.drag_drop_succeeded() {
            drag::DragResult::Dropped
        } else {
            drag::DragResult::Cancel
        };
        finish_radial_drag(
            &ended_app,
            result,
            cursor_position(window),
            candidate.token.session_id,
        );
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

#[cfg(target_os = "linux")]
fn arm_linux_drag_on_main(
    window: &gtk::ApplicationWindow,
    path: PathBuf,
    item_id: String,
    token: LinuxDragToken,
    screen_x: Option<f64>,
    screen_y: Option<f64>,
    device_pixel_ratio: Option<f64>,
) -> Result<(), String> {
    arm_linux_drag(path, item_id, token)?;
    seed_linux_pointer_press(window, screen_x, screen_y, device_pixel_ratio);
    // 候选到达时可能已经越过阈值，立即用 GTK 保存的最新事件补启动；
    // 否则交给后续 MotionNotify 在原生事件栈内启动。
    if let Err((_, error)) = try_start_linux_drag(window, None) {
        abort_linux_drag(token);
        return Err(error);
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn start_platform_drag(
    window: &WebviewWindow,
    paths: Vec<PathBuf>,
    icon_path: PathBuf,
    app: AppHandle,
    session_id: u64,
) -> Result<(), String> {
    let callback_app = app.clone();
    let callback = move |result: drag::DragResult, cursor_position: drag::CursorPosition| {
        finish_radial_drag(&callback_app, result, cursor_position, session_id);
    };

    let item = drag::DragItem::Files(paths);
    let image = drag::Image::File(icon_path);
    drag::start_drag(window, item, image, callback, drag::Options::default())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn arm_radial_file_drag(
    app: AppHandle,
    window: WebviewWindow,
    source: RadialDragSource,
    id: String,
    path: Option<String>,
    session_id: u64,
    screen_x: Option<f64>,
    screen_y: Option<f64>,
    device_pixel_ratio: Option<f64>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let token = begin_linux_drag_session(session_id)?;
        let path = match requested_drag_path(&app, source, &id, path) {
            Ok(path) => path,
            Err(error) => {
                abort_linux_drag(token);
                return Err(error);
            }
        };
        let item_id = id;
        let window_label = window.label().to_string();
        let app_for_main = app.clone();
        let (result_sender, result_receiver) = tokio::sync::oneshot::channel();

        log::debug!(
            "[radial_drag] queue GTK drag arm session={} generation={} item={}",
            token.session_id,
            token.generation,
            item_id
        );
        app.run_on_main_thread(move || {
            let result = app_for_main
                .get_webview_window(&window_label)
                .ok_or_else(|| "径向菜单窗口不存在".to_string())
                .and_then(|window| {
                    let gtk_window = window
                        .gtk_window()
                        .map_err(|error| format!("获取 GTK 窗口失败: {error}"))?;
                    arm_linux_drag_on_main(
                        &gtk_window,
                        path,
                        item_id,
                        token,
                        screen_x,
                        screen_y,
                        device_pixel_ratio,
                    )
                });
            if let Err(error) = &result {
                log::warn!(
                    "[radial_drag] GTK main-thread drag arm failed session={} generation={}: {}",
                    token.session_id,
                    token.generation,
                    error
                );
                abort_linux_drag(token);
            } else {
                log::debug!(
                    "[radial_drag] GTK main-thread drag arm returned session={} generation={}",
                    token.session_id,
                    token.generation
                );
            }
            let _ = result_sender.send(result);
        })
        .map_err(|error| {
            abort_linux_drag(token);
            format!("提交 GTK 主线程拖动失败: {error}")
        })?;

        result_receiver.await.map_err(|_| {
            abort_linux_drag(token);
            "GTK 主线程拖动启动结果丢失".to_string()
        })?
    }

    #[cfg(not(target_os = "linux"))]
    {
        // Windows/macOS 仍在越过前端阈值后通过 start_radial_file_drag 启动。
        let _ = (
            app,
            window,
            source,
            id,
            path,
            session_id,
            screen_x,
            screen_y,
            device_pixel_ratio,
        );
        Ok(())
    }
}

#[tauri::command]
pub async fn cancel_radial_file_drag(app: AppHandle, session_id: u64) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        cancel_linux_drag(session_id);
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, session_id);
        Ok(())
    }
}

#[tauri::command]
pub async fn start_radial_file_drag(
    app: AppHandle,
    window: WebviewWindow,
    source: RadialDragSource,
    id: String,
    path: Option<String>,
    session_id: u64,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        // Linux 的启动点是 GTK 的 MotionNotify；保留该命令作为旧前端
        // 兼容入口，但不再从异步 IPC 中调用 gtk_drag_begin。
        let _ = (app, window, source, id, path, session_id);
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    {
        let paths = vec![requested_drag_path(&app, source, &id, path)?];
        let icon_path = paths
            .first()
            .cloned()
            .ok_or_else(|| "没有可拖拽的文件".to_string())?;
        start_platform_drag(&window, paths, icon_path, app, session_id)
    }
}
