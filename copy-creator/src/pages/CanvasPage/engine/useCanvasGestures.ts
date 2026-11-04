import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { CanvasConnection, CanvasGroup, CanvasLayoutEntry, CanvasNode } from "../../../stores/canvasStore";
import { useCanvasData } from "../dataContext";
import { resolveWireRelease } from "../../../utils/projectWireRelease";
import { NODE_DEFAULT_SIZE, NODE_DEFS, NODE_MIN_SIZE, PORT_DEFS, outWireColorOf, portFits } from "../nodes/registry";
import type { PortDef } from "../nodes/types";
import type { NodeServices } from "../nodes/types";
import type { DragState, Pos, UndoAction, WireBox } from "./gestureTypes";
import { nodeSize, segHitsPolyline, wirePathD } from "./wireGeom";
import { moveGroupTo } from "./groupOps";
import type { NodeMetrics } from "./useNodeMetrics";
import type { ViewState } from "./useViewport";

// 画布手势会话（自 FreeCanvas.tsx 零改动搬运，2026-11-03 引擎拆分阶段 6b）。
// 引擎框架 fork 自 ProjectCanvas——按下分派（onViewportPointerDown）与窗口
// 级 move/up/cancel 的分支结构、DOM 契约（.pc-node[data-key] / .pc-port
// [data-port-id] / .pc-resize[data-corner] / .fc-vtl-strip 手势排除）、
// 「闭包随渲染刷新重订阅」惯例全部保真；回灌对齐按 ProjectCanvas 同名
// 区段逐字节对照。连线为类型化端口语义（accepts 矩阵匹配），见 nodes/registry。

/** 双击空白的节点选择框状态（含连线续接意图）。 */
export interface AddMenuState {
  sx: number;
  sy: number;
  wx: number;
  wy: number;
  /** 拖线到空白：菜单创建的节点自动接上这条线。 */
  wire?: { fromKey: string; fromDir: "in" | "out"; fromPortId: string };
  /** 摘线到空白：菜单创建的节点接走这条线（原连线行删除）。 */
  detached?: { connId: string; fromKey: string };
}

export interface GestureDeps {
  vpRef: RefObject<HTMLDivElement | null>;
  /** 视口状态：手势回调闭包随渲染刷新读取（重订阅惯例）。 */
  view: ViewState;
  setView: Dispatch<SetStateAction<ViewState>>;
  saveView(next: ViewState): void;
  nodesRef: RefObject<CanvasNode[]>;
  connectionsRef: RefObject<CanvasConnection[]>;
  selRef: RefObject<string[]>;
  setSelection(keys: string[]): void;
  /** Ctrl+G 的组（组框标题按下拖动整组）。 */
  groups: CanvasGroup[];
  /** 成员当前包围盒（世界坐标）。 */
  memberFrame(key: string): { x: number; y: number; w: number; h: number } | null;
  /** 选中组快照（minCount=2；组拖成员）。 */
  groupSnapshot(): { key: string; x: number; y: number }[] | null;
  /** 连线锚点（实测优先）。 */
  boxOf(key: string): WireBox | null;
  outPointOf(key: string): Pos | null;
  inPointOf(key: string, portId: string): Pos | null;
  nodeMetricsRef: RefObject<NodeMetrics>;
  /** 双击节点动作的分派服务（def.onDoubleClick）。 */
  canvasServices: NodeServices;
  pushUndo(action: UndoAction): void;
}

export function useCanvasGestures(deps: GestureDeps) {
  const { vpRef, view, setView, saveView, nodesRef, connectionsRef, selRef, setSelection, groups, memberFrame, groupSnapshot, boxOf, outPointOf, inPointOf, nodeMetricsRef, canvasServices, pushUndo } = deps;
  // 几何读写数据源（默认实现=canvasStore 转发；工程视图=工程 provider）。
  const data = useCanvasData();

  const [addMenu, setAddMenu] = useState<AddMenuState | null>(null);
  const [addMenuQuery, setAddMenuQuery] = useState("");
  const [wireDraft, setWireDraft] = useState<{ d: string; invalid: boolean; color?: string } | null>(null);
  /** 摘线拿着（rewire）中：该连线暂隐藏，松手转接或放回。 */
  const [liftedWire, setLiftedWire] = useState<{ connId: string; fromKey: string } | null>(null);
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

  // ── 出生锚点脉冲：新建节点出生在用户视线附近时脉冲高亮。 ──
  useEffect(() => {
    if (pulseKeys.length === 0) return;
    const timer = window.setTimeout(() => setPulseKeys([]), 2400);
    return () => window.clearTimeout(timer);
  }, [pulseKeys]);
  const pulseNodes = useCallback((ids: string[]) => {
    if (ids.length) setPulseKeys(ids);
  }, []);

  /** 摘线到空白后取消菜单（Esc/点外部）＝线就此断开（ComfyUI 语义）。 */
  const discardDetachedWire = useCallback(
    (detached: { connId: string }) => {
      setLiftedWire(null);
      void data.deleteConnection(detached.connId);
    },
    [data],
  );

  // Blender 式切线（Shift/Ctrl+右键滑动）：切痕层直写 polyline。
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
          void data.deleteConnection(connId);
        },
      });
    });
    return targets;
  }, [data, vpRef]);

  const openAddMenu = useCallback(
    (sx: number, sy: number, wx: number, wy: number, pending?: { wire?: { fromKey: string; fromDir: "in" | "out"; fromPortId: string }; detached?: { connId: string; fromKey: string } }) => {
      setAddMenu({ sx, sy, wx, wy, wire: pending?.wire, detached: pending?.detached });
      setAddMenuQuery("");
    },
    [],
  );

  /** 关闭菜单（菜单项点击 / 外点取消共用）。 */
  const closeAddMenu = useCallback(() => {
    setAddMenu(null);
    setAddMenuQuery("");
  }, []);

  /** 菜单建节点接回连线：算新节点上可接住来源的输入口 id（无可接口
   *  = 空串不接）；菜单项过滤同样用它。来源传完整节点（工程 data 匹配
   *  需要来源输出口的动态类型，如镜头卡图/视频）。 */
  const incomingPortFor = useCallback(
    (newType: string, fromNode: { type: string; metadata: CanvasNode["metadata"] }): string =>
      PORT_DEFS[newType]?.ins.find((p) => portFits(p, fromNode))?.id ?? "",
    [],
  );

  /** addnode 落点提交（2026-11-04 自 onUp 指针分支抽出）：指针松手与菜单
   *  键盘回车共用——moved=false 落菜单打开的世界点 (fox/foy)，moved=true
   *  落松手屏幕点；「拖线到空白」与「摘线转接」的自动接线语义原样保留。
   *  clientX/Y 仅 moved 时参与换算。 */
  const commitAddNode = useCallback(
    (drag: Extract<DragState, { kind: "addnode" }>, moved = false, clientX = 0, clientY = 0) => {
      const rect = vpRef.current?.getBoundingClientRect();
      const dropPos = moved && rect
        ? {
            x: (clientX - rect.left - view.x) / view.scale,
            y: (clientY - rect.top - view.y) / view.scale,
          }
        : { x: drag.fox, y: drag.foy };
      void (async () => {
        const size = NODE_DEFAULT_SIZE[drag.frameKey];
        const created = await data.createNode({
          nodeType: drag.frameKey,
          posX: dropPos.x - size.w / 2,
          posY: dropPos.y - 14,
          width: size.w,
          height: size.h,
        });
        if (!created) return;
        pulseNodes([created.id]);
        const fromNode = drag.wire ? nodesRef.current.find((n) => n.id === drag.wire!.fromKey) : undefined;
        if (drag.detached) {
          // 摘线转接：线改接新节点（新节点需要能接住原上游的口）。
          setLiftedWire(null);
          const toPort = fromNode ? incomingPortFor(created.type, fromNode) : "";
          await data.rewire(drag.detached.connId, created.id, toPort);
        } else if (drag.wire && fromNode) {
          if (drag.wire.fromDir === "out") {
            // 正拖：新节点是下游，找它可接住上游的输入口。
            const toPort = incomingPortFor(created.type, fromNode);
            await data.connect(drag.wire.fromKey, created.id, toPort);
          } else {
            // 反拖：新节点是上游，接进源输入口。
            await data.connect(created.id, drag.wire.fromKey, drag.wire.fromPortId);
          }
        }
        setSelection([created.id]);
      })();
    },
    [data, incomingPortFor, nodesRef, pulseNodes, setLiftedWire, setSelection, view, vpRef],
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
      // 上一场拖拽若有残留（松手事件在窗外丢失等），开新拖拽前先复位。
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
      // .fc-vtl-strip 是视频工具时间轴：视口抢捕获会吞掉轨道的 pointerup，
      // 拖拽会话残留成「点一下跟鼠标走」，且轨道拖动会连带拖走节点
      // （实测实锤：lostpointercapture 后节点被拖出 800px）。
      if (e.button === 0 && target?.closest("input, textarea, button, video, audio, .fc-vtl-strip")) return;

      const vp = vpRef.current;
      if (!vp) return;
      if (e.button === 1) {
        dragRef.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
        vp.classList.add("pc-panning");
        e.preventDefault();
        return;
      }
      // Blender 式切线：Shift/Ctrl+右键滑动，扫过的连线即时切断。
      if (e.button === 2 && (e.shiftKey || e.ctrlKey)) {
        dragRef.current = { kind: "wirecut", sx: e.clientX, sy: e.clientY, moved: false };
        cutPointsRef.current = [];
        vp.classList.add("pc-cutting");
        cutTargetsRef.current = buildCutTargets();
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;

      // 类型化端口：输入口按下 = 摘线（有来线时）或反向拖（无线时，落点
      // 为上游）；输出口按下 = 正向拖线。
      const port = target?.closest(".pc-port") as HTMLElement | null;
      if (port) {
        const nodeEl = port.closest(".pc-node");
        const key = nodeEl?.getAttribute("data-key") ?? "";
        const node = nodesRef.current.find((n) => n.id === key);
        // 所有注册节点都参与连线（note 的 out 为 null 也不可连——按下即
        // 摘线/反拖路径自身按口元数据处理）。原式 `node && …out !== null
        // || node` 因运算符优先级恒等于下式，予以化简（行为不变）。
        if (node) {
          const dir = port.dataset.port === "in" ? "in" : "out";
          const portId = port.dataset.portId ?? "";
          if (dir === "in" && portId) {
            // 摘一个输入口 = 拿走这条线（ComfyUI 摘线换目标）。
            const incoming = connectionsRef.current.find((c) => c.to_node === key && c.to_port === portId);
            if (incoming) {
              setLiftedWire({ connId: incoming.id, fromKey: incoming.from_node });
              vp.classList.add("pc-wiring");
              port.classList.add("pc-port-active");
              // 原口登记为「当前亮口」：拖走时悬停切换自然清它，滑回
              // 原口（放回）也能正常重新点亮。
              wirePortHoverRef.current = port;
              dragRef.current = {
                kind: "wire", sx: e.clientX, sy: e.clientY, moved: false,
                rewire: true, connId: incoming.id,
                fromKey: incoming.from_node, fromDir: "in", fromPortId: portId,
                targetKey: null, targetPort: null,
              };
              e.preventDefault();
              return;
            }
            // 无来线的输入口：反向拖（落点为上游来源）。
            vp.classList.add("pc-wiring");
            port.classList.add("pc-port-active");
            dragRef.current = {
              kind: "wire", sx: e.clientX, sy: e.clientY, moved: false,
              fromKey: key, fromDir: "in", fromPortId: portId,
              targetKey: null, targetPort: null,
            };
            e.preventDefault();
            return;
          }
          if (dir === "out") {
            // 正向拖线：源端口点亮（即使草稿线被渲染环境吞掉，按下即有
            // 可见状态）。
            vp.classList.add("pc-wiring");
            port.classList.add("pc-port-active");
            dragRef.current = {
              kind: "wire", sx: e.clientX, sy: e.clientY, moved: false,
              fromKey: key, fromDir: "out", fromPortId: "__out",
              targetKey: null, targetPort: null,
            };
            e.preventDefault();
            return;
          }
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
    [addMenu, buildCutTargets, connectionsRef, discardDetachedWire, groupSnapshot, groups, memberFrame, nodesRef, selRef, setSelection, view, vpRef],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // 首次移动即捕获指针：此后即使松手在窗口外，mouseup 仍送达。
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
        setView((prev) => ({ ...prev, x: drag.ox + dx, y: drag.oy + dy }));
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
        moveGroupTo(data, nodesRef, drag.members.map((m) => ({ key: m.key, x: m.x + dx / view.scale, y: m.y + dy / view.scale })));
      } else if (drag.kind === "node") {
        if (!drag.moved) return;
        moveGroupTo(data, nodesRef, [{ key: drag.frameKey, x: drag.ox + dx / view.scale, y: drag.oy + dy / view.scale }]);
      } else if (drag.kind === "resize") {
        // 四角自由缩放：对角固定，实时预览；西/北角缩放联动挪动位置，
        // 松手才持久化尺寸与位置。
        const key = drag.frameKey;
        const node = nodesRef.current.find((n) => n.id === key);
        const min = NODE_MIN_SIZE[node?.type ?? "gen_image"];
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
        data.commitLayout([
          { id: key, pos_x: px ?? node?.pos_x ?? 0, pos_y: py ?? node?.pos_y ?? 0, width: Math.round(w), height: Math.round(h) },
        ]);
      } else if (drag.kind === "wirecut") {
        // 松手事件丢失时右键已弹起，拖拽态却还挂着：按 e.buttons 自愈。
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
        // 摘线拿着（rewire）时草稿线锚在「留在原地的另一端」——线的真实
        // 源头输出口，刚拔空的输入口不再有线的视觉残留。
        const startPoint = drag.fromDir === "out"
          ? outPointOf(drag.fromKey)
          : drag.rewire
            ? outPointOf(drag.fromKey)
            : inPointOf(drag.fromKey, drag.fromPortId);
        if (!startPoint) return;
        const cursor = { x: wx, y: wy };
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const tEl = hit instanceof Element ? hit.closest<HTMLElement>(".pc-node[data-key]") : null;
        const tKey = tEl?.getAttribute("data-key") ?? null;
        const tNode = tKey ? nodesRef.current.find((n) => n.id === tKey) : undefined;
        const fromNode = nodesRef.current.find((n) => n.id === drag.fromKey);
        // 类型化端口匹配：
        //   正拖（out）：落点节点的某个输入口 accepts 包含来源（node
        //     匹配按类型 / 工程 data 匹配按来源输出口数据类型），
        //     多口时吸附光标最近的口（实测行位）。
        //   反拖/摘线（in）：落点节点必须有 out 且被源输入口接受。
        let targetPort: string | null = null;
        let compatible = false;
        if (drag.fromDir === "out") {
          if (tNode && tKey && fromNode && tKey !== drag.fromKey) {
            const ins = PORT_DEFS[tNode.type].ins.filter((p) => portFits(p, fromNode));
            if (ins.length > 0) {
              const box = boxOf(tKey);
              const metrics = nodeMetricsRef.current.ports[tKey];
              let best: PortDef | undefined;
              let bestDist = Infinity;
              ins.forEach((p) => {
                const off = metrics?.[p.id];
                const py = box && off ? box.y + off.y : box ? box.y + box.h / 2 : 0;
                const dist = box ? Math.abs(py - wy) : 0;
                if (!best || dist <= bestDist) {
                  best = p;
                  bestDist = dist;
                }
              });
              targetPort = best?.id ?? null;
              compatible = !!targetPort;
            }
          }
        } else {
          const inDef = PORT_DEFS[fromNode?.type ?? "note"]?.ins.find((p) => p.id === drag.fromPortId);
          if (tNode && inDef && tKey !== drag.fromKey) {
            compatible = portFits(inDef, tNode);
            targetPort = compatible ? drag.fromPortId : null;
          }
        }
        drag.invalid = !!tKey && tKey !== drag.fromKey && !compatible;
        drag.targetKey = compatible ? tKey : null;
        drag.targetPort = targetPort;
        // 落点节点高亮（可接亮框 / 不可接不亮）。
        const hoverEl = compatible ? tEl : null;
        if (wireHoverRef.current !== hoverEl) {
          wireHoverRef.current?.classList.remove("pc-wire-target");
          hoverEl?.classList.add("pc-wire-target");
          wireHoverRef.current = hoverEl;
        }
        // 悬停口点亮：线要落去的那个口与源口同款放大光圈（亮＝接得上）。
        const portEl = compatible && tEl && targetPort
          ? tEl.querySelector<HTMLElement>(`.pc-port[data-port-id="${targetPort}"]`)
          : null;
        if (wirePortHoverRef.current !== portEl) {
          wirePortHoverRef.current?.classList.remove("pc-port-active");
          portEl?.classList.add("pc-port-active");
          wirePortHoverRef.current = portEl;
        }
        // 草稿终点：命中可接口时吸附到该口实测位置。
        const endPoint =
          compatible && drag.fromDir === "out" && tKey && targetPort
            ? inPointOf(tKey, targetPort) ?? cursor
            : cursor;
        const draftColor = fromNode ? outWireColorOf(fromNode) : undefined;
        setWireDraft({
          // 摘线拿着：从源头画到手里；普通正拖 out→口；反拖 手里→口。
          d: drag.fromDir === "out"
            ? wirePathD(startPoint, endPoint)
            : wirePathD(cursor, startPoint),
          invalid: !!drag.invalid,
          color: draftColor,
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
        if (hit?.closest("textarea, input, button, video, audio")) {
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
              // 双击节点：def.onDoubleClick（便签进编辑；预览图像开大图）；
              // 其余类型无全局动作。
              const node = nodesRef.current.find((n) => n.id === key);
              if (node) NODE_DEFS[node.type].onDoubleClick?.(node, canvasServices);
            }
          }
        }
      } else if (drag.moved) {
        dblRef.current = null;
      }
      if (drag.kind === "pan") {
        if (drag.moved) saveView(view);
      } else if (drag.kind === "wirecut") {
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
        const targetPort = drag.targetPort;
        if (drag.rewire) {
          // ComfyUI 摘线收尾：换目标（拖到另一节点可接口上）/ 空白交给
          // 菜单（建节点即转接）/ 其余一律放回（行数据未删，清掉 lifted
          // 即恢复原线）。
          const lifted = liftedWire;
          if (wireRelease === "commit" && targetKey && targetPort && lifted) {
            setLiftedWire(null);
            // 单线口：转接进来前顶掉口上其他旧线（合集 multi 口不顶）。
            // 工程 provider（displacesOnConnect=false）在 rewire 内部按口
            // 语义自管顶掉（keep 自己拿走的行），引擎代删会误清组线。
            const toNode = nodesRef.current.find((n) => n.id === targetKey);
            const multi = toNode ? PORT_DEFS[toNode.type].ins.find((p) => p.id === targetPort)?.multi : false;
            if (data.displacesOnConnect !== false && !multi) {
              const old = connectionsRef.current.find((c) => c.to_node === targetKey && c.to_port === targetPort && c.id !== lifted.connId);
              if (old) void data.deleteConnection(old.id);
            }
            void data.rewire(lifted.connId, targetKey, targetPort);
          } else if (wireRelease === "picker" && lifted) {
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
        } else if (wireRelease === "commit" && targetKey && targetPort && drag.fromKey) {
          const fromKey = drag.fromDir === "out" ? drag.fromKey : targetKey;
          const toKey = drag.fromDir === "out" ? targetKey : drag.fromKey;
          const toPort = drag.fromDir === "out" ? targetPort : drag.fromPortId;
          // 单线口语义：落线顶掉该口已有旧线（合集 multi 口追加不顶）。
          // 工程 provider（displacesOnConnect=false）在 connect 内部按口
          // 语义自管顶掉（组线落资料口按组类型进对应口），引擎代删会按
          // 错误的口清线。
          const toNode = nodesRef.current.find((n) => n.id === toKey);
          const multi = toNode ? PORT_DEFS[toNode.type].ins.find((p) => p.id === toPort)?.multi : false;
          if (data.displacesOnConnect !== false && !multi) {
            const old = connectionsRef.current.find((c) => c.to_node === toKey && c.to_port === toPort && c.from_node !== fromKey);
            if (old) void data.deleteConnection(old.id);
          }
          void data.connect(fromKey, toKey, toPort);
        } else if (wireRelease === "picker" && drag.fromKey) {
          // ComfyUI 惯例：拖到空白松手 → 弹节点选择框，创建的节点自动
          // 接上这条线；落在任何节点/浮层上松手视为取消，不弹。
          if (vpRect) {
            openAddMenu(
              e.clientX - vpRect.left,
              e.clientY - vpRect.top,
              (e.clientX - vpRect.left - view.x) / view.scale,
              (e.clientY - vpRect.top - view.y) / view.scale,
              { wire: { fromKey: drag.fromKey, fromDir: drag.fromDir, fromPortId: drag.fromPortId } },
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
            // 撤销条目同样只动位置：宽高透传节点原值，保住 null 自动高。
            pushUndo({
              kind: "layout",
              prev: [{ id: drag.frameKey, pos_x: drag.ox, pos_y: drag.oy, width: node.width, height: node.height }],
              next: [{ id: drag.frameKey, pos_x: node.pos_x, pos_y: node.pos_y, width: node.width, height: node.height }],
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
            prev.push({ id: m.key, pos_x: m.x, pos_y: m.y, width: node.width, height: node.height });
            next.push({ id: m.key, pos_x: m.x + dxW, pos_y: m.y + dyW, width: node.width, height: node.height });
          }
          pushUndo({ kind: "layout", prev, next });
        }
      } else if (drag.kind === "addnode") {
        // 点击（未拖动）落双击点；按住拖到画布松手落松手点；从「拖线
        // 到空白」菜单进入时，创建的节点自动接上那条线。提交逻辑抽出
        // 共用（菜单键盘回车走同一函数，见 commitAddNode）。
        commitAddNode(drag, drag.moved ?? false, e.clientX, e.clientY);
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

  return {
    onViewportPointerDown,
    dragRef,
    suppressClickRef,
    cutTrailRef,
    cutTrailUnderRef,
    wireDraft,
    liftedWire,
    addMenu,
    addMenuQuery,
    setAddMenuQuery,
    closeAddMenu,
    discardDetachedWire,
    pulseKeys,
    pulseNodes,
    openAddMenu,
    commitAddNode,
  };
}
