import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasNode } from "../../../stores/canvasStore";
import { PORT_DEFS } from "../nodes/registry";
import type { Pos, WireBox } from "./gestureTypes";
import type { ViewState } from "./useViewport";
import { nodeSize } from "./wireGeom";

// 节点实测尺寸与端口位置（自 FreeCanvas.tsx 零改动搬运，2026-11-03 引擎
// 拆分阶段 6b；fork 自旧 ProjectCanvas，已退役）。连线锚点跟随真实 DOM——
// pc-port[data-port-id] 实测，常量只是首帧兜底。

export interface NodeMetrics {
  boxes: Record<string, { w: number; h: number }>;
  ports: Record<string, Record<string, Pos>>;
}

export function useNodeMetrics(
  vpRef: React.RefObject<HTMLDivElement | null>,
  view: ViewState,
  nodes: CanvasNode[],
) {
  const [nodeMetrics, setNodeMetrics] = useState<NodeMetrics>({ boxes: {}, ports: {} });
  const nodeMetricsRef = useRef(nodeMetrics);
  const viewScaleRef = useRef(view.scale);
  const measureRafRef = useRef<number | null>(null);

  const measureNodes = useCallback(() => {
    const els = vpRef.current?.querySelectorAll<HTMLElement>(".pc-node[data-key]");
    if (!els || els.length === 0) return;
    const scale = viewScaleRef.current || 1;
    const boxes: Record<string, { w: number; h: number }> = {};
    const ports: Record<string, Record<string, Pos>> = {};
    els.forEach((nodeEl) => {
      const key = nodeEl.getAttribute("data-key") ?? "";
      if (!key) return;
      const nr = nodeEl.getBoundingClientRect();
      boxes[key] = { w: nodeEl.offsetWidth, h: nodeEl.offsetHeight };
      const map: Record<string, Pos> = {};
      nodeEl.querySelectorAll<HTMLElement>(".pc-port").forEach((portEl) => {
        const pr = portEl.getBoundingClientRect();
        const pid = portEl.getAttribute("data-port-id") ?? "";
        if (!pid) return;
        map[pid] = {
          x: (pr.x + pr.width / 2 - nr.x) / scale,
          y: (pr.y + pr.height / 2 - nr.y) / scale,
        };
      });
      ports[key] = map;
    });
    const prev = nodeMetricsRef.current;
    if (
      JSON.stringify(prev.boxes) === JSON.stringify(boxes) &&
      JSON.stringify(prev.ports) === JSON.stringify(ports)
    ) {
      return;
    }
    const next = { boxes, ports };
    nodeMetricsRef.current = next;
    setNodeMetrics(next);
  }, [vpRef]);

  const scheduleMeasureNodes = useCallback(() => {
    if (measureRafRef.current !== null) return;
    measureRafRef.current = window.requestAnimationFrame(() => {
      measureRafRef.current = null;
      measureNodes();
    });
  }, [measureNodes]);

  const nodeRoRef = useRef<ResizeObserver | null>(null);
  useEffect(() => () => {
    nodeRoRef.current?.disconnect();
    if (measureRafRef.current !== null) window.cancelAnimationFrame(measureRafRef.current);
  }, []);
  useLayoutEffect(() => {
    viewScaleRef.current = view.scale;
    if (!nodeRoRef.current) {
      nodeRoRef.current = new ResizeObserver(scheduleMeasureNodes);
    }
    const ro = nodeRoRef.current;
    const els = Array.from(vpRef.current?.querySelectorAll<HTMLElement>(".pc-node[data-key]") ?? []);
    els.forEach((el) => ro.observe(el));
    // 节点尺寸/内容刚由 React 提交时，连线本帧就必须拿到最新端口偏移；
    // ResizeObserver 的 rAF 合帧只负责后续外部布局变化，不能成为首个测量。
    measureNodes();
    scheduleMeasureNodes();
    return () => els.forEach((el) => ro.unobserve(el));
  }, [view.scale, nodes, measureNodes, scheduleMeasureNodes, vpRef]);

  const boxOf = useCallback(
    (key: string): WireBox | null => {
      const node = nodes.find((n) => n.id === key);
      if (!node) return null;
      const measured = nodeMetrics.boxes[key];
      const size = nodeSize(node);
      return {
        x: node.pos_x,
        y: node.pos_y,
        w: measured?.w ?? size.w,
        h: measured?.h ?? size.h,
      };
    },
    [nodes, nodeMetrics],
  );

  // 端口点：优先用实测端口坐标（portBar 行位随卡体内容变化），
  // 未实测前退回「输出右缘中点 / 输入按口序分布」的常量估算。
  const outPointOf = useCallback(
    (key: string): { x: number; y: number } | null => {
      const box = boxOf(key);
      if (!box) return null;
      const off = nodeMetrics.ports[key]?.__out;
      if (off) return { x: box.x + off.x, y: box.y + off.y };
      return { x: box.x + box.w, y: box.y + box.h / 2 };
    },
    [boxOf, nodeMetrics],
  );
  const inPointOf = useCallback(
    (key: string, portId?: string): { x: number; y: number } | null => {
      const box = boxOf(key);
      if (!box) return null;
      // portId 省略时取该节点首个输入口（工程成片线只报到节点不报到口）：
      // 否则实测表查 undefined 键恒 miss，永远退到「左缘中点」常数估算，
      // 口点不在中点时线就错位（用户实测成片输入口与线错开）。
      const def = PORT_DEFS[nodes.find((n) => n.id === key)?.type ?? "note"];
      const pid = portId ?? def.ins[0]?.id;
      const off = pid ? nodeMetrics.ports[key]?.[pid] : undefined;
      if (off) return { x: box.x + off.x, y: box.y + off.y };
      const index = Math.max(0, def.ins.findIndex((p) => p.id === pid));
      const rows = Math.max(1, def.ins.length);
      return { x: box.x, y: box.y + (box.h * (index + 1)) / (rows + 1) };
    },
    [boxOf, nodeMetrics, nodes],
  );

  return { nodeMetrics, nodeMetricsRef, boxOf, outPointOf, inPointOf, measureNodes, scheduleMeasureNodes };
}
