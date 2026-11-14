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
import {
  FIND_HISTORY_SETTING_KEY,
  parseFindHistory,
  serializeFindHistory,
  type FindHistoryEntry,
} from "../utils/findHistory";

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

/** 画布 AI 生图渠道：一个条目 = 一组 Base URL + Key，测速与故障状态随条目持久化。 */
export interface AiChannel {
  id: string;
  name: string;
  protocol: "openai" | "gemini";
  baseUrl: string;
  /** Key 掩码（后端只回掩码不回明文），前端编辑留空表示不修改。 */
  apiKeyPreview: string;
  apiKeySet: boolean;
  model: string;
  price: number | null;
  currency: string;
  enabled: boolean;
  /** normal = 可用；auto_disabled = 鉴权/欠费类错误命中后自动停用。 */
  status: "normal" | "auto_disabled";
  lastError: string;
  lastLatencyMs: number | null;
  lastTestedAt: string;
  /** 限流（429）冷却截止（epoch ms），到期自动恢复参与调度；手动恢复或
   *  测速成功即清零。超时不冷却（2026-11-06：单次超时锁渠道 5 分钟是
   *  把用户锁在门外，改为仅记录错误文案）。 */
  cooldownUntilMs: number;
  sortOrder: number;
  /** 渠道级代理（http(s):// 或 socks5://）；空 = 回退全局 ai_proxy，两级都空 = 直连。 */
  proxy: string;
}

export type AiStrategy = "manual" | "latency" | "price" | "balance";

export interface AiChannelInput {
  name: string;
  protocol: "openai" | "gemini";
  baseUrl: string;
  /** 新建必填；编辑传 null 表示保留原 Key。 */
  apiKey: string | null;
  model: string;
  price: number | null;
  currency: string;
  /** 渠道级代理地址（空串 = 清除，回退全局默认）。 */
  proxy: string;
}

export const parseAiStrategy = (raw: string | undefined): AiStrategy =>
  raw === "manual" || raw === "latency" || raw === "price" || raw === "balance" ? raw : "balance";

const clampWeight = (raw: string | undefined): number => {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 40;
};

const clampCooldown = (raw: string | undefined): number => {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.min(3600, Math.max(5, n)) : 300;
};

const clampConcurrency = (raw: string | undefined): number => {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.min(8, Math.max(1, n)) : 4;
};

export const parseContentSort = (raw: string | undefined): ContentSortMode =>
  raw === "count" ? "count" : "recent";

export const clampRadialScale = (percent: number): number =>
  Math.min(RADIAL_SCALE_MAX, Math.max(RADIAL_SCALE_MIN, Math.round(percent)));

const parseRadialScale = (raw: string | undefined): number => {
  const percent = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(percent) ? clampRadialScale(percent) : RADIAL_SCALE_DEFAULT;
};

/** 历史条数上限解析：非法/缺失按不限（0）处理，负值钳到不限。 */
export const parseMaxRecords = (raw: string | undefined): number => {
  const value = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
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
  /** 采集暂停（托盘/设置页可切）：暂停期间复制内容完全不记录。 */
  clipboardPaused: boolean;
  /** 历史条数上限（0=不限），随保留期清理一同生效。 */
  clipboardMaxRecords: number;
  /** 排除规则原文（每行一条关键字，匹配来源标题/进程名）。 */
  clipboardExclusions: string;
  /** 查找替换历史（全局共享，资源详情页与新建内容窗口共用）。 */
  findReplaceHistory: FindHistoryEntry[];
  /** 画布 AI 默认模型与超时（画布设置页「生成默认值」，节点参数可覆盖）。 */
  aiModel: string;
  aiTimeout: number;
  /** 画布 AI 全局默认代理：渠道未配 proxy 时回退到此；空 = 直连。 */
  aiProxy: string;
  /** 画布 AI 渠道与调度（画布设置页，自持久化）。 */
  aiChannels: AiChannel[];
  aiStrategy: AiStrategy;
  aiBalancePriceWeight: number;
  aiFailover: boolean;
  aiAutoDisableAuth: boolean;
  aiRateLimitCooldown: number;
  aiConcurrency: number;
  aiManualChannelId: string;

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
  setClipboardPaused: (enabled: boolean) => Promise<void>;
  setLanguage: (lang: string) => Promise<void>;
  setClipboardMaxRecords: (max: number) => Promise<void>;
  setClipboardExclusions: (raw: string) => Promise<void>;
  /** 函数式更新查找替换历史：持久化并广播跨窗口同步事件。 */
  setFindReplaceHistory: (update: (prev: FindHistoryEntry[]) => FindHistoryEntry[]) => Promise<void>;
  setAutostart: (enabled: boolean) => Promise<boolean>;
  /** AI 生图配置：批量落库并同步本 store 字段（自持久化分区，不走统一保存按钮）。 */
  saveAiSettings: (patch: {
    aiModel?: string;
    aiProxy?: string;
    aiTimeout?: number;
  }) => Promise<void>;
  /** 画布 AI 渠道：重取列表（画布设置页挂载时调用）。 */
  loadAiChannels: () => Promise<void>;
  createAiChannel: (input: AiChannelInput) => Promise<void>;
  updateAiChannel: (id: string, input: AiChannelInput) => Promise<void>;
  deleteAiChannel: (id: string) => Promise<void>;
  reorderAiChannels: (ids: string[]) => Promise<void>;
  setAiChannelEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** 手动恢复渠道故障状态（清自动停用/限流冷却，不动开关与测速记录）。 */
  restoreAiChannel: (id: string) => Promise<void>;
  /** 单渠道测速：真实发一次最小生图请求，结果（延迟/错误）写回列表。 */
  testAiChannel: (id: string) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  /** 调度策略与故障处理：settings 批量落库 + 本地同步。 */
  saveAiScheduling: (patch: {
    aiStrategy?: AiStrategy;
    aiBalancePriceWeight?: number;
    aiFailover?: boolean;
    aiAutoDisableAuth?: boolean;
    aiRateLimitCooldown?: number;
    aiConcurrency?: number;
    aiManualChannelId?: string;
  }) => Promise<void>;
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
  clipboardPaused: false,
  clipboardMaxRecords: 0,
  clipboardExclusions: "",
  findReplaceHistory: [],
  aiModel: "",
  aiProxy: "",
  // 与后端默认一致（生图请求分钟级量级，60s 是文本对话量级会掐断多张生成）。
  aiTimeout: 300,
  aiChannels: [],
  aiStrategy: "balance",
  aiBalancePriceWeight: 40,
  aiFailover: false,
  aiAutoDisableAuth: true,
  aiRateLimitCooldown: 300,
  aiConcurrency: 4,
  aiManualChannelId: "",

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
      const settings = await invoke<Record<string, string>>("list_all_settings");
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
        clipboardPaused: settings.clipboard_paused === "1",
        clipboardMaxRecords: parseMaxRecords(settings.clipboard_max_records),
        clipboardExclusions: settings.clipboard_exclusions || "",
        findReplaceHistory: parseFindHistory(settings.find_replace_history),
        aiModel: settings.ai_model || "",
        aiProxy: settings.ai_proxy || "",
        aiTimeout: Number.parseInt(settings.ai_timeout || "300", 10) || 300,
        aiStrategy: parseAiStrategy(settings.ai_strategy),
        aiBalancePriceWeight: clampWeight(settings.ai_balance_price_weight),
        aiFailover: settings.ai_failover === "1",
        aiAutoDisableAuth: settings.ai_auto_disable_auth !== "0",
        aiRateLimitCooldown: clampCooldown(settings.ai_rate_limit_cooldown),
        aiConcurrency: clampConcurrency(settings.ai_concurrency),
        aiManualChannelId: settings.ai_manual_channel_id || "",
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

  // 采集暂停：持久化并广播（托盘菜单文案、剪切板页提示条都会跟随）。
  // 事件 payload 与 Rust 侧 tray toggle 的语义一致。
  setClipboardPaused: async (enabled) => {
    set({ clipboardPaused: enabled });
    try {
      await invoke("set_setting", { key: "clipboard_paused", value: enabled ? "1" : "0" });
      await emit("clipboard-pause-changed", { paused: enabled });
    } catch (e) {
      console.error("Failed to save capture pause:", e);
    }
  },

  // 语言切换：持久化 + patch 本窗口 store.language + 广播 language-changed
  // （径向菜单/新建窗口监听后各自 changeLanguage）+ 托盘菜单文案跟随。
  // 语义对齐 SettingsContent 保存按钮流程（i18n.changeLanguage 由调用方
  // 组件负责，store 不管 i18n 实例）。此前 GeneralSection 即时切换走
  // setSetting("language")，只落库不 patch 不广播——本窗口 store 过期、
  // 其他窗口与托盘语言不跟手。
  setLanguage: async (lang) => {
    set({ language: lang });
    try {
      await invoke("set_setting", { key: "language", value: lang });
      await emit("language-changed", { language: lang });
      await invoke("update_tray_language");
    } catch (e) {
      console.error("Failed to save language setting:", e);
    }
  },

  setClipboardMaxRecords: async (max) => {
    const value = Math.max(0, Math.round(max));
    set({ clipboardMaxRecords: value });
    try {
      await invoke("set_setting", { key: "clipboard_max_records", value: String(value) });
    } catch (e) {
      console.error("Failed to save max records:", e);
    }
  },

  // 排除规则：文本域失焦时整体保存，后端采集循环按行解析。
  setClipboardExclusions: async (raw) => {
    set({ clipboardExclusions: raw });
    try {
      await invoke("set_setting", { key: "clipboard_exclusions", value: raw });
    } catch (e) {
      console.error("Failed to save exclusion rules:", e);
    }
  },

  // 查找替换历史：函数式更新（执行时读最新 state，快速连续操作不丢条目）。
  // 更新器返回同引用视为无变化，跳过写库与广播（连按 Enter 导航不抖动）。
  // 持久化后广播事件；其余窗口由 useFindReplaceHistory 的监听同步，
  // 本窗口监听也会收到但 setState 同值幂等，无副作用。
  setFindReplaceHistory: async (update) => {
    const prev = get().findReplaceHistory;
    const next = update(prev);
    if (next === prev) return;
    set({ findReplaceHistory: next });
    try {
      await invoke("set_setting", { key: FIND_HISTORY_SETTING_KEY, value: serializeFindHistory(next) });
      await emit("find-replace-history-changed", { entries: next });
    } catch (e) {
      console.error("Failed to save find/replace history:", e);
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

  saveAiSettings: async (patch) => {
    const payload: Record<string, string> = {};
    if (patch.aiModel !== undefined) payload.ai_model = patch.aiModel;
    if (patch.aiProxy !== undefined) payload.ai_proxy = patch.aiProxy;
    if (patch.aiTimeout !== undefined) payload.ai_timeout = String(patch.aiTimeout);
    try {
      await invoke("set_settings_batch", { settings: payload });
      const next: Partial<SettingsState> = {};
      if (patch.aiModel !== undefined) next.aiModel = patch.aiModel;
      if (patch.aiProxy !== undefined) next.aiProxy = patch.aiProxy;
      if (patch.aiTimeout !== undefined) next.aiTimeout = patch.aiTimeout;
      if (Object.keys(next).length > 0) set(next);
    } catch (e) {
      console.error("Failed to save AI settings:", e);
    }
  },

  // ── 画布 AI 渠道：CRUD 直连 Rust 命令，成功后以返回列表整体替换 ──

  loadAiChannels: async () => {
    try {
      const channels = await invoke<AiChannel[]>("list_ai_channels");
      // mock 等验证环境可能对未实现命令返回 null，防御回空数组。
      set({ aiChannels: Array.isArray(channels) ? channels : [] });
    } catch (e) {
      console.error("Failed to load AI channels:", e);
    }
  },

  createAiChannel: async (input) => {
    const channels = await invoke<AiChannel[]>("create_ai_channel", {
      name: input.name,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey ?? "",
      model: input.model,
      price: input.price,
      currency: input.currency,
      proxy: input.proxy,
    });
    set({ aiChannels: channels });
  },

  updateAiChannel: async (id, input) => {
    const channels = await invoke<AiChannel[]>("update_ai_channel", {
      id,
      name: input.name,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey ?? null,
      model: input.model,
      price: input.price,
      currency: input.currency,
      proxy: input.proxy,
    });
    set({ aiChannels: channels });
  },

  deleteAiChannel: async (id) => {
    await invoke("delete_ai_channel", { id });
    set({ aiChannels: get().aiChannels.filter((c) => c.id !== id) });
  },

  reorderAiChannels: async (ids) => {
    set({ aiChannels: ids.map((id) => get().aiChannels.find((c) => c.id === id)).filter(Boolean) as AiChannel[] });
    try {
      await invoke("reorder_ai_channels", { ids });
    } catch (e) {
      console.error("Failed to reorder AI channels:", e);
      void get().loadAiChannels();
    }
  },

  setAiChannelEnabled: async (id, enabled) => {
    set({
      aiChannels: get().aiChannels.map((c) =>
        c.id === id
          ? {
              ...c,
              enabled,
              status: enabled ? ("normal" as const) : c.status,
              lastError: enabled ? "" : c.lastError,
              cooldownUntilMs: enabled ? 0 : c.cooldownUntilMs,
            }
          : c,
      ),
    });
    try {
      await invoke("set_ai_channel_enabled", { id, enabled });
    } catch (e) {
      console.error("Failed to toggle AI channel:", e);
      void get().loadAiChannels();
    }
  },

  // 手动恢复渠道故障状态（自动停用/限流冷却）：乐观清三态，失败回滚重载。
  // 不动 enabled 与测速记录，与后端 restore_ai_channel 同语义。
  restoreAiChannel: async (id) => {
    set({
      aiChannels: get().aiChannels.map((c) =>
        c.id === id
          ? { ...c, status: "normal" as const, lastError: "", cooldownUntilMs: 0 }
          : c,
      ),
    });
    try {
      await invoke("restore_ai_channel", { id });
    } catch (e) {
      console.error("Failed to restore AI channel:", e);
      void get().loadAiChannels();
    }
  },

  testAiChannel: async (id) => {
    let result: { ok: boolean; latencyMs?: number; error?: string };
    try {
      result = await invoke<{ ok: boolean; latencyMs?: number; error?: string }>(
        "ai_test_channel",
        { channelId: id },
      );
    } catch (e) {
      // 命令级失败（后端缺命令/参数被拒等）不会产生后端测速记录，静默吞掉
      // 会让行首状态与徽标纹丝不动（2026-11-01 旧后端实例点测速无任何反应
      // 即此因）。走与 HTTP 失败同一显示路径：写入 lastError → 行首红点 +
      // 「测速失败」tooltip 见错误；不落库，重载后回到「未测试」。
      const message = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      set({
        aiChannels: get().aiChannels.map((c) => (c.id === id ? { ...c, lastError: message } : c)),
      });
      return { ok: false, error: message };
    }
    set({
      aiChannels: get().aiChannels.map((c) =>
        c.id === id
          ? {
              ...c,
              lastLatencyMs: result.ok ? (result.latencyMs ?? null) : c.lastLatencyMs,
              lastTestedAt: result.ok ? new Date().toISOString() : c.lastTestedAt,
              status: result.ok ? ("normal" as const) : c.status,
              lastError: result.ok ? "" : (result.error ?? ""),
            }
          : c,
      ),
    });
    return result;
  },

  saveAiScheduling: async (patch) => {
    const payload: Record<string, string> = {};
    if (patch.aiStrategy !== undefined) payload.ai_strategy = patch.aiStrategy;
    if (patch.aiBalancePriceWeight !== undefined) payload.ai_balance_price_weight = String(patch.aiBalancePriceWeight);
    if (patch.aiFailover !== undefined) payload.ai_failover = patch.aiFailover ? "1" : "0";
    if (patch.aiAutoDisableAuth !== undefined) payload.ai_auto_disable_auth = patch.aiAutoDisableAuth ? "1" : "0";
    if (patch.aiRateLimitCooldown !== undefined) payload.ai_rate_limit_cooldown = String(patch.aiRateLimitCooldown);
    if (patch.aiConcurrency !== undefined) payload.ai_concurrency = String(patch.aiConcurrency);
    if (patch.aiManualChannelId !== undefined) payload.ai_manual_channel_id = patch.aiManualChannelId;
    try {
      await invoke("set_settings_batch", { settings: payload });
      const next: Partial<SettingsState> = {};
      if (patch.aiStrategy !== undefined) next.aiStrategy = patch.aiStrategy;
      if (patch.aiBalancePriceWeight !== undefined) next.aiBalancePriceWeight = patch.aiBalancePriceWeight;
      if (patch.aiFailover !== undefined) next.aiFailover = patch.aiFailover;
      if (patch.aiAutoDisableAuth !== undefined) next.aiAutoDisableAuth = patch.aiAutoDisableAuth;
      if (patch.aiRateLimitCooldown !== undefined) next.aiRateLimitCooldown = patch.aiRateLimitCooldown;
      if (patch.aiConcurrency !== undefined) next.aiConcurrency = patch.aiConcurrency;
      if (patch.aiManualChannelId !== undefined) next.aiManualChannelId = patch.aiManualChannelId;
      if (Object.keys(next).length > 0) set(next);
    } catch (e) {
      console.error("Failed to save AI scheduling settings:", e);
    }
  },
}));
