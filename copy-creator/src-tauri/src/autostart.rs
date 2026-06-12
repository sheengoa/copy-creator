use serde::Serialize;
use std::fs;
use std::path::PathBuf;

fn autostart_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config")
        .join("autostart")
}

fn desktop_file_path() -> PathBuf {
    autostart_dir().join("copy-creator.desktop")
}

fn current_exe_path() -> String {
    std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

/// Shell-escape a path for use in a .desktop Exec= line.
/// Wraps the value in single quotes, escaping any embedded single quotes.
fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Build the contents of a well-formed autostart .desktop entry.
fn desktop_entry(exe: &str) -> String {
    let exe_escaped = shell_escape(exe);
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Version=1.0\n\
         Name=Copy Creator\n\
         Comment=Clipboard manager, quick phrases, and translation tool\n\
         Exec={exe_escaped} --hidden\n\
         Icon=copy-creator\n\
         StartupNotify=false\n\
         Terminal=false\n\
         X-GNOME-Autostart-enabled=true\n",
    )
}

// ── Tauri commands ──────────────────────────────────────────────

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<bool, String> {
    let desktop_path = desktop_file_path();

    if enabled {
        let exe = current_exe_path();
        if exe.is_empty() {
            return Err("Cannot determine current executable path".to_string());
        }
        let content = desktop_entry(&exe);
        fs::create_dir_all(autostart_dir()).map_err(|e| {
            format!("Failed to create autostart directory: {e}")
        })?;
        fs::write(&desktop_path, content).map_err(|e| {
            format!("Failed to write autostart file: {e}")
        })?;
        log::info!("Autostart enabled → {}", desktop_path.display());
    } else {
        if desktop_path.exists() {
            fs::remove_file(&desktop_path).map_err(|e| {
                format!("Failed to remove autostart file: {e}")
            })?;
            log::info!("Autostart disabled — removed {}", desktop_path.display());
        }
    }

    Ok(enabled)
}

#[tauri::command]
pub fn is_autostart_enabled() -> Result<bool, String> {
    let desktop_path = desktop_file_path();
    if !desktop_path.exists() {
        return Ok(false);
    }

    let content = match fs::read_to_string(&desktop_path) {
        Ok(c) => c,
        Err(_) => return Ok(false),
    };

    let current_exe = current_exe_path();
    Ok(content.contains(&current_exe))
}

#[derive(Serialize, Clone)]
pub struct AutostartStatus {
    pub enabled: bool,
    pub file_exists: bool,
    pub path_correct: bool,
    pub message: String,
}

#[tauri::command]
pub fn validate_autostart() -> Result<AutostartStatus, String> {
    let desktop_path = desktop_file_path();
    let file_exists = desktop_path.exists();
    let mut path_correct = false;

    if file_exists {
        if let Ok(content) = fs::read_to_string(&desktop_path) {
            let current_exe = current_exe_path();
            path_correct = content.contains(&current_exe);
        }
    }

    let enabled = file_exists && path_correct;

    let message = if !file_exists {
        "Autostart file does not exist".to_string()
    } else if !path_correct {
        format!(
            "Autostart entry points to a different binary path — \
             current: {}",
            current_exe_path()
        )
    } else {
        "Autostart is configured correctly".to_string()
    };

    Ok(AutostartStatus {
        enabled,
        file_exists,
        path_correct,
        message,
    })
}

/// Called on every startup.  If the user expects autostart but the
/// .desktop file is broken or missing, repair it automatically.
pub fn repair_autostart_if_needed() {
    let desktop_path = desktop_file_path();
    let exe = current_exe_path();

    if !desktop_path.exists() {
        return; // not enabled, nothing to do
    }

    let needs_repair = match fs::read_to_string(&desktop_path) {
        Ok(content) => !content.contains(&exe),
        Err(_) => true,
    };

    if needs_repair {
        log::warn!(
            "Autostart entry is stale or broken — auto-repairing with path: {}",
            exe
        );
        if let Err(e) = fs::write(&desktop_path, desktop_entry(&exe)) {
            log::error!("Failed to repair autostart entry: {e}");
        }
    }
}
