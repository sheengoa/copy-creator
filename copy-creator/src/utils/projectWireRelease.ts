/** 画布连线松手结果：把端口提交、空白搜节点、取消/恢复三种语义集中定义。 */
export type WireReleaseAction = "commit" | "picker" | "cancel";

export interface WireReleaseState {
  cancelled: boolean;
  moved: boolean;
  hasTarget: boolean;
  landedOnCanvasItem: boolean;
  insideViewport: boolean;
}

/**
 * ComfyUI 式连线收尾：
 * - 有效目标优先提交；
 * - 画布内空白才打开节点搜索框；
 * - 节点本体、画布外、未移动和系统取消都结束当前手势。
 */
export function resolveWireRelease(state: WireReleaseState): WireReleaseAction {
  if (state.cancelled || !state.moved) return "cancel";
  if (state.hasTarget) return "commit";
  if (!state.insideViewport || state.landedOnCanvasItem) return "cancel";
  return "picker";
}
