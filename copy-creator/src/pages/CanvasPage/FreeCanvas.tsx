import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { resolveResourceMediaUrl } from "../../domain/mediaUrl";
import {
  useCanvasStore,
  type CanvasLayoutEntry,
  type CanvasNode,
  type CanvasNodeType,
} from "../../stores/canvasStore";

// 自由生图画布（画布区方案 3.3）：以 ProjectCanvas 为基座 fork——引擎框架
// （视口缩放/平移、滚轮非被动监听、聚焦滚动归零、wirePathD 贝塞尔、框选
// 阈值与撤销栈惯例）零改动搬运；连线子系统按「节点级引用」语义重写：
// 每节点右侧一个输出口、左侧一个输入位，连线即引用上游，多入线按类型
// 分组累积（text 拼接 / ref·图片累积），无端口体系、无顶掉。
// 数据全部走 canvasStore（SQLite），视口/布局防抖落盘。

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.2;
const ZOOM_STEP = 1.12;
const MARQUEE_THRESHOLD = 4; // 屏幕像素：区分点击与框选
const DRAG_THRESHOLD = 3; // 屏幕像素：区分点击与拖动
const UNDO_LIMIT = 50;

/** 节点默认尺寸：建节点即落库显式宽高（NULL 只作历史数据兜底）。 */
const NODE_DEFAULT_SIZE: Record<CanvasNodeType, { w: number; h: number }> = {
  text: { w: 210, h: 130 },
  note: { w: 190, h: 130 },
  image: { w: 220, h: 200 },
  ref: { w: 210, h: 110 },
};

/** 节点类型色通道（对齐工程画布类型色惯例，连线取上游节点色）。 */
const NODE_ACCENT: Record<CanvasNodeType, string> = {
  text: "#007AFF",
  image: "#AF52DE",
  ref: "#34C759",
  note: "#E6A700",
};

/** ComfyUI 风格连线：直接接收两端端口点（输出在节点右缘、输入在左缘），
 *  控制点沿水平方向延伸两点距离的 1/4，任意角度都是平滑弯出的贝塞尔，
 *  不存在直线或拐角形态。（自 ProjectCanvas.tsx wirePathD 零改动搬运） */
function wirePathD(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const offset = Math.hypot(b.x - a.x, b.y - a.y) * 0.25;
  return `M ${a.x} ${a.y} C ${a.x + offset} ${a.y}, ${b.x - offset} ${b.y}, ${b.x} ${b.y}`;
}

function nodeSize(node: CanvasNode): { w: number; h: number } {
  const fallback = NODE_DEFAULT_SIZE[node.type];
  return { w: node.width ?? fallback.w, h: node.height ?? fallback.h };
}

function nodeRect(node: CanvasNode): { x: number; y: number; w: number; h: number } {
  const { w, h } = nodeSize(node);
  return { x: node.pos_x, y: node.pos_y, w, h };
}

function outPointOf(node: CanvasNode): { x: number; y: number } {
  const { w, h } = nodeSize(node);
  return { x: node.pos_x + w, y: node.pos_y + h / 2 };
}

function inPointOf(node: CanvasNode): { x: number; y: number } {
  const { h } = nodeSize(node);
  return { x: node.pos_x, y: node.pos_y + h / 2 };
}

function rectsIntersect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function pointInRect(
  p: { x: number; y: number },
  r: { x: number; y: number; w: number; h: number },
): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** 线段相交（切线手势用）：叉积同侧判定。 */
function segmentsCross(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  p4: { x: number; y: number },
): boolean {
  const d = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return (
    d(p1, p2, p3) * d(p1, p2, p4) < 0 && d(p3, p4, p1) * d(p3, p4, p2) < 0
  );
}

/** 贝塞尔采样：与 wirePathD 同一控制点公式，切线相交检测用。 */
function sampleWire(a: { x: number; y: number }, b: { x: number; y: number }, steps = 14) {
  const offset = Math.hypot(b.x - a.x, b.y - a.y) * 0.25;
  const c1 = { x: a.x + offset, y: a.y };
  const c2 = { x: b.x - offset, y: b.y };
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    pts.push({
      x: mt * mt * mt * a.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * b.x,
      y: mt * mt * mt * a.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * b.y,
    });
  }
  return pts;
}

type Point = { x: number; y: number };

type Interaction =
  | { mode: "pan"; startX: number; startY: number; viewX: number; viewY: number }
  | { mode: "marquee"; start: Point; cur: Point; moved: boolean }
  | {
      mode: "node-drag";
      startX: number;
      startY: number;
      origins: { id: string; x: number; y: number }[];
      dx: number;
      dy: number;
      moved: boolean;
    }
  | {
      mode: "resize";
      id: string;
      startX: number;
      startY: number;
      originW: number;
      originH: number;
      dw: number;
      dh: number;
      moved: boolean;
    }
  | { mode: "wire"; fromNode: string; cursor: Point }
  | { mode: "rewire"; connId: string; fromNode: string; cursor: Point }
  | { mode: "cut"; last: Point };

type PendingWire =
  | { kind: "connect"; fromNode: string }
  | { kind: "rewire"; connId: string }
  | null;

type UndoAction =
  | { kind: "layout"; prev: CanvasLayoutEntry[]; next: CanvasLayoutEntry[] }
  | {
      kind: "delete";
      nodes: CanvasNode[];
      connections: { from_node: string; to_node: string }[];
    };

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

  const vpRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState(() => {
    const c = useCanvasStore.getState().activeCanvas;
    return c && c.id === canvasId
      ? { x: c.viewport_x, y: c.viewport_y, scale: c.viewport_k }
      : { x: 0, y: 0, scale: 1 };
  });
  const viewRef = useRef(view);
  const nodesRef = useRef(nodes);
  const connectionsRef = useRef(connections);
  const selectionRef = useRef<string[]>([]);
  const interactionRef = useRef<Interaction | null>(null);
  const undoRef = useRef<UndoAction[]>([]);
  const hoverRef = useRef<string | null>(null);

  const [selection, setSelection] = useState<string[]>([]);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  // 渲染后同步镜像：窗口级手势回调读 ref 免闭包陈旧（react-hooks/refs
  // 禁止渲染期写 ref，统一在 effect 提交）。
  useEffect(() => {
    nodesRef.current = nodes;
    connectionsRef.current = connections;
  }, [nodes, connections]);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);
  useEffect(() => {
    interactionRef.current = interaction;
  }, [interaction]);
  useEffect(() => {
    hoverRef.current = hoverId;
  }, [hoverId]);
  const [addMenu, setAddMenu] = useState<{
    sx: number;
    sy: number;
    wx: number;
    wy: number;
    pending: PendingWire;
  } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const store = useCanvasStore;

  const toWorld = useCallback((clientX: number, clientY: number): Point => {
    const rect = vpRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: ((clientX - (rect?.left ?? 0)) - v.x) / v.scale,
      y: ((clientY - (rect?.top ?? 0)) - v.y) / v.scale,
    };
  }, []);

  const pushUndo = useCallback((action: UndoAction) => {
    undoRef.current.push(action);
    if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift();
  }, []);

  /** 撤销（Ctrl+Z）：layout 恢复布局；delete 重建节点/连线——节点用新 id
   *  重建（无外部锚引用 canvas 节点 id），连线按 id 映射改接两端。 */
  const undo = useCallback(async () => {
    const action = undoRef.current.pop();
    if (!action) return;
    const st = store.getState();
    if (action.kind === "layout") {
      st.commitLayout(canvasId, action.prev);
      return;
    }
    const idMap = new Map<string, string>();
    for (const node of action.nodes) {
      const created = await st.createNode({
        canvasId,
        nodeType: node.type,
        title: node.title,
        posX: node.pos_x,
        posY: node.pos_y,
        width: node.width,
        height: node.height,
        resourcePath: node.resource_path,
        metadata: JSON.stringify(node.metadata),
      });
      if (created) idMap.set(node.id, created.id);
    }
    for (const conn of action.connections) {
      const from = idMap.get(conn.from_node) ?? conn.from_node;
      const to = idMap.get(conn.to_node) ?? conn.to_node;
      await st.connect(canvasId, from, to);
    }
    setSelection([...idMap.values()]);
  }, [canvasId, store]);

  const deleteSelected = useCallback(async () => {
    const ids = selectionRef.current;
    if (!ids.length) return;
    const targets = nodesRef.current.filter((n) => ids.includes(n.id));
    const conns = connectionsRef.current
      .filter((c) => targets.some((n) => n.id === c.from_node || n.id === c.to_node))
      .map((c) => ({ from_node: c.from_node, to_node: c.to_node }));
    if (targets.length) {
      pushUndo({ kind: "delete", nodes: targets, connections: conns });
    }
    for (const node of targets) {
      await store.getState().deleteNode(node.id);
    }
    setSelection([]);
  }, [pushUndo, store]);

  // ── 视口引擎（自 ProjectCanvas 零改动搬运） ─────────────────

  const zoomAt = useCallback(
    (mx: number, my: number, factor: number) => {
      setView((prev) => {
        const ns = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev.scale * factor));
        const next = {
          x: mx - (mx - prev.x) * (ns / prev.scale),
          y: my - (my - prev.y) * (ns / prev.scale),
          scale: ns,
        };
        viewRef.current = next;
        store.getState().setViewport(canvasId, next.x, next.y, next.scale);
        return next;
      });
    },
    [canvasId, store],
  );

  // 滚轮缩放走原生非被动监听：React 合成 onWheel 是 passive 的，
  // preventDefault 不生效（ctrl+滚轮会触发网页缩放）。
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // 视口永远不该被滚动（平移/缩放都走 transform）：聚焦滚动会把容器
  // 推走表现为节点集体平移。任何滚动立即归零；归零引发的再入 scroll
  // 事件值为 0，不会成环。（自 ProjectCanvas 零改动搬运）
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollLeft !== 0 || el.scrollTop !== 0) el.scrollTo(0, 0);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // ── 手势（连线子系统按节点级语义重写） ─────────────────────

  const hitTestNode = useCallback((world: Point, excludeId?: string): string | null => {
    for (const node of nodesRef.current) {
      if (node.id === excludeId) continue;
      if (pointInRect(world, nodeRect(node))) return node.id;
    }
    return null;
  }, []);

  const openAddMenu = useCallback((world: Point, pending: PendingWire) => {
    // 菜单挂在视口容器内，屏幕坐标 = 世界坐标 × 缩放 + 视口偏移。
    setAddMenu({
      sx: world.x * viewRef.current.scale + viewRef.current.x,
      sy: world.y * viewRef.current.scale + viewRef.current.y,
      wx: world.x,
      wy: world.y,
      pending,
    });
  }, []);

  const cutSegment = useCallback(
    (from: Point, to: Point) => {
      const st = store.getState();
      for (const conn of st.connections) {
        const fromNode = st.nodes.find((n) => n.id === conn.from_node);
        const toNode = st.nodes.find((n) => n.id === conn.to_node);
        if (!fromNode || !toNode) continue;
        const pts = sampleWire(outPointOf(fromNode), inPointOf(toNode));
        for (let i = 0; i < pts.length - 1; i++) {
          if (segmentsCross(from, to, pts[i], pts[i + 1])) {
            void st.deleteConnection(conn.id);
            break;
          }
        }
      }
    },
    [store],
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const it = interactionRef.current;
      if (!it) return;
      const scale = viewRef.current.scale;
      switch (it.mode) {
        case "pan": {
          const next = {
            x: it.viewX + (e.clientX - it.startX),
            y: it.viewY + (e.clientY - it.startY),
            scale,
          };
          viewRef.current = next;
          setView(next);
          store.getState().setViewport(canvasId, next.x, next.y, next.scale);
          break;
        }
        case "marquee": {
          const cur = toWorld(e.clientX, e.clientY);
          setInteraction((p) =>
            p && p.mode === "marquee"
              ? {
                  ...p,
                  cur,
                  moved:
                    p.moved ||
                    Math.hypot(cur.x - p.start.x, cur.y - p.start.y) * scale > MARQUEE_THRESHOLD,
                }
              : p,
          );
          break;
        }
        case "node-drag": {
          const dx = (e.clientX - it.startX) / scale;
          const dy = (e.clientY - it.startY) / scale;
          const moved =
            it.moved ||
            Math.hypot(e.clientX - it.startX, e.clientY - it.startY) > DRAG_THRESHOLD;
          setInteraction((p) => (p && p.mode === "node-drag" ? { ...p, dx, dy, moved } : p));
          break;
        }
        case "resize": {
          const dw = (e.clientX - it.startX) / scale;
          const dh = (e.clientY - it.startY) / scale;
          setInteraction((p) => (p && p.mode === "resize" ? { ...p, dw, dh, moved: true } : p));
          break;
        }
        case "wire":
        case "rewire": {
          const cursor = toWorld(e.clientX, e.clientY);
          const hit = hitTestNode(cursor, it.fromNode);
          setInteraction((p) =>
            p && (p.mode === "wire" || p.mode === "rewire") ? { ...p, cursor } : p,
          );
          if (hit !== hoverRef.current) setHoverId(hit);
          break;
        }
        case "cut": {
          const cur = toWorld(e.clientX, e.clientY);
          cutSegment(it.last, cur);
          setInteraction((p) => (p && p.mode === "cut" ? { ...p, last: cur } : p));
          break;
        }
      }
    },
    [canvasId, cutSegment, hitTestNode, store, toWorld],
  );

  const handlePointerUp = useCallback(() => {
      const it = interactionRef.current;
      if (!it) return;
      const st = store.getState();
      switch (it.mode) {
        case "marquee": {
          if (it.moved) {
            const rect = {
              x: Math.min(it.start.x, it.cur.x),
              y: Math.min(it.start.y, it.cur.y),
              w: Math.abs(it.cur.x - it.start.x),
              h: Math.abs(it.cur.y - it.start.y),
            };
            const ids = st.nodes.filter((n) => rectsIntersect(rect, nodeRect(n))).map((n) => n.id);
            setSelection(ids);
          } else {
            setSelection([]);
          }
          break;
        }
        case "node-drag": {
          if (it.moved && (it.dx !== 0 || it.dy !== 0)) {
            const byId = new Map(st.nodes.map((n) => [n.id, n]));
            const next: CanvasLayoutEntry[] = [];
            const prev: CanvasLayoutEntry[] = [];
            for (const o of it.origins) {
              const node = byId.get(o.id);
              if (!node) continue;
              const { w, h } = nodeSize(node);
              next.push({ id: o.id, pos_x: o.x + it.dx, pos_y: o.y + it.dy, width: w, height: h });
              prev.push({ id: o.id, pos_x: o.x, pos_y: o.y, width: w, height: h });
            }
            pushUndo({ kind: "layout", prev, next });
            st.commitLayout(canvasId, next);
          }
          break;
        }
        case "resize": {
          if (it.moved) {
            const node = st.nodes.find((n) => n.id === it.id);
            if (node) {
              const w = Math.max(120, it.originW + it.dw);
              const h = Math.max(80, it.originH + it.dh);
              pushUndo({
                kind: "layout",
                prev: [
                  { id: it.id, pos_x: node.pos_x, pos_y: node.pos_y, width: it.originW, height: it.originH },
                ],
                next: [{ id: it.id, pos_x: node.pos_x, pos_y: node.pos_y, width: w, height: h }],
              });
              st.commitLayout(canvasId, [
                { id: it.id, pos_x: node.pos_x, pos_y: node.pos_y, width: w, height: h },
              ]);
            }
          }
          break;
        }
        case "wire": {
          const target = hoverRef.current;
          const source = st.nodes.find((n) => n.id === it.fromNode);
          if (target) {
            void st.connect(canvasId, it.fromNode, target);
          } else if (source && pointInRect(it.cursor, nodeRect(source))) {
            // 放回原点 = 取消本次拖线（不弹菜单）。
          } else {
            // 拖线到空白弹建节点菜单，选型后自动接回。
            openAddMenu(it.cursor, { kind: "connect", fromNode: it.fromNode });
          }
          break;
        }
        case "rewire": {
          const target = hoverRef.current;
          const source = st.nodes.find((n) => n.id === it.fromNode);
          if (target) {
            // 摘线换目标：后端合并语义（同源重复时删本线保既有）。
            void st.rewire(it.connId, target);
          } else if (source && pointInRect(it.cursor, nodeRect(source))) {
            // 放回原上游 = 取消，线保持原状（v2 无断线语义）。
          } else {
            openAddMenu(it.cursor, { kind: "rewire", connId: it.connId });
          }
          break;
        }
        case "cut":
          break;
      }
      setInteraction(null);
      setHoverId(null);
    },
    [canvasId, openAddMenu, pushUndo, store],
  );

  // 指针手势的窗口级监听：interaction 活跃期间挂载，up 后卸载。
  const interactionActive = interaction !== null;
  useEffect(() => {
    if (!interactionActive) return;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [interactionActive, handlePointerMove, handlePointerUp]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (addMenu) setAddMenu(null);
    const target = e.target as HTMLElement;

    if (e.button === 1) {
      // 中键平移。
      e.preventDefault();
      setInteraction({
        mode: "pan",
        startX: e.clientX,
        startY: e.clientY,
        viewX: viewRef.current.x,
        viewY: viewRef.current.y,
      });
      return;
    }
    if (e.button === 2) {
      // Shift/Ctrl + 右键划线切线；普通右键无菜单（contextmenu 已屏蔽）。
      if (e.shiftKey || e.ctrlKey) {
        setInteraction({ mode: "cut", last: toWorld(e.clientX, e.clientY) });
      }
      return;
    }
    if (e.button !== 0) return;

    const nodeEl = target.closest(".fc-node") as HTMLElement | null;
    if (nodeEl) {
      // 编辑中的输入框不触发任何节点手势（选择文本/光标放置优先）。
      if (target.closest("input, textarea")) return;
      const nodeId = nodeEl.dataset.nodeId ?? "";
      const node = nodesRef.current.find((n) => n.id === nodeId);
      if (!node) return;

      if (target.closest(".fc-port-out")) {
        setInteraction({ mode: "wire", fromNode: node.id, cursor: toWorld(e.clientX, e.clientY) });
        return;
      }
      if (target.closest(".fc-port-in")) {
        // 摘线换目标：仅当该输入位有来线时可拿（v2 无顶掉语义）。
        const incoming = connectionsRef.current.find((c) => c.to_node === node.id);
        if (incoming) {
          setInteraction({
            mode: "rewire",
            connId: incoming.id,
            fromNode: incoming.from_node,
            cursor: toWorld(e.clientX, e.clientY),
          });
          return;
        }
      }
      if (target.closest(".fc-resize")) {
        const { w, h } = nodeSize(node);
        setInteraction({
          mode: "resize",
          id: node.id,
          startX: e.clientX,
          startY: e.clientY,
          originW: w,
          originH: h,
          dw: 0,
          dh: 0,
          moved: false,
        });
        return;
      }

      // 节点主体：选择 + 拖动（多选组拖）。
      let ids = selectionRef.current;
      if (e.shiftKey) {
        ids = ids.includes(node.id) ? ids.filter((i) => i !== node.id) : [...ids, node.id];
      } else if (!ids.includes(node.id)) {
        ids = [node.id];
      }
      setSelection(ids);
      selectionRef.current = ids;
      const moving = ids.includes(node.id) ? ids : [node.id];
      const origins = nodesRef.current
        .filter((n) => moving.includes(n.id))
        .map((n) => ({ id: n.id, x: n.pos_x, y: n.pos_y }));
      if (!origins.length) return;
      setInteraction({
        mode: "node-drag",
        startX: e.clientX,
        startY: e.clientY,
        origins,
        dx: 0,
        dy: 0,
        moved: false,
      });
      return;
    }

    // 空白：框选（阈值区分双击建节点菜单的两次单击）。
    setInteraction({ mode: "marquee", start: toWorld(e.clientX, e.clientY), cur: toWorld(e.clientX, e.clientY), moved: false });
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const nodeEl = target.closest(".fc-node") as HTMLElement | null;
    if (nodeEl) {
      const nodeId = nodeEl.dataset.nodeId ?? "";
      const node = nodesRef.current.find((n) => n.id === nodeId);
      if (node && (node.type === "text" || node.type === "note")) {
        setEditingId(node.id);
      }
      return;
    }
    const world = toWorld(e.clientX, e.clientY);
    openAddMenu(world, null);
  };

  // 键盘：删除选中（输入框聚焦不响应）、撤销、Escape 退出手势。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectionRef.current.length) {
        e.preventDefault();
        void deleteSelected();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void undo();
      } else if (e.key === "Escape") {
        if (interactionRef.current) setInteraction(null);
        if (addMenu) setAddMenu(null);
        setEditingId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addMenu, deleteSelected, undo]);

  // ── 渲染 ───────────────────────────────────────────────────

  const dragDelta =
    interaction?.mode === "node-drag" && interaction.moved
      ? { dx: interaction.dx, dy: interaction.dy }
      : null;

  const renderPos = (node: CanvasNode): Point => {
    if (dragDelta) {
      const origin = interaction?.mode === "node-drag"
        ? interaction.origins.find((o) => o.id === node.id)
        : undefined;
      if (origin) return { x: origin.x + dragDelta.dx, y: origin.y + dragDelta.dy };
    }
    return { x: node.pos_x, y: node.pos_y };
  };

  const renderSize = (node: CanvasNode): { w: number; h: number } => {
    if (interaction?.mode === "resize" && interaction.id === node.id && interaction.moved) {
      return {
        w: Math.max(120, interaction.originW + interaction.dw),
        h: Math.max(80, interaction.originH + interaction.dh),
      };
    }
    return nodeSize(node);
  };

  const selectedNode = nodes.find((n) => n.id === selection[0]) ?? null;

  const draftWire = (() => {
    if (interaction?.mode === "wire" || interaction?.mode === "rewire") {
      const from = nodes.find((n) => n.id === interaction.fromNode);
      if (from) {
        const p = renderPos(from);
        const s = renderSize(from);
        return wirePathD({ x: p.x + s.w, y: p.y + s.h / 2 }, interaction.cursor);
      }
    }
    return null;
  })();

  const pickNodeType = async (type: CanvasNodeType) => {
    if (!addMenu) return;
    const menu = addMenu;
    setAddMenu(null);
    const size = NODE_DEFAULT_SIZE[type];
    const node = await store.getState().createNode({
      canvasId,
      nodeType: type,
      posX: menu.wx - size.w / 2,
      posY: menu.wy - 14,
      width: size.w,
      height: size.h,
    });
    if (!node) return;
    if (menu.pending?.kind === "connect") {
      await store.getState().connect(canvasId, menu.pending.fromNode, node.id);
    } else if (menu.pending?.kind === "rewire") {
      await store.getState().rewire(menu.pending.connId, node.id);
    }
    setSelection([node.id]);
  };

  const commitContent = (node: CanvasNode, content: string) => {
    const meta = { ...node.metadata, content } as CanvasNode["metadata"];
    void store.getState().updateNode(node.id, { metadata: JSON.stringify(meta) });
  };

  const commitTitle = (node: CanvasNode, title: string) => {
    if (title !== node.title) void store.getState().updateNode(node.id, { title });
  };

  return (
    <>
      <div
        ref={vpRef}
        className="fc-world"
        onPointerDown={handlePointerDown}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          className="fc-transform"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          <svg className="fc-wires">
            {connections.map((conn) => {
              const from = nodes.find((n) => n.id === conn.from_node);
              const to = nodes.find((n) => n.id === conn.to_node);
              if (!from || !to) return null;
              const fp = renderPos(from);
              const tp = renderPos(to);
              const fs = renderSize(from);
              const ts = renderSize(to);
              const dimmed =
                interaction?.mode === "rewire" && interaction.connId === conn.id;
              return (
                <path
                  key={conn.id}
                  className={`fc-wire${dimmed ? " lifted" : ""}`}
                  d={wirePathD(
                    { x: fp.x + fs.w, y: fp.y + fs.h / 2 },
                    { x: tp.x, y: tp.y + ts.h / 2 },
                  )}
                  style={{ stroke: NODE_ACCENT[from.type] }}
                />
              );
            })}
            {draftWire && <path className="fc-wire draft" d={draftWire} />}
            {interaction?.mode === "marquee" && interaction.moved && (
              <rect
                className="fc-marquee"
                x={Math.min(interaction.start.x, interaction.cur.x)}
                y={Math.min(interaction.start.y, interaction.cur.y)}
                width={Math.abs(interaction.cur.x - interaction.start.x)}
                height={Math.abs(interaction.cur.y - interaction.start.y)}
              />
            )}
          </svg>

          {nodes.map((node) => {
            const pos = renderPos(node);
            const size = renderSize(node);
            const selected = selection.includes(node.id);
            const hovered =
              hoverId === node.id &&
              (interaction?.mode === "wire" || interaction?.mode === "rewire");
            const meta = node.metadata;
            return (
              <div
                key={node.id}
                className={`fc-node fc-node-${node.type}${selected ? " selected" : ""}${hovered ? " hover" : ""}`}
                data-node-id={node.id}
                style={
                  {
                    left: pos.x,
                    top: pos.y,
                    width: size.w,
                    height: size.h,
                    "--fc-accent": NODE_ACCENT[node.type],
                  } as CSSProperties
                }
              >
                <div className="fc-node-head">
                  <span className="fc-node-dot" />
                  <span className="fc-node-title">
                    {node.title || t(`canvas.node.${node.type}`)}
                  </span>
                </div>
                <div className="fc-node-body">
                  {(node.type === "text" || node.type === "note") && (
                    editingId === node.id ? (
                      <textarea
                        className="fc-node-edit"
                        autoFocus
                        defaultValue={meta.kind === "text" || meta.kind === "note" ? meta.content : ""}
                        onBlur={(e) => {
                          commitContent(node, e.target.value);
                          setEditingId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.currentTarget.blur();
                          }
                        }}
                      />
                    ) : (
                      <div className="fc-node-text">
                        {meta.kind === "text" || meta.kind === "note" ? meta.content || "" : ""}
                      </div>
                    )
                  )}
                  {node.type === "image" && (
                    meta.kind === "image" && meta.images.length > 0 ? (
                      <div className="fc-node-thumbs">
                        {meta.images.map((img, i) => (
                          <ResourceThumb key={i} path={img.resource_path} className="fc-thumb" />
                        ))}
                      </div>
                    ) : (
                      <div className="fc-node-placeholder">{t("canvas.imageEmpty")}</div>
                    )
                  )}
                  {node.type === "ref" && (
                    node.resource_path ? (
                      <ResourceThumb path={node.resource_path} className="fc-thumb-cover" />
                    ) : (
                      <div className="fc-node-placeholder">{t("canvas.refEmpty")}</div>
                    )
                  )}
                </div>
                <span className="fc-port fc-port-in" />
                <span className="fc-port fc-port-out" />
                <span className="fc-resize" />
              </div>
            );
          })}
        </div>

        {addMenu && (
          <div
            className="fc-addmenu"
            style={{ left: addMenu.sx, top: addMenu.sy }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {(["text", "image", "ref", "note"] as CanvasNodeType[]).map((type) => (
              <button key={type} onClick={() => void pickNodeType(type)}>
                <span className="fc-addmenu-dot" style={{ background: NODE_ACCENT[type] }} />
                {t(`canvas.node.${type}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      <aside className="fc-panel">
        <div className="fc-panel-title">{t("canvas.panel.title")}</div>
        {selectedNode ? (
          <div className="fc-panel-body" key={selectedNode.id}>
            <label className="fc-field">
              <span>{t("canvas.panel.titleLabel")}</span>
              <input
                key={`title-${selectedNode.id}`}
                defaultValue={selectedNode.title}
                onBlur={(e) => commitTitle(selectedNode, e.target.value.trim())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </label>
            {(selectedNode.type === "text" || selectedNode.type === "note") &&
              (selectedNode.metadata.kind === "text" || selectedNode.metadata.kind === "note") && (
                <label className="fc-field">
                  <span>{t("canvas.panel.contentLabel")}</span>
                  <textarea
                    key={`content-${selectedNode.id}`}
                    defaultValue={selectedNode.metadata.content}
                    onBlur={(e) => commitContent(selectedNode, e.target.value)}
                  />
                </label>
              )}
            {selectedNode.type === "ref" && (
              <label className="fc-field">
                <span>{t("canvas.panel.pathLabel")}</span>
                <input
                  key={`path-${selectedNode.id}`}
                  defaultValue={selectedNode.resource_path}
                  placeholder={t("canvas.namePlaceholder")}
                  onBlur={(e) => {
                    const path = e.target.value.trim();
                    if (path !== selectedNode.resource_path) {
                      void store.getState().updateNode(selectedNode.id, { resourcePath: path });
                    }
                  }}
                />
              </label>
            )}
            <div className="fc-panel-meta">
              {Math.round(renderSize(selectedNode).w)} × {Math.round(renderSize(selectedNode).h)}
            </div>
            <button className="fc-panel-delete" onClick={() => void deleteSelected()}>
              {t("canvas.panel.deleteNode")}
            </button>
          </div>
        ) : (
          <div className="fc-panel-empty">{t("canvas.panel.noSelection")}</div>
        )}
      </aside>
    </>
  );
}
