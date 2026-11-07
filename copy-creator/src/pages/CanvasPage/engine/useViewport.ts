import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasNode } from "../../../stores/canvasStore";
import { useCanvasData } from "../dataContext";
import type { Pos } from "./gestureTypes";
import { ZOOM_MAX, ZOOM_MIN } from "./gestureTypes";
import { nodeSize } from "./wireGeom";

// 视口引擎（自 FreeCanvas.tsx 零改动搬运，2026-11-03 引擎拆分阶段 6b）。
// 平移/缩放状态、滚轮缩放（原生非被动监听）、滚动归零、右键菜单抑制、
// 首入 fitAll——全部 fork 自旧 ProjectCanvas（已退役）。
// 视口恢复/落盘走 dataContext（默认实现=canvasStore，工程视图=按集存档）。

export type ViewState = { x: number; y: number; scale: number };

export function useViewport(nodes: CanvasNode[]) {
  const data = useCanvasData();
  const vpRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<ViewState>(() => {
    // api 视口为 {x,y,k}（k=缩放），这里映射进 ViewState 的 scale 键。
    const v = data.viewport();
    return v ? { x: v.x, y: v.y, scale: v.k } : { x: 0, y: 0, scale: 1 };
  });
  const [vpSize, setVpSize] = useState<{ w: number; h: number } | null>(null);

  // 实时视口（手势每帧直写 DOM 不进 React）：平移/缩放手势若逐帧
  // setState，整棵画布树（节点+连线+迷你地图）每帧全量重渲染，节点与
  // 媒体一多必然掉帧（2026-11-08 执行后平移卡顿的架构级防御）。手势
  // 期间 viewRef 持有真实视口并直写 pc-world transform（world 内的
  // 连线/节点/组框随 transform 合成移动，无须渲染参与）；手势结束
  // commitView 一次性提交 state，喂给渲染消费层（视口剔除/迷你地图），
  // 滞后 300ms 内不可感知。
  const viewRef = useRef<ViewState>(view);

  const saveView = useCallback(
    (next: ViewState) => {
      data.setViewport(next.x, next.y, next.scale);
    },
    [data],
  );

  // 直写实时视口（手势路径）：只动 DOM 与 viewRef，不触发渲染。
  const applyViewDirect = useCallback(
    (next: ViewState) => {
      viewRef.current = next;
      const world = vpRef.current?.firstElementChild as HTMLElement | null;
      world?.style.setProperty(
        "transform",
        `translate(${next.x}px, ${next.y}px) scale(${next.scale})`,
      );
    },
    [vpRef],
  );

  // 提交实时视口（手势/滚轮结束）：一次 setState 喂渲染消费层 + 落库。
  const commitView = useCallback(() => {
    setView(viewRef.current);
    saveView(viewRef.current);
  }, [saveView]);

  // 提交版 view 变化（fitAll/视口恢复/迷你地图/外部 setView）时同步 DOM。
  // 手势直写的值与 viewRef 一致，此 effect 不会造成回跳。
  useLayoutEffect(() => {
    viewRef.current = view;
    const world = vpRef.current?.firstElementChild as HTMLElement | null;
    world?.style.setProperty(
      "transform",
      `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
    );
  }, [view, vpRef]);

  // 视口实测尺寸：迷你地图的视口矩形与连线层视口裁切都要用。
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const update = () => setVpSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 滚轮缩放：直写实时视口 + 150ms 防抖提交（滚轮连发不逐帧渲染）。
  const wheelCommitRef = useRef<number | null>(null);
  const zoomAt = useCallback(
    (mx: number, my: number, factor: number) => {
      const prev = viewRef.current;
      const ns = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev.scale * factor));
      const next = {
        x: mx - (mx - prev.x) * (ns / prev.scale),
        y: my - (my - prev.y) * (ns / prev.scale),
        scale: ns,
      };
      applyViewDirect(next);
      if (wheelCommitRef.current !== null) clearTimeout(wheelCommitRef.current);
      wheelCommitRef.current = window.setTimeout(() => {
        wheelCommitRef.current = null;
        commitView();
      }, 150);
    },
    [applyViewDirect, commitView],
  );

  // 滚轮缩放走原生非被动监听：React 合成 onWheel 是 passive 的，
  // preventDefault 不生效（ctrl+滚轮会触发网页缩放）。
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // 视口永远不该被滚动（平移/缩放都走 transform）：聚焦滚动会把容器
  // 推走表现为节点集体平移。任何滚动立即归零。
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollLeft !== 0 || el.scrollTop !== 0) el.scrollTo(0, 0);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 画布区域一律不弹浏览器右键菜单：Shift+右键是切线手势。
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest(".pc-root")) e.preventDefault();
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, []);

  // 首入适配：视口仍是出厂默认且画布已有节点时，fitAll 一次。
  const fitAttemptedRef = useRef(false);
  const fitAll = useCallback(
    (list: CanvasNode[]): boolean => {
      const rect = vpRef.current?.getBoundingClientRect();
      // 视口还没完成布局（刚切区/首帧）时不 fit：高度为 0 会算出 scale 0
      // 并随视口落库，画布从此整体缩没（实测踩坑）。返回 false 让调用方
      // 稍后重试。
      if (!rect || rect.width === 0 || rect.height === 0 || !list.length) return false;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of list) {
        const size = nodeSize(n);
        minX = Math.min(minX, n.pos_x);
        minY = Math.min(minY, n.pos_y);
        maxX = Math.max(maxX, n.pos_x + size.w);
        maxY = Math.max(maxY, n.pos_y + size.h);
      }
      const pad = 60;
      const usableW = Math.max(200, rect.width);
      const bw = maxX - minX + pad * 2;
      const bh = maxY - minY + pad * 2;
      // 只缩小不放大：内容小于视口时保持 1:1。
      const scale = Math.min(1, Math.min(usableW / bw, rect.height / bh));
      const next = {
        x: (usableW - (maxX - minX) * scale) / 2 - minX * scale,
        y: (rect.height - (maxY - minY) * scale) / 2 - minY * scale,
        scale,
      };
      setView(next);
      saveView(next);
      return true;
    },
    [saveView],
  );
  useEffect(() => {
    if (fitAttemptedRef.current) return;
    const v = view;
    if (v.x !== 0 || v.y !== 0 || v.scale !== 1) {
      fitAttemptedRef.current = true;
      return;
    }
    if (nodes.length && fitAll(nodes)) {
      fitAttemptedRef.current = true;
    }
  }, [nodes, fitAll, view]);

  return { vpRef, view, viewRef, setView, vpSize, saveView, applyViewDirect, commitView, zoomAt, fitAll, fitAttemptedRef };
}

/** 迷你地图内容包围盒（世界坐标）——渲染层与手势共用的小工具。 */
export function contentBBoxOf(nodes: CanvasNode[]): Pos & { w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const size = nodeSize(n);
    minX = Math.min(minX, n.pos_x);
    minY = Math.min(minY, n.pos_y);
    maxX = Math.max(maxX, n.pos_x + size.w);
    maxY = Math.max(maxY, n.pos_y + size.h);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
