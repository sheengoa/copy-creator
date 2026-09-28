import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { PasteMode } from "../utils/pasteMode";
import {
  type ThemePreference,
  onSystemThemeChange,
  parseThemePreference,
  resolveTheme,
} from "../utils/theme";

type ThemeMode = ThemePreference;

/** 径向菜单缩放比（百分比），与 Rust 侧 radial_ui_scale 的取值范围保持一致。 */
export const RADIAL_SCALE_MIN = 50;
export const RADIAL_SCALE_MAX = 200;
export const RADIAL_SCALE_DEFAULT = 100;

/** 资源卡片基准宽度（px）：滑块值，列数随窗口自适应的最小列宽。460 为历史默认。 */
export const RESOURCE_CARD_SIZE_MIN = 200;
export const RESOURCE_CARD_SIZE_MAX = 800;
export const RESOURCE_CARD_SIZE_DEFAULT = 460;

export const clampResourceCardSize = (size: number): number =>
  Math.min(
    RESOURCE_CARD_SIZE_MAX,
    Math.max(RESOURCE_CARD_SIZE_MIN, Math.round(size)),
  );

export const parseResourceCardSize = (raw: string | undefined): number => {
  const size = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(size) ? clampResourceCardSize(size) : RESOURCE_CARD_SIZE_DEFAULT;
};

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
  /** 持久化的主题偏好：显式明暗或跟随系统。 */
  themeMode: ThemeMode;
  /** 由偏好与系统深浅色解析出的实际主题，UI 只读这个。 */
  resolvedTheme: "light" | "dark";
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
  resourceCardSize: number;
  /** 主窗口失焦自动隐藏（启动器式行为，默认关）。 */
  autoHideOnBlur: boolean;

  toggleTheme: () => void;
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  loadSettings: () => Promise<void>;
  doLoadSettings: () => Promise<void>;
  setSetting: (key: string, value: string) => Promise<void>;
  setSettingsBatch: (settings: Record<string, string>) => Promise<void>;
  setPasteLeftClick: (mode: PasteMode) => Promise<void>;
  setContentSort: (mode: ContentSortMode) => Promise<void>;
  setResourceCardSize: (size: number) => Promise<void>;
  setAutoHideOnBlur: (enabled: boolean) => Promise<void>;
  setAutostart: (enabled: boolean) => Promise<boolean>;
}

// 设置装载的窗口级缓存：径向菜单窗口没有 App 层的装载流程，各数据层
// 首次加载前都要能拿到已装载的偏好；幂等复用避免重复读表。
let settingsLoadPromise: Promise<void> | null = null;

// 系统深浅色订阅的窗口级单例：订阅一次，跟随系统模式下系统切换时
// 重算 resolvedTheme（App 的 effect 据此重设 data-theme）。
let themeWatcherReady = false;

export const useSettingsStore = create<SettingsState>((set, get) => ({
  themeMode: "light",
  resolvedTheme: "light",
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
  resourceCardSize: RESOURCE_CARD_SIZE_DEFAULT,
  autoHideOnBlur: false,

  // 头部快捷切换：跟随系统模式下取当前解析值的反色落为显式偏好，
  // 其余模式在明暗间往返。
  toggleTheme: () => {
    const next = get().resolvedTheme === "light" ? "dark" : "light";
    void get().setThemeMode(next);
  },

  // 设置主题偏好：持久化并广播事件。事件 payload 携带原始偏好字符串
  // （可能为 "system"），径向/新建窗口各自 resolve 后再应用。
  setThemeMode: async (mode) => {
    set({ themeMode: mode, resolvedTheme: resolveTheme(mode) });
    try {
      await invoke("set_setting", { key: "theme", value: mode });
      await emit("theme-changed", { theme: mode });
    } catch (e) {
      console.error("Failed to save theme:", e);
    }
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
      const themePref = parseThemePreference(settings.theme);

      set({
        themeMode: themePref,
        resolvedTheme: resolveTheme(themePref),
        clipboardRetention: settings.clipboard_retention || "1month",
        language: settings.language || "zh-CN",
        shortcutKey: settings.shortcut_key || "",
        radialShortcutKey: settings.shortcut_radial || "",
        clipboardCreateShortcutKey: settings.shortcut_clipboard_create || "",
        radialMenuEnabled: settings.radial_menu_enabled !== "0",
        radialMenuScale: parseRadialScale(settings.radial_menu_scale),
        pasteLeftClick: (settings.paste_left_click === "terminal" ? "terminal" : "normal") as PasteMode,
        contentSort: parseContentSort(settings.content_sort),
        resourceCardSize: parseResourceCardSize(settings.resource_card_size),
        autoHideOnBlur: settings.auto_hide_on_blur === "1",
      });

      // Read autostart state from the .desktop file
      try {
        const auto = await invoke<boolean>("is_autostart_enabled");
        set({ autostartEnabled: auto });
      } catch { /* command not available (older backend) */ }

      // 跟随系统：订阅本窗口的系统深浅色变化（每窗口各自订阅，
      // 不依赖跨窗口事件；径向/新建窗口在各自组件里同样处理）。
      if (!themeWatcherReady) {
        themeWatcherReady = true;
        onSystemThemeChange(() => {
          if (get().themeMode === "system") {
            set({ resolvedTheme: resolveTheme("system") });
          }
        });
      }
    } catch (e) {
      // 装载失败（后端启动竞态等）不能永久缓存失败结果：清空缓存允许后续
      // 调用重试，并安排一次延迟自愈重试，否则主题/语言/排序整窗回落默认
      // 值直到重启。
      console.error("Failed to load settings, will retry:", e);
      settingsLoadPromise = null;
      window.setTimeout(() => {
        void get().loadSettings();
      }, 2000);
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
        const themePref = parseThemePreference(settings.theme);
        patch.themeMode = themePref;
        patch.resolvedTheme = resolveTheme(themePref);
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

  // 卡片大小：即时生效由组件侧先改本地状态重排，防抖后调本方法持久化。
  setResourceCardSize: async (size: number) => {
    const next = clampResourceCardSize(size);
    set({ resourceCardSize: next });
    try {
      await invoke("set_settings_batch", {
        settings: { resource_card_size: String(next) },
      });
    } catch (e) {
      console.error("Failed to save resource card size:", e);
    }
  },

  // 失焦自动隐藏：即时持久化，App 的焦点监听按最新值生效。
  setAutoHideOnBlur: async (enabled) => {
    set({ autoHideOnBlur: enabled });
    try {
      await invoke("set_setting", { key: "auto_hide_on_blur", value: enabled ? "1" : "0" });
    } catch (e) {
      console.error("Failed to save auto-hide setting:", e);
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
