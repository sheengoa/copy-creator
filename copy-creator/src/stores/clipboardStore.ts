import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type UnlistenFn = () => void;

export const CLIP_TYPES = ["all", "text", "image", "link", "file"] as const;
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

  init: () => void;
  setSearch: (s: string) => void;
  setCategory: (c: ClipType) => void;
  loadRecords: (append?: boolean) => Promise<void>;
  updateRecordLabel: (id: string, label: ApiKeyLabel) => void;
  deleteRecord: (id: string) => Promise<void>;
  deleteAllRecords: () => Promise<void>;
  deleteRecordsByType: (recordType: string) => Promise<void>;
  pasteRecord: (record: ClipboardRecord) => Promise<void>;
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

  init: () => {
    if (get().initialized) return;
    set({ initialized: true });

    listen<ClipboardRecord>("clipboard-update", (event) => {
      const newRecord = event.payload;
      set((state) => {
        // Skip if record with same ID already exists (prevents loadRecords race)
        if (state.records.some((r) => r.id === newRecord.id)) return state;
        return { records: [newRecord, ...state.records].slice(0, 2000) };
      });
    }).then((fn) => {
      unlisten = fn;
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

    get().loadRecords();
  },

  setSearch: (s) => set({ search: s }),
  setCategory: (c) => set({ category: c }),

  loadRecords: async (append = false) => {
    set({ loading: true });
    try {
      const state = get();
      const s = state.search || undefined;
      const cat = state.category !== "all" ? state.category : undefined;
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

  updateRecordLabel: (id: string, label: ApiKeyLabel) =>
    set((state) => {
      const idx = state.records.findIndex((r) => r.id === id);
      if (idx === -1) return state;
      const updated = [...state.records];
      updated[idx] = { ...updated[idx], label };
      return { records: updated };
    }),

  deleteRecord: async (id: string) => {
    try {
      await invoke("delete_clipboard_record", { id });
      const thumbCache = { ...get().thumbnailCache };
      delete thumbCache[id];
      const cache = { ...get().imageCache };
      delete cache[id];
      set({
        records: get().records.filter((r) => r.id !== id),
        thumbnailCache: thumbCache,
        imageCache: cache,
      });
    } catch (e) {
      console.error("Failed to delete record:", e);
    }
  },

  deleteAllRecords: async () => {
    try {
      await invoke("delete_all_clipboard_records");
      set({ records: [], thumbnailCache: {}, imageCache: {} });
    } catch (e) {
      console.error("Failed to delete all records:", e);
    }
  },

  deleteRecordsByType: async (recordType: string) => {
    try {
      await invoke("delete_records_by_type", { recordType });
      // Immediately remove the deleted type from local state (no flash of empty state)
      const thumbCache = { ...get().thumbnailCache };
      const imgCache = { ...get().imageCache };
      set((state) => {
        const deletedIds = new Set(
          state.records.filter((r) => r.type === recordType).map((r) => r.id)
        );
        for (const id of deletedIds) {
          delete thumbCache[id];
          delete imgCache[id];
        }
        return {
          records: state.records.filter((r) => r.type !== recordType),
          thumbnailCache: thumbCache,
          imageCache: imgCache,
        };
      });
      // Reload in background to stay in sync with the backend
      get().loadRecords();
    } catch (e) {
      console.error("Failed to delete records by type:", e);
    }
  },

  pasteRecord: async (record: ClipboardRecord) => {
    try {
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

  reorderRecords: async (ids: string[]) => {
    const idOrder = new Map(ids.map((id, i) => [id, i]));
    set((state) => ({
      records: [...state.records].sort(
        (a, b) => (idOrder.get(a.id) ?? Infinity) - (idOrder.get(b.id) ?? Infinity)
      ),
    }));
    try {
      await invoke("reorder_clipboard_records", { ids });
    } catch (e) {
      console.error("Failed to reorder clipboard records:", e);
      // Revert: reload from backend
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
