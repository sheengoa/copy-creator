import type { RefObject } from "react";
import type { CanvasLayoutEntry, CanvasNode } from "../../../stores/canvasStore";
import { useCanvasStore } from "../../../stores/canvasStore";
import { nodeSize } from "./wireGeom";

// 组布局操作（自 FreeCanvas.tsx 零改动搬运，2026-11-03 引擎拆分阶段 6b）：
// 多选组快照 / 批量位置写入 / 成员包围盒——手势（组拖）、键盘（打组）、
// 渲染层（分组框）共用。ref 作为参数传入，保持纯函数可测。

/** 选中组快照：全部选中节点（世界坐标）。任一成员缺失则返回 null。 */
export function groupSnapshotOf(
  selRef: RefObject<string[]>,
  nodesRef: RefObject<CanvasNode[]>,
  minCount = 2,
): { key: string; x: number; y: number }[] | null {
  const sel = selRef.current;
  if (sel.length < minCount) return null;
  const members: { key: string; x: number; y: number }[] = [];
  for (const key of sel) {
    const node = nodesRef.current.find((n) => n.id === key);
    if (!node) return null;
    members.push({ key, x: node.pos_x, y: node.pos_y });
  }
  return members;
}

/** 批量写入各成员的绝对位置（组拖实时移动与撤销恢复共用）。 */
export function moveGroupTo(
  canvasId: string,
  nodesRef: RefObject<CanvasNode[]>,
  members: { key: string; x: number; y: number }[],
): void {
  const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
  const entries: CanvasLayoutEntry[] = [];
  for (const m of members) {
    const node = byId.get(m.key);
    if (!node) continue;
    // 仅移动位置：宽高原样透传。height null = 自动高度，绝不能借
    // nodeSize 的兜底值落成固定高——否则一拖动节点就被"定死"变形。
    entries.push({ id: m.key, pos_x: m.x, pos_y: m.y, width: node.width, height: node.height });
  }
  useCanvasStore.getState().commitLayout(canvasId, entries);
}

/** 成员当前包围盒（世界坐标；节点已删除则 null）。 */
export function memberFrameOf(
  nodesRef: RefObject<CanvasNode[]>,
  key: string,
): { x: number; y: number; w: number; h: number } | null {
  const node = nodesRef.current.find((n) => n.id === key);
  if (!node) return null;
  const size = nodeSize(node);
  return { x: node.pos_x, y: node.pos_y, w: size.w, h: size.h };
}
