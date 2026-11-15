fn main() {
    tauri_build::build();

    // tauri-build 只给 bin 目标（含 cargo test 下的 bin 测试进程）内嵌启用
    // Common-Controls v6 的清单；lib 单元测试进程没有清单，Windows 下启动即报
    // STATUS_ENTRYPOINT_NOT_FOUND。构建脚本无法把链接参数只作用于 lib 测试
    // （CARGO_CFG_TEST 守卫不会生效：脚本只随普通编译运行一次；cargo 也没有
    // 面向 lib 测试的 rustc-link-arg 指令），因此由 test.cmd 通过 RUSTFLAGS
    // 在 `cargo test --lib` 时内嵌 tests.manifest 解决。
    //
    // 2026-11-15 实证存档：rustc-link-arg-tests 指令路线走不通——①package
    // 无声明 test 目标（tests/ 目录）时 cargo 直接报 "does not have a test
    // target" 拒收指令；②补声明一个 test 目标后指令生效（另注：指令值 cargo
    // 会自动包装成 -C link-arg=<值>，值须为裸链接器 flag，再包一层会被
    // LNK4044 静默忽略），但只覆盖声明目标本身——lib 单元测试二进制的
    // rustc 调用里零 MANIFEST flag，依旧裸死。test.cmd 的 RUSTFLAGS 注入
    // 是唯一能命中 lib 测试进程的通道。
}
