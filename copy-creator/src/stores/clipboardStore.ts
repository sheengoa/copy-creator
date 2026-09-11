import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore, parseContentSort } from "./settingsStore";
import { isResourceRecord } from "../domain/records";
import { sortByIdOrder } from "../utils/reorder";
import { getResourcePath, isFileBackedTextResource } from "../domain/records";

type UnlistenFn = () => void;

type RecordsSetter = (
  partial: Partial<{ records: ClipboardRecord[] }>,
) => void;

/** 粘贴成功的即时反馈：最近使用模式置顶；最多使用模式计数 +1 并按
 *  次数重排（并列按最近使用）。时间排序已移除，此处不再区分。 */
function applyPasteFeedback(
  records: ClipboardRecord[],
  recordId: string,
  set: RecordsSetter,
) {
  const index = records.findIndex((r) => r.id === recordId);
  if (index === -1) return;
  const target: ClipboardRecord = { ...records[index] };
  const rest = records.filter((_, i) => i !== index);
  if (useSettingsStore.getState().contentSort === "count") {
    target.use_count = (target.use_count ?? 0) + 1;
    const updated = [target, ...rest];
    updated.sort((a, b) => {
      const aUsed = (a.use_count ?? 0) > 0 ? 1 : 0;
      const bUsed = (b.use_count ?? 0) > 0 ? 1 : 0;
      if (aUsed !== bUsed) return bUsed - aUsed;
      if ((b.use_count ?? 0) !== (a.use_count ?? 0)) {
        return (b.use_count ?? 0) - (a.use_count ?? 0);
      }
      const aKey = usageFallbackMs(a);
      const bKey = usageFallbackMs(b);
      return bKey - aKey;
    });
    set({ records: updated });
    return;
  }
  set({ records: [target, ...rest] });
}

/** 排序偏好请求参数：仅「全部」视图生效——资源进入具体分组（含未分组）
 *  即回到时间排序，不带 sortBy。 */
function contentSortArg(
  activeCategory: ClipType,
  activeResourceGroup: string | null | undefined,
): { sortBy: string } | Record<string, never> {
  if (activeCategory === "resources" && activeResourceGroup !== null) {
    return {};
  }
  return { sortBy: useSettingsStore.getState().contentSort };
}

/** 最近使用的兜底时间键：创建时间（与后端 MAX(touched_ms, sort_order) 的
 *  本地近似——触点毫秒仅本会话内粘贴的记录才有，取值即当前时间）。 */
function usageFallbackMs(record: ClipboardRecord): number {
  const parsed = new Date(record.created_at).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export const CLIP_TYPES = ["all", "text", "image", "link", "file", "resources"] as const;
export type ClipType = (typeof CLIP_TYPES)[number];
/** 剪贴板页的筛选范围：除资源外的全部类型。 */
export type ClipboardFilter = Exclude<ClipType, "resources">;

interface ApiKeyLabel {
  service: string;
  api_base: string;
  note: string;
  is_expired: boolean;
}

interface ClipboardRecord {
  id: string;
  type: "text" | "image" | "link" | "file";
  content: string;
  content_length?: number;
  content_truncated?: boolean;
  source_app: string;
  created_at: string;
  is_api_key?: boolean;
  user_api_key?: boolean;
  key_preview?: string;
  guessed_service?: string | null;
  label?: ApiKeyLabel | null;
  group_name?: string;
  has_images?: boolean;
  drag_path?: string;
  storage_mode?: "database" | "resource";
  resource_path?: string;
  resource_group?: string | null;
  resource_kind?: "text" | "image" | "video" | "audio" | "file";
  resource_relative_path?: string;
  resource_folder?: string | null;
  resource_file_size?: number;
  resource_managed?: boolean;
  resource_note?: string | null;
  /** 使用次数（粘贴/拖出成功自增），「最多使用」排序与次数徽标展示。 */
  use_count?: number;
  /** 最近使用时间：使用时间标签展示（未使用过的条目回退创建时间）。 */
  last_used_at?: string;
}

const PAGE_SIZE = 120;

interface ClipboardState {
  records: ClipboardRecord[];
  search: string;
  loading: boolean;
  loadError: string | null;
  hasMore: boolean;
  thumbnailCache: Record<string, string>;
  imageCache: Record<string, string>;
  category: ClipType;
  initialized: boolean;
  resourceGroup: string | null;

  init: (categoryOverride?: ClipType) => void;
  setSearch: (s: string) => void;
  setCategory: (c: ClipType) => void;
  setResourceGroup: (group: string | null) => void;
  loadRecords: (
    append?: boolean,
    categoryOverride?: ClipType,
    resourceGroup?: string | null,
  ) => Promise<void>;
  loadAllRecords: (
    categoryOverride?: ClipType,
    resourceGroup?: string | null,
    options?: { silent?: boolean },
  ) => Promise<ClipboardRecord[] | null>;
  updateRecordLabel: (id: string, label: ApiKeyLabel) => void;
  updateResourceNote: (id: string, note: string) => void;
  deleteRecords: (ids: string[]) => Promise<void>;
  deleteRecord: (id: string) => Promise<void>;
  pasteRecord: (record: ClipboardRecord) => Promise<boolean>;
  pasteRecordTerminal: (record: ClipboardRecord) => Promise<boolean>;
  moveRecordsToTop: (ids: string[]) => Promise<void>;
  getRecordContent: (record: ClipboardRecord) => Promise<string>;
  getThumbnail: (record: Pick<ClipboardRecord, "id" | "content">) => Promise<string>;
  getImageData: (record: Pick<ClipboardRecord, "id" | "content">) => Promise<string>;
}

let unlisteners: UnlistenFn[] = [];
let recordsLoadGeneration = 0;

const MAX_CONCURRENT = 3;
const MAX_THUMBNAILS = 80;
const MAX_FULL_IMAGES = 8;
let running = 0;
const queue: (() => void)[] = [];

// 粘贴成功后记录使用时间（fire-and-forget），供径向菜单「最近使用」聚合查询。
function touchClipboardUsage(ids: string[]) {
  void invoke("touch_clipboard_usage", { ids }).catch((e) => {
    console.error("Failed to record usage:", e);
  });
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = async () => {
      running++;
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        running--;
        if (queue.length > 0 && running < MAX_CONCURRENT) {
          const next = queue.shift()!;
          next();
        }
      }
    };
    if (running < MAX_CONCURRENT) {
      run();
    } else {
      queue.push(run);
    }
  });
}

function trimCache(cache: Record<string, string>, maxEntries: number) {
  const entries = Object.entries(cache);
  if (entries.length <= maxEntries) return cache;
  return Object.fromEntries(entries.slice(entries.length - maxEntries));
}

export function matchesResourceGroup(
  record: Pick<ClipboardRecord, "resource_folder" | "resource_group">,
  resourceGroup: string | null,
) {
  if (resourceGroup === null) return true;

  const recordFolder = record.resource_folder ?? record.resource_group;
  if (recordFolder === undefined || recordFolder === null) return false;

  const normalizedFolder = recordFolder.replace(/\\/g, "/");
  const normalizedGroup = resourceGroup.replace(/\\/g, "/");
  if (normalizedGroup === "") return normalizedFolder === "";
  return normalizedFolder === normalizedGroup
    || normalizedFolder.startsWith(`${normalizedGroup}/`);
}

function recordMatchesCategory(
  record: ClipboardRecord,
  category: ClipType,
  resourceGroup: string | null = null,
) {
  if (category === "all") return !isResourceRecord(record);
  if ((category as string) === "resources") {
    return isResourceRecord(record)
      && matchesResourceGroup(record, resourceGroup);
  }
  return !isResourceRecord(record) && record.type === category;
}

function recordMatchesSearch(record: ClipboardRecord, search: string) {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return record.content.toLowerCase().includes(q);
}

async function getFullContent(record: ClipboardRecord): Promise<string> {
  if (!record.content_truncated) return record.content;
  return invoke<string>("get_clipboard_record_content", { id: record.id });
}

export const useClipboardStore = create<ClipboardState>((set, get) => ({
  records: [],
  search: "",
  loading: false,
  loadError: null,
  hasMore: true,
  thumbnailCache: {},
  imageCache: {},
  category: "all",
  initialized: false,
  resourceGroup: null,

  init: (categoryOverride?: ClipType) => {
    const initialized = get().initialized;
    const previousCategory = get().category;
    if (categoryOverride && previousCategory !== categoryOverride) {
      recordsLoadGeneration++;
      set({ category: categoryOverride, resourceGroup: null });
    }
    if (initialized) {
      if (categoryOverride) {
        void get().loadRecords(false, categoryOverride);
      }
      return;
    }
    set({ initialized: true });

    listen<ClipboardRecord>("clipboard-update", (event) => {
      const newRecord = event.payload;
      set((state) => {
        // Skip if record with same ID already exists (prevents loadRecords race)
        if (state.records.some((r) => r.id === newRecord.id)) return state;
        if (!recordMatchesCategory(newRecord, state.category, state.resourceGroup)) return state;
        if (!recordMatchesSearch(newRecord, state.search)) return state;
        return { records: [newRecord, ...state.records].slice(0, 2000) };
      });
    }).then((fn) => {
      unlisteners.push(fn);
    });

    listen<string>("clipboard-record-updated", () => {
      get().loadRecords();
    }).then((fn) => {
      unlisteners.push(fn);
    });

    listen<string>("clipboard-deleted", (event) => {
      const deletedId = event.payload;
      recordsLoadGeneration++;
      set((state) => ({
        records: state.records.filter((r) => r.id !== deletedId),
        loading: false,
        loadError: null,
      }));
    }).then((fn) => {
      unlisteners.push(fn);
    });

    listen<{ sortBy: string }>("content-sort-changed", (event) => {
      // 排序偏好变化：径向菜单窗口的设置实例不经主窗口装载，
      // 必须先用事件负载更新本窗口设置值，再按新排序重载当前视图。
      useSettingsStore.setState({ contentSort: parseContentSort(event.payload.sortBy) });
      void get().loadRecords(false);
    }).then((fn) => {
      unlisteners.push(fn);
    });

    listen("clipboard-cleared", () => {
      if (get().category === "resources") return;
      recordsLoadGeneration++;
      set({
        records: [],
        hasMore: false,
        loading: false,
        loadError: null,
        thumbnailCache: {},
        imageCache: {},
      });
    }).then((fn) => {
      unlisteners.push(fn);
    });

    // 首次加载前先装载设置：contentSort 参与请求参数，径向菜单窗口
    // 没有 App 层的设置装载，必须在这里保证已从设置表读取。
    void useSettingsStore.getState().loadSettings().then(() => {
      void get().loadRecords(false, categoryOverride);
    });
  },

  setSearch: (s) => {
    recordsLoadGeneration++;
    set({ search: s });
  },
  setCategory: (c) => {
    recordsLoadGeneration++;
    set({ category: c, resourceGroup: null });
  },
  setResourceGroup: (group) => {
    recordsLoadGeneration++;
    set({ resourceGroup: group });
  },

  loadRecords: async (
    append = false,
    categoryOverride?: ClipType,
    resourceGroup?: string | null,
  ) => {
    const request = ++recordsLoadGeneration;
    set({ loading: true, loadError: null });
    try {
      const state = get();
      const s = state.search || undefined;
      const activeCategory = categoryOverride ?? state.category;
      const cat = activeCategory !== "all" ? activeCategory : undefined;
      const activeResourceGroup = activeCategory === "resources"
        ? resourceGroup !== undefined ? resourceGroup : state.resourceGroup
        : null;
      const offset = append ? state.records.length : 0;
      const requestArgs = {
        search: s,
        limit: PAGE_SIZE,
        offset,
        category: cat,
        ...contentSortArg(activeCategory, activeResourceGroup),
        ...(activeCategory === "resources" && activeResourceGroup !== null
          ? { resourceGroup: activeResourceGroup }
          : {}),
      };
      const records = await invoke<ClipboardRecord[]>("get_clipboard_records", requestArgs);
      if (request !== recordsLoadGeneration) return;
      if (append) {
        set((prev) => ({
          records: [...prev.records, ...records],
          hasMore: records.length >= PAGE_SIZE,
          category: activeCategory,
          resourceGroup: activeResourceGroup,
          loadError: null,
        }));
      } else {
        set({
          records,
          hasMore: records.length >= PAGE_SIZE,
          category: activeCategory,
          resourceGroup: activeResourceGroup,
          loadError: null,
        });
      }
    } catch (e) {
      console.error("Failed to load clipboard records:", e);
      if (request === recordsLoadGeneration) {
        set({
          loadError: e instanceof Error && e.message ? e.message : String(e),
        });
      }
    } finally {
      if (request === recordsLoadGeneration) set({ loading: false });
    }
  },

  loadAllRecords: async (
    categoryOverride?: ClipType,
    resourceGroup?: string | null,
    options?: { silent?: boolean },
  ) => {
    // silent 模式：整组粘贴等一次性取数专用。不参与 UI 加载代数竞争、
    // 不触碰共享状态，避免被并发的常规加载（如菜单打开时的 loadRecords
    // 或剪贴板推送触发的刷新）判定为过期而返回 null，导致粘贴静默失效。
    // 也不带主窗口搜索词：整组粘贴取的是分组全量，搜索框是无关状态。
    if (options?.silent === true) {
      const state = get();
      const activeCategory = categoryOverride ?? state.category;
      const category = activeCategory !== "all" ? activeCategory : undefined;
      const activeResourceGroup = activeCategory === "resources"
        ? resourceGroup !== undefined ? resourceGroup : state.resourceGroup
        : null;
      const allRecords: ClipboardRecord[] = [];
      let offset = 0;
      while (true) {
        const requestArgs = {
          limit: PAGE_SIZE,
          offset,
          category,
          ...contentSortArg(activeCategory, activeResourceGroup),
          ...(activeCategory === "resources" && activeResourceGroup !== null
            ? { resourceGroup: activeResourceGroup }
            : {}),
        };
        const page = await invoke<ClipboardRecord[]>("get_clipboard_records", requestArgs);
        allRecords.push(...page);
        if (page.length < PAGE_SIZE) break;
        offset += page.length;
      }
      return allRecords;
    }

    const request = ++recordsLoadGeneration;
    set({ loading: true, loadError: null });
    try {
      const state = get();
      const search = state.search || undefined;
      const activeCategory = categoryOverride ?? state.category;
      const category = activeCategory !== "all" ? activeCategory : undefined;
      const activeResourceGroup = activeCategory === "resources"
        ? resourceGroup !== undefined ? resourceGroup : state.resourceGroup
        : null;
      const allRecords: ClipboardRecord[] = [];
      let offset = 0;

      while (true) {
        if (request !== recordsLoadGeneration) return null;
        const requestArgs = {
          search,
          limit: PAGE_SIZE,
          offset,
          category,
          ...contentSortArg(activeCategory, activeResourceGroup),
          ...(activeCategory === "resources" && activeResourceGroup !== null
            ? { resourceGroup: activeResourceGroup }
            : {}),
        };
        const page = await invoke<ClipboardRecord[]>("get_clipboard_records", requestArgs);
        if (request !== recordsLoadGeneration) return null;
        allRecords.push(...page);
        if (page.length < PAGE_SIZE) break;
        offset += page.length;
      }

      if (
        request !== recordsLoadGeneration
        || get().search !== state.search
        || get().category !== activeCategory
      ) {
        return null;
      }
      set({
        records: allRecords,
        hasMore: false,
        category: activeCategory,
        resourceGroup: activeResourceGroup,
        loadError: null,
      });
      return allRecords;
    } catch (e) {
      console.error("Failed to load all clipboard records:", e);
      if (request === recordsLoadGeneration) {
        set({
          loadError: e instanceof Error && e.message ? e.message : String(e),
        });
      }
      return null;
    } finally {
      if (request === recordsLoadGeneration) set({ loading: false });
    }
  },

  updateRecordLabel: (id: string, label: ApiKeyLabel) =>
    set((state) => {
      const idx = state.records.findIndex((r) => r.id === id);
      if (idx === -1) return state;
      const updated = [...state.records];
      updated[idx] = { ...updated[idx], label };
      return { records: updated };
    }),

  updateResourceNote: (id: string, note: string) =>
    set((state) => {
      const idx = state.records.findIndex((r) => r.id === id);
      if (idx === -1) return state;
      const updated = [...state.records];
      updated[idx] = { ...updated[idx], resource_note: note };
      return { records: updated };
    }),

  deleteRecords: async (ids: string[]) => {
    if (ids.length === 0) return;
    recordsLoadGeneration++;
    set({ loading: false, loadError: null });
    try {
      await invoke("delete_clipboard_records", { ids });
      const deletedIds = new Set(ids);
      const thumbCache = { ...get().thumbnailCache };
      const cache = { ...get().imageCache };
      for (const id of deletedIds) {
        delete thumbCache[id];
        delete cache[id];
      }
      set({
        records: get().records.filter((r) => !deletedIds.has(r.id)),
        thumbnailCache: thumbCache,
        imageCache: cache,
      });
    } catch (e) {
      console.error("Failed to delete clipboard records:", e);
      throw e;
    }
  },

  deleteRecord: async (id: string) => get().deleteRecords([id]),

  pasteRecord: async (record: ClipboardRecord) => {
    try {
      if (record.has_images) {
        await invoke("paste_stash_record", { id: record.id, terminal: false });
        touchClipboardUsage([record.id]);
        applyPasteFeedback(get().records, record.id, set);
        return true;
      }
      const content = await getFullContent(record);
      if (record.type === "image") {
        await invoke("paste_image", { path: content });
      } else if (record.type === "file") {
        if (isFileBackedTextResource(record)) {
          try {
            // 文件承载的文本资源按内容粘贴；读取失败（超限、非 UTF-8
            // 等）时回退为文件粘贴，保持不劣于旧行为。
            await invoke("paste_text_file", { path: getResourcePath(record), terminal: false });
            touchClipboardUsage([record.id]);
            applyPasteFeedback(get().records, record.id, set);
            return true;
          } catch (error) {
            console.warn("文本资源按内容粘贴失败，回退为文件粘贴:", error);
          }
        }
        await invoke("paste_file", { path: content });
      } else {
        await invoke("paste_text", { text: content });
      }
      touchClipboardUsage([record.id]);
      applyPasteFeedback(get().records, record.id, set);
      return true;
    } catch (e) {
      console.error("Paste failed:", e);
      return false;
    }
  },

  pasteRecordTerminal: async (record: ClipboardRecord) => {
    try {
      if (record.has_images) {
        await invoke("paste_stash_record", { id: record.id, terminal: true });
        touchClipboardUsage([record.id]);
        applyPasteFeedback(get().records, record.id, set);
        return true;
      }
      const content = await getFullContent(record);
      if (record.type === "image") {
        await invoke("paste_image", { path: content });
      } else if (record.type === "file") {
        if (isFileBackedTextResource(record)) {
          try {
            await invoke("paste_text_file", { path: getResourcePath(record), terminal: true });
            touchClipboardUsage([record.id]);
            applyPasteFeedback(get().records, record.id, set);
            return true;
          } catch (error) {
            console.warn("文本资源按内容粘贴失败，回退为文件粘贴:", error);
          }
        }
        await invoke("paste_file", { path: content });
      } else {
        await invoke("paste_text_terminal", { text: content });
      }
      touchClipboardUsage([record.id]);
      applyPasteFeedback(get().records, record.id, set);
      return true;
    } catch (e) {
      console.error("Terminal paste failed:", e);
      return false;
    }
  },

  // 移到顶部：sort_order 提到全表最前，径向菜单与主窗口共用该顺序。
  // 搜索状态下执行后按当前搜索词重载，置顶项保持在结果最前。
  moveRecordsToTop: async (ids: string[]) => {
    set((state) => ({ records: sortByIdOrder(state.records, ids) }));
    try {
      await invoke("move_clipboard_records_to_top", { ids });
    } catch (e) {
      console.error("Failed to move clipboard records to top:", e);
    }
    get().loadRecords();
  },

  getRecordContent: getFullContent,

  getThumbnail: async (record: Pick<ClipboardRecord, "id" | "content">): Promise<string> => {
    const cached = get().thumbnailCache[record.id];
    if (cached) return cached;

    return enqueue(async () => {
      const cached2 = get().thumbnailCache[record.id];
      if (cached2) return cached2;

      try {
        // Use base64 data URI for reliable cross-platform display
        const base64 = await invoke<string>("get_image_thumbnail", {
          path: record.content,
          maxSize: 200,
        });
        const url = `data:image/png;base64,${base64}`;
        set({ thumbnailCache: trimCache({ ...get().thumbnailCache, [record.id]: url }, MAX_THUMBNAILS) });
        return url;
      } catch (e) {
        console.error("Failed to load thumbnail:", e);
        return "";
      }
    });
  },

  getImageData: async (record: Pick<ClipboardRecord, "id" | "content">): Promise<string> => {
    const cached = get().imageCache[record.id];
    if (cached) return cached;

    try {
      const base64 = await invoke<string>("get_image_base64", {
        path: record.content,
      });
      const url = `data:image/png;base64,${base64}`;
      set({ imageCache: trimCache({ ...get().imageCache, [record.id]: url }, MAX_FULL_IMAGES) });
      return url;
    } catch (e) {
      console.error("Failed to load image:", e);
      return "";
    }
  },
}));

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    unlisteners.forEach((fn) => fn());
    unlisteners = [];
  });
}
