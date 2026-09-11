@echo off
rem Run Rust unit tests on Windows. Equivalent to: cargo test --lib
rem
rem The lib unittest process needs an embedded Common-Controls v6 manifest.
rem tauri-build only embeds it for bin targets; without it the test process
rem fails to start with STATUS_ENTRYPOINT_NOT_FOUND. Build scripts cannot
rem scope link args to the lib test binary, so embed tests.manifest here via
rem RUSTFLAGS for this test run only. Normal builds are unaffected.
setlocal
set "RUSTFLAGS=-C link-arg=/MANIFEST:EMBED -C link-arg=/MANIFESTINPUT:%~dp0tests.manifest"
cargo test --lib %*
