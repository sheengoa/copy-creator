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
    // WebView2（Chromium）的 Windows 原生窗口遮挡检测存在误判：窗口明明
    // 可见却被判为遮挡，渲染进程随即被节流挂起——CSS 动画、JS 定时器
    // 全部停摆，窗口拖动只是操作系统在搬移冻结表面（无需页面重绘）。
    // 表现：生成等待期流光整段冻结、密度不渐密，完成事件到达才恢复
    // （2026-11-02 用户真机录像 freezedetect 实证 3.58s→19.77s 全冻，
    // 期间唯一变化是 6s 处拖窗；同代码在浏览器环境 --p 平滑爬升正常）。
    // 整族关闭节流：遮挡判定本身、遮挡后台化、定时器节流、渲染进程
    // 降优先级。环境变量由 WebView2 加载器追加到 wry 参数之后，不影响
    // wry 自带的 msWebOOUI 等默认项。
    const FIX_ARGS_BASE: &str = "--disable-features=CalculateNativeWinOcclusion \
        --disable-backgrounding-occluded-windows \
        --disable-background-timer-throttling \
        --disable-renderer-backgrounding";
    let mut fix_args = String::from(FIX_ARGS_BASE);
    // 调试构建额外开放 CDP 远程调试端口：冻结探针的日志与页面内部采样
    // 由此读取（发布构建不受影响）。
    if cfg!(debug_assertions) {
        fix_args.push_str(" --remote-debugging-port=9222");
    }
    match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        // 已有自定义参数：不含本修复标志才追加，不重复。
        Ok(existing) => {
            if !existing.contains("CalculateNativeWinOcclusion") {
                std::env::set_var(
                    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                    format!("{existing} {fix_args}"),
                );
            }
        }
        Err(_) => std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", fix_args),
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
