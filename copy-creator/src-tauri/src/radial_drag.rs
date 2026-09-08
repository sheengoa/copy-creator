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
    glib::{translate::ToGlibPtr, Propagation},
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
    /// 资源分组整组拖出：id 为分组的多级路径，拖动其目录下全部文件。
    #[serde(rename = "group")]
    ResourceGroup,
}

fn canonical_file_path(path: PathBuf) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(&path)
        .map_err(|error| format!("拖拽文件不存在: {} ({error})", path.display()))?;
    if !path.is_file() {
        return Err(format!("拖拽目标不是文件: {}", path.display()));
    }
    Ok(path)
}

fn stored_file_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    crate::db::resolve_storage_path(app, path)
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
        return Ok(vec![canonical_file_path(stored_file_path(app, path)?)?]);
    }

    match record_type.as_str() {
        "image" => Ok(vec![canonical_file_path(stored_file_path(app, &content)?)?]),
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

    Ok(vec![canonical_file_path(stored_file_path(app, &content)?)?])
}

fn resolve_drag_paths(
    app: &AppHandle,
    source: RadialDragSource,
    id: &str,
) -> Result<Vec<PathBuf>, String> {
    match source {
        RadialDragSource::Clipboard => clipboard_drag_paths(app, id),
        RadialDragSource::Phrase => phrase_drag_paths(app, id),
        RadialDragSource::ResourceGroup => resource_group_drag_paths(app, id),
    }
}

/// 收集资源分组目录下全部文件（递归，跳过点开头的隐藏目录与临时文件），
/// 作为整组拖出 / 整组粘贴的数据源。
fn resource_group_drag_paths(app: &AppHandle, folder: &str) -> Result<Vec<PathBuf>, String> {
    let folder = crate::db::normalize_resource_folder_path(Some(folder))?;
    let mut directory = crate::db::get_resource_library_dir(app);
    for segment in folder.split('/').filter(|segment| !segment.is_empty()) {
        directory.push(segment);
    }
    if !directory.is_dir() {
        return Err("资源分组不存在".to_string());
    }

    let paths = collect_group_files(&directory);
    if paths.is_empty() {
        return Err("分组内没有可拖拽的文件".to_string());
    }
    Ok(paths)
}

fn collect_group_files(directory: &std::path::Path) -> Vec<PathBuf> {
    fn collect(directory: &std::path::Path, paths: &mut Vec<PathBuf>) {
        let Ok(children) = std::fs::read_dir(directory) else {
            return;
        };
        let mut children = children.flatten().collect::<Vec<_>>();
        children.sort_by_key(|entry| entry.file_name());
        for entry in children {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                collect(&path, paths);
            } else if path.is_file() {
                paths.push(path);
            }
        }
    }

    let mut paths = Vec::new();
    collect(directory, &mut paths);
    paths
}

fn path_from_hint(app: &AppHandle, path: String) -> Result<PathBuf, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("拖拽文件路径为空".to_string());
    }
    stored_file_path(app, path)
}

fn requested_drag_paths(
    app: &AppHandle,
    source: RadialDragSource,
    id: &str,
    path: Option<String>,
) -> Result<Vec<PathBuf>, String> {
    let paths = match path.filter(|path| !path.trim().is_empty()) {
        Some(path) => vec![path_from_hint(app, path)?],
        None => resolve_drag_paths(app, source, id)?,
    };
    paths
        .into_iter()
        .map(canonical_file_path)
        .collect::<Result<Vec<_>, String>>()
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
    paths: Vec<PathBuf>,
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
fn arm_linux_drag(paths: Vec<PathBuf>, item_id: String, token: LinuxDragToken) -> Result<(), String> {
    let state = linux_drag_state();
    let mut state = state.lock().map_err(|error| error.to_string())?;

    if state.dragging {
        return Err("文件拖动已在进行中".to_string());
    }
    if state.current != Some(token) {
        return Err("文件拖动会话已取消".to_string());
    }

    state.candidate = Some(LinuxDragCandidate {
        paths,
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
fn pointer_button_is_down(window: &gtk::ApplicationWindow) -> bool {
    let Some(pointer) = window
        .display()
        .default_seat()
        .and_then(|seat| seat.pointer())
    else {
        return false;
    };
    let Some(gdk_window) = window.window() else {
        return false;
    };

    let mut mask = 0_u32;
    unsafe {
        gdk::ffi::gdk_device_get_state(
            pointer.to_glib_none().0,
            gdk_window.to_glib_none().0,
            std::ptr::null_mut(),
            std::ptr::addr_of_mut!(mask),
        );
    }
    gdk::ModifierType::from_bits_truncate(mask).contains(gdk::ModifierType::BUTTON1_MASK)
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
) -> bool {
    if !pointer_button_is_down(window) {
        return false;
    }

    let (Some(screen_x), Some(screen_y)) = (screen_x, screen_y) else {
        return true;
    };
    if !screen_x.is_finite() || !screen_y.is_finite() {
        return true;
    }
    let scale = device_pixel_ratio
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .unwrap_or_else(|| window.scale_factor().max(1) as f64);
    let root_x = screen_x * scale;
    let root_y = screen_y * scale;
    if !root_x.is_finite() || !root_y.is_finite() {
        return true;
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
    true
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
            if !button_down {
                LINUX_POINTER_STATE.with(|pointer| {
                    *pointer.borrow_mut() = LinuxPointerState::default();
                });
                clear_unclaimed_linux_drag();
                return;
            }
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
    if !pointer_button_is_down(window) {
        LINUX_POINTER_STATE.with(|pointer| {
            *pointer.borrow_mut() = LinuxPointerState::default();
        });
        clear_unclaimed_linux_drag();
        return Ok(false);
    }

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
        let paths = data_state.lock().ok().and_then(|state| {
            state
                .candidate
                .as_ref()
                .map(|candidate| candidate.paths.clone())
        });
        let Some(paths) = paths else {
            log::warn!("[radial_drag] 拖动数据请求时缺少候选文件");
            return;
        };
        // 逐个校验仍存在的文件；全部失效才放弃本次拖动。
        let mut uris = Vec::with_capacity(paths.len());
        for path in &paths {
            let Ok(path) = canonical_file_path(path.clone()) else {
                log::warn!("[radial_drag] 拖动数据请求时文件已不可用: {}", path.display());
                continue;
            };
            let uri = gtk::gio::File::for_path(&path).uri().to_string();
            uris.push(uri);
        }
        if uris.is_empty() {
            log::warn!("[radial_drag] 拖动数据请求时文件已不可用");
            return;
        }
        let uri_refs = uris.iter().map(|uri| uri.as_str()).collect::<Vec<_>>();
        let target = data.target().name();
        let set_uris_result = data.set_uris(&uri_refs);
        log::debug!(
            "[radial_drag] drag_data_get target={} uris={} set_uris={}",
            target,
            uris.len(),
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
    paths: Vec<PathBuf>,
    item_id: String,
    token: LinuxDragToken,
    screen_x: Option<f64>,
    screen_y: Option<f64>,
    device_pixel_ratio: Option<f64>,
) -> Result<(), String> {
    arm_linux_drag(paths, item_id, token)?;
    if !seed_linux_pointer_press(window, screen_x, screen_y, device_pixel_ratio) {
        abort_linux_drag(token);
        return Err("鼠标左键已释放".to_string());
    }
    // 候选到达时可能已经越过阈值，立即用 GTK 保存的最新事件补启动；
    // 否则交给后续 MotionNotify 在原生事件栈内启动。
    if let Err((_, error)) = try_start_linux_drag(window, None) {
        abort_linux_drag(token);
        return Err(error);
    }
    Ok(())
}

/// 拖动虚影位图：缩放后的 32bpp BGRA 像素（Windows 专用）。
#[cfg(target_os = "windows")]
pub(crate) struct DragImage {
    width: i32,
    height: i32,
    bgra: Vec<u8>,
}

/// 生成拖动虚影位图：原图等比缩放到 128×128 以内。直接把原图当拖动
/// 图像时，虚影按原始像素渲染，截图类内容会大到夸张（实测踩坑）。
/// 非图片文件（zip 等）解码失败返回 None，拖动时表现为无虚影。
#[cfg(target_os = "windows")]
fn make_drag_image(source: &std::path::Path) -> Option<DragImage> {
    const MAX_DIM: u32 = 128;
    let img = image::open(source).ok()?;
    let resized = if img.width() <= MAX_DIM && img.height() <= MAX_DIM {
        img
    } else {
        img.resize(MAX_DIM, MAX_DIM, image::imageops::FilterType::Triangle)
    };
    let (width, height) = (resized.width() as i32, resized.height() as i32);
    let mut bgra = resized.to_rgba8().into_raw();
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2); // RGBA → BGRA（Win32 32bpp 位图字节序）
    }
    Some(DragImage { width, height, bgra })
}

#[cfg(not(target_os = "linux"))]
fn start_platform_drag(
    window: &WebviewWindow,
    paths: Vec<PathBuf>,
    drag_image: Option<DragImage>,
    app: AppHandle,
    session_id: u64,
) -> Result<(), String> {
    log::info!(
        "[radial_drag] start_platform_drag session={session_id} paths={}",
        paths.len()
    );

    #[cfg(target_os = "windows")]
    {
        start_windows_drag(window, paths, drag_image, app, session_id)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = drag_image;
        let callback_app = app.clone();
        let callback = move |result: drag::DragResult, cursor_position: drag::CursorPosition| {
            finish_radial_drag(&callback_app, result, cursor_position, session_id);
        };

        let image = drag::Image::File(paths.first().cloned().ok_or("没有可拖拽的文件")?);
        let item = drag::DragItem::Files(paths);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            drag::start_drag(window, item, image, callback, drag::Options::default())
        }));
        match result {
            Ok(Ok(())) => {
                log::info!("[radial_drag] start_drag returned (drag finished) session={session_id}");
                Ok(())
            }
            Ok(Err(error)) => {
                log::error!("[radial_drag] start_drag failed session={session_id}: {error}");
                Err(error.to_string())
            }
            Err(panic) => {
                let msg = panic
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".to_string());
                log::error!("[radial_drag] start_drag panicked session={session_id}: {msg}");
                Err(format!("拖动启动崩溃: {msg}"))
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod windows_drag {
    //! Windows 原生文件拖出的私有实现。
    //!
    //! 关键约束（实测踩坑 + 上游 issue crabnebula-dev/drag-rs#94）：
    //! DoDragDrop 的模态循环依赖调用线程持续收到鼠标消息。若从后台线程
    //! （如 tokio 工作线程）调用，OLE 无法把左键按下时的隐式鼠标捕获
    //! 转移到拖动循环，循环收不到任何鼠标输入——释放按键也无人观察，
    //! QueryContinueDrag 零调用，拖动永久挂死。因此必须在收到左键按下
    //! 的 UI 主线程上执行（tauri-plugin-drag 上游同样用 run_on_main_thread）。
    //!
    //! 兜底：主线程被挂死的拖动循环占住 = 整个应用冻结。看门狗线程监控
    //! "捕获被 CLIPBRDWNDCLASS 持有且无任何鼠标键按下"这一僵死特征
    //! （issue #94 作者实测有效），向捕获窗口注入 ESC 强制走
    //! QueryContinueDrag 的取消分支，拖动以 Cancel 收场，应用自动恢复。
    use super::finish_radial_drag;
    use super::DragImage;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager, WebviewWindow};

    type Handle = *mut core::ffi::c_void;

    const WM_KEYDOWN: u32 = 0x0100;
    const WM_KEYUP: u32 = 0x0101;
    const VK_ESCAPE: usize = 0x1B;
    const VK_LBUTTON: i32 = 0x01;
    const VK_RBUTTON: i32 = 0x02;
    /// 捕获无键按下持续超过该时长即判定拖动循环僵死（过短会误杀
    /// "松开后目标进程正在处理 IDropTarget::Drop"的正常慢场景）。
    const WEDGE_GRACE: Duration = Duration::from_secs(5);

    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct GuiThreadInfo {
        cb_size: u32,
        flags: u32,
        hwnd_active: Handle,
        hwnd_capture: Handle,
        hwnd_menu_owner: Handle,
        hwnd_move_size: Handle,
        hwnd_caret: Handle,
        rc_caret: Rect,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetWindowThreadProcessId(hwnd: Handle, out_pid: *mut u32) -> u32;
        fn GetGUIThreadInfo(thread_id: u32, info: *mut GuiThreadInfo) -> i32;
        fn GetClassNameW(hwnd: Handle, buf: *mut u16, max_count: i32) -> i32;
        fn GetAsyncKeyState(v_key: i32) -> i16;
        fn PostMessageW(hwnd: Handle, msg: u32, w_param: usize, l_param: isize) -> i32;
    }

    fn mouse_button_down() -> bool {
        unsafe {
            (GetAsyncKeyState(VK_LBUTTON) as u16 & 0x8000) != 0
                || (GetAsyncKeyState(VK_RBUTTON) as u16 & 0x8000) != 0
        }
    }

    fn window_class_is(hwnd: Handle, expect: &[u16]) -> bool {
        let mut buf = [0_u16; 32];
        let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        n > 0 && buf[..n as usize] == *expect
    }

    /// OLE 拖动循环使用的窗口类名（宽字符，不含结尾 0）。
    const CLIPBRDWNDCLASS: &[u16] = &[
        b'C' as u16, b'L' as u16, b'I' as u16, b'P' as u16, b'B' as u16, b'R' as u16,
        b'D' as u16, b'W' as u16, b'N' as u16, b'D' as u16, b'C' as u16, b'L' as u16,
        b'A' as u16, b'S' as u16, b'S' as u16,
    ];

    /// 监控主线程拖动循环僵死；发现即注入 ESC 取消拖动并结束自身。
    /// 窗口句柄以整数传递（裸指针不能跨线程）。
    fn spawn_wedge_watchdog(main_hwnd: isize, stop: Arc<AtomicBool>) {
        std::thread::Builder::new()
            .name("radial-drag-watchdog".into())
            .spawn(move || {
                let main_hwnd = main_hwnd as Handle;
                let mut pid = 0_u32;
                let thread_id = unsafe { GetWindowThreadProcessId(main_hwnd, &mut pid) };
                let start = Instant::now();
                while !stop.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(500));
                    if start.elapsed() < WEDGE_GRACE {
                        continue;
                    }
                    if mouse_button_down() {
                        continue;
                    }
                    unsafe {
                        let mut info: GuiThreadInfo = core::mem::zeroed();
                        info.cb_size = core::mem::size_of::<GuiThreadInfo>() as u32;
                        if GetGUIThreadInfo(thread_id, &mut info) == 0
                            || info.hwnd_capture.is_null()
                            || !window_class_is(info.hwnd_capture, CLIPBRDWNDCLASS)
                        {
                            continue;
                        }
                        // 僵死特征齐备：OLE 拖动窗口仍持有捕获，却没有任何
                        // 鼠标键按下——循环永远等不到释放。注入 ESC 走取消分支。
                        log::warn!(
                            "[radial_drag] 检测到拖动循环僵死，注入 ESC 恢复 (session 主线程 thread={thread_id})"
                        );
                        PostMessageW(info.hwnd_capture, WM_KEYDOWN, VK_ESCAPE, 0);
                        PostMessageW(info.hwnd_capture, WM_KEYUP, VK_ESCAPE, 0);
                    }
                    return;
                }
            })
            .ok();
    }

    pub fn start_drag(
        window: &WebviewWindow,
        paths: Vec<PathBuf>,
        drag_image: Option<DragImage>,
        app: AppHandle,
        session_id: u64,
    ) -> Result<(), String> {
        let main_app = app.clone();
        let drag_window = window.clone();
        app.run_on_main_thread(move || {
            // 先隐藏径向窗口：给出"拖动开始"的视觉反馈，同时释放 WebView2
            // 的隐式鼠标捕获。DoDragDrop 随后在主线程上接管输入。
            if let Some(radial) = main_app.get_webview_window("radial-menu") {
                let _ = radial.hide();
            }

            let Ok(hwnd) = drag_window.hwnd() else {
                log::warn!("[radial_drag] 获取窗口句柄失败，看门狗降级为不启用");
                return;
            };
            let main_hwnd = hwnd.0 as isize;
            let stop_watchdog = Arc::new(AtomicBool::new(false));
            let watchdog_stop = stop_watchdog.clone();
            spawn_wedge_watchdog(main_hwnd, watchdog_stop);

            // DoDragDrop 同步阻塞主线程直到拖动结束（内部自泵消息）。
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                ole_drag::drag_files(&paths, drag_image.as_ref())
            }));
            stop_watchdog.store(true, Ordering::Release);
            match result {
                Ok(Ok((dropped, x, y))) => {
                    log::info!(
                        "[radial_drag] ole drag finished session={session_id} dropped={dropped} cursor=({x},{y})"
                    );
                    let result = if dropped {
                        drag::DragResult::Dropped
                    } else {
                        drag::DragResult::Cancel
                    };
                    finish_radial_drag(
                        &main_app,
                        result,
                        drag::CursorPosition { x, y },
                        session_id,
                    );
                }
                Ok(Err(error)) => {
                    log::error!("[radial_drag] ole drag failed session={session_id}: {error}");
                    finish_radial_drag(
                        &main_app,
                        drag::DragResult::Cancel,
                        drag::CursorPosition { x: 0, y: 0 },
                        session_id,
                    );
                }
                Err(panic) => {
                    let msg = panic
                        .downcast_ref::<&str>()
                        .map(|s| s.to_string())
                        .or_else(|| panic.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "unknown panic".to_string());
                    log::error!("[radial_drag] start_drag panicked session={session_id}: {msg}");
                    finish_radial_drag(
                        &main_app,
                        drag::DragResult::Cancel,
                        drag::CursorPosition { x: 0, y: 0 },
                        session_id,
                    );
                }
            }
        })
        .map_err(|error| format!("提交主线程拖动失败: {error}"))?;
        Ok(())
    }

    /// 自研 OLE 文件拖出。不使用 drag crate：其 DataObject 包装层的
    /// EnumFormatEtc 返回 E_NOTIMPL，Chromium 系浏览器靠枚举格式判断
    /// 拖动内容，枚举失败即判定为空拖动——文件永远"拖不进"网页上传区
    /// （资源管理器直接查 CF_HDROP 所以不受影响）。shell 原生数据对象
    /// 自带完整格式枚举，浏览器/编辑器/终端全部兼容。
    pub(crate) mod ole_drag {
        use super::super::DragImage;
        use std::os::windows::ffi::OsStrExt;
        use std::path::PathBuf;

        use windows::core::{implement, HRESULT, PCWSTR};
        use windows::Win32::Foundation::{
            BOOL, COLORREF, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS,
            POINT, SIZE,
        };
        use windows::Win32::Graphics::Gdi::CreateBitmap;
        use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance, IDataObject};
        use windows::Win32::System::Ole::{
            DoDragDrop, DROPEFFECT, DROPEFFECT_COPY, IDropSource, IDropSource_Impl,
            OleInitialize,
        };
        use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
        use windows::Win32::UI::Shell::{
            BHID_DataObject, CLSID_DragDropHelper, IDragSourceHelper, IShellItemArray,
            ILCreateFromPathW, ILFree, SHCreateShellItemArrayFromIDLists, SHDRAGIMAGE,
        };
        use windows::Win32::UI::Shell::Common::ITEMIDLIST;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

        #[implement(IDropSource)]
        struct OleDropSource;

        #[allow(non_snake_case)]
        impl IDropSource_Impl for OleDropSource {
            fn QueryContinueDrag(
                &self,
                f_escape_pressed: BOOL,
                grf_key_state: MODIFIERKEYS_FLAGS,
            ) -> HRESULT {
                if f_escape_pressed.as_bool() {
                    DRAGDROP_S_CANCEL
                } else if (grf_key_state & MK_LBUTTON) == MODIFIERKEYS_FLAGS(0) {
                    // 左键松开 → 落放。
                    DRAGDROP_S_DROP
                } else {
                    HRESULT(0)
                }
            }

            fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
                DRAGDROP_S_USEDEFAULTCURSORS
            }
        }

        /// 同步执行一次 OLE 文件拖出，返回 (是否落放, 光标 X, 光标 Y)。
        /// 必须在 UI 主线程（STA）上调用。
        pub(super) fn drag_files(
            paths: &[PathBuf],
            image: Option<&DragImage>,
        ) -> Result<(bool, i32, i32), String> {
            unsafe {
                if let Err(e) = OleInitialize(Some(std::ptr::null_mut())) {
                    return Err(format!("OLE 初始化失败: {e}"));
                }

                // ILCreateFromPathW 无法解析 `\\?\` 扩展路径前缀（canonicalize
                // 的产物，实测必失败），先统一转回常规路径。
                let paths: Vec<PathBuf> = paths
                    .iter()
                    .map(|path| {
                        let raw = path.to_string_lossy();
                        if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
                            std::path::PathBuf::from(format!(r"\\{rest}"))
                        } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
                            std::path::PathBuf::from(rest)
                        } else {
                            path.clone()
                        }
                    })
                    .collect();

                // shell 数据对象：自带 CF_HDROP / FileGroupDescriptor 等
                // 完整格式枚举，是浏览器上传兼容性的关键。
                let mut pidls: Vec<*mut ITEMIDLIST> = Vec::with_capacity(paths.len());
                for path in &paths {
                    let wide: Vec<u16> =
                        path.as_os_str().encode_wide().chain(Some(0)).collect();
                    let pidl = ILCreateFromPathW(PCWSTR::from_raw(wide.as_ptr()));
                    if pidl.is_null() {
                        for done in &pidls {
                            ILFree(Some(*done as *const ITEMIDLIST));
                        }
                        return Err(format!("无法定位文件: {}", path.display()));
                    }
                    pidls.push(pidl);
                }
                let pidl_refs: Vec<*const ITEMIDLIST> =
                    pidls.iter().map(|p| p.cast_const()).collect();
                let array: IShellItemArray = SHCreateShellItemArrayFromIDLists(&pidl_refs)
                    .map_err(|e| format!("创建 shell 项数组失败: {e}"))?;
                let data_object: IDataObject = array
                    .BindToHandler(None, &BHID_DataObject)
                    .map_err(|e| format!("创建拖拽数据对象失败: {e}"))?;

                // 拖动虚影（可选）：缩放后的 32bpp BGRA 位图交给系统渲染。
                if let Some(img) = image {
                    let hbmp = CreateBitmap(
                        img.width,
                        img.height,
                        1,
                        32,
                        Some(img.bgra.as_ptr() as *const core::ffi::c_void),
                    );
                    if !hbmp.is_invalid() {
                        let helper: IDragSourceHelper =
                            CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_ALL)
                                .map_err(|e| format!("创建 DragSourceHelper 失败: {e}"))?;
                        let shdi = SHDRAGIMAGE {
                            sizeDragImage: SIZE {
                                cx: img.width,
                                cy: img.height,
                            },
                            ptOffset: POINT { x: 0, y: 0 },
                            hbmpDragImage: hbmp,
                            crColorKey: COLORREF(0),
                        };
                        let _ = helper.InitializeFromBitmap(&shdi, &data_object);
                    }
                }

                let drop_source: IDropSource = OleDropSource.into();
                let mut effect = DROPEFFECT::default();
                let hr = DoDragDrop(&data_object, &drop_source, DROPEFFECT_COPY, &mut effect);
                for pidl in &pidls {
                    ILFree(Some(*pidl as *const ITEMIDLIST));
                }
                let dropped = hr == DRAGDROP_S_DROP;
                let mut pos = POINT::default();
                if GetCursorPos(&mut pos).is_err() {
                    (pos.x, pos.y) = (0, 0);
                }
                Ok((dropped, pos.x, pos.y))
            }
        }
    }
}

#[cfg(target_os = "windows")]
use windows_drag::start_drag as start_windows_drag;

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
        let paths = match requested_drag_paths(&app, source, &id, path) {
            Ok(paths) => paths,
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
                        paths,
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
        log::info!(
            "[radial_drag] start_radial_file_drag invoked session={session_id} source={source:?} id={id} path={path:?}"
        );
        let paths = requested_drag_paths(&app, source, &id, path)?;
        let icon_path = paths
            .first()
            .cloned()
            .ok_or_else(|| "没有可拖拽的文件".to_string())?;
        // 在异步工作线程上预生成缩略虚影，避免解码大图阻塞 UI 主线程。
        let drag_image = make_drag_image(&icon_path);
        start_platform_drag(&window, paths, drag_image, app, session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::{collect_group_files, make_drag_image_bytes};

    #[test]
    fn group_files_are_collected_recursively_without_hidden_entries() {
        let root = std::env::temp_dir().join(format!(
            "copy-creator-radial-group-test-{}",
            uuid::Uuid::new_v4()
        ));
        let nested = root.join("子目录");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(root.join("b.png"), [1_u8]).unwrap();
        std::fs::write(root.join("a.txt"), [2_u8]).unwrap();
        std::fs::write(nested.join("c.mp4"), [3_u8]).unwrap();
        std::fs::create_dir_all(root.join(".copy-creator/attachments")).unwrap();
        std::fs::write(root.join(".copy-creator/attachments/image-1.png"), [4_u8]).unwrap();
        std::fs::write(root.join(".tmp-upload"), [5_u8]).unwrap();
        std::fs::create_dir_all(root.join("空目录")).unwrap();

        let paths = collect_group_files(&root);
        let names = paths
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["a.txt", "b.png", "c.mp4"]);
        assert!(paths.iter().all(|path| path.starts_with(&root)));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn empty_directories_collect_no_files() {
        let root = std::env::temp_dir().join(format!(
            "copy-creator-radial-group-empty-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        assert!(collect_group_files(&root).is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
