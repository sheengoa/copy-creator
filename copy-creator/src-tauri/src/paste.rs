use std::sync::atomic::{AtomicBool, Ordering};

pub static PASTING: AtomicBool = AtomicBool::new(false);

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

struct CachedImage {
    rgba: Arc<Vec<u8>>,
    width: u32,
    height: u32,
    png_bytes: Arc<Vec<u8>>,
}

struct ImageCache {
    map: HashMap<String, CachedImage>,
    order: Vec<String>,
}

static IMAGE_CACHE: OnceLock<Mutex<ImageCache>> = OnceLock::new();

fn get_image_cache() -> &'static Mutex<ImageCache> {
    IMAGE_CACHE.get_or_init(|| Mutex::new(ImageCache {
        map: HashMap::new(),
        order: Vec::new(),
    }))
}

struct PasteGuard;

impl Drop for PasteGuard {
    fn drop(&mut self) {
        PASTING.store(false, Ordering::SeqCst);
    }
}

pub fn cache_image(path: String, rgba: Vec<u8>, width: u32, height: u32, png_bytes: Vec<u8>) {
    let mut cache = get_image_cache().lock().unwrap();
    // Evict oldest entries (deterministic insertion order)
    if cache.map.len() >= 30 {
        let evict_count = 15.min(cache.order.len());
        let evicted: Vec<String> = cache.order.drain(..evict_count).collect();
        for k in &evicted {
            cache.map.remove(k);
        }
    }
    cache.order.push(path.clone());
    cache.map.insert(path, CachedImage {
        rgba: Arc::new(rgba),
        width,
        height,
        png_bytes: Arc::new(png_bytes),
    });
}

use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use enigo::{Enigo, Keyboard, Key, Direction, Mouse, Settings};
use std::process::Command;
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PasteShortcut {
    CtrlV,
    CtrlShiftV,
}

static LAST_PASTE_TARGET_CLASS: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn paste_target_class_cache() -> &'static Mutex<Option<String>> {
    LAST_PASTE_TARGET_CLASS.get_or_init(|| Mutex::new(None))
}

pub fn remember_paste_target() {
    if let Ok(mut cached) = paste_target_class_cache().lock() {
        *cached = active_window_class();
    }
}

fn remembered_paste_target_class() -> Option<String> {
    paste_target_class_cache()
        .lock()
        .ok()
        .and_then(|c| c.clone())
}

fn paste_shortcut_for_window_class(class_name: Option<&str>) -> PasteShortcut {
    let Some(class_name) = class_name else {
        return PasteShortcut::CtrlV;
    };

    let class_name = class_name.to_lowercase();
    let terminals = [
        "alacritty",
        "blackbox",
        "com.mitchellh.ghostty",
        "foot",
        "gnome-terminal",
        "gnome-terminal-server",
        "io.elementary.terminal",
        "kgx",
        "kitty",
        "konsole",
        "mate-terminal",
        "org.gnome.console",
        "org.gnome.terminal",
        "org.wezfurlong.wezterm",
        "rio",
        "terminal",
        "terminator",
        "tilix",
        "wezterm",
        "xfce4-terminal",
        "xterm",
    ];

    if terminals
        .iter()
        .any(|terminal| class_name.contains(terminal))
    {
        PasteShortcut::CtrlShiftV
    } else {
        PasteShortcut::CtrlV
    }
}

// ── Environment detection ───────────────────────────────────────

/// Whether we are running under a Wayland compositor.
fn is_wayland() -> bool {
    std::env::var("WAYLAND_DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

/// Whether we are running under X11.
fn is_x11() -> bool {
    std::env::var("DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

/// Try to locate an executable in PATH.
fn which(cmd: &str) -> Option<String> {
    Command::new("which")
        .arg(cmd)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn command_stdout(cmd: &str, args: &[&str]) -> Option<String> {
    Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

fn command_stdout_with_env(cmd: &str, args: &[&str], envs: &[(&str, &str)]) -> Option<String> {
    let mut command = Command::new(cmd);
    command.args(args);
    for (key, value) in envs {
        command.env(key, value);
    }
    command
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

fn active_window_class_xdotool() -> Option<String> {
    if which("xdotool").is_none() {
        return None;
    }
    command_stdout("xdotool", &["getactivewindow", "getwindowclassname"])
}

fn parse_xprop_active_window_id(output: &str) -> Option<String> {
    let id = output.split('#').nth(1)?.trim();
    if id.is_empty() || id == "0x0" {
        None
    } else {
        Some(id.to_string())
    }
}

fn parse_xprop_wm_class(output: &str) -> Option<String> {
    let value = output.split('=').nth(1)?.trim();
    let classes = value
        .split(',')
        .map(|part| part.trim().trim_matches('"'))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if classes.is_empty() {
        None
    } else {
        Some(classes.join(" "))
    }
}

fn parse_xprop_pid(output: &str) -> Option<u32> {
    output.split('=').nth(1)?.trim().parse().ok()
}

fn active_window_pid_xprop(window_id: &str) -> Option<u32> {
    let output = command_stdout("xprop", &["-id", window_id, "_NET_WM_PID"])?;
    parse_xprop_pid(&output)
}

fn parse_single_quoted_value(output: &str) -> Option<String> {
    let start = output.find('\'')? + 1;
    let end = output[start..].find('\'')? + start;
    Some(output[start..end].to_string())
}

fn parse_bus_name_for_pid(output: &str, pid: u32) -> Option<String> {
    for line in output.lines().skip(1) {
        let mut parts = line.split_whitespace();
        let name = parts.next()?;
        let line_pid = parts.next()?.parse::<u32>().ok()?;
        if line_pid == pid {
            return Some(name.to_string());
        }
    }
    None
}

fn parse_object_paths(output: &str) -> Vec<String> {
    output
        .split("objectpath '")
        .skip(1)
        .filter_map(|part| part.split('\'').next())
        .filter(|path| !path.ends_with("/null"))
        .map(str::to_string)
        .collect()
}

fn cursor_position() -> Option<(i32, i32)> {
    Enigo::new(&Settings::default()).ok()?.location().ok()
}

fn atspi_bus_address() -> Option<String> {
    if which("gdbus").is_none() {
        return None;
    }
    let output = command_stdout(
        "gdbus",
        &[
            "call",
            "--session",
            "--dest",
            "org.a11y.Bus",
            "--object-path",
            "/org/a11y/bus",
            "--method",
            "org.a11y.Bus.GetAddress",
        ],
    )?;
    parse_single_quoted_value(&output)
}

fn atspi_bus_name_for_pid(address: &str, pid: u32) -> Option<String> {
    if which("busctl").is_none() {
        return None;
    }
    let output = command_stdout_with_env(
        "busctl",
        &["--user", "list"],
        &[("DBUS_SESSION_BUS_ADDRESS", address)],
    )?;
    parse_bus_name_for_pid(&output, pid)
}

fn atspi_call(address: &str, dest: &str, path: &str, method: &str, args: &[String]) -> Option<String> {
    let mut command_args = vec![
        "call".to_string(),
        "--session".to_string(),
        "--dest".to_string(),
        dest.to_string(),
        "--object-path".to_string(),
        path.to_string(),
        "--method".to_string(),
        method.to_string(),
    ];
    command_args.extend(args.iter().cloned());
    let refs = command_args.iter().map(String::as_str).collect::<Vec<_>>();
    command_stdout_with_env("gdbus", &refs, &[("DBUS_SESSION_BUS_ADDRESS", address)])
}

fn atspi_accessible_at_cursor_for_pid(pid: u32) -> Option<String> {
    let address = atspi_bus_address()?;
    let dest = atspi_bus_name_for_pid(&address, pid)?;
    let (x, y) = cursor_position()?;
    let children = atspi_call(
        &address,
        &dest,
        "/org/a11y/atspi/accessible/root",
        "org.a11y.atspi.Accessible.GetChildren",
        &[],
    )?;

    for path in parse_object_paths(&children) {
        let hit = atspi_call(
            &address,
            &dest,
            &path,
            "org.a11y.atspi.Component.GetAccessibleAtPoint",
            &[x.to_string(), y.to_string(), "0".to_string()],
        )?;
        for hit_path in parse_object_paths(&hit) {
            let role = atspi_call(
                &address,
                &dest,
                &hit_path,
                "org.a11y.atspi.Accessible.GetRoleName",
                &[],
            )
            .and_then(|out| parse_single_quoted_value(&out))
            .unwrap_or_default();
            let name = command_stdout_with_env(
                "gdbus",
                &[
                    "call",
                    "--session",
                    "--dest",
                    &dest,
                    "--object-path",
                    &hit_path,
                    "--method",
                    "org.freedesktop.DBus.Properties.Get",
                    "org.a11y.atspi.Accessible",
                    "Name",
                ],
                &[("DBUS_SESSION_BUS_ADDRESS", &address)],
            )
            .and_then(|out| parse_single_quoted_value(&out))
            .unwrap_or_default();
            let descriptor = format!("{} {}", role, name).trim().to_string();
            if !descriptor.is_empty() {
                return Some(descriptor);
            }
        }
    }
    None
}

fn active_window_class_xprop() -> Option<String> {
    if which("xprop").is_none() {
        return None;
    }
    let active = command_stdout("xprop", &["-root", "_NET_ACTIVE_WINDOW"])?;
    let window_id = parse_xprop_active_window_id(&active)?;
    let wm_class = command_stdout("xprop", &["-id", window_id.as_str(), "WM_CLASS"])?;
    let mut class_name = parse_xprop_wm_class(&wm_class)?;
    if class_name.to_lowercase().contains("code") {
        if let Some(pid) = active_window_pid_xprop(&window_id) {
            if let Some(accessible) = atspi_accessible_at_cursor_for_pid(pid) {
                class_name.push(' ');
                class_name.push_str(&accessible);
            }
        }
    }
    Some(class_name)
}

fn active_window_class_hyprctl() -> Option<String> {
    if which("hyprctl").is_none() {
        return None;
    }
    let stdout = command_stdout("hyprctl", &["activewindow", "-j"])?;
    serde_json::from_str::<serde_json::Value>(&stdout)
        .ok()
        .and_then(|json| {
            json.get("class")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .filter(|s| !s.is_empty())
}

fn active_window_class_gnome_shell() -> Option<String> {
    if which("gdbus").is_none() {
        return None;
    }
    let stdout = command_stdout(
        "gdbus",
        &[
            "call",
            "--session",
            "--dest",
            "org.gnome.Shell",
            "--object-path",
            "/org/gnome/Shell",
            "--method",
            "org.gnome.Shell.Eval",
            "global.display.focus_window ? global.display.focus_window.get_wm_class() : ''",
        ],
    )?;

    let start = stdout.find("'\"")? + 1;
    let end = stdout[start..].find("\"'")? + start + 1;
    serde_json::from_str::<String>(&stdout[start..end]).ok()
}

fn active_window_class() -> Option<String> {
    active_window_class_hyprctl()
        .or_else(active_window_class_xprop)
        .or_else(active_window_class_xdotool)
        .or_else(active_window_class_gnome_shell)
}

/// Check whether ydotool daemon is reachable (ydotool needs ydotoold running).
fn ydotool_available() -> bool {
    which("ydotool").is_some()
}

// ── Keystroke simulation ────────────────────────────────────────

/// Inject Ctrl+Shift+V via ydotool (kernel-level uinput — works on all
/// Wayland compositors including GNOME/Mutter).
///
/// Keycodes: 29=LCtrl 42=LShift 47=V
/// :1 = press, :0 = release
fn ydotool_ctrl_shift_v() -> Result<(), String> {
    let status = Command::new("ydotool")
        .args(["key", "29:1", "42:1", "47:1", "47:0", "42:0", "29:0"])
        .status()
        .map_err(|e| format!("ydotool spawn failed: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("ydotool exited with {status}"))
    }
}

/// Inject Ctrl+V via ydotool.
fn ydotool_ctrl_v() -> Result<(), String> {
    let status = Command::new("ydotool")
        .args(["key", "29:1", "47:1", "47:0", "29:0"])
        .status()
        .map_err(|e| format!("ydotool spawn failed: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("ydotool exited with {status}"))
    }
}

/// Inject Ctrl+Shift+V via enigo.
fn enigo_ctrl_shift_v() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("enigo init: {e}"))?;
    enigo.key(Key::Control, Direction::Press)
        .map_err(|e| format!("enigo ctrl press: {e}"))?;
    enigo.key(Key::Shift, Direction::Press)
        .map_err(|e| format!("enigo shift press: {e}"))?;
    thread::sleep(Duration::from_millis(20));
    enigo.key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| format!("enigo v click: {e}"))?;
    thread::sleep(Duration::from_millis(10));
    enigo.key(Key::Shift, Direction::Release)
        .map_err(|e| format!("enigo shift release: {e}"))?;
    enigo.key(Key::Control, Direction::Release)
        .map_err(|e| format!("enigo ctrl release: {e}"))?;
    Ok(())
}

/// Inject Ctrl+V via enigo.
fn enigo_ctrl_v() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("enigo init: {e}"))?;
    enigo.key(Key::Control, Direction::Press)
        .map_err(|e| format!("enigo ctrl press: {e}"))?;
    thread::sleep(Duration::from_millis(30));
    enigo.key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| format!("enigo v click: {e}"))?;
    thread::sleep(Duration::from_millis(10));
    enigo.key(Key::Control, Direction::Release)
        .map_err(|e| format!("enigo ctrl release: {e}"))?;
    Ok(())
}

/// Inject Ctrl+V via xdotool.
fn xdotool_ctrl_v() -> Result<(), String> {
    let status = Command::new("xdotool")
        .args(["key", "--clearmodifiers", "ctrl+v"])
        .status()
        .map_err(|e| format!("xdotool spawn failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("xdotool exited with {status}"))
    }
}

/// Inject Ctrl+Shift+V via xdotool.
fn xdotool_ctrl_shift_v() -> Result<(), String> {
    let status = Command::new("xdotool")
        .args(["key", "--clearmodifiers", "ctrl+shift+v"])
        .status()
        .map_err(|e| format!("xdotool spawn failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("xdotool exited with {status}"))
    }
}

/// Inject Ctrl+V via wtype.
fn wtype_ctrl_v() -> Result<(), String> {
    let status = Command::new("wtype")
        .args(["-M", "ctrl", "-k", "v"])
        .status()
        .map_err(|e| format!("wtype spawn failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("wtype exited with {status}"))
    }
}

/// Inject Ctrl+Shift+V via wtype.
fn wtype_ctrl_shift_v() -> Result<(), String> {
    let status = Command::new("wtype")
        .args(["-M", "ctrl", "-M", "shift", "-k", "v"])
        .status()
        .map_err(|e| format!("wtype spawn failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("wtype exited with {status}"))
    }
}

// ── Unified paste entry-point ───────────────────────────────────

/// Run the best available keystroke injection method using the
/// shortcut selected for the target app. Terminals use Ctrl+Shift+V;
/// regular document editors and file managers use Ctrl+V.
fn inject_paste_with_shortcut(shortcut: PasteShortcut) {
    if is_wayland() && ydotool_available() {
        // Wayland + ydotool: the most reliable combination on all compositors
        match shortcut {
            PasteShortcut::CtrlShiftV => {
                if let Err(e) = ydotool_ctrl_shift_v() {
                    log::warn!("ydotool Ctrl+Shift+V failed: {e}");
                }
            }
            PasteShortcut::CtrlV => {
                if let Err(e) = ydotool_ctrl_v() {
                    log::warn!("ydotool Ctrl+V failed: {e}");
                }
            }
        }
        return;
    }

    if is_wayland() {
        // Wayland without ydotool — try wtype (wlroots only), then enigo
        if which("wtype").is_some() {
            let result = match shortcut {
                PasteShortcut::CtrlShiftV => wtype_ctrl_shift_v(),
                PasteShortcut::CtrlV => wtype_ctrl_v(),
            };
            match result {
                Ok(()) => return,
                Err(e) => log::warn!("wtype paste failed: {e}"),
            }
        }

        // Last resort: enigo (only works on XWayland or with older enigo)
        let result = match shortcut {
            PasteShortcut::CtrlShiftV => enigo_ctrl_shift_v(),
            PasteShortcut::CtrlV => enigo_ctrl_v(),
        };
        match result {
            Ok(()) => return,
            Err(e) => log::warn!("enigo paste failed on Wayland: {e}"),
        }
        return;
    }

    // X11 path (DISPLAY is set, WAYLAND_DISPLAY is not)
    if is_x11() {
        let result = match shortcut {
            PasteShortcut::CtrlShiftV => enigo_ctrl_shift_v(),
            PasteShortcut::CtrlV => enigo_ctrl_v(),
        };
        match result {
            Ok(()) => return,
            Err(e) => log::warn!("enigo paste failed: {e}"),
        }
        if which("xdotool").is_some() {
            let result = match shortcut {
                PasteShortcut::CtrlShiftV => xdotool_ctrl_shift_v(),
                PasteShortcut::CtrlV => xdotool_ctrl_v(),
            };
            if let Err(e) = result {
                log::warn!("xdotool paste failed: {e}");
            }
        }
        return;
    }

    // Neither Wayland nor X11 detected — try enigo anyway
    log::error!(
        "paste: cannot detect display server (no WAYLAND_DISPLAY, no DISPLAY); \
         paste may not work"
    );
    let _ = match shortcut {
        PasteShortcut::CtrlShiftV => enigo_ctrl_shift_v(),
        PasteShortcut::CtrlV => enigo_ctrl_v(),
    };
}

fn inject_paste() {
    let class_name = active_window_class().or_else(remembered_paste_target_class);
    let shortcut = paste_shortcut_for_window_class(class_name.as_deref());
    inject_paste_with_shortcut(shortcut);
}

// ── Diagnostics (called once at startup) ────────────────────────

/// Emit a desktop notification if `notify-send` is available.
pub fn notify(title: &str, body: &str) {
    let _ = Command::new("notify-send")
        .args(["--expire-time=5000", title, body])
        .spawn();
}

/// Run at startup: log the paste environment and warn if no method is
/// available.
pub fn diagnose_paste_environment() {
    let wayland = is_wayland();
    let x11 = is_x11();
    let has_ydotool = ydotool_available();
    let has_xdotool = which("xdotool").is_some();
    let has_wtype = which("wtype").is_some();

    log::info!(
        "Paste environment: wayland={wayland}, x11={x11}, \
         ydotool={has_ydotool}, xdotool={has_xdotool}, wtype={has_wtype}"
    );

    if wayland && !has_ydotool {
        log::warn!(
            "Wayland detected but ydotool is not installed. \
             Install it for reliable paste support: \
             sudo apt install ydotool"
        );
        notify(
            "Copy Creator — 粘贴功能提示",
            "检测到 Wayland 但未安装 ydotool。\n\
             请运行: sudo apt install ydotool\n\
             以确保粘贴功能正常工作。",
        );
    }

    if !wayland && x11 && !has_xdotool {
        log::warn!(
            "X11 detected but xdotool is not installed. \
             Install it for fallback paste support: \
             sudo apt install xdotool"
        );
    }
}

// ── File-paste helpers ──────────────────────────────────────────

/// Write a URI list to the system clipboard so that Linux file managers
/// recognise the paste as a file operation (rather than plain text).
///
/// On X11 this uses `xclip -t text/uri-list`; on Wayland it uses
/// `wl-copy -t text/uri-list`.  Falls back to writing plain text via
/// the Tauri clipboard plugin when neither tool is available.
fn write_uri_list(handle: &AppHandle, uri: &str) {
    let (cmd, args): (&str, &[&str]) = if is_wayland() {
        ("wl-copy", &["-t", "text/uri-list"])
    } else {
        ("xclip", &["-selection", "clipboard", "-t", "text/uri-list"])
    };

    let result = Command::new(cmd)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(uri.as_bytes());
            }
            child.wait()
        });

    match result {
        Ok(status) if status.success() => {
            log::info!("paste_file: wrote text/uri-list via {}", cmd);
        }
        _ => {
            log::warn!(
                "paste_file: {} not available, falling back to plain-text URI; \
                 install xclip (X11) or wl-clipboard (Wayland) for proper file paste",
                cmd
            );
            // Last-resort fallback: plain-text file:// URI
            let _ = handle.clipboard().write_text(uri);
        }
    }
}

fn paste_with_defocus(
    app: &AppHandle,
    shortcut_override: Option<PasteShortcut>,
) -> Result<(), String> {
    // Hide radial popup if visible.  When pasting from the radial menu
    // itself the frontend has already issued a hide, so this is a fast
    // no-op in the common case — but it is a safety net for edge cases
    // where the popup was left open.
    if let Some(radial) = app.get_webview_window("radial-menu") {
        let _ = radial.hide();
    }

    let window = app
        .get_webview_window("main")
        .ok_or("no window")?;

    let is_pinned = window.is_always_on_top().unwrap_or(false);
    if !is_pinned {
        window.hide().map_err(|e| e.to_string())?;
    }

    // Settle time for the compositor to defocus our window(s) and
    // transfer focus to the previously-active window.  200 ms has been
    // empirically sufficient on GNOME/Wayland and X11 alike now that
    // the Wayland keystroke-injection and terminal-shortcut issues are
    // fixed.
    thread::sleep(Duration::from_millis(200));

    match shortcut_override {
        Some(shortcut) => inject_paste_with_shortcut(shortcut),
        None => inject_paste(),
    }

    Ok(())
}

// ── Tauri commands ──────────────────────────────────────────────

#[tauri::command]
pub fn paste_text(app: AppHandle, text: String) -> Result<(), String> {
    if PASTING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    if let Err(e) = app.clipboard().write_text(text) {
        PASTING.store(false, Ordering::SeqCst);
        return Err(e.to_string());
    }

    // Sync monitor cache so the clipboard poller doesn't re-record our own paste
    crate::clipboard::sync_monitor_cache(&app);

    let handle = app.clone();
    std::thread::spawn(move || {
        let _guard = PasteGuard;
        paste_with_defocus(&handle, None).ok();
    });

    Ok(())
}

#[tauri::command]
pub fn paste_text_terminal(app: AppHandle, text: String) -> Result<(), String> {
    if PASTING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    if let Err(e) = app.clipboard().write_text(text) {
        PASTING.store(false, Ordering::SeqCst);
        return Err(e.to_string());
    }

    crate::clipboard::sync_monitor_cache(&app);

    let handle = app.clone();
    std::thread::spawn(move || {
        let _guard = PasteGuard;
        paste_with_defocus(&handle, Some(PasteShortcut::CtrlShiftV)).ok();
    });

    Ok(())
}

#[tauri::command]
pub fn paste_image(app: AppHandle, path: String) -> Result<(), String> {
    if PASTING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        let _guard = PasteGuard;

        let (rgba, w, h, _png) = {
            let cache = get_image_cache().lock().unwrap();
            if let Some(cached) = cache.map.get(&path) {
                (cached.rgba.clone(), cached.width, cached.height, cached.png_bytes.clone())
            } else {
                drop(cache);

                let mut base_dir = crate::db::get_storage_dir(&handle);
                base_dir.push(&path);

                let bytes = match std::fs::read(&base_dir) {
                    Ok(b) => b,
                    Err(e) => { log::error!("paste_image: read error: {}", e); return; }
                };

                let png_arc = Arc::new(bytes.clone());

                let (rgba, w, h) = {
                    use image::ImageDecoder;
                    let decoder = match image::codecs::png::PngDecoder::new(std::io::Cursor::new(&bytes)) {
                        Ok(d) => d,
                        Err(e) => { log::error!("paste_image: decode error: {}", e); return; }
                    };
                    let dims = decoder.dimensions();
                    let mut buf = vec![0; (dims.0 * dims.1 * 4) as usize];
                    if let Err(e) = decoder.read_image(&mut buf) {
                        log::error!("paste_image: read pixels error: {}", e); return;
                    }
                    (buf, dims.0, dims.1)
                };

                cache_image(path.clone(), rgba.clone(), w, h, bytes);
                (Arc::new(rgba), w, h, png_arc)
            }
        };

        // arboard writes proper image/png format that Linux apps understand
        let mut clipboard = match arboard::Clipboard::new() {
            Ok(c) => c,
            Err(e) => { log::error!("paste_image: arboard init: {:?}", e); return; }
        };
        let img = arboard::ImageData {
            width: w as usize,
            height: h as usize,
            bytes: std::borrow::Cow::Borrowed(&rgba),
        };
        if let Err(e) = clipboard.set_image(img) {
            log::error!("paste_image: arboard set_image: {:?}", e); return;
        }

        crate::clipboard::sync_monitor_cache(&handle);
        paste_with_defocus(&handle, None).ok();
    });

    Ok(())
}

#[tauri::command]
pub fn paste_file(app: AppHandle, path: String) -> Result<(), String> {
    if PASTING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    // Verify the file still exists on disk before pasting
    let file_meta = std::fs::metadata(&path);
    if file_meta.is_err() {
        log::error!("paste_file: file not found: {}", path);
        PASTING.store(false, Ordering::SeqCst);
        return Err(format!("File not found: {}", path));
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        let _guard = PasteGuard;

        // Write file:// URI as text/uri-list MIME type so file managers
        // recognise the paste as a file operation.
        let uri = format!("file://{}", path);
        write_uri_list(&handle, &uri);

        crate::clipboard::sync_monitor_cache(&handle);
        paste_with_defocus(&handle, Some(PasteShortcut::CtrlV)).ok();
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        parse_xprop_active_window_id,
        parse_xprop_wm_class,
        paste_shortcut_for_window_class,
        PasteShortcut,
    };

    #[test]
    fn uses_terminal_paste_shortcut_for_known_terminal_classes() {
        for class_name in [
            "gnome-terminal",
            "Alacritty",
            "kitty",
            "org.wezfurlong.wezterm",
        ] {
            assert_eq!(
                paste_shortcut_for_window_class(Some(class_name)),
                PasteShortcut::CtrlShiftV
            );
        }
    }

    #[test]
    fn uses_normal_paste_shortcut_for_documents_and_unknown_targets() {
        for class_name in [
            Some("Code"),
            Some("org.gnome.Nautilus"),
            Some("libreoffice-writer"),
            None,
        ] {
            assert_eq!(
                paste_shortcut_for_window_class(class_name),
                PasteShortcut::CtrlV
            );
        }
    }

    #[test]
    fn parses_xprop_active_window_id() {
        assert_eq!(
            parse_xprop_active_window_id("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x6400004"),
            Some("0x6400004".to_string())
        );
    }

    #[test]
    fn parses_xprop_wm_class() {
        assert_eq!(
            parse_xprop_wm_class("WM_CLASS(STRING) = \"gnome-terminal-server\", \"Gnome-terminal\""),
            Some("gnome-terminal-server Gnome-terminal".to_string())
        );
    }
}
