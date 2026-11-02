import { create } from "zustand";

// 节点错误文案（UI 层状态，不落库）：run*/取媒/工具执行失败写，节点体
// 读（fc-gen-warn 红字行）。set 置空串与 delete 键两种清法都保留，与
// FreeCanvas 原 setState 更新器签名一致（调用点零改动）。
interface NodeErrorsState {
  errors: Record<string, string>;
  setErrors: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
}

export const useNodeErrors = create<NodeErrorsState>((set) => ({
  errors: {},
  setErrors: (updater) => set((s) => ({ errors: updater(s.errors) })),
}));
