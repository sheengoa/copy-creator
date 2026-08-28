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

fn main() {
    configure_linux_webkit_renderer();
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
