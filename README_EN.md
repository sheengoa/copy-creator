<div align="right">

English | [中文](./README.md)

</div>

<div align="center">

<img src="copy-creator/public/logo.png" alt="Copy Creator Logo" width="120">

# Copy Creator

**Desktop Productivity Tool for Linux**

Clipboard Manager · Quick Phrases · Translation

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Linux%20(Ubuntu%2024.04)-brightgreen.svg)
![Tauri](https://img.shields.io/badge/Tauri-2.x-ffc131.svg)
![React](https://img.shields.io/badge/React-19-61dafb.svg)

</div>

---

## Overview

Copy Creator is a lightweight Linux desktop productivity tool that appears as a floating window and minimizes to the system tray when closed. It integrates three core features: clipboard history management, quick phrases, and translation, helping users improve text processing efficiency in their daily work.

## Features

### 📋 Clipboard Manager
- Automatically records text and image copy history
- Keyword search for quick access to historical content
- One-click paste to the current cursor position
- Configurable retention period with automatic cleanup

### ⚡ Quick Phrases
- Organize common phrases and code snippets by scenario groups
- Customizable groups for flexible content organization
- Click to paste directly without manual copying

### 🌐 Translation
- **AI Translation**: Compatible with OpenAI API format, customizable endpoint and model
- **Built-in Translation**: Free translation service, ready to use out of the box
- Local caching of translation results to avoid redundant requests

### ⚙️ System Features
- Global hotkey to show/hide window
- Window always-on-top display
- Light/Dark theme switching
- Launch at system startup

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

## Download

### System Requirements

- Ubuntu 24.04 or compatible Linux distribution
- Wayland (recommended) or X11 display server

### Option 1: AppImage (Recommended)

Go to the [Releases](https://github.com/hu-qi-jia/copy-creator/releases) page and download the latest `Copy Creator.AppImage`:

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
  libayatana-appindicator3-dev libxdo-dev
```

### Local Development

```bash
# Clone the repository
git clone https://github.com/hu-qi-jia/copy-creator.git
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
│   ├── components/         # React components
│   ├── pages/              # Page components
│   ├── stores/             # Zustand state management
│   ├── styles/             # CSS style files
│   ├── i18n/               # Internationalization config
│   └── types/              # TypeScript type definitions
├── src-tauri/              # Tauri backend source code
│   ├── src/                # Rust source code
│   └── Cargo.toml          # Rust dependency config
├── public/                 # Static assets
└── package.json            # Frontend dependency config
```

## License

This project is licensed under the [MIT License](LICENSE).

---

<div align="center">

If you find this project helpful, feel free to give it a Star!

</div>
