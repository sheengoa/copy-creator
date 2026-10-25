@echo off
rem Run Rust unit tests on Windows. Equivalent to: cargo test --lib
rem
rem The lib unittest process needs an embedded Common-Controls v6 manifest.
rem tauri-build only embeds it for bin targets; without it the test process
rem fails to start with STATUS_ENTRYPOINT_NOT_FOUND. Build scripts cannot
rem scope link args to the lib test binary, so embed tests.manifest here via
rem RUSTFLAGS for this test run only. Normal builds are unaffected.
rem
rem MSVC bin goes first on PATH so link.exe finds mt.exe (manifest tool) and
rem the real MSVC toolchain wins over Git Bash's usr/bin/link.exe. Keep the
rem MSVC version in sync with .cargo/config.toml (local, untracked).
setlocal
set "MSVC_BIN=F:\install\L\VC\Tools\MSVC\14.43.34808\bin\Hostx64\x64"
rem mt.exe ships with the Windows SDK, not with MSVC (this VS install has
rem no copy next to link.exe), so the SDK tools dir goes on PATH as well.
set "SDK_BIN=C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64"
set "PATH=%MSVC_BIN%;%SDK_BIN%;%PATH%"
set "RUSTFLAGS=-C link-arg=/MANIFEST:EMBED -C link-arg=/MANIFESTINPUT:%~dp0tests.manifest"
cargo test --lib %*
