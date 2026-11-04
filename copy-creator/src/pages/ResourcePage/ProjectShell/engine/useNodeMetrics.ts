// 工程画布连线几何与节点实测尺寸（自 ProjectCanvas.tsx 组件体零改动
// 搬移，2026-11-03 引擎拆分阶段 11d）：生成链+手动线聚合、DOM 实测
// 卡体/端口偏移（ResizeObserver + rAF 合帧）、boxOf/outPointOf/inPoint
// 锚点解析与实体→承载节点 key 回退。
import { useCallback, useLayoutEffect, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ProjectAssetLink, ProjectNodeLink, ProjectScene } from "../../../../stores/projectStore";
import { allAssetsOf, SEG_H, SEG_W, INFO_H, INFO_W, OUTPUT_H, OUTPUT_W, SCRIPT_W } from "../layout";
import type { CanvasInfo, Pos, PosMap, WireBox, WireItem } from "../types";

type ViewState = { x: number; y: number; scale: number };

export function useNodeMetrics(deps: {
  vpRef: RefObject<HTMLDivElement | null>;
  view: ViewState;
  layout: Omit<import("../types").CanvasLayout, "infoFramePos">;
  scenes: ProjectScene[];
  links: ProjectAssetLink[];
  nodeSizes: Record<string, { w: number; h: number }>;
  infoNodes: CanvasInfo[];
  segments: unknown[];
  promptPhs: unknown[];
  entityPhs: unknown[];
  pos: PosMap;
  cardSizeOf(shotId: string): { w: number; h: number };
  outputBox: WireBox | null;
  segPos: Record<string, Pos>;
  sizeOfNode(key: string): { w: number; h: number } | null;
  infoNodePos(key: string): Pos;
  infoGroups: import("../types").InfoGroup[];
}) {
  const {
    vpRef, view, layout, scenes, links, nodeSizes, infoNodes, segments,
    promptPhs, entityPhs, pos, cardSizeOf, outputBox, segPos, sizeOfNode,
    infoNodePos, infoGroups,
  } = deps;

  // ── 连线：容器（镜头卡）之间的生成链 + 手动线 ──
  const containerOf = useCallback(
    (assetId: string): string | null => {
      for (const scene of scenes) {
        for (const shot of scene.shots) {
          if (shot.assets.some((a) => a.id === assetId)) return `shot:${shot.id}`;
        }
      }
      return null;
    },
    [scenes],
  );

  const wires = useMemo(() => {
    const list: WireItem[] = [];
    const kindOf = new Map(allAssetsOf(scenes).map((a) => [a.id, a.kind]));
    const pushWire = (fromAsset: string, toAsset: string, kind: "gen" | "manual") => {
      const from = containerOf(fromAsset);
      const to = containerOf(toAsset);
      if (!from || !to || from === to) return;
      if (list.some((w) => w.fromKey === from && w.toKey === to && w.kind === kind)) return;
      list.push({ fromKey: from, toKey: to, kind, type: kindOf.get(fromAsset) ?? "file" });
    };
    allAssetsOf(scenes).forEach((asset) => {
      if (asset.gen_from_asset && kindOf.has(asset.gen_from_asset)) {
        pushWire(asset.gen_from_asset, asset.id, "gen");
      }
    });
    links.forEach((link: ProjectAssetLink) => {
      pushWire(link.from_asset, link.to_asset, "manual");
    });
    return list;
  }, [scenes, links, containerOf]);

  // ── 节点实测尺寸与端口位置：连线锚点跟随真实 DOM（内容自适应的
  // 标题条/端口行/缩略图都会改变卡体高度，常量只是首帧兜底） ──
  const [nodeMetrics, setNodeMetrics] = useState<{
    boxes: Record<string, { w: number; h: number }>;
    ports: Record<string, Record<string, Pos>>;
  }>({ boxes: {}, ports: {} });
  const nodeMetricsRef = useRef(nodeMetrics);
  const viewScaleRef = useRef(view.scale);
  const measureRafRef = useRef<number | null>(null);
  const measureNodes = useCallback(() => {
    const nodes = vpRef.current?.querySelectorAll<HTMLElement>(".pc-node[data-key]");
    if (!nodes || nodes.length === 0) return;
    const scale = viewScaleRef.current || 1;
    const boxes: Record<string, { w: number; h: number }> = {};
    const ports: Record<string, Record<string, Pos>> = {};
    nodes.forEach((nodeEl) => {
      const key = nodeEl.getAttribute("data-key") ?? "";
      if (!key) return;
      const nr = nodeEl.getBoundingClientRect();
      boxes[key] = { w: nodeEl.offsetWidth, h: nodeEl.offsetHeight };
      const map: Record<string, Pos> = {};
      nodeEl.querySelectorAll<HTMLElement>(".pc-port").forEach((portEl) => {
        const pr = portEl.getBoundingClientRect();
        const pid =
          portEl.getAttribute("data-port-id") ??
          (portEl.getAttribute("data-port") === "out" ? "__out" : "__in");
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
  }, [view.scale, layout, nodeSizes, infoNodes, segments, promptPhs, entityPhs, measureNodes, scheduleMeasureNodes, vpRef]);

  const boxOf = useCallback(
    (key: string): WireBox | null => {
      const measured = nodeMetrics.boxes[key];
      const finish = (x: number, y: number, w: number, h: number): WireBox => ({
        x,
        y,
        w: measured?.w ?? w,
        h: measured?.h ?? h,
      });
      if (key.startsWith("shot:")) {
        const p = pos.cards[key.slice(5)];
        if (!p) return null;
        const size = sizeOfNode(key) ?? cardSizeOf(key.slice(5));
        return finish(p.x, p.y, size.w, size.h);
      }
      if (key.startsWith("segment:")) {
        const p = segPos[key.slice(8)];
        const size = sizeOfNode(key);
        return p ? finish(p.x, p.y, size?.w ?? SEG_W, SEG_H) : null;
      }
      if (key === "output") {
        const size = sizeOfNode(key) ?? { w: OUTPUT_W, h: OUTPUT_H };
        return outputBox ? finish(outputBox.x, outputBox.y, size.w, size.h) : null;
      }
      if (key.startsWith("eph:")) {
        const p = infoNodePos(key);
        const size = sizeOfNode(key);
        return p ? finish(p.x, p.y, size?.w ?? INFO_W, size?.h ?? INFO_H) : null;
      }
      // 提示词纸片：独立渲染块（不在 infoNodes），位置同空白占位解析。
      if (key.startsWith("prompt:")) {
        const p = infoNodePos(key);
        const size = sizeOfNode(key);
        return p ? finish(p.x, p.y, size?.w ?? SCRIPT_W, size?.h ?? INFO_H + 40) : null;
      }
      // 资料节点（角色/场景/道具/剧本）：拖动过的用覆盖位置，否则网格。
      const infoNode = infoNodes.find((item) => item.key === key);
      const infoP = infoNode ? infoNodePos(key) : undefined;
      const infoSize = infoNode ? sizeOfNode(key) ?? { w: infoNode.w, h: infoNode.h } : null;
      return infoNode && infoP && infoSize ? finish(infoP.x, infoP.y, infoSize.w, infoSize.h) : null;
    },
    [pos, cardSizeOf, outputBox, segPos, infoNodes, nodeMetrics, sizeOfNode, infoNodePos],
  );

  // 端口点：优先用实测端口坐标（标题条/端口行让卡体高度自适应），
  // 未实测前退回「输出右缘中点 / 输入口按列分布」的常量估算。
  const outPointOf = useCallback(
    (key: string): { x: number; y: number } | null => {
      const box = boxOf(key);
      if (!box) return null;
      const off = nodeMetrics.ports[key]?.__out;
      return off ? { x: box.x + off.x, y: box.y + off.y } : { x: box.x + box.w, y: box.y + box.h / 2 };
    },
    [boxOf, nodeMetrics],
  );

  // 实体 → 承载它的节点 key（组节点优先，否则默认单实体节点）。
  // 共享语义下同一实体可被多个组认领，此函数只用于「渲染位置」类回退
  // （取第一个组）；线的归属一律看线自己的 owner_key（ownerKeyOfLink）。
  const ownerKeyOf = useCallback(
    (fromKind: string, fromId: string): string => {
      if (fromKind === "character" || fromKind === "location" || fromKind === "prop") {
        const group = infoGroups.find((g) => g.kind === fromKind && g.members.includes(fromId));
        if (group) return `grp:${group.id}`;
      }
      return fromKind === "script"
        ? "script"
        : fromKind === "character"
          ? `char:${fromId}`
          : fromKind === "location"
            ? `loc:${fromId}`
            : fromKind === "prop"
              ? `prop:${fromId}`
              : fromKind === "segment"
                ? `segment:${fromId}`
                : `shot:${fromId}`;
    },
    [infoGroups],
  );
  // 连线 → 发出节点 key：优先线自身记录的 owner（资料组线身份，精确）；
  // 旧数据无 owner 时按当前组账回退定位（历史互斥语义下唯一组，等价）。
  const ownerKeyOfLink = useCallback(
    (link: Pick<ProjectNodeLink, "from_kind" | "from_id" | "owner_key">): string =>
      link.owner_key ? link.owner_key : ownerKeyOf(link.from_kind, link.from_id),
    [ownerKeyOf],
  );

  return {
    containerOf,
    wires,
    nodeMetrics,
    setNodeMetrics,
    nodeMetricsRef,
    measureNodes,
    boxOf,
    outPointOf,
    ownerKeyOf,
    ownerKeyOfLink,
  };
}
