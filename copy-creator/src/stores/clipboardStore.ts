import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isResourceRecord } from "../utils/clipboardRecord";

type UnlistenFn = () => void;

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

  init: (categoryOverride?: ClipType) => void;
  setSearch: (s: string) => void;
  setCategory: (c: ClipType) => void;
  loadRecords: (append?: boolean, categoryOverride?: ClipType) => Promise<void>;
  loadAllRecords: (categoryOverride?: ClipType) => Promise<ClipboardRecord[] | null>;
  updateRecordLabel: (id: string, label: ApiKeyLabel) => void;
  deleteRecords: (ids: string[]) => Promise<void>;
  deleteRecord: (id: string) => Promise<void>;
  pasteRecord: (record: ClipboardRecord) => Promise<boolean>;
  pasteRecordTerminal: (record: ClipboardRecord) => Promise<boolean>;
  reorderRecords: (ids: string[]) => Promise<void>;
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

function recordMatchesCategory(record: ClipboardRecord, category: ClipType) {
  if (category === "all") return !isResourceRecord(record);
  if ((category as string) === "resources") {
    return isResourceRecord(record);
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

  init: (categoryOverride?: ClipType) => {
    const initialized = get().initialized;
    const previousCategory = get().category;
    if (categoryOverride && previousCategory !== categoryOverride) {
      recordsLoadGeneration++;
      set({ category: categoryOverride });
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
        if (!recordMatchesCategory(newRecord, state.category)) return state;
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

    void get().loadRecords(false, categoryOverride);
  },

  setSearch: (s) => {
    recordsLoadGeneration++;
    set({ search: s });
  },
  setCategory: (c) => {
    recordsLoadGeneration++;
    set({ category: c });
  },

  loadRecords: async (append = false, categoryOverride?: ClipType) => {
    const request = ++recordsLoadGeneration;
    set({ loading: true, loadError: null });
    try {
      const state = get();
      const s = state.search || undefined;
      const activeCategory = categoryOverride ?? state.category;
      const cat = activeCategory !== "all" ? activeCategory : undefined;
      const offset = append ? state.records.length : 0;
      const records = await invoke<ClipboardRecord[]>("get_clipboard_records", {
        search: s,
        limit: PAGE_SIZE,
        offset,
        category: cat,
      });
      if (request !== recordsLoadGeneration) return;
      if (append) {
        set((prev) => ({
          records: [...prev.records, ...records],
          hasMore: records.length >= PAGE_SIZE,
          category: activeCategory,
          loadError: null,
        }));
      } else {
        set({
          records,
          hasMore: records.length >= PAGE_SIZE,
          category: activeCategory,
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

  loadAllRecords: async (categoryOverride?: ClipType) => {
    const request = ++recordsLoadGeneration;
    set({ loading: true, loadError: null });
    try {
      const state = get();
      const search = state.search || undefined;
      const activeCategory = categoryOverride ?? state.category;
      const category = activeCategory !== "all" ? activeCategory : undefined;
      const allRecords: ClipboardRecord[] = [];
      let offset = 0;

      while (true) {
        if (request !== recordsLoadGeneration) return null;
        const page = await invoke<ClipboardRecord[]>("get_clipboard_records", {
          search,
          limit: PAGE_SIZE,
          offset,
          category,
        });
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
      set({ records: allRecords, hasMore: false, category: activeCategory, loadError: null });
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
        return true;
      }
      const content = await getFullContent(record);
      if (record.type === "image") {
        await invoke("paste_image", { path: content });
      } else if (record.type === "file") {
        await invoke("paste_file", { path: content });
      } else {
        await invoke("paste_text", { text: content });
      }
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
        return true;
      }
      const content = await getFullContent(record);
      if (record.type === "image") {
        await invoke("paste_image", { path: content });
      } else if (record.type === "file") {
        await invoke("paste_file", { path: content });
      } else {
        await invoke("paste_text_terminal", { text: content });
      }
      return true;
    } catch (e) {
      console.error("Terminal paste failed:", e);
      return false;
    }
  },

  reorderRecords: async (ids: string[]) => {
    const idOrder = new Map(ids.map((id, i) => [id, i]));
    set((state) => ({
      records: [...state.records].sort(
        (a, b) => (idOrder.get(a.id) ?? Infinity) - (idOrder.get(b.id) ?? Infinity)
      ),
    }));
    try {
      await invoke("reorder_clipboard_records", { ids });
      get().loadRecords();
    } catch (e) {
      console.error("Failed to reorder clipboard records:", e);
      get().loadRecords();
    }
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
