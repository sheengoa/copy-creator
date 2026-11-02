import { createContext, useContext } from "react";

// 自动保存管线运行时的 Context 与钩子（无组件模块，配合 saveRuntime.tsx
// 的 Provider；拆文件是为满足 react-refresh 组件文件纯组件导出约定）。

export interface SaveRuntime {
  /** 设置自动保存目标：清指纹让管线对现有产物立即（重）存一次。 */
  setSaveAutoTarget(nodeId: string, target: "library" | "dir", dir: string): void;
  /** 清除目标回到选择态。 */
  clearSaveAutoTarget(nodeId: string): void;
  /** 弹系统选目录并设为指定路径目标。 */
  pickSaveAutoDir(nodeId: string): Promise<void>;
  /** 失败重试：清 error 态，管线下一拍自动重跑。 */
  retrySaveAuto(nodeId: string): void;
}

export const SaveRuntimeCtx = createContext<SaveRuntime | null>(null);

export function useSaveRuntime(): SaveRuntime {
  const ctx = useContext(SaveRuntimeCtx);
  if (!ctx) throw new Error("useSaveRuntime 必须在 <SaveRuntimeProvider> 内使用");
  return ctx;
}
