@echo off
rem ============================================================
rem  Dev launcher: set up MSVC / Windows SDK env before tauri dev.
rem  Why: Visual Studio was moved to F:\install\L and the Windows
rem  SDK registry info is missing, so a plain `pnpm tauri dev`
rem  fails with  fatal error C1034: windows.h: not found in include
rem  paths.  This script also pins the real MSVC link.exe so rustc
rem  does not pick up Git Bash's usr/bin/link.exe.
rem  Usage: double-click, or run `dev.cmd`
rem ============================================================
set "MSVC=F:\install\L\VC\Tools\MSVC\14.43.34808"
set "SDK=C:\Program Files (x86)\Windows Kits\10"
set "SDKVER=10.0.22621.0"
set "PATH=%MSVC%\bin\Hostx64\x64;%SDK%\bin\%SDKVER%\x64;%PATH%"
set "INCLUDE=%MSVC%\include;%SDK%\Include\%SDKVER%\ucrt;%SDK%\Include\%SDKVER%\um;%SDK%\Include\%SDKVER%\shared;%SDK%\Include\%SDKVER%\winrt;%SDK%\Include\%SDKVER%\cppwinrt"
set "LIB=%MSVC%\lib\x64;%SDK%\Lib\%SDKVER%\ucrt\x64;%SDK%\Lib\%SDKVER%\um\x64"
echo [dev] MSVC/SDK env ready, starting tauri dev ...
cd /d "%~dp0"
pnpm tauri dev
