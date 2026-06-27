//! Unix-domain-socket IPC server so that external scripts (bound to
//! Ubuntu keyboard shortcuts via Settings → Keyboard → Shortcuts) can
//! control the running application.
//!
//! ## Usage (after the app is running)
//!
//! ```bash
//! # Toggle the main window
//! echo show | nc -U "$XDG_RUNTIME_DIR/copy-creator.sock"
//!
//! # Show the radial menu at the cursor
//! echo radial | nc -U "$XDG_RUNTIME_DIR/copy-creator.sock"
//!
//! # Health check
//! echo ping | nc -U "$XDG_RUNTIME_DIR/copy-creator.sock"  # → "pong"
//! ```
//!
//! Set these as custom keyboard shortcuts in Ubuntu Settings.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// Prevent stacked show requests from piling up restore-pin threads.
static SHOWING: AtomicBool = AtomicBool::new(false);

/// RAII guard that resets SHOWING on drop, even if a thread panics.
struct ShowGuard;

impl Drop for ShowGuard {
    fn drop(&mut self) {
        SHOWING.store(false, Ordering::SeqCst);
    }
}

fn socket_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        PathBuf::from(dir).join("copy-creator.sock")
    } else {
        PathBuf::from(
            std::env::var("HOME")
                .unwrap_or_else(|_| "/tmp".into()),
        )
        .join(".local/share/copy-creator/copy-creator.sock")
    }
}

/// Handle a single client connection.
/// Reads ONE line, processes the command, writes an optional reply, then
/// closes the connection.
fn handle_client(mut stream: UnixStream, app: &AppHandle) {
    // Set a read timeout so a stalled client can't hold the handler forever.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));

    let mut line = String::new();
    {
        let mut reader = BufReader::new(&stream);
        if reader.read_line(&mut line).is_err() {
            return;
        }
    }
    let cmd = line.trim().to_lowercase();

    match cmd.as_str() {
        "show" | "toggle" => {
            cmd_show(app);
            let _ = writeln!(stream, "ok");
        }
        "radial" => {
            log::info!("[ipc] show radial menu");
            crate::shortcut::show_radial_menu(app);
            let _ = writeln!(stream, "ok");
        }
        "ping" => {
            let _ = writeln!(stream, "pong");
        }
        "" => {} // ignore empty lines
        other => {
            log::warn!("[ipc] unknown command: {}", other);
            let _ = writeln!(stream, "error: unknown command '{}'", other);
        }
    }
}

/// Show the main window reliably, breaking through GNOME's focus-stealing
/// prevention by temporarily flagging the window as always-on-top.
fn cmd_show(app: &AppHandle) {
    // Guard against re-entrant / stacked calls
    if SHOWING.swap(true, Ordering::SeqCst) {
        log::info!("[ipc] show skipped — already in progress");
        return;
    }
    let _guard = ShowGuard;

    crate::paste::remember_paste_target();

    let window = match app.get_webview_window("main") {
        Some(w) => w,
        None => {
            log::error!("[ipc] main window not found — webview not created yet?");
            return;
        }
    };

    log::info!("[ipc] showing main window");

    // 1. Remember user's pin preference
    let was_pinned = window.is_always_on_top().unwrap_or(false);

    // 2. Force on-top to break through GNOME focus-stealing prevention
    if let Err(e) = window.set_always_on_top(true) {
        log::warn!("[ipc] set_always_on_top(true) failed: {}", e);
    }

    // 3. Unminimize if needed, then show
    let _ = window.unminimize();
    let _ = window.show();

    // 4. Focus — first attempt
    let _ = window.set_focus();

    // 5. Delayed restore: wait for the window to surface, then restore
    //    the user's pin preference and re-focus.
    let handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(200));
        match handle.get_webview_window("main") {
            Some(w) => {
                // Only restore if SHOWING is false (no new show request arrived)
                if !SHOWING.load(Ordering::SeqCst) {
                    if let Err(e) = w.set_always_on_top(was_pinned) {
                        log::warn!("[ipc] restore pin failed: {}", e);
                    }
                }
                // Re-focus after the stacking order has settled
                let _ = w.set_focus();
            }
            None => log::warn!("[ipc] main window gone before restore"),
        }
    });
}

/// Start the IPC server in a background thread.
/// Returns the path of the socket so it can be documented / displayed.
pub fn start_ipc_server(app: AppHandle) -> PathBuf {
    let path = socket_path();

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Clean up stale socket from a previous run
    let _ = std::fs::remove_file(&path);

    let listener = match UnixListener::bind(&path) {
        Ok(l) => {
            // Restrict permissions to the owner only (privacy)
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            l
        }
        Err(e) => {
            log::warn!(
                "[ipc] failed to bind {}: {} — keyboard-shortcut IPC disabled",
                path.display(),
                e
            );
            return path;
        }
    };

    log::info!("[ipc] listening on {}", path.display());

    thread::spawn(move || {
        loop {
            match listener.accept() {
                Ok((stream, _addr)) => {
                    handle_client(stream, &app);
                }
                Err(e) => {
                    match e.kind() {
                        // Transient errors — log and keep going
                        std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::WouldBlock => {
                            log::warn!("[ipc] transient accept error: {}", e);
                            continue;
                        }
                        // Fatal errors — exit the loop
                        _ => {
                            log::error!("[ipc] fatal accept error: {}", e);
                            break;
                        }
                    }
                }
            }
        }
        log::warn!("[ipc] server loop exited");
    });

    path
}
