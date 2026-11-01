// Release 版为 Windows GUI 子系统，不分配控制台窗口；Debug 版保留控制台以便查看日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
fn should_disable_dmabuf_renderer(explicit_value: Option<&str>, nvidia_present: bool) -> bool {
    explicit_value.is_none() && nvidia_present
}

#[cfg(target_os = "linux")]
fn configure_linux_webkit_renderer() {
    let nvidia_present = ["/dev/nvidiactl", "/dev/nvidia0"]
        .iter()
        .any(|path| std::path::Path::new(path).exists());
    let explicit_value = std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").ok();

    if should_disable_dmabuf_renderer(explicit_value.as_deref(), nvidia_present) {
        // NVIDIA + WebKitGTK 的透明窗口在调整大小时可能闪烁；禁用
        // DMABUF 路径可避免该合成问题，同时保留 CSS 圆角和透明窗口。
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        eprintln!("NVIDIA detected; disabling WebKitGTK DMABUF renderer for stable resizing");
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_webkit_renderer() {}

#[cfg(windows)]
fn configure_windows_webview_throttling() {
    // WebView2（Chromium）在 Windows 上的原生窗口遮挡检测存在误判可能：
    // 把可见窗口判为遮挡后节流挂起渲染进程——CSS 动画、JS 定时器全停，
    // 窗口拖动只是操作系统在搬移冻结表面。2026-11-02 排查「生成等待期
    // 流光整段冻结」时加上这组豁免做保险；该次冻结的主因后来查明是流光
    // 光团群 JSX 结构错误从未绘制（见 GenAuroraStage 注释），但误判挂起
    // 是同类应用的已知真实问题，豁免零成本，保留。
    // 环境变量由 WebView2 加载器追加到 wry 参数之后，不影响 wry 自带的
    // msWebOOUI 等默认项。
    const FIX_ARGS: &str = "--disable-features=CalculateNativeWinOcclusion \
        --disable-backgrounding-occluded-windows \
        --disable-background-timer-throttling \
        --disable-renderer-backgrounding";
    match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        // 已有自定义参数：不含本修复标志才追加，不重复。
        Ok(existing) => {
            if !existing.contains("CalculateNativeWinOcclusion") {
                std::env::set_var(
                    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                    format!("{existing} {FIX_ARGS}"),
                );
            }
        }
        Err(_) => std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", FIX_ARGS),
    }
}

#[cfg(not(windows))]
fn configure_windows_webview_throttling() {}

fn main() {
    configure_linux_webkit_renderer();
    configure_windows_webview_throttling();
    app_lib::run();
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    use super::should_disable_dmabuf_renderer;

    #[cfg(target_os = "linux")]
    #[test]
    fn enables_workaround_only_when_nvidia_is_present_and_unconfigured() {
        assert!(should_disable_dmabuf_renderer(None, true));
        assert!(!should_disable_dmabuf_renderer(Some("0"), true));
        assert!(!should_disable_dmabuf_renderer(None, false));
    }
}
