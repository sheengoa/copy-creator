# Copy Creator Linux 重写方案

> 状态：**径向菜单已适配，待实机测试** | 创建：2026-06-04 | 最后更新：2026-06-05
> 目标：将 Copy Creator 重写为纯 Linux 版本，删除所有 Windows 代码，在 Ubuntu 24.04 上完整运行

---

## 执行进度

### 2026-06-05 会话总结

#### ✅ 已完成：Linux 径向菜单适配

采用**方案 A（键盘快捷键触发 + 点击选择）**，替代 Windows 鼠标钩子模型：

**交互流程**：
1. 用户按下全局快捷键 → 径向窗口出现在鼠标光标位置
2. 鼠标移动 → 自然 CSS hover 高亮项
3. 点击项 → 粘贴内容 → 窗口自动隐藏
4. Escape / 点击窗外 / 失焦 → 窗口关闭

**后端改动**（Rust）：

| 文件 | 改动 |
|:---|:---|
| `shortcut.rs` | 新增 `get_cursor_position()`（enigo）、`show_radial_menu()`、`update_radial_shortcut` 命令、快捷键分发 accessor |
| `lib.rs` | 全局快捷键 handler 分发（主窗口 / 径向菜单）、径向快捷键注册、`update_radial_shortcut` 注册 |

**前端改动**（React/TypeScript）：

| 文件 | 改动 |
|:---|:---|
| `RadialMenu/index.tsx` | 移除 Windows 鼠标钩子事件监听（down/move/up），替换为 click-to-select + Escape-to-dismiss + 自然鼠标悬停 |
| `ShortcutSection.tsx` | 径向菜单行从 toggle 开关替换为快捷键录制器 |
| `SettingsContent.tsx` | 新增径向快捷键录制状态管理和保存逻辑 |
| `settingsStore.ts` | 新增 `radialShortcutKey` 字段 |
| `i18n/zh-CN.json`、`en.json` | 更新 `radialShortcutDesc` 描述文本 |

**总计**：8 个文件，+304 行，-87 行

### 2026-06-04 会话总结

#### ✅ 已完成：Rust 后端纯 Linux 重写

| 文件 | 改动 | 行数变化 |
|:---|:---|:---|
| `Cargo.toml` | 删除 `windows` crate，`arboard` 提升为通用依赖 | -14 |
| `main.rs` | 删除 `windows_subsystem` 属性 | -2 |
| `paste.rs` | 删除 Win32 剪切板/前台追踪代码，仅保留 Linux arboard + file:// URI 路径 | 654→212 |
| `clipboard.rs` | 删除 Win32 监控代码，简化为纯 arboard/文本/文件轮询 | 904→512 |
| `shortcut.rs` | 删除全局鼠标钩子 (~200 行)，只保留键盘快捷键 + 日志 | 293→99 |
| `lib.rs` | 删除 DWM 毛玻璃效果、前台追踪初始化 | 214→159 |

**编译**：0 errors, 0 warnings (Rust 1.96.0, Ubuntu 24.04)

**已提交**：`d2eed07 refactor: 重写为纯 Linux 版本，删除全部 Windows 代码`

#### ⏳ 待完成：运行测试

项目尚未在 Ubuntu 24.04 上实际运行验证，以下功能需要实机测试：
- [ ] 文本剪切板监听 + 粘贴
- [ ] 图片剪切板监听 + 粘贴（arboard 路径）
- [ ] 文件剪切板监听 + 粘贴（file:// URI 路径）
- [ ] 键盘全局快捷键唤起窗口
- [ ] 系统托盘图标及菜单
- [ ] 翻译（AI + Google）
- [ ] 快捷短语管理
- [ ] 设置持久化

#### ⏳ 待完成：打包配置

- [x] 配置 Linux 打包 (AppImage / deb) — `tauri.conf.json` 已更新
- [ ] 实际打包验证（需在 Ubuntu 上运行 `pnpm tauri build`）
- [ ] 验证开机自启动 (.desktop 文件)
- [x] 更新 README 中的平台说明和安装步骤 — 中文/英文 README 已更新

---

## 1. 改写原则

**彻底删除，不做条件编译**。目标不是"双平台兼容"，而是"纯 Linux 应用"：

- 所有 `#[cfg(target_os = "windows")]` 代码块 → 直接删除
- 所有 `#[cfg(target_os = "linux")]` 标注 → 移除，变成唯一路径
- `#[cfg(target_os = "macos")]` 代码 → 删除
- `windows` crate 依赖 → 删除
- `arboard` crate → 从条件依赖提升为通用依赖
- `enigo` → 仅保留 Linux 路径

## 2. 文件改动清单

### 2.1 `Cargo.toml` — 依赖清理

| 操作 | 内容 |
|:---|:---|
| 删除 | `[target.'cfg(target_os = "windows")'.dependencies]` 整个段落（`windows` crate） |
| 删除 | `[target.'cfg(target_os = "linux")'.dependencies]` 段落头 |
| 移动 | `arboard` 移入 `[dependencies]` |
| 保留 | 其余依赖不变 |

### 2.2 `main.rs` — 入口

| 操作 | 内容 |
|:---|:---|
| 替换 | `#![cfg_attr(...)]` → 删除该行（Linux 应用不需要 windows_subsystem） |

### 2.3 `paste.rs` — 核心重写（删除 ~350 行）

删除清单：

| 行号范围 | 内容 | 原因 |
|:---|:---|:---|
| 3-8 | `AtomicPtr`, `ptr`, `base64::Engine` 的 cfg import | Windows 专用 |
| 12-76 | `LAST_FOREGROUND_HWND`、`OUR_HWND`、`RADIAL_HWND`、`register_radial_hwnd`、`save_foreground_window`、`init_foreground_tracker`、`foreground_change_hook` | Windows 窗口管理 |
| 78-85 | Linux stub 函数（`register_radial_hwnd` 等） | 原文调用方被删除后不再需要 |
| 145-149 | `paste_with_defocus` 中的 `AllowSetForegroundWindow` | Windows 专用 |
| 163-173 | 置顶窗口的 `SetForegroundWindow` 恢复 | Windows 专用 |
| 177-187 | 非置顶窗口的 `SetForegroundWindow` 恢复 | Windows 专用 |
| 193-211 | `GetAsyncKeyState` Ctrl/Alt 检测 | Windows 专用 |
| 213-215 | `#[cfg(not(windows))]` 的 sleep fallback | 简化为直接 sleep |
| 220-227 | `#[cfg(windows)]` Ctrl+V 块 | Windows 专用 |
| 239-248 | `#[cfg(macos)]` Cmd+V 块 | macOS |
| 253-278 | `build_image_html` | Windows 专用 |
| 280-430 | `write_image_to_clipboard` | Windows Win32 剪切板 |
| 432-494 | `write_files_to_clipboard` | Windows Win32 剪切板 |
| 565-570 | `paste_image` 中的 `#[cfg(windows)]` 块 | Windows 专用 |
| 589-595 | `paste_image` 中的 `#[cfg(macos)]` 块 | macOS |
| 622-628 | `paste_file` 中的 `#[cfg(windows)]` 块 | Windows 专用 |
| 640-646 | `paste_file` 中的 `#[cfg(macos)]` 块 | macOS |
| 所有 `#[cfg(...)]` 注解 | 移除，直接保留 Linux 路径 | 纯 Linux |

保留清单：

| 内容 | 说明 |
|:---|:---|
| `PASTING`、`PasteGuard` | 粘贴互斥锁 |
| `ImageCache` 基础设施 | 图片缓存 |
| `paste_text` 命令 | 文本粘贴（无需改） |
| `paste_image` 命令 | 仅保留 arboard 路径 |
| `paste_file` 命令 | 仅保留 file:// URI 路径 |
| `paste_with_defocus` | 简化为纯 Linux 逻辑 |

### 2.4 `clipboard.rs` — 重写（删除 ~200 行）

删除清单：

| 内容 | 原因 |
|:---|:---|
| `use std::sync::atomic::Ordering` (cfg windows) | Windows 专用 |
| `get_clipboard_image_hash` 函数 | Windows Win32 剪切板 |
| `read_clipboard_image_raw` 函数 | Windows Win32 剪切板 |
| `read_clipboard_files` 函数 | Windows Win32 剪切板 |
| `LAST_CLIPBOARD_FILES_KEY` 上的 `#[cfg(any(...))]` | 直接暴露 |
| `LAST_CLIPBOARD_SEQ` 静态变量 | Windows 序列号 |
| `get_clipboard_sequence` 函数 | Windows 序列号 |
| `sync_monitor_cache` 中 `#[cfg(windows)]` 块 | Windows only |
| `start_monitor` 中 `#[cfg(windows)]` 初始化块 | Windows only |
| `seq_changed` 中的 cfg 分支 | 简化为 `true` |
| 图片检测中的 `#[cfg(windows)]` 和 `#[cfg(macos)]` 块 | 只留 Linux arboard 路径 |
| `image_is_same` 处理中的 `#[cfg(windows)]` 块 | 只留 Linux arboard 路径 |
| `image_recorded` 后面 `#[cfg(windows)]` 文件缓存同步 | Windows only |
| 文件检测中的 `#[cfg(windows)]` 块 | 只留 Linux file:// 路径 |

### 2.5 `shortcut.rs` — 重写（删除 ~200 行）

删除清单：

| 内容 | 原因 |
|:---|:---|
| 所有 `#[cfg(windows)]` import | Windows 专用 |
| `#[cfg(windows)]` 的 `use windows::...` | Windows 专用 |
| `APP_HANDLE`、`HOOK_HANDLE` (cfg windows) | Windows 钩子 |
| `RADIAL_RIGHT_DOWN`、`RADIAL_START_X`、`RADIAL_START_Y`、`LAST_MOVE_EMIT_MS` (cfg windows) | Windows 径向菜单 |
| `MOVE_THROTTLE_MS` 常量 | Windows 鼠标移动节流 |
| `RadialMenuPoint`、`RadialMenuDownPayload` 结构体 | Windows 径向菜单事件 |
| `screen_to_css` 函数 | Windows 坐标转换 |
| `mouse_hook_callback` 函数 | Windows 鼠标钩子 |
| `install_mouse_hook` 中 `#[cfg(windows)]` 块 | 只留 Linux 日志分支 |
| `toggle_window` 中 `#[cfg(windows)]` 块 | 删除焦点管理 |

### 2.6 `lib.rs` — 清理（删除 ~30 行）

删除清单：

| 内容 | 原因 |
|:---|:---|
| `apply_backdrop_effect` 函数（整个 `#[cfg(windows)]` 块） | Windows DWM |
| setup 中的 `#[cfg(windows)]` 窗口初始化块 | Windows DWM + 前台追踪 |
| setup 中 radial 窗口的 `#[cfg(windows)]` 块 | Windows DWM + HWND 注册 |

### 2.7 `tray.rs`、`translator.rs`、`db.rs` — 不改

这些文件使用 Tauri 跨平台 API 或纯 HTTP/SQLite，没有平台特定代码。

## 3. 编译验证

```bash
cargo build --manifest-path src-tauri/Cargo.toml
# 预期: 0 errors, 0 warnings
```

## 4. 改动统计

| 文件 | 预计删除行数 | 预计保留行数 |
|:---|:---|:---|
| `Cargo.toml` | ~12 | ~40 |
| `main.rs` | 1 | 3 |
| `paste.rs` | ~350 | ~300 |
| `clipboard.rs` | ~200 | ~620 |
| `shortcut.rs` | ~200 | ~65 |
| `lib.rs` | ~30 | ~185 |
| **合计** | **~800 行删除** | **~1200 行保留** |
