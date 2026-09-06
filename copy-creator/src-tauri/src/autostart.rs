use serde::Serialize;

fn autostart_dir() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config")
        .join("autostart")
}

fn desktop_file_path() -> std::path::PathBuf {
    autostart_dir().join("copy-creator.desktop")
}

/// Return the path to the current executable, resolving the AppImage
/// case where `current_exe()` points inside a transient FUSE mount.
fn current_exe_path() -> String {
    // When running inside an AppImage, the APPIMAGE env var holds the
    // real path of the AppImage file — use that instead of the FUSE
    // mount path which disappears after the process exits.
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        if !appimage.is_empty() {
            log::info!("Autostart: using APPIMAGE path: {appimage}");
            return appimage;
        }
    }
    std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

#[derive(Serialize, Clone)]
pub struct AutostartStatus {
    pub enabled: bool,
    pub file_exists: bool,
    pub path_correct: bool,
    pub message: String,
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{autostart_dir, current_exe_path, desktop_file_path};
    use std::fs;

    /// Build the contents of a well-formed autostart .desktop entry.
    ///
    /// NOTE: The Freedesktop `.desktop` spec does **not** interpret the
    /// `Exec=` line through a shell — quotes around the binary path are
    /// a spec violation and will cause the entry to be rejected (GNOME
    /// logs "contains a reserved character ''' outside of a quote").
    /// We use the bare path because Linux binary paths never contain
    /// spaces in practice.
    fn desktop_entry(exe: &str) -> String {
        format!(
            "[Desktop Entry]\n\
             Type=Application\n\
             Version=1.0\n\
             Name=Copy Creator\n\
             Comment=Clipboard manager, quick input, and translation tool\n\
             Exec={exe} --hidden\n\
             Icon=copy-creator\n\
             StartupNotify=false\n\
             Terminal=false\n\
             X-GNOME-Autostart-enabled=true\n\
             X-GNOME-Autostart-Delay=2\n",
        )
    }

    pub fn set_autostart(enabled: bool) -> Result<bool, String> {
        let desktop_path = desktop_file_path();

        if enabled {
            let exe = current_exe_path();
            if exe.is_empty() {
                return Err("Cannot determine current executable path".to_string());
            }
            let content = desktop_entry(&exe);
            fs::create_dir_all(autostart_dir())
                .map_err(|e| format!("Failed to create autostart directory: {e}"))?;
            fs::write(&desktop_path, content)
                .map_err(|e| format!("Failed to write autostart file: {e}"))?;
            log::info!("Autostart enabled → {}", desktop_path.display());
        } else {
            if desktop_path.exists() {
                fs::remove_file(&desktop_path)
                    .map_err(|e| format!("Failed to remove autostart file: {e}"))?;
                log::info!("Autostart disabled — removed {}", desktop_path.display());
            }
        }

        Ok(enabled)
    }

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

    pub fn status() -> super::AutostartStatus {
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

        super::AutostartStatus {
            enabled,
            file_exists,
            path_correct,
            message,
        }
    }

    /// Called on every startup.  If the user expects autostart but the
    /// .desktop file is broken or stale, repair it automatically.
    ///
    /// We regenerate the file unconditionally (when it exists) to fix:
    /// - Old/broken `Exec=` lines with shell quotes (v0.1.1 auto-repair)
    /// - Stale paths after an AppImage update or binary relocation
    /// - Any spec-invalid content from earlier versions
    pub fn repair_autostart_if_needed() {
        let desktop_path = desktop_file_path();

        if !desktop_path.exists() {
            return; // not enabled, nothing to do
        }

        let exe = current_exe_path();
        if exe.is_empty() {
            log::error!("Autostart repair skipped: cannot determine current exe path");
            return;
        }

        let fresh = desktop_entry(&exe);

        let needs_repair = match fs::read_to_string(&desktop_path) {
            Ok(current) => current != fresh,
            Err(_) => true,
        };

        if needs_repair {
            log::warn!(
                "Autostart entry is stale or broken — auto-repairing with path: {}",
                exe
            );
            if let Err(e) = fs::write(&desktop_path, &fresh) {
                log::error!("Failed to repair autostart entry: {e}");
            } else {
                log::info!("Autostart entry repaired successfully");
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{current_exe_path, AutostartStatus};
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    // HKCU Run 键：登录时按值启动，无需管理员权限，与任务管理器
    // "启动应用"开关一致。
    const RUN_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE_NAME: &str = "Copy Creator";

    fn autostart_command() -> String {
        // 引号包裹可执行路径：Windows 路径常见空格（Program Files 等）。
        format!("\"{}\" --hidden", current_exe_path())
    }

    fn stored_command() -> Result<Option<String>, String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let Ok(key) = hkcu.open_subkey_with_flags(RUN_SUBKEY, KEY_READ) else {
            return Ok(None);
        };
        Ok(key.get_value::<String, _>(VALUE_NAME).ok())
    }

    pub fn set_autostart(enabled: bool) -> Result<bool, String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if enabled {
            let command = autostart_command();
            if current_exe_path().is_empty() {
                return Err("Cannot determine current executable path".to_string());
            }
            let (key, _) = hkcu
                .create_subkey(RUN_SUBKEY)
                .map_err(|e| format!("Failed to open Run registry key: {e}"))?;
            key.set_value(VALUE_NAME, &command)
                .map_err(|e| format!("Failed to write Run registry value: {e}"))?;
            log::info!("Autostart enabled → HKCU\\{RUN_SUBKEY}\\{VALUE_NAME}");
        } else {
            let Ok(key) = hkcu.open_subkey_with_flags(RUN_SUBKEY, KEY_SET_VALUE) else {
                return Ok(false); // Run 键不存在，视为已禁用
            };
            // 值本就不存在时删除失败属预期，忽略。
            let _ = key.delete_value(VALUE_NAME);
            log::info!("Autostart disabled — removed HKCU\\{RUN_SUBKEY}\\{VALUE_NAME}");
        }
        Ok(enabled)
    }

    pub fn is_autostart_enabled() -> Result<bool, String> {
        // 忽略大小写与分隔符差异：注册表中的路径可能由不同版本的
        // 安装器写入，盘符/目录大小写不构成"配置失效"。
        Ok(match stored_command()? {
            Some(stored) => stored.eq_ignore_ascii_case(&autostart_command()),
            None => false,
        })
    }

    pub fn status() -> AutostartStatus {
        let stored = match stored_command() {
            Ok(stored) => stored,
            Err(e) => {
                return AutostartStatus {
                    enabled: false,
                    file_exists: false,
                    path_correct: false,
                    message: format!("Failed to read Run registry value: {e}"),
                };
            }
        };
        let value_exists = stored.is_some();
        let path_correct = stored
            .as_deref()
            .is_some_and(|stored| stored.eq_ignore_ascii_case(&autostart_command()));

        let message = if !value_exists {
            "Autostart registry value does not exist".to_string()
        } else if !path_correct {
            format!(
                "Autostart registry value points to a different command — \
                 current: {}",
                autostart_command()
            )
        } else {
            "Autostart is configured correctly".to_string()
        };

        AutostartStatus {
            enabled: value_exists && path_correct,
            file_exists: value_exists,
            path_correct,
            message,
        }
    }

    pub fn repair_autostart_if_needed() {
        let Some(stored) = stored_command().ok().flatten() else {
            return; // 未启用，无事可做
        };
        let current = autostart_command();
        if stored.eq_ignore_ascii_case(&current) {
            return;
        }
        // exe 位置变化（重装/更新路径）后自动改写 Run 值。
        if let Err(e) = set_autostart(true) {
            log::error!("Autostart repair failed: {e}");
        } else {
            log::warn!("Autostart registry value was stale — repaired to: {current}");
        }
    }
}

use platform::{
    is_autostart_enabled as platform_is_enabled, repair_autostart_if_needed as platform_repair,
    set_autostart as platform_set, status as platform_status,
};

// ── Tauri commands ──────────────────────────────────────────────

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<bool, String> {
    platform_set(enabled)
}

#[tauri::command]
pub fn is_autostart_enabled() -> Result<bool, String> {
    platform_is_enabled()
}

#[tauri::command]
pub fn validate_autostart() -> Result<AutostartStatus, String> {
    Ok(platform_status())
}

/// Called on every startup so a stale entry (binary moved, reinstalled
/// elsewhere) is rewritten to point at the current executable.
pub fn repair_autostart_if_needed() {
    platform_repair();
}
