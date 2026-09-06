<div align="right">

English | [中文](./README.md)

</div>

<div align="center">

<img src="copy-creator/public/logo.png" alt="Copy Creator Logo" width="120">

# Copy Creator

**Desktop Productivity Tool for Windows & Linux**

Clipboard Manager · Content Library · Quick Phrases · Translation

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2B%20%7C%20Linux%20(Ubuntu%2024.04)-brightgreen.svg)
![Tauri](https://img.shields.io/badge/Tauri-2.x-ffc131.svg)
![React](https://img.shields.io/badge/React-19-61dafb.svg)

</div>

---

## Overview

Copy Creator is a lightweight cross-platform (Windows / Linux) desktop productivity tool that appears as a floating window and minimizes to the system tray when closed. It integrates four core features: clipboard history management, a content library, quick phrases, and translation, helping users save, find, and reuse content efficiently in their daily work.

> **Acknowledgement**: This project is forked from [hu-qi-jia/copy-creator](https://github.com/hu-qi-jia/copy-creator). The original project was Windows-only. This repository is a complete Linux adaptation (including Wayland/X11 dual protocol support, Ubuntu native shortcut integration, clipboard compatibility fixes, and more) with Windows build support restored, now available on both platforms. Thanks to the original author for the open-source contribution!

## Features

### 📋 Clipboard Manager
- Automatically records text and image copy history
- Keyword search for quick access to historical content
- One-click paste to the current cursor position
- Configurable retention period with automatic cleanup

### 🗂 Content Library (Resources)
- A dedicated library folder (customizable location) where content is stored as plain files — open it with any file manager at any time
- Save text, images, links, and files; files placed into the folder are discovered and managed automatically
- Multi-level grouping (subfolders): create, rename, move, and delete groups, with group counts including all descendants
- Move content between groups from three entry points: the card "⋯" menu, batch selection, and the detail page "Group" row — missing target folders are created automatically and name conflicts cancel the whole move
- Double-click the title on the detail page to rename a file (extension preserved automatically)
- Notes participate in search; images, audio, and video support inline preview and playback, with thumbnails for fast browsing

### ⚡ Quick Phrases
- Organize common phrases and code snippets by scenario groups
- Customizable groups for flexible content organization
- Click to paste directly without manual copying

### 🧭 Radial Menu
- A quick panel pops up at the mouse cursor, with Clipboard / Phrases / Resources tabs
- The Resources tab supports batch operations on a whole group:

  | Gesture | Action |
  |:---|:---|
  | Click a group | Switch to that group |
  | Shift + click a group | Paste the whole group |
  | Hold and drag a group | Natively drag all files of that group out |

  Paste-group semantics: when a group contains only text, everything is merged into a single text paste; when it contains images, audio/video, or other files, the whole group is pasted at once as a file list.
- Groups with subfolders can be expanded via ▾ for subfolder navigation; list items also support click-to-paste and hold-to-drag

### 🌐 Translation
- **AI Translation**: Compatible with OpenAI API format, customizable endpoint and model
- **Built-in Translation**: Free translation service, ready to use out of the box
- Local caching of translation results to avoid redundant requests

### ⚙️ System Features
- Global hotkey to show/hide window
- Window always-on-top display
- Light/Dark theme switching
- Launch at system startup

## Download

### System Requirements

- Windows 10 or later, or Ubuntu 24.04 / compatible Linux distribution
- Linux requires Wayland (recommended) or X11 display server

### Windows Installation

Download and run `Copy Creator_x64-setup.exe` (NSIS installer) or `Copy Creator_x64_zh-CN.msi` from the [Releases](https://github.com/sheengoa/copy-creator/releases) page. Global shortcuts are registered by the app automatically — no manual setup needed.

### Option 1: AppImage (Recommended)

Go to the [Releases](https://github.com/sheengoa/copy-creator/releases) page and download the latest `Copy Creator.AppImage`:

```bash
chmod +x "Copy Creator.AppImage"
./Copy\ Creator.AppImage
```

### Option 2: deb Package

Download the `.deb` file and install via double-click or command line:

```bash
sudo dpkg -i copy-creator_*.deb
```

## Usage Guide

### Getting Started

1. **Launch the App**: Launch from the application menu after installation, the app will appear as a floating window
2. **System Tray**: When you close the window, the app automatically minimizes to the system tray and continues running in the background
3. **Show Window**: Use the global hotkey (configurable in settings) to quickly show/hide the window
4. **Quick Menu**: Set an independent global hotkey to open a quick menu at the mouse cursor for fast selection and pasting

### Clipboard Feature

1. Copy any text or image, and the system will automatically record it to clipboard history
2. Click the tray icon or use the hotkey to open the main window
3. Switch to the "Clipboard" tab to browse or search history
4. Click any record to paste it directly to the current cursor position

### Content Library Feature

1. Switch to the "Resources" tab; set your own library folder under "Library Settings" on first use
2. Click "New" to save text or images, or simply place files into the library folder (they are discovered automatically)
3. Use the "Manage Groups" dialog next to the group bar to create groups and subfolders, rename, move, or delete groups; deleting a group keeps its content and moves it to Ungrouped
4. Move content to another group via the card "⋯" menu, batch selection, or the "Group" row on the detail page
5. Double-click the title on the detail page to rename the file (extension preserved); notes are searchable
6. Open a card's detail page to review images or play audio/video before using it

### Radial Menu Feature

1. Trigger the radial menu hotkey to open the quick panel at the cursor; list items support click-to-paste and hold-to-drag into target apps
2. Batch operations on a whole group in the Resources tab (design notes):

   - **Click a group**: switch to that group, same as the main window
   - **Shift + click a group**: paste the whole group at the current input position
   - **Hold and drag a group**: natively drag all files of that group into a file manager, chat window, or other target app — the cursor carries the drag data and dropping completes the action
   - Dragging and clicking are distinguished by a unified movement threshold; empty groups and the "All" view offer no batch operations

### Quick Phrases Feature

1. Switch to the "Phrases" tab
2. Click "New Group" to create scenario groups (e.g., customer service scripts, code snippets)
3. Add commonly used phrases to the group
4. When needed, click a phrase to paste it to the current input position

### Translation Feature

1. Switch to the "Translation" tab
2. Enter or paste the text to translate
3. Select translation direction (e.g., Chinese → English)
4. Click the translate button to get results
5. For AI translation, please configure the API endpoint and key in settings

### Personalization Settings

- **Hotkeys**: Customize global hotkeys
- **Theme**: Switch between light and dark themes
- **Launch at Startup**: Enable or disable auto-start on boot
- **Storage Management**: Configure clipboard history retention period

## Tech Stack

| Layer | Technology |
|:---:|:---|
| Desktop Framework | [Tauri 2.x](https://tauri.app/) (Rust) |
| Frontend Framework | React 19 + TypeScript |
| Build Tool | [Vite](https://vitejs.dev/) |
| UI Styling | Pure CSS (iOS-style frosted glass effect) |
| State Management | [Zustand](https://zustand-demo.pmnd.rs/) |
| Local Storage | SQLite (rusqlite, bundled) |
| Internationalization | react-i18next (Simplified Chinese / English) |

## Development Guide

### Prerequisites

- [Node.js](https://nodejs.org/) (18+ recommended)
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/)
- [Tauri CLI](https://tauri.app/)
- Linux system dependencies:

```bash
# Ubuntu 24.04
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev libxdo-dev xdotool xclip
```

### Local Development

```bash
# Clone the repository
git clone https://github.com/sheengoa/copy-creator.git
cd copy-creator/copy-creator

# Install dependencies
pnpm install

# Start development mode
pnpm tauri dev

# Build for production
pnpm tauri build
```

## Project Structure

```
copy-creator/
├── src/                    # Frontend source code
│   ├── components/         # React components (incl. RadialMenu)
│   ├── pages/              # Page components (Clipboard / Phrases / Resources / Translation)
│   ├── stores/             # Zustand state management
│   ├── styles/             # CSS style files
│   ├── i18n/               # Internationalization config
│   ├── utils/              # Utility functions
│   └── types/              # TypeScript type definitions
├── src-tauri/              # Tauri backend source code
│   ├── src/                # Rust source code (clipboard, resource library, file drag, paste, etc.)
│   └── Cargo.toml          # Rust dependency config
├── public/                 # Static assets
└── package.json            # Frontend dependency config
```

## License

This project is licensed under the [MIT License](LICENSE).

---

<div align="center">

If you find this project helpful, feel free to give it a Star!

---

Forked from [hu-qi-jia/copy-creator](https://github.com/hu-qi-jia/copy-creator) · Original Windows version · This repo is a Linux adaptation with Windows & Linux support

Thanks to [baihejiangnan](https://github.com/baihejiangnan) for the contribution!

</div>
