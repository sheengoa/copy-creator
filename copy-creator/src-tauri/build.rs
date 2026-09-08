fn main() {
    tauri_build::build();

    // 测试二进制也导入了 comctl32 v6 专属函数（如 TaskDialogIndirect），
    // 但 tauri-build 只给主程序内嵌启用 Common-Controls v6 的清单；
    // 不补上时 Windows 下测试进程启动即报 STATUS_ENTRYPOINT_NOT_FOUND。
    if cfg!(target_os = "windows") && std::env::var_os("CARGO_CFG_TEST").is_some() {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:tests.manifest");
    }
}
