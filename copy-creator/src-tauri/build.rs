fn main() {
    tauri_build::build();

    // tauri-build 只给 bin 目标（含 cargo test 下的 bin 测试进程）内嵌启用
    // Common-Controls v6 的清单；lib 单元测试进程没有清单，Windows 下启动即报
    // STATUS_ENTRYPOINT_NOT_FOUND。构建脚本无法把链接参数只作用于 lib 测试
    // （CARGO_CFG_TEST 守卫不会生效：脚本只随普通编译运行一次；cargo 也没有
    // 面向 lib 测试的 rustc-link-arg 指令），因此由 test.cmd 通过 RUSTFLAGS
    // 在 `cargo test --lib` 时内嵌 tests.manifest 解决。
}
