import type { CanvasLayoutEntry, CanvasNode } from "../../../stores/canvasStore";

// 画布手势共享类型与常量（自 FreeCanvas.tsx 零改动搬运，2026-11-03 引擎
// 拆分阶段 6a）。引擎框架 fork 自旧 ProjectCanvas（已退役）。

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 2.2;
export const WIRES_VIEWPORT_PAD = 64;
export const MINI_W = 150;
export const MINI_H = 96;
export const UNDO_LIMIT = 50;

export type Pos = { x: number; y: number };
export type WireBox = Pos & { w: number; h: number };

export type DragState =
  | { kind: "pan"; sx: number; sy: number; ox: number; oy: number; moved: boolean }
  | { kind: "marquee"; sx: number; sy: number; mq: HTMLDivElement | null; moved: boolean }
  | {
      kind: "node";
      sx: number; sy: number;
      ox: number; oy: number;
      frameKey: string;
      moved: boolean;
    }
  | { kind: "multidrag"; sx: number; sy: number; moved: boolean; members: { key: string; x: number; y: number }[] }
  | {
      kind: "resize";
      sx: number; sy: number; moved: boolean;
      ox: number; oy: number;
      frameKey: string;
      corner: "nw" | "ne" | "sw" | "se";
      px?: number;
      py?: number;
      px0?: number;
      py0?: number;
    }
  | {
      kind: "wire";
      sx: number; sy: number; moved: boolean;
      fromKey: string;
      /** 拖线方向：out = 从输出口拖出建线；in = 从输入口反向拖（落点
       *  为上游）或摘线换目标（rewire）。 */
      fromDir: "in" | "out";
      fromPortId: string;
      /** 摘线换目标：拿着的那条连线（行数据未删，松手定去向）。 */
      rewire?: boolean;
      connId?: string;
      targetKey: string | null;
      targetPort: string | null;
      invalid?: boolean;
    }
  | { kind: "wirecut"; sx: number; sy: number; moved: boolean; px?: number; py?: number }
  | {
      kind: "addnode";
      sx: number; sy: number; moved: boolean;
      fox: number; foy: number;
      /** 新节点类型（工程作用域为工程类型 id，放宽为 string）。 */
      frameKey: string;
      /** 拖线到空白建节点：创建后自动接上这条线。 */
      wire?: { fromKey: string; fromDir: "in" | "out"; fromPortId: string };
      /** 摘线到空白建节点：创建后线改接新节点（原连线行删除）。 */
      detached?: { connId: string; fromKey: string };
    };

export type UndoAction =
  | { kind: "layout"; prev: CanvasLayoutEntry[]; next: CanvasLayoutEntry[] }
  | {
      kind: "delete";
      nodes: CanvasNode[];
      connections: { from_node: string; to_node: string; to_port: string }[];
    }
  | { kind: "create"; ids: string[] };
