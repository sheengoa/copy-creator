import type { CanvasNode } from "../../../stores/canvasStore";
import { NODE_FALLBACK_SIZE } from "../nodes/registry";

// 连线几何纯函数（自 FreeCanvas.tsx 零改动搬运，2026-11-03 引擎拆分阶段
// 6a）。贝塞尔路径 / 切线命中判定 fork 自旧 ProjectCanvas.tsx（已退役）。

// 线段相交（同横坐标单调判定，经典叉积法）——切线的扫过判定用。
// （自旧 ProjectCanvas.tsx 零改动搬运）
export const segsIntersect = (
  a1: { x: number; y: number }, a2: { x: number; y: number },
  b1: { x: number; y: number }, b2: { x: number; y: number },
): boolean => {
  const d = (b1.x - a1.x) * (a2.y - a1.y) - (b1.y - a1.y) * (a2.x - a1.x);
  const e = (b2.x - a1.x) * (a2.y - a1.y) - (b2.y - a1.y) * (a2.x - a1.x);
  const f = (b2.x - b1.x) * (a2.y - a1.y) - (b2.y - b1.y) * (a2.x - a1.x);
  const g = (a1.x - b1.x) * (b2.y - b1.y) - (a1.y - b1.y) * (b2.x - b1.x);
  return d * e < 0 && f * g < 0;
};

// 轨迹段到点的最短距离（刀刃擦过采样点也算切到）。
export const distToSeg = (
  p: { x: number; y: number },
  a1: { x: number; y: number }, a2: { x: number; y: number },
): number => {
  const dx = a2.x - a1.x;
  const dy = a2.y - a1.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a1.x) * dx + (p.y - a1.y) * dy) / len2));
  const ex = p.x - (a1.x + t * dx);
  const ey = p.y - (a1.y + t * dy);
  return Math.hypot(ex, ey);
};

// 切割线段是否命中折线（连线按贝塞尔采样后的屏幕坐标点列）。
export const CUT_TOUCH_PX = 2;
export const segHitsPolyline = (
  a1: { x: number; y: number }, a2: { x: number; y: number },
  pts: { x: number; y: number }[],
): boolean => {
  for (let i = 0; i < pts.length; i++) {
    if (distToSeg(pts[i], a1, a2) < CUT_TOUCH_PX) return true;
  }
  for (let i = 1; i < pts.length; i++) {
    if (segsIntersect(a1, a2, pts[i - 1], pts[i])) return true;
  }
  return false;
};

/** ComfyUI 风格连线贝塞尔（自旧 ProjectCanvas.tsx 零改动搬运）。 */
export function wirePathD(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const offset = Math.hypot(b.x - a.x, b.y - a.y) * 0.25;
  return `M ${a.x} ${a.y} C ${a.x + offset} ${a.y}, ${b.x - offset} ${b.y}, ${b.x} ${b.y}`;
}

/** 节点渲染尺寸（未实测前按类型兜底）。 */
export function nodeSize(node: CanvasNode): { w: number; h: number } {
  const fallback = NODE_FALLBACK_SIZE[node.type];
  return { w: node.width ?? fallback.w, h: node.height ?? fallback.h };
}
