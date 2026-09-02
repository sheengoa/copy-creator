import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type UnlistenFn = () => void;

export const CLIP_TYPES = ["all", "text", "image", "link", "file", "stash", "resources"] as const;
export type ClipType = (typeof CLIP_TYPES)[number];

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
}

const PAGE_SIZE = 120;

interface ClipboardState {
  records: ClipboardRecord[];
  search: string;
  loading: boolean;
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
  createRecord: (content: string, groupName?: string) => Promise<void>;
  deleteRecords: (ids: string[]) => Promise<void>;
  deleteRecord: (id: string) => Promise<void>;
  pasteRecord: (record: ClipboardRecord) => Promise<void>;
  pasteRecordTerminal: (record: ClipboardRecord) => Promise<void>;
  reorderRecords: (ids: string[]) => Promise<void>;
  getRecordContent: (record: ClipboardRecord) => Promise<string>;
  getThumbnail: (record: Pick<ClipboardRecord, "id" | "content">) => Promise<string>;
  getImageData: (record: Pick<ClipboardRecord, "id" | "content">) => Promise<string>;
}

let unlisten: UnlistenFn | null = null;

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
  if (category === "all") return true;
  if (category === "stash") {
    return record.group_name === "暂存" || record.group_name === "stash";
  }
  if ((category as string) === "resources") {
    return Boolean(record.group_name);
  }
  return record.type === category;
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
  hasMore: true,
  thumbnailCache: {},
  imageCache: {},
  category: "all",
  initialized: false,

  init: (categoryOverride?: ClipType) => {
    if (get().initialized) return;
    if (categoryOverride) set({ category: categoryOverride });
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
      unlisten = fn;
    });

    listen<string>("clipboard-record-updated", () => {
      get().loadRecords();
    });

    listen<string>("clipboard-deleted", (event) => {
      const deletedId = event.payload;
      set((state) => ({
        records: state.records.filter((r) => r.id !== deletedId),
      }));
    });

    listen("clipboard-cleared", () => {
      set({ records: [], thumbnailCache: {}, imageCache: {} });
    });

    get().loadRecords(false, categoryOverride);
  },

  setSearch: (s) => set({ search: s }),
  setCategory: (c) => set({ category: c }),

  loadRecords: async (append = false, categoryOverride?: ClipType) => {
    set({ loading: true });
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
      if (append) {
        set((prev) => ({
          records: [...prev.records, ...records],
          hasMore: records.length >= PAGE_SIZE,
        }));
      } else {
        set({ records, hasMore: records.length >= PAGE_SIZE });
      }
    } catch (e) {
      console.error("Failed to load clipboard records:", e);
    } finally {
      set({ loading: false });
    }
  },

  loadAllRecords: async (categoryOverride?: ClipType) => {
    set({ loading: true });
    try {
      const state = get();
      const search = state.search || undefined;
      const activeCategory = categoryOverride ?? state.category;
      const category = activeCategory !== "all" ? activeCategory : undefined;
      const allRecords: ClipboardRecord[] = [];
      let offset = 0;

      while (true) {
        const page = await invoke<ClipboardRecord[]>("get_clipboard_records", {
          search,
          limit: PAGE_SIZE,
          offset,
          category,
        });
        allRecords.push(...page);
        if (page.length < PAGE_SIZE) break;
        offset += page.length;
      }

      const latestState = get();
      if (latestState.search !== state.search || latestState.category !== activeCategory) {
        return null;
      }
      set({ records: allRecords, hasMore: false, category: activeCategory });
      return allRecords;
    } catch (e) {
      console.error("Failed to load all clipboard records:", e);
      return null;
    } finally {
      set({ loading: false });
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

  createRecord: async (content: string, groupName?: string) => {
    try {
      await invoke("create_clipboard_record", { content, groupName });
    } catch (e) {
      console.error("Failed to create record:", e);
    }
  },

  deleteRecords: async (ids: string[]) => {
    if (ids.length === 0) return;
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
        return;
      }
      const content = await getFullContent(record);
      if (record.type === "image") {
        await invoke("paste_image", { path: content });
      } else if (record.type === "file") {
        await invoke("paste_file", { path: content });
      } else {
        await invoke("paste_text", { text: content });
      }
    } catch (e) {
      console.error("Paste failed:", e);
    }
  },

  pasteRecordTerminal: async (record: ClipboardRecord) => {
    try {
      if (record.has_images) {
        await invoke("paste_stash_record", { id: record.id, terminal: true });
        return;
      }
      const content = await getFullContent(record);
      if (record.type === "image") {
        await invoke("paste_image", { path: content });
      } else if (record.type === "file") {
        await invoke("paste_file", { path: content });
      } else {
        await invoke("paste_text_terminal", { text: content });
      }
    } catch (e) {
      console.error("Terminal paste failed:", e);
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
    if (unlisten) unlisten();
  });
}
