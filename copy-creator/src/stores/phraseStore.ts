import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Phrase, PhraseGroup } from "../types";

const isAbsolutePath = (path: string) => /^([a-zA-Z]:[\\/]|[/\\])/.test(path);

const resolveStoredFilePath = async (content: string) => {
  if (isAbsolutePath(content)) return content;
  const storagePath = await invoke<string>("get_storage_path");
  return `${storagePath.replace(/[\\/]+$/, "")}/${content.replace(/^[\\/]+/, "")}`;
};

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
  deletePhrase: (id: string) => Promise<void>;
  pastePhrase: (phrase: Phrase) => Promise<void>;
  pastePhraseTerminal: (phrase: Phrase) => Promise<void>;
  reorderPhrases: (ids: string[]) => Promise<void>;
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
      if (groups.length > 0 && !get().selectedGroupId) {
        get().loadPhrases(groups[0].id);
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

    get().loadGroups();
  },

  loadPhrases: async (groupId: string) => {
    set({ loading: true });
    try {
      const phrases = await invoke<Phrase[]>("get_phrases", { groupId });
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
      await invoke("delete_phrase_group", { id });
      set({
        groups: get().groups.filter((g) => g.id !== id),
        phrases:
          get().selectedGroupId === id ? [] : get().phrases,
        selectedGroupId:
          get().selectedGroupId === id ? null : get().selectedGroupId,
      });
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

  deletePhrase: async (id: string) => {
    try {
      await invoke("delete_phrase", { id });
      set({ phrases: get().phrases.filter((p) => p.id !== id) });
    } catch (e) {
      console.error("Failed to delete phrase:", e);
    }
  },

  pastePhrase: async (phrase: Phrase) => {
    try {
      if (phrase.input_type === "file") {
        await invoke("paste_file", { path: await resolveStoredFilePath(phrase.content) });
      } else {
        await invoke("paste_text", { text: phrase.content });
      }
    } catch (e) {
      console.error("Paste failed:", e);
    }
  },

  pastePhraseTerminal: async (phrase: Phrase) => {
    try {
      if (phrase.input_type === "file") {
        await invoke("paste_file", { path: await resolveStoredFilePath(phrase.content) });
      } else {
        await invoke("paste_text_terminal", { text: phrase.content });
      }
    } catch (e) {
      console.error("Terminal paste failed:", e);
    }
  },

  reorderPhrases: async (ids: string[]) => {
    const idOrder = new Map(ids.map((id, i) => [id, i]));
    set((s) => ({
      phrases: [...s.phrases].sort(
        (a, b) => (idOrder.get(a.id) ?? Infinity) - (idOrder.get(b.id) ?? Infinity)
      ),
    }));
    try {
      await invoke("reorder_phrases", { ids });
    } catch (e) {
      console.error("Failed to reorder phrases:", e);
    }
  },

  reorderGroups: async (ids: string[]) => {
    const idOrder = new Map(ids.map((id, i) => [id, i]));
    set((s) => ({
      groups: [...s.groups].sort(
        (a, b) => (idOrder.get(a.id) ?? Infinity) - (idOrder.get(b.id) ?? Infinity)
      ),
    }));
    try {
      await invoke("reorder_phrase_groups", { ids });
    } catch (e) {
      console.error("Failed to reorder groups:", e);
    }
  },
  };
});
