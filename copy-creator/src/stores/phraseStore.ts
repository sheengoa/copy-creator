import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore, parseContentSort } from "./settingsStore";
import type { Phrase, PhraseGroup } from "../types";
import { sortByIdOrder } from "../utils/reorder";
import { DECODABLE_IMAGE_EXTENSIONS, getResourceExtension } from "../domain/mediaKind";
import { resolveAbsoluteResourcePath } from "../domain/mediaUrl";

/** 「全部」跨分组视图的选择哨兵：真实分组 id 由后端生成，不会与之冲突。 */
export const ALL_PHRASES_GROUP_ID = "__all__";

// 置顶/重排序失败后按当前分组重载短语，恢复与后端一致的真实顺序。
const reloadPhrasesAfterFailure = async (get: () => PhraseState) => {
  const groupId = get().selectedGroupId;
  if (groupId !== null) await get().loadPhrases(groupId);
};

/** 文件短语是否指向图片文件：粘贴时走位图路径而非文件引用。
 *  可位图粘贴的扩展以资源区 DECODABLE_IMAGE_EXTENSIONS 为单一来源
 *  （与后端 image 解码能力对应），避免两处判断漂移。 */
export const isImageFilePath = (path: string) =>
  DECODABLE_IMAGE_EXTENSIONS.has(getResourceExtension(path));

// 粘贴成功后记录使用时间（fire-and-forget），供「全部」视图按最近使用排序。
function touchPhraseUsage(id: string) {
  void invoke("touch_phrase_usage", { id }).catch((e) => {
    console.error("Failed to record phrase usage:", e);
  });
}

export interface QuickInputFileSelection {
  path: string;
  file_size: number;
}

interface PhraseState {
  groups: PhraseGroup[];
  phrases: Phrase[];
  selectedGroupId: string | null;
  search: string;
  loading: boolean;

  setSearch: (s: string) => void;
  setSelectedGroup: (id: string | null) => void;
  init: () => void;
  loadGroups: () => Promise<void>;
  loadPhrases: (groupId: string) => Promise<void>;
  /** 图像文件短语的缩略图（收编 UI 层直接 invoke，规则见架构方案 §5.1）。 */
  getImageThumbnail: (path: string) => Promise<string>;
  createGroup: (name: string) => Promise<void>;
  updateGroup: (id: string, name: string) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  createPhrase: (
    groupId: string,
    title: string,
    content: string
  ) => Promise<void>;
  updatePhrase: (
    id: string,
    title: string,
    content: string
  ) => Promise<void>;
  selectQuickInputFile: () => Promise<QuickInputFileSelection>;
  getQuickInputFileInfo: (path: string) => Promise<QuickInputFileSelection>;
  getQuickInputFileLimit: () => Promise<number>;
  createFilePhrase: (
    groupId: string,
    sourcePath: string,
    title: string
  ) => Promise<void>;
  updateFilePhrase: (
    id: string,
    sourcePath: string,
    title: string
  ) => Promise<void>;
  deletePhrases: (ids: string[]) => Promise<void>;
  deletePhrase: (id: string) => Promise<void>;
  pastePhrase: (phrase: Phrase) => Promise<void>;
  pastePhraseTerminal: (phrase: Phrase) => Promise<void>;
  reorderPhrases: (ids: string[]) => Promise<void>;
  movePhrasesToTop: (ids: string[]) => Promise<void>;
  reorderGroups: (ids: string[]) => Promise<void>;
}

export const usePhraseStore = create<PhraseState>()((set, get) => {
  let initialized = false;

  return {
  groups: [],
  phrases: [],
  selectedGroupId: null,
  search: "",
  loading: false,

  setSearch: (s: string) => set({ search: s }),
  setSelectedGroup: (id: string | null) => set({ selectedGroupId: id }),

  loadGroups: async () => {
    try {
      const groups = await invoke<PhraseGroup[]>("get_phrase_groups");
      set({ groups });
      // 无已选分组时默认落「全部」视图：跨分组按最近使用排序，省去先选分组。
      if (!get().selectedGroupId) {
        get().loadPhrases(ALL_PHRASES_GROUP_ID);
      }
    } catch (e) {
      console.error("Failed to load phrase groups:", e);
    }
  },

  init: () => {
    if (initialized) return;
    initialized = true;

    listen("phrase-groups-changed", () => {
      get().loadGroups();
    });

    listen<{ sortBy: string }>("content-sort-changed", (event) => {
      // 与剪切板同口径：先用事件负载更新本窗口设置值再重载。
      useSettingsStore.setState({ contentSort: parseContentSort(event.payload.sortBy) });
      if (get().selectedGroupId === ALL_PHRASES_GROUP_ID) {
        void get().loadPhrases(ALL_PHRASES_GROUP_ID);
      }
    });

    // 与剪切板同口径：首次加载前先装载设置（径向菜单窗口无 App 层装载）。
    void useSettingsStore.getState().loadSettings().then(() => {
      get().loadGroups();
    });
  },

  getImageThumbnail: async (path: string) => {
    return invoke<string>("get_image_thumbnail", { path, maxSize: 96 });
  },

  loadPhrases: async (groupId: string) => {
    set({ loading: true });
    try {
      // 「全部」走跨分组聚合查询：附带分组名与最近使用时间，供来源标签展示。
      const phrases = groupId === ALL_PHRASES_GROUP_ID
        ? await invoke<Phrase[]>("get_all_phrases", {
            sortBy: useSettingsStore.getState().contentSort,
          })
        : await invoke<Phrase[]>("get_phrases", { groupId });
      set({ phrases, selectedGroupId: groupId });
    } catch (e) {
      console.error("Failed to load phrases:", e);
    } finally {
      set({ loading: false });
    }
  },

  createGroup: async (name: string) => {
    try {
      const group = await invoke<PhraseGroup>("create_phrase_group", { name });
      set({ groups: [...get().groups, group] });
    } catch (e) {
      console.error("Failed to create group:", e);
    }
  },

  updateGroup: async (id: string, name: string) => {
    try {
      await invoke("update_phrase_group", { id, name });
      set({
        groups: get().groups.map((g) => (g.id === id ? { ...g, name } : g)),
      });
    } catch (e) {
      console.error("Failed to update group:", e);
    }
  },

  deleteGroup: async (id: string) => {
    try {
      const wasSelected = get().selectedGroupId === id;
      await invoke("delete_phrase_group", { id });
      set({
        groups: get().groups.filter((g) => g.id !== id),
        phrases: wasSelected ? [] : get().phrases,
        selectedGroupId: wasSelected ? null : get().selectedGroupId,
      });
      // 被删分组正处于选中态：回到「全部」视图，保持列表有内容。
      if (wasSelected) {
        get().loadPhrases(ALL_PHRASES_GROUP_ID);
      }
    } catch (e) {
      console.error("Failed to delete group:", e);
    }
  },

  createPhrase: async (groupId: string, title: string, content: string) => {
    try {
      const phrase = await invoke<Phrase>("create_phrase", {
        groupId,
        title,
        content,
      });
      set({ phrases: [...get().phrases, phrase] });
    } catch (e) {
      console.error("Failed to create phrase:", e);
    }
  },

  updatePhrase: async (id: string, title: string, content: string) => {
    try {
      await invoke("update_phrase", { id, title, content });
      set({
        phrases: get().phrases.map((p) =>
          p.id === id
            ? { ...p, title, content, input_type: "text", source_path: "", file_size: 0 }
            : p
        ),
      });
    } catch (e) {
      console.error("Failed to update phrase:", e);
    }
  },

  selectQuickInputFile: async () => {
    return invoke<QuickInputFileSelection>("select_quick_input_file");
  },

  getQuickInputFileLimit: async () => {
    return invoke<number>("get_quick_input_file_limit");
  },

  getQuickInputFileInfo: async (path: string) => {
    return invoke<QuickInputFileSelection>("get_quick_input_file_info", { path });
  },

  createFilePhrase: async (groupId: string, sourcePath: string, title: string) => {
    try {
      const phrase = await invoke<Phrase>("create_file_phrase", {
        groupId,
        sourcePath,
        title,
      });
      set({ phrases: [...get().phrases, phrase] });
    } catch (e) {
      console.error("Failed to create file phrase:", e);
      throw e;
    }
  },

  updateFilePhrase: async (id: string, sourcePath: string, title: string) => {
    try {
      const phrase = await invoke<Phrase>("update_file_phrase", {
        id,
        sourcePath,
        title,
      });
      set({
        phrases: get().phrases.map((p) => (p.id === id ? phrase : p)),
      });
    } catch (e) {
      console.error("Failed to update file phrase:", e);
      throw e;
    }
  },

  deletePhrases: async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      await invoke("delete_phrases", { ids });
      const deletedIds = new Set(ids);
      set({ phrases: get().phrases.filter((p) => !deletedIds.has(p.id)) });
    } catch (e) {
      console.error("Failed to delete phrases:", e);
      throw e;
    }
  },

  deletePhrase: async (id: string) => get().deletePhrases([id]),

  pastePhrase: async (phrase: Phrase) => {
    try {
      if (phrase.input_type === "file") {
        const path = await resolveAbsoluteResourcePath(phrase.content);
        if (isImageFilePath(path)) {
          // 图像文件以位图粘贴（图像只能 Ctrl+V），终端入口同普通入口。
          await invoke("paste_image_file", { path });
        } else {
          await invoke("paste_file", { path });
        }
      } else {
        await invoke("paste_text", { text: phrase.content });
      }
      touchPhraseUsage(phrase.id);
      // 「全部」视图按最近使用排序：粘贴成功即乐观移到最前，与后端排序一致。
      set((s) => {
        if (s.selectedGroupId !== ALL_PHRASES_GROUP_ID) return {};
        const target = s.phrases.find((p) => p.id === phrase.id);
        if (!target) return {};
        const rest = s.phrases.filter((p) => p.id !== phrase.id);
        if (useSettingsStore.getState().contentSort === "count") {
          // 最多使用模式：计数 +1 并按次数重排（并列按最近使用）。
          const bumped: Phrase = {
            ...target,
            use_count: (target.use_count ?? 0) + 1,
            last_used_at: new Date().toISOString(),
          };
          const updated = [bumped, ...rest];
          updated.sort((a, b) => {
            const aUsed = (a.use_count ?? 0) > 0 ? 1 : 0;
            const bUsed = (b.use_count ?? 0) > 0 ? 1 : 0;
            if (aUsed !== bUsed) return bUsed - aUsed;
            if ((b.use_count ?? 0) !== (a.use_count ?? 0)) {
              return (b.use_count ?? 0) - (a.use_count ?? 0);
            }
            return (b.last_used_at ?? "").localeCompare(a.last_used_at ?? "");
          });
          return { phrases: updated };
        }
        if (s.phrases[0]?.id === phrase.id) return {};
        return { phrases: [target, ...rest] };
      });
    } catch (e) {
      console.error("Paste failed:", e);
    }
  },

  pastePhraseTerminal: async (phrase: Phrase) => {
    try {
      if (phrase.input_type === "file") {
        const path = await resolveAbsoluteResourcePath(phrase.content);
        if (isImageFilePath(path)) {
          await invoke("paste_image_file", { path });
        } else {
          await invoke("paste_file", { path });
        }
      } else {
        await invoke("paste_text_terminal", { text: phrase.content });
      }
      touchPhraseUsage(phrase.id);
      set((s) => {
        if (s.selectedGroupId !== ALL_PHRASES_GROUP_ID) return {};
        const target = s.phrases.find((p) => p.id === phrase.id);
        if (!target) return {};
        const rest = s.phrases.filter((p) => p.id !== phrase.id);
        if (useSettingsStore.getState().contentSort === "count") {
          // 最多使用模式：计数 +1 并按次数重排（并列按最近使用）。
          const bumped: Phrase = {
            ...target,
            use_count: (target.use_count ?? 0) + 1,
            last_used_at: new Date().toISOString(),
          };
          const updated = [bumped, ...rest];
          updated.sort((a, b) => {
            const aUsed = (a.use_count ?? 0) > 0 ? 1 : 0;
            const bUsed = (b.use_count ?? 0) > 0 ? 1 : 0;
            if (aUsed !== bUsed) return bUsed - aUsed;
            if ((b.use_count ?? 0) !== (a.use_count ?? 0)) {
              return (b.use_count ?? 0) - (a.use_count ?? 0);
            }
            return (b.last_used_at ?? "").localeCompare(a.last_used_at ?? "");
          });
          return { phrases: updated };
        }
        if (s.phrases[0]?.id === phrase.id) return {};
        return { phrases: [target, ...rest] };
      });
    } catch (e) {
      console.error("Terminal paste failed:", e);
    }
  },

  reorderPhrases: async (ids: string[]) => {
    set((s) => ({ phrases: sortByIdOrder(s.phrases, ids) }));
    try {
      await invoke("reorder_phrases", { ids });
    } catch (e) {
      console.error("Failed to reorder phrases:", e);
      await reloadPhrasesAfterFailure(get);
    }
  },

  // 组内置顶：径向菜单快捷输入 tab 按组内顺序展示，置顶即第一屏可见。
  // 失败时按当前分组重载，避免乐观顺序与后端持久化顺序不一致。
  movePhrasesToTop: async (ids: string[]) => {
    set((s) => ({ phrases: sortByIdOrder(s.phrases, ids) }));
    try {
      await invoke("move_phrases_to_top", { ids });
    } catch (e) {
      console.error("Failed to move phrases to top:", e);
      await reloadPhrasesAfterFailure(get);
    }
  },

  reorderGroups: async (ids: string[]) => {
    set((s) => ({ groups: sortByIdOrder(s.groups, ids) }));
    try {
      await invoke("reorder_phrase_groups", { ids });
    } catch (e) {
      console.error("Failed to reorder groups:", e);
      await get().loadGroups();
    }
  },
  };
});
