import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Icons } from "../../components/Icons";
import { openResourceFile } from "../../domain/mediaAssets";
import { resolveResourceMediaUrl } from "../../domain/mediaUrl";
import { useSettingsStore } from "../../stores/settingsStore";
import { resolveWireRelease } from "../../utils/projectWireRelease";
import {
  useCanvasStore,
  type CanvasLayoutEntry,
  type CanvasNode,
  type CanvasNodeType,
} from "../../stores/canvasStore";

// 自由生图画布（画布区方案 3.3）：以 ProjectCanvas 为基座 fork——引擎框架
// （视口平移/缩放/滚轮非被动监听/聚焦滚动归零、nodeMetrics 节点实测锚点、
// wirePathD 贝塞尔、视口裁切连线层、ComfyUI 连线手势状态机、Blender 切线
// 与切痕层、框选、四角尺寸手柄、双击建节点菜单、出生锚点脉冲、统一双击
// 判定）自工程画布零改动搬运；连线落点按「节点级引用」语义重写（每节点
// 右侧一个输出口、左侧一个输入位，多入线按类型分组累积，无端口体系）。
// 数据全部走 canvasStore（SQLite），视口/布局防抖落盘。

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.2;
const WIRES_VIEWPORT_PAD = 64;
const MINI_W = 150;
const MINI_H = 96;
const UNDO_LIMIT = 50;

/** 建节点落库的默认尺寸（画布区节点视觉标准，B+ 通透玻璃稿定案）：
 *  高度不落库 = 内容自适应撑开（消灭固定高的大空白）；text 正文是
 *  常驻编辑框需固定高。用户拖过尺寸手柄后 height 落库转固定。 */
const NODE_DEFAULT_SIZE: Record<CanvasNodeType, { w: number; h: number | null }> = {
  text: { w: 260, h: 170 },
  note: { w: 220, h: null },
  image: { w: 280, h: null },
  ref: { w: 260, h: null },
};

/** 连线锚点在 nodeMetrics 实测前的兜底尺寸（实测优先，常量只是首帧）。 */
const NODE_FALLBACK_SIZE: Record<CanvasNodeType, { w: number; h: number }> = {
  text: { w: 260, h: 170 },
  note: { w: 220, h: 120 },
  image: { w: 280, h: 320 },
  ref: { w: 260, h: 200 },
};

/** 各类型缩放下限（对齐工程画布 resize 分类型的 minW/minH 惯例）。 */
const NODE_MIN_SIZE: Record<CanvasNodeType, { w: number; h: number }> = {
  text: { w: 180, h: 120 },
  note: { w: 120, h: 80 },
  image: { w: 180, h: 200 },
  ref: { w: 150, h: 120 },
};

/** 节点类型色通道（连线取上游节点色，对齐工程画布「线色跟来源」惯例）。 */
const NODE_ACCENT: Record<CanvasNodeType, string> = {
  text: "#007AFF",
  image: "#AF52DE",
  ref: "#34C759",
  note: "#E6A700",
};

type Pos = { x: number; y: number };
type WireBox = Pos & { w: number; h: number };

// 线段相交（同横坐标单调判定，经典叉积法）——切线的扫过判定用。
// （自 ProjectCanvas.tsx 零改动搬运）
const segsIntersect = (
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
const distToSeg = (
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
// 叉积法对「恰好穿过采样顶点」的零面积相交会漏判，补 2px 触碰判定：
// 刀刃扫到即断，符合 knife 手势直觉。
const CUT_TOUCH_PX = 2;
const segHitsPolyline = (
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

/** ComfyUI 风格连线：直接接收两端端口点（输出在节点右缘、输入在左缘），
 *  控制点沿水平方向延伸两点距离的 1/4，任意角度都是平滑弯出的贝塞尔，
 *  不存在直线或拐角形态。（自 ProjectCanvas.tsx 零改动搬运） */
function wirePathD(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const offset = Math.hypot(b.x - a.x, b.y - a.y) * 0.25;
  return `M ${a.x} ${a.y} C ${a.x + offset} ${a.y}, ${b.x - offset} ${b.y}, ${b.x} ${b.y}`;
}

function nodeSize(node: CanvasNode): { w: number; h: number } {
  const fallback = NODE_FALLBACK_SIZE[node.type];
  return { w: node.width ?? fallback.w, h: node.height ?? fallback.h };
}

type DragState =
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
      fromDir: "in" | "out";
      /** 摘线换目标：拿着的那条连线（行数据未删，松手定去向）。 */
      rewire?: boolean;
      connId?: string;
      targetKey: string | null;
      invalid?: boolean;
    }
  | { kind: "wirecut"; sx: number; sy: number; moved: boolean; px?: number; py?: number }
  | {
      kind: "addnode";
      sx: number; sy: number; moved: boolean;
      fox: number; foy: number;
      frameKey: CanvasNodeType;
      /** 拖线到空白建节点：创建后自动接上这条线。 */
      wire?: { fromKey: string; fromDir: "in" | "out" };
      /** 摘线到空白建节点：创建后线改接新节点（原连线行删除）。 */
      detached?: { connId: string; fromKey: string };
    };

type UndoAction =
  | { kind: "layout"; prev: CanvasLayoutEntry[]; next: CanvasLayoutEntry[] }
  | {
      kind: "delete";
      nodes: CanvasNode[];
      connections: { from_node: string; to_node: string }[];
    }
  | { kind: "create"; ids: string[] };

/** 资源缩略图：mediaUrl 域层唯一出口，路径变化重解析。 */
function ResourceThumb({ path, className }: { path: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    resolveResourceMediaUrl(path)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);
  if (!url) return null;
  return <img className={className} src={url} alt="" draggable={false} />;
}

export default function FreeCanvas({ canvasId }: { canvasId: string }) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const connections = useCanvasStore((s) => s.connections);
  const groups = useCanvasStore((s) => s.groups);
  const genProgress = useCanvasStore((s) => s.genProgress);
  const aiModel = useSettingsStore((s) => s.aiModel);
  const aiProvider = useSettingsStore((s) => s.aiProvider);
  /** 模型占位符兜底：节点未填且设置页默认模型为空时按提供商给示例名。 */
  const modelFallback = aiModel || (aiProvider === "gemini" ? "gemini-2.5-flash-image" : "gpt-image-1");

  const store = useCanvasStore;
  const nodesRef = useRef(nodes);
  const connectionsRef = useRef(connections);
  const selRef = useRef<string[]>([]);

  const vpRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState(() => {
    const c = useCanvasStore.getState().activeCanvas;
    return c && c.id === canvasId
      ? { x: c.viewport_x, y: c.viewport_y, scale: c.viewport_k }
      : { x: 0, y: 0, scale: 1 };
  });
  const [vpSize, setVpSize] = useState<{ w: number; h: number } | null>(null);
  const [selKeys, setSelKeys] = useState<string[]>([]);
  const setSelection = useCallback((keys: string[]) => {
    selRef.current = keys;
    setSelKeys(keys);
  }, []);

  const [addMenu, setAddMenu] = useState<{
    sx: number;
    sy: number;
    wx: number;
    wy: number;
    /** 拖线到空白：菜单创建的节点自动接上这条线。 */
    wire?: { fromKey: string; fromDir: "in" | "out" };
    /** 摘线到空白：菜单创建的节点接走这条线（原连线行删除）。 */
    detached?: { connId: string; fromKey: string };
  } | null>(null);
  const [addMenuQuery, setAddMenuQuery] = useState("");
  const [wireDraft, setWireDraft] = useState<{ d: string; invalid: boolean; color?: string } | null>(null);
  /** 摘线拿着（rewire）中：该连线暂隐藏，松手转接或放回。 */
  const [liftedWire, setLiftedWire] = useState<{ connId: string; fromKey: string } | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [genStarting, setGenStarting] = useState(false);
  const [nodeErrors, setNodeErrors] = useState<Record<string, string>>({});
  const [pulseKeys, setPulseKeys] = useState<string[]>([]);

  const dragRef = useRef<DragState | null>(null);
  const wireHoverRef = useRef<HTMLElement | null>(null);
  const wirePortHoverRef = useRef<HTMLElement | null>(null);
  const cutTrailRef = useRef<SVGPolylineElement | null>(null);
  const cutTrailUnderRef = useRef<SVGPolylineElement | null>(null);
  const cutPointsRef = useRef<string[]>([]);
  const cutTargetsRef = useRef<{ pts: { x: number; y: number }[]; done: boolean; del: () => void }[] | null>(null);
  const dblRef = useRef<{ key: string; x: number; y: number; t: number } | null>(null);
  const capturedRef = useRef(false);
  const suppressClickRef = useRef(false);

  // 渲染后同步镜像：窗口级手势回调读 ref 免闭包陈旧（react-hooks/refs
  // 禁止渲染期写 ref，统一在 effect 提交）。
  useEffect(() => {
    nodesRef.current = nodes;
    connectionsRef.current = connections;
  }, [nodes, connections]);
  useEffect(() => {
    selRef.current = selKeys;
  }, [selKeys]);

  // ── 撤销栈（对齐工程画布惯例：undoingRef 锁防 StrictMode 双触发） ──

  const undoStackRef = useRef<UndoAction[]>([]);
  const undoingRef = useRef(false);
  const pastingRef = useRef(false);
  const pushUndo = useCallback((action: UndoAction) => {
    undoStackRef.current.push(action);
    if (undoStackRef.current.length > UNDO_LIMIT) undoStackRef.current.shift();
  }, []);

  /** 撤销（Ctrl+Z）：layout 恢复布局；delete 重建节点/连线——节点用新 id
   *  重建（无外部锚引用 canvas 节点 id），连线按 id 映射改接两端；create
   *  （粘贴/种子模板）整节点移除。 */
  const runUndo = useCallback(() => {
    if (undoingRef.current) return;
    undoingRef.current = true;
    try {
      const action = undoStackRef.current.pop();
      if (!action) return;
      if (action.kind === "layout") {
        store.getState().commitLayout(canvasId, action.prev);
        return;
      }
      if (action.kind === "create") {
        for (const id of action.ids) {
          void store.getState().deleteNode(id);
        }
        setSelection([]);
        return;
      }
      void (async () => {
        const idMap = new Map<string, string>();
        for (const node of action.nodes) {
          // 删除时仍在生成中的图片节点，恢复时归一为 error——后台任务已随
          // 删除取消，留着 generating 会让节点永远转圈。
          const restoredMeta = { ...node.metadata };
          if (restoredMeta.kind === "image" && restoredMeta.status === "generating") {
            restoredMeta.status = "error";
            restoredMeta.error = "生成已中断";
          }
          const created = await store.getState().createNode({
            canvasId,
            nodeType: node.type,
            title: node.title,
            posX: node.pos_x,
            posY: node.pos_y,
            width: node.width,
            height: node.height,
            resourcePath: node.resource_path,
            metadata: JSON.stringify(restoredMeta),
          });
          if (created) idMap.set(node.id, created.id);
        }
        for (const conn of action.connections) {
          const from = idMap.get(conn.from_node) ?? conn.from_node;
          const to = idMap.get(conn.to_node) ?? conn.to_node;
          await store.getState().connect(canvasId, from, to);
        }
        setSelection([...idMap.values()]);
      })();
    } finally {
      // 撤销里的后端动作是异步的，锁放到下一宏任务才放开。
      window.setTimeout(() => {
        undoingRef.current = false;
      }, 0);
    }
  }, [canvasId, setSelection, store]);

  // ── 删除（可完整恢复，记撤销栈） ─────────────────────────

  const deleteNodes = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    const targets = nodesRef.current.filter((n) => ids.includes(n.id));
    const conns = connectionsRef.current
      .filter((c) => targets.some((n) => n.id === c.from_node || n.id === c.to_node))
      .map((c) => ({ from_node: c.from_node, to_node: c.to_node }));
    if (targets.length) {
      pushUndo({ kind: "delete", nodes: targets, connections: conns });
    }
    for (const node of targets) {
      // 生成中的节点先取消后端任务再删：否则孤儿请求继续跑完，产物照常
      // 入资源库、落库 UPDATE 落在已删除的行上静默失效。
      const progress = store.getState().genProgress[node.id];
      if (progress) void store.getState().cancelGeneration(progress.requestId);
      await store.getState().deleteNode(node.id);
    }
    setSelection([]);
  }, [pushUndo, setSelection, store]);

  const deleteSelected = useCallback(async () => {
    await deleteNodes(selRef.current);
  }, [deleteNodes]);

  // ── 视口引擎（自 ProjectCanvas 零改动搬运） ─────────────────

  const saveView = useCallback(
    (next: { x: number; y: number; scale: number }) => {
      store.getState().setViewport(canvasId, next.x, next.y, next.scale);
    },
    [canvasId, store],
  );

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

  const zoomAt = useCallback(
    (mx: number, my: number, factor: number) => {
      setView((prev) => {
        const ns = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev.scale * factor));
        const next = {
          x: mx - (mx - prev.x) * (ns / prev.scale),
          y: my - (my - prev.y) * (ns / prev.scale),
          scale: ns,
        };
        saveView(next);
        return next;
      });
    },
    [saveView],
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

  // 视口永远不该被滚动（平移/缩放都走 transform）：overflow:hidden 的
  // 容器仍会被「聚焦滚动」推动——弹层搜索框、便签输入框等聚焦在视口
  // 边缘外时，浏览器会滚动容器把聚焦元素露出，表现为整个画布节点集体
  // 平移（连线/断线时位置漂移的根源）。这里把任何滚动立即归零，根治
  // 所有聚焦滚动路径；归零引发的再入 scroll 事件值为 0，不会成环。
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollLeft !== 0 || el.scrollTop !== 0) el.scrollTo(0, 0);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 画布区域一律不弹浏览器右键菜单：Shift+右键是切线手势，滑动滑出画布
  // （扫到侧栏/顶栏）时弹出的系统菜单会打断手势——表现为闪烁加手势冻结。
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest(".pc-root")) e.preventDefault();
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, []);

  // 首入适配：视口仍是出厂默认（从未缩放/平移过）且画布已有节点时，
  // fitAll 一次；已有保存视口则尊重恢复（对齐工程画布换集 fitAll 体验）。
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
      // 只缩小不放大：内容小于视口时保持 1:1（单节点内容不该被怼到最大倍率）。
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

  // ── 节点实测尺寸与端口位置（自 ProjectCanvas 零改动搬运）：连线
  //    锚点跟随真实 DOM（内容自适应的卡体高度，常量只是首帧兜底） ──

  const [nodeMetrics, setNodeMetrics] = useState<{
    boxes: Record<string, { w: number; h: number }>;
    ports: Record<string, Record<string, Pos>>;
  }>({ boxes: {}, ports: {} });
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
  }, []);
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
    const els = Array.from(
      vpRef.current?.querySelectorAll<HTMLElement>(".pc-node[data-key]") ?? [],
    );
    els.forEach((el) => ro.observe(el));
    // 节点尺寸/内容刚由 React 提交时，连线本帧就必须拿到最新端口偏移；
    // ResizeObserver 的 rAF 合帧只负责后续外部布局变化，不能成为首个测量。
    measureNodes();
    scheduleMeasureNodes();
    return () => els.forEach((el) => ro.unobserve(el));
  }, [view.scale, nodes, measureNodes, scheduleMeasureNodes]);

  const nodeById = useCallback(
    (id: string): CanvasNode | undefined => nodes.find((n) => n.id === id),
    [nodes],
  );

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

  // 端口点：优先用实测端口坐标（卡体高度自适应），未实测前退回
  // 「输出右缘中点 / 输入左缘中点」的常量估算。
  const outPointOf = useCallback(
    (key: string): { x: number; y: number } | null => {
      const box = boxOf(key);
      if (!box) return null;
      const off = nodeMetrics.ports[key]?.__out;
      return off ? { x: box.x + off.x, y: box.y + off.y } : { x: box.x + box.w, y: box.y + box.h / 2 };
    },
    [boxOf, nodeMetrics],
  );
  const inPointOf = useCallback(
    (key: string): { x: number; y: number } | null => {
      const box = boxOf(key);
      if (!box) return null;
      const off = nodeMetrics.ports[key]?.__in;
      return off ? { x: box.x + off.x, y: box.y + off.y } : { x: box.x, y: box.y + box.h / 2 };
    },
    [boxOf, nodeMetrics],
  );

  // ── 出生锚点脉冲（自 ProjectCanvas 搬运）：新建节点出生在用户视线
  //    （鼠标）附近时脉冲高亮，一眼可见「节点出现在这」。 ──
  useEffect(() => {
    if (pulseKeys.length === 0) return;
    const timer = window.setTimeout(() => setPulseKeys([]), 2400);
    return () => window.clearTimeout(timer);
  }, [pulseKeys]);
  const pulseNodes = useCallback((ids: string[]) => {
    if (ids.length) setPulseKeys(ids);
  }, []);

  // ── 多选组拖 / 位置批量写入（对齐工程画布管线） ───────────

  /** 选中组快照：全部选中节点（世界坐标）。任一成员缺失则返回 null。 */
  const groupSnapshot = useCallback(
    (minCount = 2): { key: string; x: number; y: number }[] | null => {
      const sel = selRef.current;
      if (sel.length < minCount) return null;
      const members: { key: string; x: number; y: number }[] = [];
      for (const key of sel) {
        const node = nodesRef.current.find((n) => n.id === key);
        if (!node) return null;
        members.push({ key, x: node.pos_x, y: node.pos_y });
      }
      return members;
    },
    [],
  );
  /** 批量写入各成员的绝对位置（组拖实时移动与撤销恢复共用）：尺寸保持
   *  各节点当前值，只挪位置。 */
  const moveGroupTo = useCallback(
    (members: { key: string; x: number; y: number }[]) => {
      const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
      const entries: CanvasLayoutEntry[] = [];
      for (const m of members) {
        const node = byId.get(m.key);
        if (!node) continue;
        const size = nodeSize(node);
        entries.push({ id: m.key, pos_x: m.x, pos_y: m.y, width: size.w, height: size.h });
      }
      store.getState().commitLayout(canvasId, entries);
    },
    [canvasId, store],
  );

  // ── 节点分组（Ctrl+G，ComfyUI Group 的对应物）：选中若干节点打组成框
  //    （框自适应成员包围盒）；拖组框标题整组移动（复用组拖管线）；选中
  //    恰好是某组全部成员再按 Ctrl+G 解组。成员从其他组移出（互斥）。 ──

  /** 成员当前包围盒（世界坐标；节点已删除则 null，渲染与剪枝自动剔除
   *  ——组员被删后框随之收缩）。 */
  const memberFrame = useCallback(
    (key: string): { x: number; y: number; w: number; h: number } | null => {
      const node = nodesRef.current.find((n) => n.id === key);
      if (!node) return null;
      const size = nodeSize(node);
      return { x: node.pos_x, y: node.pos_y, w: size.w, h: size.h };
    },
    [],
  );

  // 防重入：StrictMode 开发态会双挂载键盘监听，一次 Ctrl+G 建组又解组。
  const groupingRef = useRef(false);
  const toggleGroup = useCallback(() => {
    if (groupingRef.current) return;
    groupingRef.current = true;
    window.setTimeout(() => {
      groupingRef.current = false;
    }, 0);
    const sel = selRef.current;
    if (sel.length === 0) return;
    const st = store.getState();
    // 先剪枝：成员已被删除的组清掉死成员（空组丢弃），保证解组判定与
    // 组框都基于存活成员。
    const pruned = st.groups
      .map((g) => ({ ...g, members: g.members.filter((key) => memberFrame(key) !== null) }))
      .filter((g) => g.members.length > 0);
    const fullGroup = pruned.find(
      (g) => g.members.length === sel.length && sel.every((key) => g.members.includes(key)),
    );
    if (fullGroup) {
      void st.setGroups(canvasId, pruned.filter((g) => g.id !== fullGroup.id));
    } else {
      const kept = pruned
        .map((g) => ({ ...g, members: g.members.filter((key) => !sel.includes(key)) }))
        .filter((g) => g.members.length > 0);
      void st.setGroups(canvasId, [
        ...kept,
        {
          id: `ng${Date.now()}${Math.floor(Math.random() * 1e4)}`,
          label: t("project.canvas.nodeGroup"),
          members: [...sel],
        },
      ]);
    }
  }, [canvasId, memberFrame, store, t]);

  // ── 复制 / 粘贴（Ctrl+C/V） ──────────────────────────────

  const clipRef = useRef<{ nodes: CanvasNode[]; wires: { from_node: string; to_node: string }[]; ax: number; ay: number } | null>(null);
  const copySelection = useCallback(() => {
    const members = groupSnapshot(1);
    if (!members) return;
    const ax = Math.min(...members.map((m) => m.x));
    const ay = Math.min(...members.map((m) => m.y));
    const ids = members.map((m) => m.key);
    const copied = nodesRef.current.filter((n) => ids.includes(n.id));
    // 只带内部连线：两端都在选区内的线随复制重建。
    const wires = connectionsRef.current
      .filter((c) => ids.includes(c.from_node) && ids.includes(c.to_node))
      .map((c) => ({ from_node: c.from_node, to_node: c.to_node }));
    if (copied.length) clipRef.current = { nodes: copied, wires, ax, ay };
  }, [groupSnapshot]);
  const pasteClipboard = useCallback(async () => {
    if (pastingRef.current) return;
    pastingRef.current = true;
    try {
      const clip = clipRef.current;
      if (!clip?.nodes.length) return;
      const st = store.getState();
      const idMap = new Map<string, string>();
      const newIds: string[] = [];
      for (const node of clip.nodes) {
        const created = await st.createNode({
          canvasId,
          nodeType: node.type,
          title: node.title,
          posX: node.pos_x - clip.ax + 28,
          posY: node.pos_y - clip.ay + 28,
          width: node.width,
          height: node.height,
          resourcePath: node.resource_path,
          metadata: JSON.stringify(node.metadata),
        });
        if (created) {
          idMap.set(node.id, created.id);
          newIds.push(created.id);
        }
      }
      for (const wire of clip.wires) {
        const from = idMap.get(wire.from_node);
        const to = idMap.get(wire.to_node);
        if (from && to) await st.connect(canvasId, from, to);
      }
      if (newIds.length) {
        // 粘贴可撤销（对齐工程画布）：整批节点随 Ctrl+Z 移除。
        pushUndo({ kind: "create", ids: newIds });
        setSelection(newIds);
      }
    } finally {
      pastingRef.current = false;
    }
  }, [canvasId, pushUndo, setSelection, store]);

  // ── 连线手势（节点级语义 + 工程画布手势骨架） ─────────────

  /** 摘线到空白后取消菜单（Esc/点外部）＝线就此断开（ComfyUI 语义）。 */
  const discardDetachedWire = useCallback(
    (detached: { connId: string }) => {
      setLiftedWire(null);
      void store.getState().deleteConnection(detached.connId);
    },
    [store],
  );

  // Blender 式切线（Shift/Ctrl+右键滑动）：候选线在按下时采样缓存，
  // 滑动中逐段判定相交。（切痕层直写 polyline，不经 React 状态）
  const buildCutTargets = useCallback(() => {
    const svg = vpRef.current?.querySelector("svg.pc-wires");
    if (!svg) return [];
    const targets: { pts: { x: number; y: number }[]; done: boolean; del: () => void }[] = [];
    svg.querySelectorAll<SVGGElement>("g.pc-wire[data-cut]").forEach((g) => {
      const path = g.querySelector("path.pc-wire-line") as SVGPathElement | null;
      const ctm = path?.getScreenCTM();
      if (!path || !ctm) return;
      const len = path.getTotalLength();
      if (len <= 0) return;
      const pts: { x: number; y: number }[] = [];
      const N = 24;
      for (let i = 0; i <= N; i++) {
        const pt = path.getPointAtLength((len * i) / N);
        const sp = new DOMPoint(pt.x, pt.y).matrixTransform(ctm);
        pts.push({ x: sp.x, y: sp.y });
      }
      const connId = g.getAttribute("data-cut") ?? "";
      targets.push({
        pts,
        done: false,
        del: () => {
          void store.getState().deleteConnection(connId);
        },
      });
    });
    return targets;
  }, [store]);

  const openAddMenu = useCallback(
    (sx: number, sy: number, wx: number, wy: number, pending?: { wire?: { fromKey: string; fromDir: "in" | "out" }; detached?: { connId: string; fromKey: string } }) => {
      setAddMenu({ sx, sy, wx, wy, wire: pending?.wire, detached: pending?.detached });
      setAddMenuQuery("");
    },
    [],
  );

  const onViewportPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      // 节点搜索框是连线释放后的模态状态：点击外部只取消搜索框，
      // 摘线场景同时断开摘下的线，不能继续落入画布空白的框选分支。
      if (addMenu && !target?.closest(".pc-addmenu")) {
        if (addMenu.detached) discardDetachedWire(addMenu.detached);
        setAddMenu(null);
        setAddMenuQuery("");
        e.preventDefault();
        return;
      }
      // 上一场拖拽若有残留（松手事件在窗外丢失等），开新拖拽前先复位：
      // 冻结的草稿线、拿着的摘线、切线态，避免「松手后线卡住」的残影。
      capturedRef.current = false;
      setWireDraft(null);
      setLiftedWire(null);
      if (dragRef.current) {
        dragRef.current = null;
        wireHoverRef.current?.classList.remove("pc-wire-target");
        wireHoverRef.current = null;
        wirePortHoverRef.current?.classList.remove("pc-port-active");
        wirePortHoverRef.current = null;
        vpRef.current?.classList.remove("pc-cutting");
        cutTargetsRef.current = null;
        cutPointsRef.current = [];
        cutTrailUnderRef.current?.setAttribute("points", "");
        cutTrailRef.current?.setAttribute("points", "");
      }
      // 可交互元素一律不进手势：button 上 begin() 会把指针捕获到视口容器，
      // click 被重定向到捕获元素反而点不中；输入元素要保住文本选择/光标。
      if (e.button === 0 && target?.closest("input, textarea, button")) return;

      const vp = vpRef.current;
      if (!vp) return;
      if (e.button === 1) {
        dragRef.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
        vp.classList.add("pc-panning");
        e.preventDefault();
        return;
      }
      // Blender 式切线：Shift/Ctrl+右键滑动，扫过的连线即时切断（光标变
      // 刀、拖出亮色切痕）。候选线在按下时采样缓存，滑动中逐段判定相交。
      if (e.button === 2 && (e.shiftKey || e.ctrlKey)) {
        dragRef.current = { kind: "wirecut", sx: e.clientX, sy: e.clientY, moved: false };
        cutPointsRef.current = [];
        vp.classList.add("pc-cutting");
        cutTargetsRef.current = buildCutTargets();
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;

      // 连线端口：右侧输出口拖出建连线；左侧输入口有来线时按下即摘线
      // （ComfyUI 摘线换目标），无来线时反向拖（落点成为来源）。
      const port = target?.closest(".pc-port") as HTMLElement | null;
      if (port) {
        const nodeEl = port.closest(".pc-node");
        const key = nodeEl?.getAttribute("data-key") ?? "";
        const dir = port.dataset.port === "in" ? "in" : "out";
        if (key) {
          if (dir === "in") {
            // 摘一个输入口 = 拿走这条线（节点级单入线）。
            const incoming = connectionsRef.current.find((c) => c.to_node === key);
            if (incoming) {
              setLiftedWire({ connId: incoming.id, fromKey: incoming.from_node });
              vp.classList.add("pc-wiring");
              port.classList.add("pc-port-active");
              // 原口登记为「当前亮口」：亮口唯一由 wirePortHoverRef 管理，
              // 拖走时悬停切换自然清它，滑回原口也能正常重新点亮。
              wirePortHoverRef.current = port;
              dragRef.current = {
                kind: "wire", sx: e.clientX, sy: e.clientY, moved: false,
                rewire: true, connId: incoming.id,
                fromKey: incoming.from_node, fromDir: "in",
                targetKey: null,
              };
              e.preventDefault();
              return;
            }
          }
          // 普通拖线：源端口点亮（即使草稿线被渲染环境吞掉，按下即有可见状态）。
          vp.classList.add("pc-wiring");
          port.classList.add("pc-port-active");
          dragRef.current = {
            kind: "wire", sx: e.clientX, sy: e.clientY, moved: false,
            fromKey: key, fromDir: dir, targetKey: null,
          };
          e.preventDefault();
          return;
        }
      }

      // 节点四角尺寸手柄（ComfyUI 式）：按下即改尺寸，不挪位置。
      const resizeEl = target?.closest(".pc-resize");
      if (resizeEl) {
        const nodeEl = resizeEl.closest(".pc-node") as HTMLElement | null;
        const key = nodeEl?.getAttribute("data-key") ?? "";
        const node = nodesRef.current.find((n) => n.id === key);
        if (node) {
          const corner = (resizeEl.getAttribute("data-corner") ?? "se") as "nw" | "ne" | "sw" | "se";
          const size = nodeSize(node);
          // 西/北角缩放会挪动节点，按下时记下原始位置。
          const px = node.pos_x;
          const py = node.pos_y;
          nodeEl?.classList.add("pc-resizing");
          dragRef.current = {
            kind: "resize", sx: e.clientX, sy: e.clientY, moved: false,
            // 首次拖拽从实际渲染尺寸起算（自适应高度节点取实测高）。
            ox: nodeEl?.offsetWidth ?? size.w,
            oy: nodeEl?.offsetHeight ?? size.h,
            frameKey: key,
            corner,
            px,
            py,
            px0: px,
            py0: py,
          };
          e.preventDefault();
          return;
        }
      }

      // 节点主体：按下即选中（点亮描边）并拖动；已在多选中时整组拖。
      const nodeEl = target?.closest(".pc-node") as HTMLElement | null;
      if (nodeEl) {
        const key = nodeEl.getAttribute("data-key") ?? "";
        const node = nodesRef.current.find((n) => n.id === key);
        if (node) {
          const group = selRef.current.length > 1 && selRef.current.includes(key) ? groupSnapshot() : null;
          setSelection(selRef.current.includes(key) ? selRef.current : [key]);
          nodeEl.classList.add("pc-dragging");
          dragRef.current = group
            ? { kind: "multidrag", sx: e.clientX, sy: e.clientY, moved: false, members: group }
            : {
                kind: "node",
                sx: e.clientX, sy: e.clientY, moved: false,
                ox: node.pos_x, oy: node.pos_y, frameKey: key,
              };
          e.preventDefault();
          return;
        }
      }

      // 组框标题（Ctrl+G 的组）：按下拖动整组移动（复用组拖管线）。
      const ngLabel = target?.closest(".pc-nodegroup-label");
      if (ngLabel) {
        const gid = ngLabel.closest(".pc-nodegroup")?.getAttribute("data-group") ?? "";
        const group = groups.find((g) => g.id === gid);
        if (group) {
          const members = group.members
            .map((key) => {
              const f = memberFrame(key);
              return f ? { key, x: f.x, y: f.y } : null;
            })
            .filter((m): m is { key: string; x: number; y: number } => m !== null);
          if (members.length > 0) {
            setSelection(members.map((m) => m.key));
            dragRef.current = { kind: "multidrag", sx: e.clientX, sy: e.clientY, moved: false, members };
            e.preventDefault();
            return;
          }
        }
      }

      // 左键空白：框选（DOM 直挂的 marquee 矩形，选中判定在松手）。
      const mq = document.createElement("div");
      mq.className = "pc-marquee";
      vp.appendChild(mq);
      dragRef.current = { kind: "marquee", sx: e.clientX, sy: e.clientY, mq, moved: false };
      e.preventDefault();
    },
    [addMenu, buildCutTargets, discardDetachedWire, groupSnapshot, groups, memberFrame, setSelection, view],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // 首次移动即捕获指针：此后即使松手在窗口外，mouseup 仍送达（根治
      // 「松在窗外 → 摘下的线/草稿线卡住冻结」）；纯点击不经此处不受影响。
      if (!capturedRef.current) {
        capturedRef.current = true;
        try {
          vpRef.current?.setPointerCapture(e.pointerId);
        } catch {
          // 指针已不可捕获（如合成事件）：退化为无捕获，后续照旧。
        }
      }
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.kind === "pan") {
        setView((prev) => ({ ...prev, x: (drag.ox) + dx, y: (drag.oy) + dy }));
      } else if (drag.kind === "marquee") {
        const el = vpRef.current;
        if (!el || !drag.mq) return;
        const rect = el.getBoundingClientRect();
        const x1 = Math.max(0, Math.min(drag.sx, e.clientX) - rect.left);
        const y1 = Math.max(0, Math.min(drag.sy, e.clientY) - rect.top);
        const x2 = Math.min(rect.width, Math.max(drag.sx, e.clientX) - rect.left);
        const y2 = Math.min(rect.height, Math.max(drag.sy, e.clientY) - rect.top);
        drag.mq.style.left = `${x1}px`;
        drag.mq.style.top = `${y1}px`;
        drag.mq.style.width = `${x2 - x1}px`;
        drag.mq.style.height = `${y2 - y1}px`;
      } else if (drag.kind === "multidrag") {
        // 多选组拖：整组成员按同一位移移动。
        if (!drag.moved || !drag.members?.length) return;
        moveGroupTo(drag.members.map((m) => ({ key: m.key, x: m.x + dx / view.scale, y: m.y + dy / view.scale })));
      } else if (drag.kind === "node") {
        if (!drag.moved) return;
        moveGroupTo([{ key: drag.frameKey, x: drag.ox + dx / view.scale, y: drag.oy + dy / view.scale }]);
      } else if (drag.kind === "resize") {
        // 四角自由缩放：对角固定，实时预览；西/北角缩放联动挪动位置，
        // 松手才持久化尺寸与位置。
        const key = drag.frameKey;
        const node = nodesRef.current.find((n) => n.id === key);
        const min = NODE_MIN_SIZE[node?.type ?? "text"];
        const corner = drag.corner;
        const dxW = dx / view.scale;
        const dyW = dy / view.scale;
        let w = drag.ox;
        let h = drag.oy;
        if (corner === "ne" || corner === "se") w = Math.max(min.w, w + dxW);
        if (corner === "sw" || corner === "se") h = Math.max(min.h, h + dyW);
        if (corner === "nw" || corner === "sw") w = Math.max(min.w, w - dxW);
        if (corner === "nw" || corner === "ne") h = Math.max(min.h, h - dyW);
        const shiftX = corner === "nw" || corner === "sw";
        const shiftY = corner === "nw" || corner === "ne";
        let px: number | undefined;
        let py: number | undefined;
        if ((shiftX || shiftY) && drag.px0 != null && drag.py0 != null) {
          // 每步都从按下时的初始位置绝对推导（对角固定 ⇒ 平移量 = 原尺寸
          // − 新尺寸）；不能用回写的 drag.px 叠加，否则逐复合漂移。
          px = Math.round(drag.px0 + (shiftX ? drag.ox - w : 0));
          py = Math.round(drag.py0 + (shiftY ? drag.oy - h : 0));
          drag.px = px;
          drag.py = py;
        }
        store.getState().commitLayout(canvasId, [
          { id: key, pos_x: px ?? node?.pos_x ?? 0, pos_y: py ?? node?.pos_y ?? 0, width: Math.round(w), height: Math.round(h) },
        ]);
      } else if (drag.kind === "wirecut") {
        // 松手事件丢失（松在窗外、系统手势吞掉 mouseup）时右键已弹起，
        // 拖拽态却还挂着：之后每次移动都会续画切痕并误切连线——表现为
        // 「划痕满屏」。按 e.buttons 自愈：右键不在按下态即等同松手，
        // 就地收尾（与 onUp 的 wirecut 分支同一套清理）。
        if ((e.buttons & 2) === 0) {
          vpRef.current?.classList.remove("pc-cutting");
          cutTargetsRef.current = null;
          cutPointsRef.current = [];
          cutTrailUnderRef.current?.setAttribute("points", "");
          cutTrailRef.current?.setAttribute("points", "");
          dragRef.current = null;
          return;
        }
        // 切痕延伸 + 实时判定：本段轨迹扫过哪条连线就立即切断哪条。
        const from = { x: drag.px ?? drag.sx, y: drag.py ?? drag.sy };
        const to = { x: e.clientX, y: e.clientY };
        drag.px = to.x;
        drag.py = to.y;
        drag.moved = true;
        // 切痕画在视口直下的绝对定位层（屏幕坐标），盖在卡片之上。
        const vpRect = vpRef.current?.getBoundingClientRect();
        if (vpRect) {
          const w = (cx: number, cy: number) => ({
            x: cx - vpRect.left,
            y: cy - vpRect.top,
          });
          const wTo = w(to.x, to.y);
          if (cutPointsRef.current.length === 0) {
            const wFrom = w(from.x, from.y);
            cutPointsRef.current.push(`${wFrom.x},${wFrom.y}`);
          }
          cutPointsRef.current.push(`${wTo.x},${wTo.y}`);
          const pts = cutPointsRef.current.join(" ");
          cutTrailUnderRef.current?.setAttribute("points", pts);
          cutTrailRef.current?.setAttribute("points", pts);
        }
        const targets = cutTargetsRef.current;
        if (targets) {
          for (const tg of targets) {
            if (tg.done) continue;
            if (segHitsPolyline(from, to, tg.pts)) {
              tg.done = true;
              tg.del();
            }
          }
        }
      } else if (drag.kind === "wire") {
        const el = vpRef.current;
        if (!el || !drag.fromKey) return;
        const rect = el.getBoundingClientRect();
        const wx = (e.clientX - rect.left - view.x) / view.scale;
        const wy = (e.clientY - rect.top - view.y) / view.scale;
        // 摘线拿着（rewire）时草稿线锚在「留在原地的另一端」——源头输出
        // 口：线从源头拉到手里，刚拔空的输入口不再有线的视觉残留，才是
        // 「拆掉电线拿在手里」的观感。
        const startPoint = drag.rewire
          ? outPointOf(drag.fromKey)
          : drag.fromDir === "in"
            ? inPointOf(drag.fromKey)
            : outPointOf(drag.fromKey);
        if (!startPoint) return;
        const cursor = { x: wx, y: wy };
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const tEl = hit instanceof Element ? hit.closest<HTMLElement>(".pc-node[data-key]") : null;
        const tKey = tEl?.getAttribute("data-key") ?? null;
        // 节点级兼容性：任何两个不同节点都可连（引用语义）；悬停自身
        // （非摘线场景）视为无效落点。
        const isSelf = !!tKey && tKey === drag.fromKey;
        const compatible = !!tKey && !isSelf;
        drag.invalid = !!tKey && isSelf && !drag.rewire;
        drag.targetKey = compatible ? tKey : null;
        // 落点节点高亮（可接亮框 / 不可接不亮）。
        const hoverEl = compatible ? tEl : null;
        if (wireHoverRef.current !== hoverEl) {
          wireHoverRef.current?.classList.remove("pc-wire-target");
          hoverEl?.classList.add("pc-wire-target");
          wireHoverRef.current = hoverEl;
        }
        // 悬停口点亮：线要落去的那个口与源口同款放大光圈（亮＝接得上），
        // 正拖亮输入口、反拖亮输出口。摘线的原口在 pointerdown 时已登记为
        // 本 ref 的「当前亮口」：拖走即被这里的切换清掉，滑回原口（放回）
        // 亮回。
        const portEl = compatible && tEl
          ? tEl.querySelector<HTMLElement>(
              drag.fromDir === "out" ? '.pc-port[data-port="in"]' : '.pc-port[data-port="out"]',
            )
          : null;
        if (wirePortHoverRef.current !== portEl) {
          wirePortHoverRef.current?.classList.remove("pc-port-active");
          portEl?.classList.add("pc-port-active");
          wirePortHoverRef.current = portEl;
        }
        // 草稿终点：正拖命中节点时吸附到输入口的位置。
        const endPoint =
          compatible && drag.fromDir === "out" && tKey
            ? inPointOf(tKey) ?? cursor
            : cursor;
        const sourceNode = nodesRef.current.find((n) => n.id === drag.fromKey);
        setWireDraft({
          // 摘线拿着：从源头画到手里（方向与正常连线一致）；普通拖线
          // 保持原方向（输入口拖=手里→口，输出口拖=口→手里）。
          d: drag.rewire
            ? wirePathD(startPoint, cursor)
            : drag.fromDir === "in"
              ? wirePathD(cursor, startPoint)
              : wirePathD(startPoint, endPoint),
          invalid: !!drag.invalid,
          color: sourceNode ? NODE_ACCENT[sourceNode.type] : undefined,
        });
      }
    };
    const cleanupPointerVisuals = (moved: boolean) => {
      vpRef.current?.classList.remove("pc-panning");
      vpRef.current?.classList.remove("pc-wiring");
      document
        .querySelectorAll<HTMLElement>(".pc-port-active")
        .forEach((el) => el.classList.remove("pc-port-active"));
      wirePortHoverRef.current = null;
      vpRef.current?.querySelectorAll<HTMLElement>(".pc-dragging").forEach((el) => el.classList.remove("pc-dragging"));
      vpRef.current?.querySelectorAll<HTMLElement>(".pc-resizing").forEach((el) => el.classList.remove("pc-resizing"));
      if (moved) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      dragRef.current = null;
    };

    const onUp = (e: PointerEvent, cancelled = false) => {
      const drag = dragRef.current;
      if (capturedRef.current && vpRef.current?.hasPointerCapture(e.pointerId)) {
        vpRef.current.releasePointerCapture(e.pointerId);
      }
      capturedRef.current = false;
      if (!drag) return;
      if (cancelled) {
        // pointercancel 表示系统手势/浏览器接管了指针，不能把最后一次
        // 悬停目标当作有效落点提交；摘线恢复原连接。
        if (drag.kind === "wire") {
          wireHoverRef.current?.classList.remove("pc-wire-target");
          wireHoverRef.current = null;
          setWireDraft(null);
          setLiftedWire(null);
        } else if (drag.kind === "wirecut") {
          vpRef.current?.classList.remove("pc-cutting");
          cutTargetsRef.current = null;
          cutPointsRef.current = [];
          cutTrailUnderRef.current?.setAttribute("points", "");
          cutTrailRef.current?.setAttribute("points", "");
        } else if (drag.kind === "marquee") {
          drag.mq?.remove();
        }
        cleanupPointerVisuals(drag.moved ?? false);
        return;
      }
      // 统一双击判定：两次「按下即松手」（未拖动）在 500ms 内落在同一
      // 目标（≤16px）上才算双击。不用原生 dblclick——它把拖拽轻抖的
      // 松手也计成第二次点击，是「单击/拖完莫名弹窗」的根源。
      const dblCountable = drag.kind === "marquee" || drag.kind === "node" || drag.kind === "multidrag";
      if (dblCountable && !drag.moved) {
        const hitEl = document.elementFromPoint(e.clientX, e.clientY);
        const hit = hitEl instanceof Element ? hitEl : null;
        if (hit?.closest("textarea, input, button")) {
          // 控件上的两次点击是控件自己的事，不算空白双击。
          dblRef.current = null;
        } else {
          const nodeEl = hit?.closest(".pc-node") ?? null;
          const key = nodeEl?.getAttribute("data-key") ?? "";
          const now = performance.now();
          const prev = dblRef.current;
          dblRef.current = { key, x: e.clientX, y: e.clientY, t: now };
          if (prev && prev.key === key && now - prev.t < 500 &&
              Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 16) {
            dblRef.current = null;
            if (!key) {
              // 双击空白 → 节点选择框（ComfyUI 式）。
              const rect = vpRef.current?.getBoundingClientRect();
              if (rect) {
                openAddMenu(
                  e.clientX - rect.left,
                  e.clientY - rect.top,
                  (e.clientX - rect.left - view.x) / view.scale,
                  (e.clientY - rect.top - view.y) / view.scale,
                );
              }
            } else {
              // 双击便签 → 编辑态（对齐工程画布便签惯例）。
              const node = nodesRef.current.find((n) => n.id === key);
              if (node?.type === "note" && node.metadata.kind === "note") {
                setEditingNoteId(key);
                setNoteDraft(node.metadata.content);
              }
            }
          }
        }
      } else if (drag.moved) {
        dblRef.current = null;
      }
      if (drag.kind === "pan") {
        if (drag.moved) saveView(view);
      } else if (drag.kind === "wirecut") {
        // pc-cutting 类仅管刀光标；切痕轨迹点清空即隐形，下次按下重建。
        vpRef.current?.classList.remove("pc-cutting");
        cutTargetsRef.current = null;
        cutPointsRef.current = [];
        cutTrailUnderRef.current?.setAttribute("points", "");
        cutTrailRef.current?.setAttribute("points", "");
      } else if (drag.kind === "wire") {
        wireHoverRef.current?.classList.remove("pc-wire-target");
        wireHoverRef.current = null;
        setWireDraft(null);
        const vpRect = vpRef.current?.getBoundingClientRect();
        const insideViewport = !!vpRect && e.clientX >= vpRect.left && e.clientX <= vpRect.right
          && e.clientY >= vpRect.top && e.clientY <= vpRect.bottom;
        const hitEl = insideViewport ? document.elementFromPoint(e.clientX, e.clientY) : null;
        const landed = hitEl instanceof Element
          ? hitEl.closest(".pc-node, .pc-glass, .pc-addmenu")
          : null;
        const wireRelease = resolveWireRelease({
          cancelled: false,
          moved: !!drag.moved,
          hasTarget: !!drag.targetKey,
          landedOnCanvasItem: !!landed,
          insideViewport,
        });
        const targetKey = drag.targetKey;
        if (drag.rewire) {
          // ComfyUI 摘线收尾：换目标（拖到另一节点）/ 空白交给菜单
          // （建节点即转接）/ 其余一律放回（行数据未删，清掉 lifted 即
          // 恢复原线）。
          const lifted = liftedWire;
          if (wireRelease === "commit" && targetKey && lifted) {
            setLiftedWire(null);
            // 摘线换目标：改写该线 to_node（后端合并语义：同源重复时
            // 删本线保既有）。
            void store.getState().rewire(lifted.connId, targetKey);
          } else if (wireRelease === "picker" && lifted) {
            // 松手在画布内才谈「空白弹菜单」；出界（窗外松手）一律放回。
            if (vpRect) {
              openAddMenu(
                e.clientX - vpRect.left,
                e.clientY - vpRect.top,
                (e.clientX - vpRect.left - view.x) / view.scale,
                (e.clientY - vpRect.top - view.y) / view.scale,
                { detached: { connId: lifted.connId, fromKey: lifted.fromKey } },
              );
            } else {
              setLiftedWire(null);
            }
          } else {
            setLiftedWire(null);
          }
        } else if (wireRelease === "commit" && targetKey && drag.fromKey) {
          // 反拖（从输入口出发）时落点才是数据的来源方。
          const [outKey, inKey] = drag.fromDir === "in"
            ? [targetKey, drag.fromKey]
            : [drag.fromKey, targetKey];
          void store.getState().connect(canvasId, outKey, inKey);
        } else if (wireRelease === "picker" && drag.fromKey) {
          // ComfyUI 惯例：拖到空白松手 → 弹节点选择框，创建的节点自动
          // 接上这条线；落在任何节点/浮层上松手视为取消，不弹。
          if (vpRect) {
            openAddMenu(
              e.clientX - vpRect.left,
              e.clientY - vpRect.top,
              (e.clientX - vpRect.left - view.x) / view.scale,
              (e.clientY - vpRect.top - view.y) / view.scale,
              { wire: { fromKey: drag.fromKey, fromDir: drag.fromDir } },
            );
          }
        }
      } else if (drag.kind === "resize") {
        // 改尺寸松手：尺寸已在移动中按角实时算好（commitLayout 已同步
        // 本地与防抖落盘），这里补记撤销；西/北角缩放挪过的位置一并记。
        const key = drag.frameKey;
        const node = nodesRef.current.find((n) => n.id === key);
        if (drag.moved && node) {
          const size = nodeSize(node);
          const prevEntry: CanvasLayoutEntry = {
            id: key,
            pos_x: drag.px0 ?? node.pos_x,
            pos_y: drag.py0 ?? node.pos_y,
            width: drag.ox,
            height: drag.oy,
          };
          const nextEntry: CanvasLayoutEntry = {
            id: key,
            pos_x: drag.px ?? node.pos_x,
            pos_y: drag.py ?? node.pos_y,
            width: size.w,
            height: size.h,
          };
          pushUndo({ kind: "layout", prev: [prevEntry], next: [nextEntry] });
        }
      } else if (drag.kind === "node") {
        // 拖动松手：commitLayout 已在移动中即时合并（防抖落盘），这里
        // 补记撤销（恢复到拖前位置）。
        if (drag.moved) {
          const node = nodesRef.current.find((n) => n.id === drag.frameKey);
          if (node) {
            const size = nodeSize(node);
            pushUndo({
              kind: "layout",
              prev: [{ id: drag.frameKey, pos_x: drag.ox, pos_y: drag.oy, width: size.w, height: size.h }],
              next: [{ id: drag.frameKey, pos_x: node.pos_x, pos_y: node.pos_y, width: size.w, height: size.h }],
            });
          }
        }
      } else if (drag.kind === "multidrag") {
        // 组拖松手：按总位移算出整组最终位置，补记撤销（整组恢复）。
        if (drag.moved && drag.members?.length) {
          const dxW = (e.clientX - drag.sx) / view.scale;
          const dyW = (e.clientY - drag.sy) / view.scale;
          const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
          const prev: CanvasLayoutEntry[] = [];
          const next: CanvasLayoutEntry[] = [];
          for (const m of drag.members) {
            const node = byId.get(m.key);
            if (!node) continue;
            const size = nodeSize(node);
            prev.push({ id: m.key, pos_x: m.x, pos_y: m.y, width: size.w, height: size.h });
            next.push({ id: m.key, pos_x: m.x + dxW, pos_y: m.y + dyW, width: size.w, height: size.h });
          }
          pushUndo({ kind: "layout", prev, next });
        }
      } else if (drag.kind === "addnode") {
        // 点击（未拖动）落双击点；按住拖到画布松手落松手点；从「拖线
        // 到空白」菜单进入时（drag.wire / drag.detached），创建的节点
        // 自动接上那条线。
        const rect = vpRef.current?.getBoundingClientRect();
        const dropPos = drag.moved && rect
          ? {
              x: (e.clientX - rect.left - view.x) / view.scale,
              y: (e.clientY - rect.top - view.y) / view.scale,
            }
          : { x: drag.fox, y: drag.foy };
        void (async () => {
          const size = NODE_DEFAULT_SIZE[drag.frameKey];
          const created = await store.getState().createNode({
            canvasId,
            nodeType: drag.frameKey,
            posX: dropPos.x - size.w / 2,
            posY: dropPos.y - 14,
            width: size.w,
            height: size.h,
          });
          if (!created) return;
          pulseNodes([created.id]);
          if (drag.detached) {
            // 摘线转接：线改接新节点（原连线行由后端合并语义处理）。
            setLiftedWire(null);
            await store.getState().rewire(drag.detached.connId, created.id);
          } else if (drag.wire) {
            if (drag.wire.fromDir === "in") {
              // 反拖：新节点是来源方。
              await store.getState().connect(canvasId, created.id, drag.wire.fromKey);
            } else {
              await store.getState().connect(canvasId, drag.wire.fromKey, created.id);
            }
          }
          setSelection([created.id]);
        })();
      } else if (drag.kind === "marquee") {
        const list: string[] = [];
        if (drag.moved) {
          const el = vpRef.current;
          if (el) {
            const rect = el.getBoundingClientRect();
            const rx1 = (Math.min(drag.sx, e.clientX) - rect.left - view.x) / view.scale;
            const ry1 = (Math.min(drag.sy, e.clientY) - rect.top - view.y) / view.scale;
            const rx2 = (Math.max(drag.sx, e.clientX) - rect.left - view.x) / view.scale;
            const ry2 = (Math.max(drag.sy, e.clientY) - rect.top - view.y) / view.scale;
            // 框选判定对齐工程画布：节点中心落入框内即选中。
            const inBox = (p: Pos, w: number, h: number) => {
              const cx = p.x + w / 2;
              const cy = p.y + h / 2;
              return cx >= rx1 && cx <= rx2 && cy >= ry1 && cy <= ry2;
            };
            for (const node of nodesRef.current) {
              const size = nodeSize(node);
              if (inBox({ x: node.pos_x, y: node.pos_y }, size.w, size.h)) list.push(node.id);
            }
          }
        }
        setSelection(list);
        drag.mq?.remove();
      }
      cleanupPointerVisuals(drag.moved ?? false);
    };
    const onCancel = (e: PointerEvent) => onUp(e, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    // 闭包随渲染刷新（对齐工程画布手势重订阅惯例：拖拽状态在 dragRef，
    // 数据快照走 ref 镜像，重订阅只为拿到新鲜 view/store 闭包）。
  });

  // ── 键盘：删除选中、撤销、全选、复制粘贴、Escape（输入框聚焦与
  //    弹层打开时不响应；面板保挂载隐藏时不响应） ──────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      // 面板保挂载：画布被 display:none 隐藏（用户在其他顶级区）时不响应，
      // 否则别的页面按 Delete/Backspace 会隔着隐藏面板删掉画布选中节点。
      if (!vpRef.current || vpRef.current.offsetParent === null) return;
      // 弹层打开时不响应（对齐工程画布惯例）：确认框/重命名对话框/画布
      // chips 弹层/节点选择框开着时，Delete 不该删到背后的选中节点。
      if (document.querySelector(".dialog-overlay, .canvas-dialog-overlay, .canvas-chip-popover") || addMenu) {
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl) {
        const k = e.key.toLowerCase();
        if (k === "c") {
          copySelection();
          return;
        }
        if (k === "v") {
          e.preventDefault();
          void pasteClipboard();
          return;
        }
        if (k === "z") {
          e.preventDefault();
          runUndo();
          return;
        }
        if (k === "a") {
          e.preventDefault();
          setSelection(nodesRef.current.map((n) => n.id));
          return;
        }
        if (k === "g") {
          e.preventDefault();
          toggleGroup();
          return;
        }
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selRef.current.length) {
        e.preventDefault();
        void deleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addMenu, copySelection, deleteSelected, discardDetachedWire, pasteClipboard, runUndo, setSelection, toggleGroup]);

  // ── 生图（画布区特有，融入工程画布节点 chrome）：参数编辑、生成、
  //    主图切换、参考图上传 ─────────────────────────────────────

  /** 提示词来源检查（方案 3.6）：至少一条来自非空文本节点的入线。 */
  const hasPromptSourceFor = (node: CanvasNode): boolean =>
    connections.some((c) => {
      if (c.to_node !== node.id) return false;
      const from = nodes.find((n) => n.id === c.from_node);
      if (!from || from.type !== "text") return false;
      return from.metadata.kind === "text" && from.metadata.content.trim().length > 0;
    });

  const commitContent = (node: CanvasNode, content: string) => {
    const meta = { ...node.metadata, content } as CanvasNode["metadata"];
    void store.getState().updateNode(node.id, { metadata: JSON.stringify(meta) });
  };

  const commitImageParams = (
    node: CanvasNode,
    patch: { model?: string; size?: string; count?: number },
  ) => {
    if (node.metadata.kind !== "image") return;
    const meta = { ...node.metadata, params: { ...node.metadata.params, ...patch } };
    void store.getState().updateNode(node.id, { metadata: JSON.stringify(meta) });
  };

  const setImagePrimary = (node: CanvasNode, primaryIdx: number) => {
    if (node.metadata.kind !== "image") return;
    const meta = {
      ...node.metadata,
      images: node.metadata.images.map((img, i) => ({ ...img, primary: i === primaryIdx })),
    };
    void store.getState().updateNode(node.id, { metadata: JSON.stringify(meta) });
  };

  const startGenerate = async (node: CanvasNode) => {
    setGenStarting(true);
    setNodeErrors((prev) => ({ ...prev, [node.id]: "" }));
    try {
      await store.getState().generateImage(canvasId, node.id);
    } catch (err) {
      setNodeErrors((prev) => ({ ...prev, [node.id]: String(err) }));
    } finally {
      setGenStarting(false);
    }
  };

  const uploadReference = async (node: CanvasNode) => {
    try {
      const picked = await invoke<{ path: string }>("select_resource_trace_file");
      const imported = await invoke<{ file_path: string }>("import_resource_file", {
        sourcePath: picked.path,
      });
      await store.getState().updateNode(node.id, { resourcePath: imported.file_path });
    } catch (err) {
      // 用户在系统对话框取消：静默；其余错误在节点上提示。
      const msg = String(err);
      if (!msg.includes("取消") && !msg.includes("cancel")) {
        setNodeErrors((prev) => ({ ...prev, [node.id]: msg }));
      }
    }
  };

  // ── 空画布示意（方案 3.6）：一键创建 提示词 → 生图 最小工作流 ──

  const seedTemplate = useCallback(async () => {
    const rect = vpRef.current?.getBoundingClientRect();
    const center = rect
      ? {
          x: (rect.left + rect.width / 2 - rect.left - view.x) / view.scale,
          y: (rect.top + rect.height / 2 - rect.top - view.y) / view.scale,
        }
      : { x: 0, y: 0 };
    const st = store.getState();
    const text = await st.createNode({
      canvasId,
      nodeType: "text",
      posX: center.x - 340,
      posY: center.y - 110,
      width: NODE_DEFAULT_SIZE.text.w,
      height: NODE_DEFAULT_SIZE.text.h,
      metadata: JSON.stringify({ kind: "text", content: t("canvas.seedPrompt") }),
    });
    if (!text) return;
    const img = await st.createNode({
      canvasId,
      nodeType: "image",
      posX: center.x + 30,
      posY: center.y - 170,
      width: NODE_DEFAULT_SIZE.image.w,
      height: NODE_DEFAULT_SIZE.image.h,
    });
    if (!img) return;
    await st.connect(canvasId, text.id, img.id);
    pushUndo({ kind: "create", ids: [text.id, img.id] });
    pulseNodes([text.id, img.id]);
    setSelection([text.id, img.id]);
    // 种子完成后整体适配窗口：fit effect 在首批节点（text 先落库）变化时
    // 触发一次就标记结束，后落的图片节点会被留在视野外（窄窗口实测）。
    if (fitAll(store.getState().nodes)) {
      fitAttemptedRef.current = true;
    }
  }, [canvasId, fitAll, pushUndo, pulseNodes, setSelection, store, t, view.scale, view.x, view.y]);

  // ── OS 文件拖入（阶段 3）：图片文件 → 入库 → 参考图节点 ──────

  const [dropHint, setDropHint] = useState(false);

  const handleFileDrop = useCallback(
    async (paths: string[], logical: { x: number; y: number }) => {
      const imageExts = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
      const imagePaths = paths.filter(
        (p) => imageExts.includes(p.split(".").pop()?.toLowerCase() ?? ""),
      );
      if (!imagePaths.length) return;
      const rect = vpRef.current?.getBoundingClientRect();
      const world = rect
        ? {
            x: (logical.x - rect.left - view.x) / view.scale,
            y: (logical.y - rect.top - view.y) / view.scale,
          }
        : { x: 0, y: 0 };
      const st = store.getState();
      let offset = 0;
      const createdIds: string[] = [];
      for (const path of imagePaths) {
        try {
          // 一切参考图先进资源库（方案 3.5）：拖入即入库再引用。
          const imported = await invoke<{ file_path: string }>("import_resource_file", {
            sourcePath: path,
          });
          const node = await st.createNode({
            canvasId,
            nodeType: "ref",
            posX: world.x + offset,
            posY: world.y + offset,
            width: NODE_DEFAULT_SIZE.ref.w,
            height: NODE_DEFAULT_SIZE.ref.h,
            resourcePath: imported.file_path,
          });
          if (node) createdIds.push(node.id);
          offset += 24;
        } catch (err) {
          console.error("拖入文件入库失败:", err);
        }
      }
      pulseNodes(createdIds);
    },
    [canvasId, pulseNodes, store, view.scale, view.x, view.y],
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        // 保挂载面板：画布被 display:none 隐藏时不接管拖放。
        if (!vpRef.current || vpRef.current.offsetParent === null) return;
        const payload = event.payload;
        if (payload.type === "over" || payload.type === "drop") {
          const dpr = window.devicePixelRatio || 1;
          const logical = { x: payload.position.x / dpr, y: payload.position.y / dpr };
          if (payload.type === "over") {
            setDropHint(true);
          } else {
            setDropHint(false);
            void handleFileDrop(payload.paths, logical);
          }
        } else {
          setDropHint(false);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleFileDrop]);

  // ── 批量生成（阶段 3）：多选图片节点 → 队列顺序执行 ─────────

  const batchRunningRef = useRef(false);
  // 用渲染期的 nodes 状态过滤，批量条的计数与实选严格一致；runBatch 内部
  // 执行时再走 nodesRef 取最新。
  const selectedImageIds = selKeys.filter(
    (id) => nodes.find((n) => n.id === id)?.type === "image",
  );
  const runBatch = useCallback(async () => {
    if (batchRunningRef.current) return;
    batchRunningRef.current = true;
    try {
      for (const id of selectedImageIds) {
        const node = nodesRef.current.find((n) => n.id === id);
        if (node) await startGenerate(node);
      }
    } finally {
      batchRunningRef.current = false;
    }
    // startGenerate 依赖 canvasId/store，经其闭包稳定；选中集变化由渲染期值传入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedImageIds.join(",")]);

  // ── 渲染 ───────────────────────────────────────────────────

  // 连线层（卡片之下）：按视口尺寸渲染 + 平移组换算世界坐标，不再铺
  // 世界范围的巨型图层（部分 WebView2 GPU 栅格化超限时会整层不绘制，
  // 表现为连线全不可见）。
  const wiresVis = {
    x: -view.x / view.scale - WIRES_VIEWPORT_PAD,
    y: -view.y / view.scale - WIRES_VIEWPORT_PAD,
    w: ((vpSize?.w ?? 0) || 1600) / view.scale + WIRES_VIEWPORT_PAD * 2,
    h: ((vpSize?.h ?? 0) || 900) / view.scale + WIRES_VIEWPORT_PAD * 2,
  };

  // 尺寸手柄（四角）：双击不冒泡到节点。
  const resizeHandle = (
    <>
      {(["nw", "ne", "sw", "se"] as const).map((corner) => (
        <span
          key={corner}
          className={`pc-resize ${corner}`}
          data-corner={corner}
          aria-hidden="true"
        />
      ))}
    </>
  );

  // 迷你地图比例：内容包围盒铺满小地图。
  const miniBBox = (() => {
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
  })();
  const miniRatio = miniBBox
    ? Math.min(MINI_W / Math.max(miniBBox.w, 1), MINI_H / Math.max(miniBBox.h, 1))
    : 1;

  // 连线渲染锚点取实时布局（拖动中 commitLayout 即时合并，天然跟随）。

  return (
    <div className="pc-root fc-root">
      <div
        ref={vpRef}
        className="pc-viewport"
        onPointerDown={onViewportPointerDown}
        onClickCapture={(e) => {
          if (!suppressClickRef.current) return;
          e.stopPropagation();
          e.preventDefault();
          suppressClickRef.current = false;
        }}
      >
        <div
          className="pc-world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          <svg
            className="pc-wires"
            aria-hidden="true"
            style={{
              left: wiresVis.x,
              top: wiresVis.y,
              width: wiresVis.w,
              height: wiresVis.h,
            }}
          >
            <g transform={`translate(${-wiresVis.x}, ${-wiresVis.y})`}>
              {connections.map((conn) => {
                // 被摘下的线（拿着换目标中）暂时隐藏，收尾时转接或放回。
                if (liftedWire && conn.id === liftedWire.connId) return null;
                const from = nodeById(conn.from_node);
                const to = nodeById(conn.to_node);
                if (!from || !to) return null;
                const a = outPointOf(from.id);
                const b = inPointOf(to.id);
                if (!a || !b) return null;
                const d = wirePathD(a, b);
                return (
                  <g key={conn.id} className="pc-wire" data-cut={conn.id}>
                    <path className="pc-wire-hit" d={d} />
                    <path className="pc-wire-line" d={d} style={{ stroke: NODE_ACCENT[from.type] }} />
                  </g>
                );
              })}
              {wireDraft && (
                <path
                  className={`pc-wire-temp${wireDraft.invalid ? " invalid" : ""}`}
                  d={wireDraft.d}
                  style={wireDraft.color ? { stroke: wireDraft.color } : undefined}
                />
              )}
            </g>
          </svg>

          {/* 节点分组框（Ctrl+G）：框自适应成员包围盒，渲染在节点层之下；
              拖标题条整组移动（复用组拖管线），组员被删后框随之收缩。 */}
          {groups.map((group) => {
            const frames = group.members
              .map((key) => memberFrame(key))
              .filter((f): f is { x: number; y: number; w: number; h: number } => f !== null);
            if (frames.length === 0) return null;
            const pad = 14;
            const left = Math.min(...frames.map((f) => f.x)) - pad;
            const top = Math.min(...frames.map((f) => f.y)) - pad - 18;
            const right = Math.max(...frames.map((f) => f.x + f.w)) + pad;
            const bottom = Math.max(...frames.map((f) => f.y + f.h)) + pad;
            return (
              <div
                key={group.id}
                data-group={group.id}
                className="pc-nodegroup"
                style={{ left, top, width: right - left, height: bottom - top }}
              >
                <div className="pc-nodegroup-label">{group.label}</div>
              </div>
            );
          })}

          {nodes.map((node) => {
            const selected = selKeys.includes(node.id);
            const size = nodeSize(node);
            const accent = NODE_ACCENT[node.type];
            // meta 提前捕获为 const：闭包（onClick/onBlur）拿不到属性
            // 链的判窄，const 变量的判窄可以跨闭包保留。
            const meta = node.metadata;
            const portSpans = (
              <>
                <span className="pc-port pc-port-in" data-port="in" style={{ background: "var(--text-tertiary)" }} />
                <span className="pc-port pc-port-out" data-port="out" style={{ background: accent }} />
              </>
            );
            const head = (
              <div className="pc-node-head">
                <span className="pc-node-kind">{t(`canvas.node.${node.type}`)}</span>
                {node.title && <b className="pc-node-title">{node.title}</b>}
              </div>
            );
            const tools = (
              <span className="pc-node-tools">
                <button
                  type="button"
                  data-tooltip={t("common.delete")}
                  className="danger"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteNodes([node.id]);
                  }}
                >
                  {Icons.close}
                </button>
              </span>
            );
            if (node.type === "note") {
              // 便签节点：视觉标准与通用节点一致（B+ 头栏卡 + 黄色内嵌
              // 便签体），双击进入编辑（对齐工程画布便签惯例）。
              return (
                <div
                  key={node.id}
                  data-key={node.id}
                  className={`pc-node fc-type-note${selected ? " pc-selected" : ""}${pulseKeys.includes(node.id) ? " pc-spawn" : ""}`}
                  style={
                    {
                      left: node.pos_x,
                      top: node.pos_y,
                      width: size.w,
                      height: node.height != null ? size.h : undefined,
                      "--node-accent": accent,
                    } as CSSProperties
                  }
                >
                  <div className="pc-node-head">
                    <span className="pc-node-kind">{t(`canvas.node.${node.type}`)}</span>
                  </div>
                  {editingNoteId === node.id ? (
                    <textarea
                      className="fc-note-input"
                      autoFocus
                      value={noteDraft}
                      onChange={(event) => setNoteDraft(event.target.value)}
                      onBlur={() => {
                        if (meta.kind === "note") commitContent(node, noteDraft.trim());
                        setEditingNoteId(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setEditingNoteId(null);
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                    />
                  ) : (
                    <div className="fc-note-body">
                      {meta.kind === "note" && meta.content ? meta.content : <i>{t("project.canvas.noteEmpty")}</i>}
                    </div>
                  )}
                  <span className="pc-node-tools">
                    <button
                      type="button"
                      data-tooltip={t("common.edit")}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        if (meta.kind === "note") {
                          setEditingNoteId(node.id);
                          setNoteDraft(meta.content);
                        }
                      }}
                    >
                      {Icons.edit}
                    </button>
                    <button
                      type="button"
                      data-tooltip={t("common.delete")}
                      className="danger"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteNodes([node.id]);
                      }}
                    >
                      {Icons.close}
                    </button>
                  </span>
                  {portSpans}
                  {resizeHandle}
                </div>
              );
            }
            return (
              <div
                key={node.id}
                data-key={node.id}
                className={`pc-node fc-type-${node.type}${selected ? " pc-selected" : ""}${pulseKeys.includes(node.id) ? " pc-spawn" : ""}`}
                style={
                  {
                    left: node.pos_x,
                    top: node.pos_y,
                    width: size.w,
                    // 视觉标准（B+）：未拖过尺寸手柄的节点高度由内容撑开
                    // （height 不落库），text 常驻编辑框除外。
                    height: node.height != null || node.type === "text" ? size.h : undefined,
                    "--node-accent": accent,
                  } as CSSProperties
                }
              >
                {head}
                {node.type === "text" && (
                  // 正文即节点体：常驻可编辑，失焦提交。
                  <textarea
                    className="fc-node-edit"
                    key={`t-${node.id}-${node.updated_at}`}
                    defaultValue={node.metadata.kind === "text" ? node.metadata.content : ""}
                    placeholder={t("canvas.textContentPlaceholder")}
                    onBlur={(e) => commitContent(node, e.target.value)}
                  />
                )}
                {node.type === "image" && meta.kind === "image" && (
                  <div className="fc-node-form">
                    <input
                      className="fc-node-input"
                      key={`gm-${node.id}-${node.updated_at}`}
                      defaultValue={meta.params.model}
                      placeholder={`${t("canvas.genModelLabel")}：${modelFallback}`}
                      onBlur={(e) => commitImageParams(node, { model: e.target.value.trim() })}
                    />
                    <div className="fc-node-row">
                      <input
                        className="fc-node-input grow"
                        key={`gs-${node.id}-${node.updated_at}`}
                        defaultValue={meta.params.size}
                        placeholder="auto / 1024x1024 / 3:2"
                        onBlur={(e) => commitImageParams(node, { size: e.target.value.trim() })}
                      />
                      <input
                        className="fc-node-input count"
                        key={`gc-${node.id}-${node.updated_at}`}
                        type="number"
                        min={1}
                        max={15}
                        defaultValue={meta.params.count}
                        onBlur={(e) =>
                          commitImageParams(node, {
                            count: Math.max(1, Math.min(15, Number.parseInt(e.target.value, 10) || 1)),
                          })
                        }
                      />
                    </div>
                    {genProgress[node.id] ? (
                      <>
                        <div className="fc-gen-slots">
                          {Array.from({ length: genProgress[node.id].total }, (_, i) => {
                            const url = genProgress[node.id].previews[i];
                            return url ? (
                              <img key={i} className="fc-gen-slot filled" src={url} alt="" draggable={false} />
                            ) : (
                              <span key={i} className="fc-gen-slot pending">{t("canvas.genSlotPending")}</span>
                            );
                          })}
                        </div>
                        <div className="fc-node-row">
                          <span className="fc-gen-summary">
                            {t("canvas.generating")} {genProgress[node.id].received + genProgress[node.id].errors}/{genProgress[node.id].total}
                          </span>
                          <button
                            className="fc-node-btn ghost"
                            onClick={() => void store.getState().cancelGeneration(genProgress[node.id].requestId)}
                          >
                            {t("canvas.cancelGen")}
                          </button>
                        </div>
                      </>
                    ) : (
                      <button
                        className="fc-node-btn accent"
                        disabled={genStarting || !hasPromptSourceFor(node)}
                        onClick={() => void startGenerate(node)}
                      >
                        {meta.status === "done" ? t("canvas.regenerate") : t("canvas.genButton")}
                      </button>
                    )}
                    {!hasPromptSourceFor(node) && !genProgress[node.id] && (
                      <div className="fc-gen-warn">{t("canvas.noPromptSource")}</div>
                    )}
                    {nodeErrors[node.id] && <div className="fc-gen-warn">{nodeErrors[node.id]}</div>}
                    {meta.status === "error" && meta.error && (
                      <div className="fc-gen-warn">{meta.error}</div>
                    )}
                    {meta.images.length > 0 && (
                      <>
                        <div className="fc-gen-thumbs">
                          {meta.images.map((thumb, i) => (
                            <button
                              key={i}
                              className={`fc-gen-thumb${thumb.primary ? " primary" : ""}`}
                              title={thumb.primary ? t("canvas.genPrimary") : t("canvas.genSetPrimary")}
                              onClick={() => setImagePrimary(node, i)}
                            >
                              <ResourceThumb path={thumb.resource_path} className="fc-thumb" />
                              {thumb.primary && <span className="fc-gen-primary-badge">{t("canvas.genPrimary")}</span>}
                            </button>
                          ))}
                        </div>
                        <button
                          className="fc-node-btn ghost"
                          onClick={() => {
                            const target = meta.images.find((item) => item.primary) ?? meta.images[0];
                            if (target?.resource_path) void openResourceFile(target.resource_path);
                          }}
                        >
                          {t("canvas.showInLibrary")}
                        </button>
                      </>
                    )}
                  </div>
                )}
                {node.type === "ref" && (
                  <div className="fc-node-form">
                    {node.resource_path ? (
                      <ResourceThumb path={node.resource_path} className="fc-thumb-cover" />
                    ) : (
                      <div className="fc-node-placeholder">{t("canvas.refEmpty")}</div>
                    )}
                    <input
                      className="fc-node-input"
                      key={`p-${node.id}-${node.updated_at}`}
                      defaultValue={node.resource_path}
                      placeholder={t("canvas.pathPlaceholder")}
                      onBlur={(e) => {
                        const path = e.target.value.trim();
                        if (path !== node.resource_path) {
                          void store.getState().updateNode(node.id, { resourcePath: path });
                        }
                      }}
                    />
                    <button className="fc-node-btn ghost" onClick={() => void uploadReference(node)}>
                      {t("canvas.uploadRef")}
                    </button>
                  </div>
                )}
                {tools}
                {portSpans}
                {resizeHandle}
              </div>
            );
          })}
        </div>

        {/* 刀切痕层：视口直下的绝对定位层（pc-world 之后 → 盖在卡片上），
            用视口屏幕坐标画折线。滑动中 ref 直写双描边（暗衬 + 白芯），
            松手清空即隐形。 */}
        <svg className="pc-trailayer" aria-hidden="true">
          <polyline ref={cutTrailUnderRef} className="pc-wire-cut-under" points="" />
          <polyline ref={cutTrailRef} className="pc-wire-cut" points="" />
        </svg>

        {/* 双击空白的节点选择框（ComfyUI 搜索框的对应物） */}
        {addMenu && (
          <div
            className="pc-addmenu"
            style={{ left: addMenu.sx, top: addMenu.sy }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <input
              className="pc-addmenu-search"
              placeholder={t("project.canvas.addNodeSearch")}
              value={addMenuQuery}
              onChange={(event) => setAddMenuQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  // 取消菜单＝不建节点直接退出：摘下的线就此断开
                  // （见 discardDetachedWire），不放回原口。
                  if (addMenu.detached) discardDetachedWire(addMenu.detached);
                  setAddMenu(null);
                }
              }}
              // 聚焦必须带 preventScroll：菜单常弹出在画布边缘，默认聚焦
              // 会让浏览器滚动 overflow:hidden 的视口容器把输入框露出来，
              // 表现为整个画布节点集体平移（连线/断线时位置漂移的根源）。
              ref={(el) => {
                el?.focus({ preventScroll: true });
              }}
            />
            {([
              {
                key: "text",
                label: t("canvas.node.text"),
                hint: t("canvas.typeTextHint"),
                icon: Icons.file,
              },
              {
                key: "image",
                label: t("canvas.node.image"),
                hint: t("canvas.typeImageHint"),
                icon: Icons.image,
              },
              {
                key: "ref",
                label: t("canvas.node.ref"),
                hint: t("canvas.typeRefHint"),
                icon: Icons.resources,
              },
              {
                key: "note",
                label: t("canvas.node.note"),
                hint: t("project.canvas.typeNoteHint"),
                icon: Icons.edit,
              },
            ] as { key: CanvasNodeType; label: string; hint: string; icon: ReactNode }[])
              .filter((item) => item.label.toLowerCase().includes(addMenuQuery.trim().toLowerCase()))
              .map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="pc-addmenu-item"
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.stopPropagation();
                    event.preventDefault();
                    // 立即捕获指针：菜单按钮随 setAddMenu(null) 卸载，
                    // 卸载后浏览器释放捕获，pointerup 按 hit-test 落到
                    // 视口、照常冒泡给 window 的 onUp 收尾（落节点/摘线
                    // 转接）。不捕获的话，按住拖到窗外松手或松手恰逢
                    // 按钮已卸载，up 丢失会让「摘下的线」永久悬空。
                    try {
                      event.currentTarget.setPointerCapture(event.pointerId);
                    } catch {
                      // 指针已不可捕获（合成事件等）：退化为无捕获。
                    }
                    dragRef.current = {
                      kind: "addnode", sx: event.clientX, sy: event.clientY, moved: false,
                      fox: addMenu.wx, foy: addMenu.wy, frameKey: item.key,
                      wire: addMenu.wire,
                      detached: addMenu.detached,
                    };
                    setAddMenu(null);
                    setAddMenuQuery("");
                  }}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  <small>{item.hint}</small>
                </button>
              ))}
          </div>
        )}

        {/* 空画布示意（方案 3.6）：一键创建 提示词 → 生图 最小工作流 */}
        {!nodes.length && !connections.length && !addMenu && (
          <button className="fc-seed" onClick={() => void seedTemplate()}>
            <span className="fc-seed-title">{t("canvas.seedCta")}</span>
            <span className="fc-seed-sub">{t("canvas.seedHint")}</span>
          </button>
        )}

        {/* 拖放遮罩：OS 图片文件拖入提示 */}
        {dropHint && (
          <div className="fc-drop-overlay">
            <span>{t("canvas.dropHint")}</span>
          </div>
        )}

        {/* 批量生成浮动条：多选图片节点时出现 */}
        {selectedImageIds.length >= 2 && !genStarting && (
          <div className="fc-batchbar" onPointerDown={(e) => e.stopPropagation()}>
            <button onClick={() => void runBatch()}>
              {t("canvas.batchGenerate", { count: selectedImageIds.length })}
            </button>
          </div>
        )}

        {/* 画布信息玻璃卡 + 统计 */}
        <div className="pc-glass fc-statcard">
          <div className="pc-ep-stats">
            <span>{t("canvas.statNodes", { count: nodes.length })}</span>
            <span>{t("project.canvas.statWires", { count: connections.length })}</span>
          </div>
        </div>

        <div className="pc-tip">{t("canvas.tip")}</div>

        {/* 缩放条（工程画布同款）：缩小 / 百分比 / 放大 */}
        <div className="pc-glass pc-zoombar">
          <button
            type="button"
            data-tooltip={t("project.canvas.zoomOut")}
            onClick={() => {
              const rect = vpRef.current?.getBoundingClientRect();
              if (rect) zoomAt(rect.width / 2, rect.height / 2, 1 / 1.2);
            }}
          >
            <span aria-hidden="true">−</span>
          </button>
          <span className="pc-zpct">{Math.round(view.scale * 100)}%</span>
          <button
            type="button"
            data-tooltip={t("project.canvas.zoomIn")}
            onClick={() => {
              const rect = vpRef.current?.getBoundingClientRect();
              if (rect) zoomAt(rect.width / 2, rect.height / 2, 1.2);
            }}
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>

        {/* 迷你地图（工程画布同款）：节点包围盒 + 视口矩形，点击跳转 */}
        {miniBBox && (
          <div className="pc-glass pc-minimap" data-tooltip={t("project.canvas.minimap")}>
            <svg
              width={MINI_W}
              height={MINI_H}
              viewBox={`0 0 ${MINI_W} ${MINI_H}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
                const wx = (e.clientX - rect.left) / miniRatio + miniBBox.x;
                const wy = (e.clientY - rect.top) / miniRatio + miniBBox.y;
                const vpRect = vpRef.current?.getBoundingClientRect();
                if (!vpRect) return;
                setView((prev) => {
                  const next = {
                    ...prev,
                    x: vpRect.width / 2 - wx * prev.scale,
                    y: vpRect.height / 2 - wy * prev.scale,
                  };
                  saveView(next);
                  return next;
                });
              }}
            >
              {nodes.map((node) => {
                const size = nodeSize(node);
                return (
                  <rect
                    key={node.id}
                    x={(node.pos_x - miniBBox.x) * miniRatio}
                    y={(node.pos_y - miniBBox.y) * miniRatio}
                    width={Math.max(3, size.w * miniRatio)}
                    height={Math.max(2.5, size.h * miniRatio)}
                    rx="1.5"
                    fill="var(--text-tertiary)"
                  />
                );
              })}
              <rect
                x={(((-view.x / view.scale) - miniBBox.x) * miniRatio)}
                y={(((-view.y / view.scale) - miniBBox.y) * miniRatio)}
                width={((vpSize?.w ?? 1200) / view.scale) * miniRatio}
                height={((vpSize?.h ?? 700) / view.scale) * miniRatio}
                fill="rgba(127,127,140,.1)"
                stroke="var(--text-primary)"
                strokeWidth="1.2"
                rx="2"
              />
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}
