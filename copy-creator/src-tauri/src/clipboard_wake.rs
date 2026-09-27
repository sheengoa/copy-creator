//! 剪贴板采集唤醒源。`wait_for_wake_or_timeout` 是全平台接口：Windows
//! 上经消息-only 窗口监听 WM_CLIPBOARDUPDATE，把采集循环的「纯 800ms
//! 定时轮询」升级为「事件即时唤醒 + 定时兜底」，复制后立即入库；其他
//! 平台保持纯定时轮询。事件监听异常时兜底轮询保证功能不中断（只是
//! 退化为原延迟）。

#[cfg(target_os = "windows")]
use std::sync::{Condvar, Mutex};

#[cfg(target_os = "windows")]
#[derive(Default)]
struct WakeState {
    version: u64,
}

#[cfg(target_os = "windows")]
static WAKE_LOCK: Mutex<WakeState> = Mutex::new(WakeState { version: 0 });
#[cfg(target_os = "windows")]
static WAKE_CV: Condvar = Condvar::new();

/// 事件线程唤醒采集循环（WM_CLIPBOARDUPDATE 到达时调用）
#[cfg(target_os = "windows")]
fn notify() {
    if let Ok(mut state) = WAKE_LOCK.lock() {
        state.version += 1;
        WAKE_CV.notify_all();
    }
}

/// 采集循环等待：剪贴板事件到达立即返回；超时无事件按兜底轮询返回。
/// 非 Windows 平台保持纯定时轮询。
pub fn wait_for_wake_or_timeout(timeout_ms: u64) {
    #[cfg(target_os = "windows")]
    {
        let Ok(state) = WAKE_LOCK.lock() else {
            std::thread::sleep(std::time::Duration::from_millis(timeout_ms));
            return;
        };
        let _ = WAKE_CV.wait_timeout(state, std::time::Duration::from_millis(timeout_ms));
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::thread::sleep(std::time::Duration::from_millis(timeout_ms));
    }
}

/// 启动 Windows 剪贴板事件监听线程：创建消息-only 窗口并注册
/// AddClipboardFormatListener，收到 WM_CLIPBOARDUPDATE 后唤醒采集循环。
/// 监听线程若异常退出，采集循环的兜底轮询不受影响。
#[cfg(target_os = "windows")]
pub fn start_windows_listener() {
    std::thread::Builder::new()
        .name("clipboard-wake".into())
        .spawn(|| {
            use windows::core::PCWSTR;
            use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
            use windows::Win32::System::DataExchange::AddClipboardFormatListener;
            use windows::Win32::System::LibraryLoader::GetModuleHandleW;
            use windows::Win32::UI::WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassExW,
                TranslateMessage, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSEXW,
            };

            const WM_CLIPBOARDUPDATE: u32 = 0x031D;

            // wndproc 只关心剪贴板更新，其余全部交回默认处理
            unsafe extern "system" fn wndproc(
                hwnd: HWND,
                msg: u32,
                wparam: WPARAM,
                lparam: LPARAM,
            ) -> LRESULT {
                if msg == WM_CLIPBOARDUPDATE {
                    notify();
                    return LRESULT(0);
                }
                unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
            }

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
                use windows::Win32::Foundation::HINSTANCE;
                let class_name: Vec<u16> = "CopyCreatorClipboardWake\0"
                    .encode_utf16()
                    .collect();
                let hmodule = GetModuleHandleW(None).unwrap_or_default();
                let hinstance = HINSTANCE(hmodule.0);

                let mut wcx = WNDCLASSEXW::default();
                wcx.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
                wcx.lpfnWndProc = Some(wndproc);
                wcx.hInstance = hinstance;
                wcx.lpszClassName = PCWSTR(class_name.as_ptr());
                if RegisterClassExW(&wcx) == 0 {
                    log::error!("[clipboard-wake] RegisterClassExW failed");
                    return;
                }

                // parent = HWND_MESSAGE：消息-only 窗口，不出现在任务栏与屏幕上
                let hwnd = CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    PCWSTR(class_name.as_ptr()),
                    PCWSTR::null(),
                    WINDOW_STYLE::default(),
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    None,
                    hinstance,
                    None,
                );
                if hwnd.0 == 0 {
                    log::error!("[clipboard-wake] CreateWindowExW failed");
                    return;
                }
                if let Err(e) = AddClipboardFormatListener(hwnd) {
                    log::error!("[clipboard-wake] AddClipboardFormatListener failed: {e}");
                    return;
                }
                log::info!("[clipboard-wake] clipboard update listener started");

                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }));
            if result.is_err() {
                log::error!("[clipboard-wake] listener thread panicked; fallback polling keeps recording");
            }
        })
        .map(|_| ())
        .map_err(|e| log::error!("[clipboard-wake] spawn failed: {e}"))
        .ok();
}
