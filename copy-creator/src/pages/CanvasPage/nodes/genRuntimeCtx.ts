import { createContext, useContext } from "react";
import type { CanvasNode } from "../../../stores/canvasStore";

// 生成运行时的 Context 与钩子（无组件模块，配合 genRuntime.tsx 的
// Provider；拆文件为满足 react-refresh 组件文件纯组件导出约定）。

/** 谢幕节拍（ms）：全部到齐 → 融合收拢 → 膨开铺满 → 舞台淡出 → 缩略图
 *  落格。与原型时序一致，canvas.css 的过渡时长与之对齐。 */
export const GEN_WAIT_FUSE_MS = 950;
export const GEN_WAIT_BLOOM_MS = 1200;
export const GEN_WAIT_EXIT_MS = 300;
export const GEN_WAIT_LAND_MS = 520;

export type GenWaitPhase = "wait" | "fuse" | "bloom" | "exit" | "land";

/** 等待编排快照：跟随 store 逐张回传镜像（wait 态持续更新），store 条目
 *  被最终 canvas-changed 裁掉后冻结——谢幕序列不能依赖 store，它比节点
 *  状态刷新先消失。 */
export interface GenWaitSnap {
  phase: GenWaitPhase;
  /** 走过融合庆祝（全部成功）：exit 淡出时保留融合态，光满着谢幕。 */
  celebrated: boolean;
  total: number;
  received: number;
  errors: number;
  requestId: string;
  previews: Record<number, string>;
}

export interface GenRuntime {
  /** 生成等待快照表（GenImageBody 读 busyOn 与流光舞台）。 */
  genWait: Record<string, GenWaitSnap>;
  /** 生成发起中（按钮禁用 + 批量条隐藏）。 */
  genStarting: boolean;
  startGenerate(node: CanvasNode): Promise<void>;
  runBatch(): Promise<void>;
}

export const GenRuntimeCtx = createContext<GenRuntime | null>(null);

export function useGenRuntime(): GenRuntime {
  const ctx = useContext(GenRuntimeCtx);
  if (!ctx) throw new Error("useGenRuntime 必须在 <GenRuntimeProvider> 内使用");
  return ctx;
}
