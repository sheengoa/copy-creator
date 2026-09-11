import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { PasteMode } from "../utils/pasteMode";

type ThemeMode = "light" | "dark";

/** 径向菜单缩放比（百分比），与 Rust 侧 radial_ui_scale 的取值范围保持一致。 */
export const RADIAL_SCALE_MIN = 50;
export const RADIAL_SCALE_MAX = 200;
export const RADIAL_SCALE_DEFAULT = 100;

/** 内容列表排序偏好：最近使用（默认）| 最多使用。作用于剪切板、资源、快捷输入主列表。 */
export type ContentSortMode = "recent" | "count";

export const parseContentSort = (raw: string | undefined): ContentSortMode =>
  raw === "count" ? "count" : "recent";

export const clampRadialScale = (percent: number): number =>
  Math.min(RADIAL_SCALE_MAX, Math.max(RADIAL_SCALE_MIN, Math.round(percent)));

const parseRadialScale = (raw: string | undefined): number => {
  const percent = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(percent) ? clampRadialScale(percent) : RADIAL_SCALE_DEFAULT;
};

interface SettingsState {
  themeMode: ThemeMode;
  clipboardRetention: string;
  language: string;
  shortcutKey: string;
  radialShortcutKey: string;
  clipboardCreateShortcutKey: string;
  radialMenuEnabled: boolean;
  radialMenuScale: number;
  autostartEnabled: boolean;
  pasteLeftClick: PasteMode;
  contentSort: ContentSortMode;

  toggleTheme: () => void;
  loadSettings: () => Promise<void>;
  doLoadSettings: () => Promise<void>;
  setSetting: (key: string, value: string) => Promise<void>;
  setSettingsBatch: (settings: Record<string, string>) => Promise<void>;
  setPasteLeftClick: (mode: PasteMode) => Promise<void>;
  setContentSort: (mode: ContentSortMode) => Promise<void>;
  setAutostart: (enabled: boolean) => Promise<boolean>;
}

// 设置装载的窗口级缓存：径向菜单窗口没有 App 层的装载流程，各数据层
// 首次加载前都要能拿到已装载的偏好；幂等复用避免重复读表。
let settingsLoadPromise: Promise<void> | null = null;

export const useSettingsStore = create<SettingsState>((set, get) => ({
  themeMode: "light",
  clipboardRetention: "1month",
  language: "zh-CN",
  shortcutKey: "",
  radialShortcutKey: "",
  clipboardCreateShortcutKey: "",
  radialMenuEnabled: true,
  radialMenuScale: RADIAL_SCALE_DEFAULT,
  autostartEnabled: false,
  pasteLeftClick: "normal",
  contentSort: "recent",

  toggleTheme: () => {
    const next = get().themeMode === "light" ? "dark" : "light";
    set({ themeMode: next });
    // Persist to DB so radial menu reads the correct theme on re-open
    get().setSetting("theme", next);
    emit("theme-changed", { theme: next });
  },

  // 窗口级幂等装载：首次真正读表，之后复用同一 Promise。
  // 供主窗口 App 与各数据层（含径向菜单窗口）在首次加载前 await。
  loadSettings: () => {
    if (!settingsLoadPromise) {
      settingsLoadPromise = get().doLoadSettings();
    }
    return settingsLoadPromise;
  },

  doLoadSettings: async () => {
    try {
      const settings = await invoke<Record<string, string>>("get_all_settings");

      set({
        themeMode: (settings.theme === "dark" ? "dark" : "light") as ThemeMode,
        clipboardRetention: settings.clipboard_retention || "1month",
        language: settings.language || "zh-CN",
        shortcutKey: settings.shortcut_key || "",
        radialShortcutKey: settings.shortcut_radial || "",
        clipboardCreateShortcutKey: settings.shortcut_clipboard_create || "",
        radialMenuEnabled: settings.radial_menu_enabled !== "0",
        radialMenuScale: parseRadialScale(settings.radial_menu_scale),
        pasteLeftClick: (settings.paste_left_click === "terminal" ? "terminal" : "normal") as PasteMode,
        contentSort: parseContentSort(settings.content_sort),
      });

      // Read autostart state from the .desktop file
      try {
        const auto = await invoke<boolean>("is_autostart_enabled");
        set({ autostartEnabled: auto });
      } catch { /* command not available (older backend) */ }
    } catch {
      // Settings not yet initialized, use defaults
    }
  },

  setSetting: async (key: string, value: string) => {
    try {
      await invoke("set_setting", { key, value });
      const patch: Partial<SettingsState> = {};
      if (key === "shortcut_key") patch.shortcutKey = value;
      if (key === "shortcut_radial") patch.radialShortcutKey = value;
      if (key === "shortcut_clipboard_create") patch.clipboardCreateShortcutKey = value;
      if (key === "radial_menu_scale") patch.radialMenuScale = parseRadialScale(value);
      if (Object.keys(patch).length > 0) set(patch);
    } catch (e) {
      console.error("Failed to save setting:", e);
    }
  },

  setSettingsBatch: async (settings: Record<string, string>) => {
    try {
      await invoke("set_settings_batch", { settings });
      // 同步更新本地 state，避免 UI 组件读到旧值
      const patch: Partial<SettingsState> = {};
      if ("theme" in settings) {
        patch.themeMode = (settings.theme === "dark" ? "dark" : "light") as ThemeMode;
      }
      if ("clipboard_retention" in settings) {
        patch.clipboardRetention = settings.clipboard_retention || "1month";
      }
      if ("language" in settings) patch.language = settings.language || "zh-CN";
      if ("radial_menu_scale" in settings) {
        patch.radialMenuScale = parseRadialScale(settings.radial_menu_scale);
        // 通知径向菜单窗口即时切换 zoom（该窗口不挂载设置页，只能靠事件同步）。
        // payload 与 Rust 侧 radial-menu-show 的 scale 语义一致：小数系数。
        void emit("radial-scale-changed", { scale: patch.radialMenuScale / 100 });
      }
      if ("paste_left_click" in settings) {
        patch.pasteLeftClick = (settings.paste_left_click === "terminal" ? "terminal" : "normal") as PasteMode;
      }
      if (Object.keys(patch).length > 0) set(patch);
    } catch (e) {
      console.error("Failed to batch save settings:", e);
    }
  },

  setPasteLeftClick: async (mode: PasteMode) => {
    set({ pasteLeftClick: mode });
    try {
      await invoke("set_settings_batch", { settings: { paste_left_click: mode } });
    } catch (e) {
      console.error("Failed to save paste setting:", e);
    }
  },

  // 排序偏好切换：持久化后广播事件，两个窗口的 clipboardStore / phraseStore
  // 实例各自监听并按新排序重载当前视图（emit 对本窗口同样可见）。
  setContentSort: async (mode: ContentSortMode) => {
    set({ contentSort: mode });
    try {
      await invoke("set_settings_batch", { settings: { content_sort: mode } });
      await emit("content-sort-changed", { sortBy: mode });
    } catch (e) {
      console.error("Failed to save content sort setting:", e);
    }
  },

  setAutostart: async (enabled: boolean) => {
    try {
      const result = await invoke<boolean>("set_autostart", { enabled });
      // Only update state if the backend confirmed success
      set({ autostartEnabled: result === enabled });
      return result === enabled;
    } catch (e) {
      console.error("Failed to set autostart:", e);
      // Do NOT set autostartEnabled=true on failure — the caller
      // should surface the error to the user
      throw e;
    }
  },
}));
