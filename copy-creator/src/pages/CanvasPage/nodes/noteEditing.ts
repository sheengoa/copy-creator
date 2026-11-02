import { create } from "zustand";

// 便签编辑会话（UI 层状态，不落库）：双击手势与 note 模块（编辑工具钮、
// textarea）共享的桥。start 由 def.onDoubleClick（双击）或编辑钮调用。
interface NoteEditingState {
  editingId: string | null;
  draft: string;
  start: (id: string, content: string) => void;
  setDraft: (draft: string) => void;
  close: () => void;
}

export const useNoteEditing = create<NoteEditingState>((set) => ({
  editingId: null,
  draft: "",
  start: (id, content) => set({ editingId: id, draft: content }),
  setDraft: (draft) => set({ draft }),
  close: () => set({ editingId: null }),
}));
