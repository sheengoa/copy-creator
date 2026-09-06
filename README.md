<div align="right">

[English](./README_EN.md) | 中文

</div>

<div align="center">

<img src="copy-creator/public/logo.png" alt="Copy Creator Logo" width="120">

# Copy Creator

**PC 端效率辅助工具**

剪切板管理 · 内容库 · 快捷短语 · 翻译

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2B%20%7C%20Linux%20(Ubuntu%2024.04)-brightgreen.svg)
![Tauri](https://img.shields.io/badge/Tauri-2.x-ffc131.svg)
![React](https://img.shields.io/badge/React-19-61dafb.svg)

</div>

---

## 项目简介

Copy Creator 是一款轻量级的跨平台桌面效率工具（Windows / Linux），以悬浮窗形式呈现，关闭后自动驻留系统托盘。它集成了剪切板历史管理、内容库、快捷短语和翻译四大核心功能，帮助用户在日常工作中高效地保存、查找和复用内容。

> **致谢**：本项目 Fork 自 [hu-qi-jia/copy-creator](https://github.com/hu-qi-jia/copy-creator)。原项目为 Windows 平台版本，本仓库在其基础上完成了完整的 Linux 适配（包括 Wayland/X11 双协议支持、Ubuntu 原生快捷键集成、剪切板兼容修复等），并恢复 Windows 构建支持，现已双平台可用。感谢原作者的开源贡献！

## 主要功能

### 📋 剪切板管理
- 自动记录文本和图片的复制历史
- 支持关键词搜索，快速定位历史内容
- 一键粘贴到当前光标位置
- 可设置保留时长，自动清理过期记录

### 🗂 内容库（资源）
- 独立的资源库目录（可自定义保存位置），内容即文件，随时可用文件管理器直接打开
- 支持保存文本、图片、链接与各类文件，放入目录中的文件会被自动发现并纳入管理
- 多级分组（子文件夹）管理：新建、重命名、删除、移动分组，分组计数含全部子级
- 内容移动分组：卡片「⋯」菜单、批量选择、详情页「所属分组」三处入口，目标层级自动创建、同名冲突整体取消
- 详情页双击标题即可重命名（自动保留扩展名）
- 备注可直接搜索；图片、音频、视频支持内嵌预览播放，列表缩略图加速浏览

### ⚡ 快捷短语
- 按场景分组管理常用话术和代码片段
- 支持自定义分组，灵活组织内容
- 点击即粘贴，无需手动复制

### 🧭 径向菜单
- 快捷键在鼠标位置弹出快捷面板，含剪切板 / 快捷输入 / 资源三个标签页
- 资源区支持对整个分组批量操作：

  | 手势 | 行为 |
  |:---|:---|
  | 单击分组 | 切换分组浏览 |
  | Shift + 单击分组 | 整组粘贴 |
  | 按住分组拖动 | 原生拖出该组全部文件 |

  整组粘贴语义：分组内全部为文本时合并为一段文本粘贴；包含图片、音视频或其他文件时，整组作为文件列表一次粘贴。
- 带子分组的分组可通过 ▾ 展开子分组导航；列表条目同样支持单击粘贴与按住拖出

### 🌐 翻译
- **AI 翻译**：兼容 OpenAI API 格式，可自定义端点和模型
- **内置翻译**：免费翻译服务，开箱即用
- 翻译结果本地缓存，避免重复请求

### ⚙️ 系统功能
- 全局快捷键唤起/隐藏窗口
- 窗口置顶显示
- 亮色/暗色主题切换
- 开机自启动

## 下载安装

### 系统要求

- Windows 10 及以上，或 Ubuntu 24.04 等兼容的 Linux 发行版
- Linux 侧需要 Wayland（推荐）或 X11 显示服务

### Windows 安装

前往 [Releases](https://github.com/sheengoa/copy-creator/releases) 页面下载并运行 `Copy Creator_x64-setup.exe`（NSIS 安装包）或 `Copy Creator_x64_zh-CN.msi`。全局快捷键由应用内自动注册，无需手动配置。

### 方式一：AppImage（推荐）

前往 [Releases](https://github.com/sheengoa/copy-creator/releases) 页面下载最新 `Copy Creator.AppImage`：

```bash
chmod +x "Copy Creator.AppImage"
./Copy\ Creator.AppImage
```

### 方式二：deb 包

下载 `.deb` 文件后双击安装，或使用命令行：

```bash
sudo dpkg -i copy-creator_*.deb
```

## 操作说明

### 基本使用

1. **启动应用**：安装后从应用菜单启动，或以悬浮窗形式显示
2. **驻留托盘**：关闭窗口后，应用会自动最小化到系统托盘，继续在后台运行
3. **设置全局快捷键**（Ubuntu 原生方式）：

   由于 Wayland 安全限制，全局快捷键需通过系统设置绑定。应用启动后会自动创建 Unix socket，外部脚本可控制应用。

   **步骤**：打开 Ubuntu **设置 → 键盘 → 键盘快捷键 → 自定义快捷键**，添加：

   | 名称 | 命令 | 建议快捷键 |
   |:---|:---|:---|
   | Copy Creator — 窗口 | `path/to/copy-creator-ctl show` | `Ctrl+Shift+V` |
   | Copy Creator — 径向菜单 | `path/to/copy-creator-ctl radial` | `Ctrl+Shift+B` |

   > `copy-creator-ctl` 脚本位于安装目录的 `scripts/` 文件夹中。复制到 `~/.local/bin/` 可直接使用。

### 剪切板功能

1. 复制任意文本或图片，系统会自动记录到剪切板历史
2. 点击托盘图标或使用快捷键打开主窗口
3. 切换到「剪切板」标签页，浏览或搜索历史记录
4. 点击任意记录即可一键粘贴到当前光标位置

### 内容库功能

1. 切换到「资源」标签页；首次使用可在「库设置」中自定义保存目录
2. 点击「新建」保存文本或图片，或直接把文件放进资源库目录（会被自动发现）
3. 通过分组条旁的「管理分组」对话框创建分组与子分组、重命名、移动或删除分组；删除分组时其中内容会保留并移入未分组
4. 通过卡片「⋯」菜单、批量选择或详情页「所属分组」行，把内容移动到其他分组
5. 详情页双击标题重命名文件（扩展名自动保留），备注支持直接搜索
6. 点击卡片进入详情页，确认图片、音视频内容后再使用，避免误用

### 径向菜单功能

1. 触发径向菜单快捷键后在鼠标位置弹出快捷面板，列表条目支持单击粘贴、按住拖出到目标应用
2. 资源区对整个分组批量操作（设计说明）：

   - **单击分组**：切换分组浏览，与主窗口行为一致
   - **Shift + 单击分组**：整组粘贴该组内容到当前输入位置
   - **按住分组拖动**：以原生文件拖拽把该组全部文件拖入文件管理器、聊天窗口等目标应用，光标会携带拖拽数据，松开即完成
   - 拖动与点击通过统一的位移阈值区分，拖拽未成功时窗口保持原状；空分组与「全部」视图不提供批量操作

### 快捷短语功能

1. 切换到「短语」标签页
2. 点击「新建分组」创建场景分组（如：客服话术、代码片段等）
3. 在分组中添加常用短语
4. 需要使用时，点击短语即可粘贴到当前输入位置

### 翻译功能

1. 切换到「翻译」标签页
2. 输入或粘贴需要翻译的文本
3. 选择翻译方向（如：中文 → 英文）
4. 点击翻译按钮获取结果
5. 如需使用 AI 翻译，请在设置中配置 API 端点和密钥

### 个性化设置

- **快捷键**：自定义全局快捷键
- **主题**：切换亮色/暗色主题
- **开机自启**：设置是否开机自动启动
- **存储管理**：配置剪切板历史保留时长

## 技术栈

| 层级 | 技术选型 |
|:---:|:---|
| 桌面框架 | [Tauri 2.x](https://tauri.app/) (Rust) |
| 前端框架 | React 19 + TypeScript |
| 构建工具 | [Vite](https://vitejs.dev/) |
| UI 样式 | 纯 CSS（iOS 风格磨砂玻璃效果） |
| 状态管理 | [Zustand](https://zustand-demo.pmnd.rs/) |
| 本地存储 | SQLite (rusqlite, bundled) |
| 国际化 | react-i18next（简体中文 / English） |

## 开发指南

### 环境准备

- [Node.js](https://nodejs.org/) (推荐 18+)
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/)
- [Tauri CLI](https://tauri.app/)
- Linux 系统依赖：

```bash
# Ubuntu 24.04
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev libxdo-dev xdotool xclip
```

### 本地开发

```bash
# 克隆项目
git clone https://github.com/sheengoa/copy-creator.git
cd copy-creator/copy-creator

# 安装依赖
pnpm install

# 启动开发模式
pnpm tauri dev

# 构建生产版本
pnpm tauri build
```

## 项目结构

```
copy-creator/
├── src/                    # 前端源码
│   ├── components/         # React 组件（含径向菜单 RadialMenu）
│   ├── pages/              # 页面组件（剪切板 / 短语 / 资源 / 翻译）
│   ├── stores/             # Zustand 状态管理
│   ├── styles/             # CSS 样式文件
│   ├── i18n/               # 国际化配置
│   ├── utils/              # 工具函数
│   └── types/              # TypeScript 类型定义
├── src-tauri/              # Tauri 后端源码
│   ├── src/                # Rust 源码（剪切板、资源库、文件拖拽、粘贴等模块）
│   └── Cargo.toml          # Rust 依赖配置
├── public/                 # 静态资源
└── package.json            # 前端依赖配置
```

## 许可证

本项目采用 [MIT 许可证](LICENSE) 开源。

---

<div align="center">

如果觉得这个项目对你有帮助，欢迎点个 Star 支持一下！

---

Forked from [hu-qi-jia/copy-creator](https://github.com/hu-qi-jia/copy-creator) · 原项目作者 Windows 版本 · 本仓库已完成 Linux 适配并支持 Windows / Linux 双平台

感谢 [baihejiangnan](https://github.com/baihejiangnan) 的贡献！

</div>
