// 工程画布手势引擎（自 ProjectCanvas.tsx 组件体零改动搬移，2026-11-03
// 阶段 11b）：DragState 按下分派（14 种拖拽）+ 窗口级 move/up/cancel +
// Blender 切线 + ComfyUI 摘线换源换口 + 统一双击判定。引擎 fork 自
// ProjectCanvas 单体（与自由画布 FreeCanvas/engine 同源骨架），回灌对齐
// 按原文注释对照；依赖经 GestureDeps 解构注入，代码体保持原缩进原语句。
import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ProjectAsset, ProjectNodeLink, ProjectScene, ProjectSegment } from "../../../../stores/projectStore";
import { resolveWireRelease } from "../../../../utils/projectWireRelease";
import { WIRE_TYPE_COLORS } from "../colors";
import { INFO_H, INFO_W, SCRIPT_W, SEG_H, SEG_W, WORLD_MARGIN, portRatio, segHitsPolyline, shotCardSize, wirePathD } from "../layout";
import type {
  CanvasInfo,
  CanvasLayout,
  CanvasNote,
  EntityPh,
  InfoGroup,
  NodeGroup,
  PendingLink,
  Pos,
  PosMap,
  PromptPh,
  WireBox,
} from "../types";

export interface DragState {
  kind: "pan" | "marquee" | "card" | "group" | "infoframe" | "wire" | "outnode" | "note" | "addnode" | "segment" | "resize" | "infonode" | "multidrag" | "wirecut";
  sx: number;
  sy: number;
  moved?: boolean;
  ox?: number;
  oy?: number;
  mq?: HTMLDivElement;
  moves?: { key: string; x: number; y: number }[];
  // 多选组拖：按下时整组选中节点的初始位置（完整节点 key，世界坐标）。
  members?: GroupMember[];
  frameKey?: string;
  corner?: "nw" | "ne" | "sw" | "se";
  px?: number;
  py?: number;
  // 按下时的初始位置（世界坐标）：移动中每步的绝对计算基准；
  // px/py 则是最新预览位置（回写供 mouseup 兜底），两者不能混用。
  px0?: number;
  py0?: number;
  fox?: number;
  foy?: number;
  starts?: { key: string; x: number; y: number }[];
  fromKey?: string;
  targetKey?: string | null;
  fromDir?: "out" | "in"; // 从输出口正拖 / 从输入口反拖
  fromType?: string; // 正拖：出发输出口的数据类型
  fromAccepts?: string[]; // 反拖：出发输入口可接的类型
  fromPortId?: string; // 反拖：出发的输入口
  targetPort?: string | null; // 正拖：悬停片段上匹配的输入口
  invalid?: boolean; // 悬停目标类型不兼容
  // ComfyUI 摘线：从已有连线的输入口按下，拿着原线换源/换节点，
  // 而不是再拉一条新线。
  rewire?: boolean;
  // addnode：从「摘线到空白」菜单创建节点后要转接的摘下线
  //（pending 一条或 db 多行），创建成功即删旧写新，取消则断开。
  detached?: { pendings: PendingLink[]; rows: ProjectNodeLink[] };
  wire?: { // addnode：从「拖线到空白」菜单创建节点后要自动接的线
    fromKey: string;
    fromDir: "out" | "in";
    fromType?: string;
    fromAccepts?: string[];
    fromPortId?: string;
  };
}

export interface LiftedWire {
  fromKey: string; // 视觉线的源节点 key（组线为整组承载节点）
  pendings: PendingLink[];
  rows: ProjectNodeLink[];
}

export interface GestureDeps {
  vpRef: RefObject<HTMLDivElement | null>;
  view: ViewState;
  setView: Dispatch<SetStateAction<ViewState>>;
  saveView(next: ViewState): void;
  layout: Omit<CanvasLayout, "infoFramePos">;
  pos: PosMap;
  setPos: Dispatch<SetStateAction<PosMap>>;
  segPos: Record<string, Pos>;
  setSegPos: Dispatch<SetStateAction<Record<string, Pos>>>;
  outputBox: WireBox | null;
  notes: CanvasNote[];
  setNotes: Dispatch<SetStateAction<CanvasNote[]>>;
  nodeSizes: Record<string, { w: number; h: number }>;
  setNodeSizes: Dispatch<SetStateAction<Record<string, { w: number; h: number }>>>;
  infoGroups: InfoGroup[];
  infoNodes: CanvasInfo[];
  infoNodePos(key: string): Pos;
  entityPhs: EntityPh[];
  promptPhs: PromptPh[];
  segments: ProjectSegment[];
  /** 生成链聚合线（切线候选的数据来源）。 */
  segWires: ReadonlyArray<{ links: ProjectNodeLink[] }>;
  nodeLinks: ProjectNodeLink[];
  pendingLinks: PendingLink[];
  persistPendingLinks(next: PendingLink[]): void;
  nodeGroups: NodeGroup[];
  memberFrame(key: string): { x: number; y: number; w: number; h: number } | null;
  groupSnapshot(): GroupMember[] | null;
  selRef: RefObject<string[]>;
  setSelection(keys: string[]): void;
  moveGroupTo(members: GroupMember[]): void;
  persistPositions(members: GroupMember[]): void;
  pushUndo(action: unknown): void;
  persistCards(cards: Record<string, Pos>): void;
  saveCanvasLayout(payload: {
    assets: { id: string; x: number | null; y: number | null; w: number | null }[];
    shots: { id: string; x: number | null; y: number | null }[];
    scenes: { id: string; x: number | null; y: number | null }[];
    segments?: { id: string; x: number; y: number }[];
  }): unknown;
  saveInfoFramePos(pos: Pos | null): void;
  saveOutputPos(pos: Pos): void;
  setEpisodeOutput(episodeId: string, key: string | null): unknown;
  episodeId: string;
  persistNotes(notes: CanvasNote[]): void;
  addNote(x: number, y: number): void;
  addEntityPh(kind: string, x: number, y: number): string;
  addPromptPh(x: number, y: number): string;
  persistSegments(next: Record<string, Pos>): void;
  linkNode(
    episodeId: string, kind: string, id: string,
    segmentId: string, port: string, ownerKey?: string,
  ): unknown;
  unlinkNode(
    kind: string, id: string, segmentId: string, port: string, ownerKey?: string,
  ): unknown;
  unlinkAssets(fromAssetId: string, toAssetId: string): unknown;
  nodeKeyParts(key: string): { kind: string; id: string } | null;
  addSegment(episodeId: string): Promise<{ id: string } | null>;
  autoConnectNewNode(newKey: string, wire: DragState["wire"] | null): void;
  persistSizes(sizes: Record<string, { w: number; h: number }>): void;
  persistInfoOffsets(next: Record<string, Pos>): void;
  setInfoFramePos: Dispatch<SetStateAction<Pos | null>>;
  setInfoOffsets: Dispatch<SetStateAction<Record<string, Pos>>>;
  setOutputPos: Dispatch<SetStateAction<Pos | null>>;
  infoPos: { frame: Pos };
  portsOf(key: string): { ins: { id: string; label: string; accepts: string[] }[]; out?: { label: string; type: string } };
  boxOf(key: string): WireBox | null;
  outPointOf(key: string): Pos | null;
  inPointOf(key: string, portId?: string): Pos | null;
  nodeMetricsRef: RefObject<{ ports: Record<string, Record<string, Pos>> }>;
  sizeOfNode(key: string): { w: number; h: number } | null;
  addMenu: { detached?: { pendings: PendingLink[]; rows: ProjectNodeLink[] } } | null;
  setAddMenu: Dispatch<SetStateAction<AddMenuState | null>>;
  setAddMenuQuery(q: string): void;
  ownerKeyOfLink(link: ProjectNodeLink): string;
  displacePortLinks(
    segmentId: string, port: string,
    keep?: { rows?: Set<string>; pendings?: PendingLink[]; pendingFromKey?: string },
  ): void;
  nodeWireColorOf(key: string): string | null | undefined;
  setDetailFor(d: unknown): void;
  setScriptPickTarget(t: string): void;
  setScriptPickOpen(open: boolean): void;
  setPromptPickTarget(t: string): void;
  setPromptPickOpen(open: boolean): void;
  setEditingNoteId(id: string | null): void;
  setNoteDraft(text: string): void;
  onOpenAsset(asset: ProjectAsset): void;
  onPickForShot(shotId: string): void;
  scenes: ProjectScene[];
}

type ViewState = { x: number; y: number; scale: number };
interface GroupMember { key: string; x: number; y: number }
interface AddMenuState {
  sx: number; sy: number; wx: number; wy: number;
  wire?: { fromKey: string; fromDir: "out" | "in"; fromType?: string; fromAccepts?: string[]; fromPortId?: string };
  detached?: { pendings: PendingLink[]; rows: ProjectNodeLink[] };
}

export function useCanvasGestures(deps: GestureDeps) {
  const {
    vpRef, view, setView, saveView, layout, pos, setPos, segPos, outputBox,
    notes, setNotes, nodeSizes, setNodeSizes, infoGroups, infoNodes, infoNodePos,
    entityPhs, promptPhs, segments, segWires, nodeLinks, pendingLinks,
    persistPendingLinks, nodeGroups, memberFrame, groupSnapshot, selRef,
    setSegPos, setSelection, moveGroupTo, persistPositions, pushUndo, persistCards,
    saveCanvasLayout, saveInfoFramePos, saveOutputPos, setEpisodeOutput,
    episodeId, persistNotes, addNote, addEntityPh, addPromptPh, persistSegments,
    linkNode, unlinkNode, unlinkAssets, nodeKeyParts, addSegment,
    autoConnectNewNode, persistSizes, persistInfoOffsets, setInfoFramePos,
    setInfoOffsets, setOutputPos, infoPos, portsOf, boxOf, outPointOf, inPointOf,
    nodeMetricsRef, sizeOfNode, addMenu, setAddMenu, setAddMenuQuery,
    ownerKeyOfLink, displacePortLinks, nodeWireColorOf, setDetailFor,
    setScriptPickTarget, setScriptPickOpen, setPromptPickTarget,
    setPromptPickOpen, setEditingNoteId, setNoteDraft, onOpenAsset,
    onPickForShot, scenes,
  } = deps;

  // ── 场景框位置：scenes.canvas 之外再叠一层本地偏移（拖标签牌实时） ──
  const [scenePos, setScenePos] = useState<Record<string, Pos>>({});
  useEffect(() => {
    setScenePos((prev) => {
      const next: Record<string, Pos> = {};
      scenes.forEach((scene) => {
        next[scene.id] = prev[scene.id] ?? (
          scene.canvas_x != null && scene.canvas_y != null
            ? { x: scene.canvas_x, y: scene.canvas_y }
            : layout.framePos[scene.id] ?? { x: WORLD_MARGIN, y: 110 }
        );
      });
      return next;
    });
  }, [scenes, layout.framePos]);


  const dragRef = useRef<DragState | null>(null);
  // 拖动后 mouseup 落在卡内按钮（挂靠/缩略图）上会派发 click，需吞掉这次误触。
  const suppressClickRef = useRef(false);
  const [wireDraft, setWireDraft] = useState<{ d: string; invalid: boolean; color?: string } | null>(null);
  // 拖线悬停高亮的目标节点（ComfyUI 落点亮框），松手/取消时清除。
  const wireHoverRef = useRef<Element | null>(null);
  // 画布上唯一点亮的输入口（源口/落点共用的放大光圈）：拖线切换、
  // 摘线按下登记原口，松手/取消时清除。
  const wirePortHoverRef = useRef<HTMLElement | null>(null);
  // ComfyUI 摘线：点击已连线的输入口把线「摘下来拿着」——这个口上的
  // 全部线（暂存线 + 正式线）进入隐藏态（渲染层过滤），松手时整组转接 /
  // 交给添加菜单（建新节点即转接）/ 无效落点原样放回。行数据不预先删除，
  // 收尾才落库。摘一个口 = 拿走这个口上所有线，不留残留。

  const [liftedWire, setLiftedWire] = useState<LiftedWire | null>(null);
  const liftedRef = useRef<LiftedWire | null>(null);
  useEffect(() => {
    liftedRef.current = liftedWire;
  }, [liftedWire]);
  // 「摘线到空白」菜单的取消（Esc / 点空白）：「不建节点直接退出」＝
  // 摘下的线就此断开——正式线删连接行、暂存线从画布层移除，不放回
  // 原口（反悔走「拖回原口松手」手势）。
  const discardDetachedWire = useCallback(
    (detached: { pendings: PendingLink[]; rows: ProjectNodeLink[] }) => {
      detached.rows.forEach((row) => {
        void unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port, row.owner_key);
      });
      if (detached.pendings.length > 0) {
        persistPendingLinks(pendingLinks.filter((l) => !detached.pendings.includes(l)));
      }
      setLiftedWire(null);
    },
    [pendingLinks, persistPendingLinks, unlinkNode],
  );
  // Blender 式切线（Shift+右键滑动）：切痕与候选线缓存。切痕不经
  // React 状态——滑动中每帧直写 polyline 的 points，避免整画布逐帧
  // 重渲染（表现为视图跳帧）；显示/隐藏由 pc-cutting 类驱动。
  const cutTrailRef = useRef<SVGPolylineElement | null>(null);
  const cutTrailUnderRef = useRef<SVGPolylineElement | null>(null);
  const cutPointsRef = useRef<string[]>([]);
  const cutTargetsRef = useRef<{ pts: { x: number; y: number }[]; done: boolean; del: () => void }[] | null>(null);
  // 统一双击判定（见 onUp）：记录上一次「按下即松手」的落点与时刻。
  const dblRef = useRef<{ key: string; thumb: string | null; x: number; y: number; t: number } | null>(null);
  // 首次移动时捕获指针（见 onMove）：拖拽中松手在窗口外，mouseup 仍送达。
  const capturedRef = useRef(false);
  // 画布区域一律不弹浏览器右键菜单：Shift+右键是切线手势，滑动滑出画布
  // （扫到侧栏/顶栏）时弹出的系统菜单会打断手势——表现为闪烁加手势冻结。
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest(".pc-root")) e.preventDefault();
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, []);

  // 切线候选：所有可切连线（g[data-cut]）的屏幕坐标采样折线 + 删除分发。
  // 隐式聚合线（片段→成片）无 data-cut，不参与切线。
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
      const cutId = g.getAttribute("data-cut") ?? "";
      targets.push({
        pts,
        done: false,
        del: () => {
          if (cutId.startsWith("m:")) {
            // data-cut 里存的是容器 key（shot:<id>），解连要的是素材 id。
            const [fromKey, toKey] = cutId.slice(2).split("|");
            void unlinkAssets(fromKey.slice(fromKey.indexOf(":") + 1), toKey.slice(toKey.indexOf(":") + 1));
          } else if (cutId.startsWith("s:")) {
            const group = segWires.find((w) => w.links[0]?.id === cutId.slice(2));
            group?.links.forEach((l) => {
              void unlinkNode(l.from_kind, l.from_id, l.to_segment, l.to_port, l.owner_key);
            });
          } else if (cutId.startsWith("p:")) {
            const [fromKey, segId, port] = cutId.slice(2).split("|");
            persistPendingLinks(
              pendingLinks.filter((l) => !(l.fromKey === fromKey && l.toSegmentId === segId && l.toPort === port)),
            );
          } else if (cutId === "o") {
            void setEpisodeOutput(episodeId, null);
          }
        },
      });
    });
    return targets;
  }, [segWires, pendingLinks, unlinkAssets, unlinkNode, persistPendingLinks, setEpisodeOutput, episodeId]);

  const onViewportPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      // 节点搜索框是连线释放后的模态状态：点击外部只取消搜索框，
      // 摘线场景同时断开摘下的线，不能继续落入画布空白的框选分支。
      if (addMenu && !target?.closest(".pc-addmenu")) {
        // 点空白取消＝不建节点直接退出：摘下的线就此断开（见
        // discardDetachedWire），不放回原口。
        if (addMenu.detached) discardDetachedWire(addMenu.detached);
        setAddMenu(null);
        setAddMenuQuery("");
        e.preventDefault();
        return;
      }
      // 上一场拖拽若有残留（松手事件在窗外丢失等），开新拖拽前先复位：
      // 冻结的草稿线、拿着的摘线、切线态，避免「松手后线卡住」的残影。
      // 指针捕获标记一并复位——wirecut 的 buttons 自愈路径会清掉拖拽态
      // 却不经 onUp，捕获标记若残留会让下一场拖拽首次移动不再捕获指针。
      capturedRef.current = false;
      setWireDraft(null);
      setLiftedWire(null);
      if (dragRef.current) {
        dragRef.current = null;
        wireHoverRef.current?.classList.remove("pc-wire-target");
        wireHoverRef.current = null;
        // 唯一亮口（摘线原口/拖线落点）一并复位：ref 记账与口上光圈
        // 都清掉，下一场拖拽的切换逻辑才不会把残留口当成「当前亮口」。
        wirePortHoverRef.current?.classList.remove("pc-port-active");
        wirePortHoverRef.current = null;
        vpRef.current?.classList.remove("pc-cutting");
        cutTargetsRef.current = null;
        // 残留若是切线手势，切痕 polyline 也要一并清空——上面只复位了
        // 状态，轨迹点留在层上会以「白色划痕」形式常驻画布。
        cutPointsRef.current = [];
        cutTrailUnderRef.current?.setAttribute("points", "");
        cutTrailRef.current?.setAttribute("points", "");
      }
      // 便签卡：按下即拖动（编辑态与缩放手柄除外）；已在多选中时整组拖。
      const noteEl = target?.closest(".pc-note");
      if (noteEl && !target?.closest("textarea, button, .pc-resize")) {
        const noteId = noteEl.getAttribute("data-note") ?? "";
        const note = notes.find((item) => item.id === noteId);
        if (note) {
          const noteKey = `note:${noteId}`;
          const group = selRef.current.length > 1 && selRef.current.includes(noteKey) ? groupSnapshot() : null;
          setSelection(selRef.current.includes(noteKey) ? selRef.current : [noteKey]);
          noteEl.classList.add("pc-dragging");
          dragRef.current = group
            ? { kind: "multidrag", sx: e.clientX, sy: e.clientY, moved: false, members: group }
            : {
                kind: "note", sx: e.clientX, sy: e.clientY, moved: false,
                ox: note.x, oy: note.y, frameKey: noteId,
              };
          e.preventDefault();
          return;
        }
      }
      // 节点四角尺寸手柄（ComfyUI 式）：按下即改尺寸，不挪位置。
      const resizeEl = target?.closest(".pc-resize");
      if (resizeEl) {
        const nodeEl = resizeEl.closest(".pc-node, .pc-note") as HTMLElement | null;
        const isNote = !!nodeEl?.classList.contains("pc-note");
        const rawKey = nodeEl?.getAttribute(isNote ? "data-note" : "data-key") ?? "";
        const key = isNote ? `note:${rawKey}` : rawKey;
        const size = sizeOfNode(key);
        if (key && (size || isNote)) {
          const corner = (resizeEl.getAttribute("data-corner") ?? "se") as DragState["corner"];
          // 西/北角缩放会挪动节点，按下时记下原始位置。
          let px: number | undefined;
          let py: number | undefined;
          if (key.startsWith("segment:")) {
            const p = segPos[key.slice(8)];
            px = p?.x;
            py = p?.y;
          } else if (key.startsWith("shot:")) {
            const p = pos.cards[key.slice(5)];
            px = p?.x;
            py = p?.y;
          } else if (key.startsWith("note:")) {
            const note = notes.find((item) => item.id === key.slice(5));
            px = note?.x;
            py = note?.y;
          } else if (key === "output") {
            px = outputBox?.x;
            py = outputBox?.y;
          } else {
            const p = infoNodePos(key);
            px = p?.x;
            py = p?.y;
          }
          nodeEl?.classList.add("pc-resizing");
          dragRef.current = {
            kind: "resize", sx: e.clientX, sy: e.clientY, moved: false,
            // 首次拖拽从实际渲染尺寸起算（覆盖层只存改过的节点）；片段的
            // 存量语义是节点总高，其余以渲染实测兜底。
            ox: nodeSizes[key]?.w ?? nodeEl?.offsetWidth ?? size?.w ?? 0,
            oy: nodeSizes[key]?.h ?? nodeEl?.offsetHeight ?? size?.h ?? 0,
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
      // 只豁免悬停工具条与浮层玻璃卡；镜头卡头/缩略网格属于卡面，按下即拖卡。
      if (
        target?.closest(".pc-node-tools") ||
        target?.closest(".pc-glass") ||
        target?.closest(".pc-frame-ops")
      ) {
        return;
      }
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
      const port = target?.closest(".pc-port") as HTMLElement | null;
      if (port) {
        const nodeEl = port.closest(".pc-node");
        const key = nodeEl?.getAttribute("data-key") ?? "";
        const dir = port.dataset.port === "in" ? "in" : "out";
        const portId = port.dataset.portId ?? "";
        const ports = portsOf(key);
        const inPort = ports.ins.find((item) => item.id === portId);
        // ComfyUI 摘线：点击已连线的片段输入口 → 摘下那条线拿着（换源），
        // 而不是再拉一条新线。成片输入口是隐式聚合（无连线数据）不摘。
        if (dir === "in" && inPort && key.startsWith("segment:")) {
          const segId = key.slice(8);
          // 摘一个口 = 拿走这个口上的全部线：暂存线与正式线并存时都要
          // 拿，只摘其一会留下「摘了还连着」的残留。
          const pendings = pendingLinks.filter((l) => l.toSegmentId === segId && l.toPort === portId);
          const rows = nodeLinks.filter((l) => l.to_segment === segId && l.to_port === portId);
          if (pendings.length > 0 || rows.length > 0) {
            const fromKey = pendings.length > 0
              ? pendings[pendings.length - 1].fromKey
              : ownerKeyOfLink(rows[0]);
            setLiftedWire({ fromKey, pendings, rows });
            vp.classList.add("pc-wiring");
            port.classList.add("pc-port-active");
            // 原口登记为「当前亮口」：亮口唯一由 wirePortHoverRef 管理，
            // 拖走时悬停切换自然清它（原口与落点不同时亮），滑回原口
            // （放回落点）也能正常重新点亮——不登记的话切换逻辑不知道
            // 原口亮着，既清不掉（双口同亮）也亮不回（ref 与 DOM 脱节）。
            wirePortHoverRef.current = port;
            dragRef.current = {
              kind: "wire", sx: e.clientX, sy: e.clientY, moved: false, rewire: true,
              fromKey: key, targetKey: null, targetPort: null,
              fromDir: "in", fromAccepts: inPort.accepts, fromPortId: portId,
            };
            e.preventDefault();
            return;
          }
        }
        if (key && (dir === "out" ? ports.out : inPort)) {
          vp.classList.add("pc-wiring");
          // 源端口点亮：即使草稿线被渲染环境吞掉，按下即有可见状态。
          port.classList.add("pc-port-active");
          dragRef.current = {
            kind: "wire", sx: e.clientX, sy: e.clientY, fromKey: key, targetKey: null,
            targetPort: null, fromDir: dir,
            fromType: ports.out?.type, fromAccepts: inPort?.accepts,
            fromPortId: portId || undefined,
          };
          e.preventDefault();
          return;
        }
      }
      const nodeEl = target?.closest(".pc-node");
      if (nodeEl) {
        const key = nodeEl.getAttribute("data-key") ?? "";
        if (key === "output" && outputBox) {
          // 成片输出节点：卡体拖动只挪位置（localStorage 按集记忆）。
          // 按下即选中：配合选中点亮样式，「在操作哪个节点」一眼可见。
          const group = selRef.current.length > 1 && selRef.current.includes(key) ? groupSnapshot() : null;
          setSelection(selRef.current.includes(key) ? selRef.current : [key]);
          nodeEl.classList.add("pc-dragging");
          dragRef.current = group
            ? { kind: "multidrag", sx: e.clientX, sy: e.clientY, moved: false, members: group }
            : {
                kind: "outnode", sx: e.clientX, sy: e.clientY, moved: false,
                ox: outputBox.x, oy: outputBox.y,
              };
          e.preventDefault();
          return;
        }
        if (key.startsWith("segment:")) {
          // 片段卡：按下即拖动，松手持久化坐标；已在多选中时整组拖。
          const segId = key.slice(8);
          const p = segPos[segId];
          if (p) {
            const group = selRef.current.length > 1 && selRef.current.includes(key) ? groupSnapshot() : null;
            setSelection(selRef.current.includes(key) ? selRef.current : [key]);
            nodeEl.classList.add("pc-dragging");
            dragRef.current = group
              ? { kind: "multidrag", sx: e.clientX, sy: e.clientY, moved: false, members: group }
              : {
                  kind: "segment", sx: e.clientX, sy: e.clientY, moved: false,
                  ox: p.x, oy: p.y, frameKey: segId,
                };
            e.preventDefault();
            return;
          }
        }
        if (
          key.startsWith("char:") || key.startsWith("loc:") ||
          key.startsWith("prop:") || key === "script" || key.startsWith("script:") ||
          key.startsWith("eph:") || key.startsWith("prompt:") || key.startsWith("grp:")
        ) {
          // 资料节点（含组节点与空白资料占位）：按下即自由拖动（覆盖层
          // 按绝对位置记忆，资料框退化为背景分组框，节点不再被网格钉死）。
          // 按下即选中：配合选中点亮样式，「在操作哪个节点」一眼可见。
          const p = infoNodePos(key);
          const group = selRef.current.length > 1 && selRef.current.includes(key) ? groupSnapshot() : null;
          setSelection(selRef.current.includes(key) ? selRef.current : [key]);
          nodeEl.classList.add("pc-dragging");
          dragRef.current = group
            ? { kind: "multidrag", sx: e.clientX, sy: e.clientY, moved: false, members: group }
            : {
                kind: "infonode", sx: e.clientX, sy: e.clientY, moved: false,
                ox: p.x, oy: p.y, frameKey: key,
              };
          e.preventDefault();
          return;
        }
        if (key.startsWith("shot:")) {
          // 镜头卡：已在多选中时整组拖（跨类型混合选择同样成立）。
          const nextSel = selRef.current.includes(key) ? selRef.current : [key];
          const group = nextSel.length > 1 ? groupSnapshot() : null;
          setSelection(nextSel);
          nodeEl.classList.add("pc-dragging");
          dragRef.current = group
            ? { kind: "multidrag", sx: e.clientX, sy: e.clientY, moved: false, members: group }
            : {
                kind: "card", sx: e.clientX, sy: e.clientY, moved: false,
                moves: nextSel
                  .map((k) => {
                    const id = k.slice(5);
                    const p = pos.cards[id];
                    return p ? { key: id, x: p.x, y: p.y } : null;
                  })
                  .filter((item): item is { key: string; x: number; y: number } => item !== null),
              };
          e.preventDefault();
          return;
        }
      }
      // 组框标题（Ctrl+G 的组）：按下拖动整组移动（复用组拖管线）。
      const ngLabel = target?.closest(".pc-nodegroup-label");
      if (ngLabel) {
        const gid = ngLabel.closest(".pc-nodegroup")?.getAttribute("data-group") ?? "";
        const group = nodeGroups.find((g) => g.id === gid);
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
      const labelEl = target?.closest(".pc-frame-label");
      if (labelEl) {
        const frameEl = labelEl.closest(".pc-frame");
        const frameKey = frameEl?.getAttribute("data-frame") ?? "";
        if (frameKey === "info") {
          dragRef.current = {
            kind: "infoframe", sx: e.clientX, sy: e.clientY,
            fox: infoPos.frame.x, foy: infoPos.frame.y, moved: false,
          };
          e.preventDefault();
          return;
        }
        if (frameKey) {
          dragRef.current = {
            kind: "group", sx: e.clientX, sy: e.clientY, frameKey,
            fox: scenePos[frameKey]?.x ?? 0,
            foy: scenePos[frameKey]?.y ?? 0,
            starts: [], moved: false,
          };          dragRef.current.starts = layout.cards
            .filter((c) => c.sceneId === frameKey)
            .map((c) => ({ key: c.shot.id, x: pos.cards[c.shot.id]?.x ?? 0, y: pos.cards[c.shot.id]?.y ?? 0 }));
          e.preventDefault();
          return;
        }
      }
      // 左键空白：框选
      const mq = document.createElement("div");
      mq.className = "pc-marquee";
      vp.appendChild(mq);
      dragRef.current = { kind: "marquee", sx: e.clientX, sy: e.clientY, mq, moved: false };
      e.preventDefault();
    },
    [layout, pos, setSelection, view, infoPos, scenePos, portsOf, outputBox, notes, segPos, sizeOfNode, infoNodePos, nodeSizes, groupSnapshot, nodeGroups, memberFrame, addMenu, nodeLinks, pendingLinks, ownerKeyOfLink, buildCutTargets, setLiftedWire, discardDetachedWire],
  );


  // 资料节点 → 详情窗口（该类资源列表，当前/全部切换；剧本是单文件窗口）。
  // 双击节点与悬停工具条的「查看」按钮共用。剧本两段式：未挂文件的空
  // 节点双击直接打开文件选择（选完即挂，挂接目标记节点 key）。
  const openInfoDetail = useCallback((node: { kind: string; key: string; textPath?: string }) => {
    if (node.kind === "character") {
      setDetailFor({ kind: "info", group: "character", sourceKey: node.key, scope: "current" });
    } else if (node.kind === "location") {
      setDetailFor({ kind: "info", group: "location", sourceKey: node.key, scope: "current" });
    } else if (node.kind === "prop") {
      setDetailFor({ kind: "info", group: "prop", sourceKey: node.key, scope: "current" });
    } else if (node.kind === "script") {
      if (!node.textPath) {
        setScriptPickTarget(node.key);
        setScriptPickOpen(true);
      } else {
        setDetailFor(node.key === "script" ? { kind: "script" } : { kind: "script", phId: node.key.slice(7) });
      }
    }
  }, []);

  // 画布全部节点统一「双击打开」（mouseup 判定，见 onUp）：镜头卡=挂靠
  // 面板、剧本空纸片=文件选择、其余=详情窗口；片段/镜头缩略图上的双击
  // =打开素材详情（缩略图优先于卡体语义）。
  const openNodeDetail = useCallback(
    (key: string, thumbAssetId: string | null) => {
      if (key.startsWith("shot:")) {
        if (thumbAssetId) {
          const card = layout.cards.find((c) => c.key === key);
          const asset = card?.assets.find((a) => a.asset.id === thumbAssetId)?.asset;
          if (asset) {
            onOpenAsset(asset);
            return;
          }
        }
        onPickForShot(key.slice(5));
        return;
      }
      if (key.startsWith("segment:")) {
        if (thumbAssetId) {
          const segment = segments.find((s) => `segment:${s.id}` === key);
          if (segment?.asset) {
            onOpenAsset(segment.asset);
            return;
          }
        }
        setDetailFor({ kind: "segment", id: key.slice(8), scopes: { chars: "current", locs: "current", props: "current" } });
        return;
      }
      if (key.startsWith("eph:")) {
        setDetailFor({ kind: "entityPh", id: key.slice(4) });
        return;
      }
      if (key.startsWith("prompt:")) {
        const ph = promptPhs.find((item) => `prompt:${item.id}` === key);
        if (!ph) return;
        if (!ph.promptId) {
          // 空纸片：双击从提示词库选一条。
          setPromptPickTarget(key);
          setPromptPickOpen(true);
        } else {
          setDetailFor({ kind: "promptPh", id: ph.id });
        }
        return;
      }
      if (key.startsWith("note:")) {
        const note = notes.find((item) => `note:${item.id}` === key);
        if (note) {
          setEditingNoteId(note.id);
          setNoteDraft(note.text);
        }
        return;
      }
      if (key === "output") return;
      const node = infoNodes.find((item) => item.key === key);
      if (node) openInfoDetail(node);
    },
    [layout, segments, notes, infoNodes, promptPhs, onOpenAsset, onPickForShot, openInfoDetail],
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
        setView((prev) => ({ ...prev, x: (drag.ox ?? 0) + dx, y: (drag.oy ?? 0) + dy }));
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
      } else if (drag.kind === "group") {
        if (!drag.moved) return;
        setScenePos((prev) => {
          const fk = drag.frameKey ?? "";
          const base = { x: (drag.fox ?? 0) + dx / view.scale, y: (drag.foy ?? 0) + dy / view.scale };
          const prevPos = prev[fk] ?? { x: 0, y: 0 };
          void prevPos;
          return { ...prev, [fk]: base };
        });
        setPos((prev) => {
          const cards = { ...prev.cards };
          drag.starts?.forEach((start) => {
            cards[start.key] = {
              x: start.x + dx / view.scale,
              y: start.y + dy / view.scale,
            };
          });
          return { ...prev, cards };
        });
      } else if (drag.kind === "multidrag") {
        // 多选组拖：整组成员按同一位移移动（各类型切片批量写入）。
        if (!drag.moved || !drag.members?.length) return;
        moveGroupTo(drag.members.map((m) => ({ key: m.key, x: m.x + dx / view.scale, y: m.y + dy / view.scale })));
      } else if (drag.kind === "infoframe") {
        if (!drag.moved) return;
        setInfoFramePos({
          x: (drag.fox ?? 0) + dx / view.scale,
          y: (drag.foy ?? 0) + dy / view.scale,
        });
      } else if (drag.kind === "outnode") {
        if (!drag.moved) return;
        setOutputPos({
          x: (drag.ox ?? 0) + dx / view.scale,
          y: (drag.oy ?? 0) + dy / view.scale,
        });
      } else if (drag.kind === "segment") {
        if (!drag.moved) return;
        const segId = drag.frameKey ?? "";
        setSegPos((prev) => ({
          ...prev,
          [segId]: { x: (drag.ox ?? 0) + dx / view.scale, y: (drag.oy ?? 0) + dy / view.scale },
        }));
      } else if (drag.kind === "note") {
        if (!drag.moved) return;
        setNotes((prev) =>
          prev.map((item) =>
            item.id === drag.frameKey
              ? { ...item, x: (drag.ox ?? 0) + dx / view.scale, y: (drag.oy ?? 0) + dy / view.scale }
              : item,
          ),
        );
      } else if (drag.kind === "resize") {
        // 四角自由缩放：对角固定，实时预览；西/北角缩放联动挪动位置，
        // 松手才持久化尺寸与位置。
        const key = drag.frameKey ?? "";
        const corner = drag.corner ?? "se";
        const dxW = dx / view.scale;
        const dyW = dy / view.scale;
        const minW = key.startsWith("segment:") ? 180 : key.startsWith("note:") ? 120 : 140;
        const minH = key === "output" ? 60 : key.startsWith("note:") ? 80 : 90;
        let w = drag.ox ?? 0;
        let h = drag.oy ?? 0;
        if (corner === "ne" || corner === "se") w = Math.max(minW, w + dxW);
        if (corner === "sw" || corner === "se") h = Math.max(minH, h + dyW);
        if (corner === "nw" || corner === "sw") w = Math.max(minW, w - dxW);
        if (corner === "nw" || corner === "ne") h = Math.max(minH, h - dyW);
        setNodeSizes((prev) => ({ ...prev, [key]: { w: Math.round(w), h: Math.round(h) } }));
        const shiftX = corner === "nw" || corner === "sw";
        const shiftY = corner === "nw" || corner === "ne";
        if ((shiftX || shiftY) && drag.px != null && drag.py != null) {
          // 每步都从按下时的初始位置绝对推导（对角固定 ⇒ 平移量 = 原尺寸
          // − 新尺寸）；不能用回写的 drag.px 叠加，否则逐复合漂移。
          const px = Math.round((drag.px0 ?? 0) + (shiftX ? (drag.ox ?? 0) - w : 0));
          const py = Math.round((drag.py0 ?? 0) + (shiftY ? (drag.oy ?? 0) - h : 0));
          // 回写进 drag 对象：mouseup 闭包可能拿不到最新 state，用它兜底。
          drag.px = px;
          drag.py = py;
          if (key.startsWith("segment:")) {
            const segId = key.slice(8);
            setSegPos((prev) => ({ ...prev, [segId]: { x: px, y: py } }));
          } else if (key.startsWith("shot:")) {
            const shotId = key.slice(5);
            setPos((prev) => ({ ...prev, cards: { ...prev.cards, [shotId]: { x: px, y: py } } }));
          } else if (key.startsWith("note:")) {
            const noteId = key.slice(5);
            setNotes((prev) => prev.map((item) => (item.id === noteId ? { ...item, x: px, y: py } : item)));
          } else if (key === "output") {
            setOutputPos({ x: px, y: py });
          } else {
            setInfoOffsets((prev) => ({ ...prev, [key]: { x: px, y: py } }));
          }
        }
      } else if (drag.kind === "infonode") {
        if (!drag.moved) return;
        const key = drag.frameKey ?? "";
        setInfoOffsets((prev) => ({
          ...prev,
          [key]: { x: (drag.ox ?? 0) + dx / view.scale, y: (drag.oy ?? 0) + dy / view.scale },
        }));
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
          for (const t of targets) {
            if (t.done) continue;
            if (segHitsPolyline(from, to, t.pts)) {
              t.done = true;
              t.del();
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
        const lifted = drag.rewire ? liftedRef.current : null;
        const startPoint = lifted
          ? outPointOf(lifted.fromKey)
          : drag.fromDir === "in"
            ? inPointOf(drag.fromKey, drag.fromPortId)
            : outPointOf(drag.fromKey);
        if (!startPoint) return;
        const cursor = { x: wx, y: wy };
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const tEl = hit instanceof Element ? hit.closest(".pc-node") : null;
        const tKey = tEl?.getAttribute("data-key") ?? null;
        // 可写连接模型：兼容性判断与松手后的落库动作一一对应，杜绝
        // "看起来能连、松手却写不进"的死线。镜头卡的产出可进片段口与
        // 成片；片段→成片是按拼接序的隐式聚合。
        const outKeyOf = drag.fromDir === "in" ? tKey : drag.fromKey;
        const inKeyOf = drag.fromDir === "in" ? drag.fromKey : tKey;
        const writable =
          !!outKeyOf && !!inKeyOf &&
          ((inKeyOf === "output" &&
            (outKeyOf.startsWith("shot:") || outKeyOf.startsWith("segment:"))) ||
            (inKeyOf.startsWith("segment:") &&
              (outKeyOf === "script" ||
                outKeyOf.startsWith("script:") ||
                outKeyOf.startsWith("prompt:") ||
                ["shot:", "char:", "loc:", "prop:", "grp:", "segment:", "eph:"].some((p) => outKeyOf.startsWith(p)))));
        let compatible = false;
        let targetPort: string | null = null;
        if (tKey && writable) {
          const ports = portsOf(tKey);
          if (drag.fromDir === "in") {
            if (drag.rewire && tKey.startsWith("segment:")) {
              // 摘线换接口（同片段换口与跨片段换目标同一手势）：拖着被摘
              // 的线到任何片段的某个输入口上松手＝线整个改接到那个口。
              // 目标口只认光标悬停的那个输入口（用户指哪接哪）；跨片段
              // 不在口上时回退同名口（片段家族同名口语义一致）。拖回原
              // 口＝放回；同片段悬停非口位置＝放回（同名口即原口）。
              // 口须兼容被摘线的来源类型（与新连线同款校验）：剧本/提示
              // 词线落不进角色/场景/道具口，悬停在不可接的口＝放回。
              const isSameNode = tKey === drag.fromKey;
              const hoverPortId =
                hit instanceof Element
                  ? hit.closest('.pc-port[data-port="in"]')?.getAttribute("data-port-id") ?? null
                  : null;
              const ins = ports.ins;
              const fromType = lifted ? portsOf(lifted.fromKey).out?.type : undefined;
              const typeOk = (id: string | null) =>
                !id || !fromType || !!ins.find((item) => item.id === id)?.accepts.includes(fromType);
              const hovered = typeOk(hoverPortId) ? hoverPortId : null;
              const sameName =
                !isSameNode &&
                drag.fromPortId &&
                typeOk(drag.fromPortId)
                  ? drag.fromPortId
                  : null;
              targetPort = hovered ?? sameName;
              compatible = !!targetPort && (!isSameNode || targetPort !== drag.fromPortId);
            } else if (tKey !== drag.fromKey) {
              compatible = !!ports.out && !!drag.fromAccepts?.includes(ports.out.type);
            }
          } else if (drag.fromType && tKey !== drag.fromKey) {
            // 吸附优先级：光标就近的可接输入口（ComfyUI 落点即所接口），
            // 不就近时回退为第一个可接口。口距用实测行位（nodeMetrics），
            // 没量到才退回按口数均分的估算——估算会让光标下的口输给邻口。
            let best: { id: string } | undefined;
            let bestDist = Infinity;
            const box = boxOf(tKey);
            const metrics = nodeMetricsRef.current.ports[tKey];
            ports.ins.forEach((item, index) => {
              if (!item.accepts.includes(drag.fromType!)) return;
              const off = metrics?.[item.id];
              const dist = box
                ? Math.abs((off ? box.y + off.y : box.y + box.h * portRatio(index, ports.ins.length)) - wy)
                : 0;
              if (!best || dist <= bestDist) {
                best = item;
                bestDist = dist;
              }
            });
            compatible = !!best;
            targetPort = best?.id ?? null;
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
        // 悬停口点亮：线要落去的那个输入口与源口同款放大光圈（亮＝接
        // 得上），摘线换口与连线吸附的落点一眼可见；不可接的口不亮。
        // 摘线的原口在 pointerdown 时已登记为本 ref 的「当前亮口」：
        // 拖走即被这里的切换清掉（双口不再同亮），滑回原口（放回）亮回。
        const portEl =
          compatible && tEl && targetPort
            ? tEl.querySelector<HTMLElement>(
                `.pc-port[data-port="in"][data-port-id="${targetPort}"]`,
              )
            : null;
        // 拖回被摘的原口＝放回，也是合法落点（松手线落回这），同款点亮。
        // 命中区放宽到原口整行（圆点 + 标签是兄弟元素，closest 沿祖先链
        // 找不到圆点，光标停在标签上也该算「指着这个口」）；同片段悬停
        // 别的口＝不可接，行的 querySelector 找不到原口，保持全灭。
        const rewireBackEl =
          !portEl && drag.rewire && tKey === drag.fromKey && hit instanceof Element
            ? hit.closest<HTMLElement>(".pc-port-row")?.querySelector<HTMLElement>(
              `.pc-port[data-port="in"][data-port-id="${drag.fromPortId ?? ""}"]`,
            ) ?? null
            : null;
        const hoverPortEl = portEl ?? rewireBackEl;
        if (wirePortHoverRef.current !== hoverPortEl) {
          wirePortHoverRef.current?.classList.remove("pc-port-active");
          hoverPortEl?.classList.add("pc-port-active");
          wirePortHoverRef.current = hoverPortEl;
        }
        // 草稿终点：正拖命中片段时吸附到匹配输入口的位置。
        const endPoint =
          compatible && drag.fromDir === "out" && tKey
            ? inPointOf(tKey, targetPort ?? undefined) ?? cursor
            : cursor;
        setWireDraft({
          // 摘线拿着：从源头画到手里（方向与正常连线一致）；普通拖线
          // 保持原方向（输入口拖=手里→口，输出口拖=口→手里）。
          d: lifted
            ? wirePathD(startPoint, cursor)
            : drag.fromDir === "in"
              ? wirePathD(cursor, startPoint)
              : wirePathD(startPoint, endPoint),
          invalid: drag.invalid,
          color: lifted
            ? nodeWireColorOf(lifted.fromKey) ?? WIRE_TYPE_COLORS[portsOf(lifted.fromKey).out?.type ?? ""] ?? undefined
            : nodeWireColorOf(drag.fromKey) ?? (drag.fromType ? WIRE_TYPE_COLORS[drag.fromType] : undefined),
        });
      } else if (drag.kind === "card") {
        setPos((prev) => {
          const cards = { ...prev.cards };
          drag.moves?.forEach((mv) => {
            cards[mv.key] = { x: mv.x + dx / view.scale, y: mv.y + dy / view.scale };
          });
          return { ...prev, cards };
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
        // 悬停目标当作有效落点提交；摘线与菜单建节点都恢复原连接。
        if (drag.kind === "wire" || drag.detached) {
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
      // 统一双击判定：两次「按下即松手」（未拖动）在 450ms 内落在同一
      // 目标（≤16px）上才算双击。不用原生 dblclick——它把拖拽轻抖的
      // 松手也计成第二次点击，是「单击/拖完莫名弹窗」的根源。
      const dblCountable = drag.kind === "marquee" ||
        ["card", "segment", "outnode", "note", "infonode", "multidrag"].includes(drag.kind);
      if (dblCountable && !drag.moved) {
        const hitEl = document.elementFromPoint(e.clientX, e.clientY);
        const hit = hitEl instanceof Element ? hitEl : null;
        if (hit?.closest(".pc-checkbar, textarea, input, button") &&
            !hit?.closest(".pc-seg-thumb, .pc-shot-asset-thumb")) {
          // 控件上的两次点击是控件自己的事（如双击提醒条按钮），不算空白
          // 双击；节点缩略图（也是 button）除外——缩略图双击=开素材详情。
          dblRef.current = null;
        } else {
          const nodeEl = hit?.closest(".pc-node, .pc-note") ?? null;
          const noteId = nodeEl?.getAttribute("data-note") ?? null;
          const key = nodeEl?.getAttribute("data-key") ?? (noteId ? `note:${noteId}` : "");
          const thumb = hit?.closest(".pc-seg-thumb, .pc-shot-asset-thumb");
          const thumbAsset = thumb?.getAttribute("data-asset") ?? null;
          const now = performance.now();
          const prev = dblRef.current;
          dblRef.current = { key, thumb: thumbAsset, x: e.clientX, y: e.clientY, t: now };
          if (prev && prev.key === key && now - prev.t < 500 &&
              Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 16) {
            dblRef.current = null;
            if (!key) {
              // 双击空白 → 节点选择框（ComfyUI 式）。
              const rect = vpRef.current?.getBoundingClientRect();
              if (rect) {
                setAddMenu({
                  sx: e.clientX - rect.left,
                  sy: e.clientY - rect.top,
                  wx: (e.clientX - rect.left - view.x) / view.scale,
                  wy: (e.clientY - rect.top - view.y) / view.scale,
                });
                setAddMenuQuery("");
              }
            } else {
              openNodeDetail(key, thumbAsset);
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
          ? hitEl.closest(".pc-node, .pc-note, .pc-glass, .pc-checkbar")
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
          // ComfyUI 摘线收尾：换目标（拖到另一片段的口上）/ 换源转接 /
          // 空白交给菜单（建节点即转接）/ 其余一律放回（行数据未删，
          // 清掉 lifted 即恢复原线）。
          const lifted = liftedRef.current;
          const rewireToSegment =
            wireRelease === "commit" &&
            !!targetKey &&
            targetKey.startsWith("segment:") &&
            !!drag.targetPort;
          if (rewireToSegment && lifted) {
            // 换目标：口上全部线（暂存线 + 正式线）整组改接到新片段的
            // 目标口（onMove 定好的悬停口或同名口），原口不留残留。
            // 落点是资料口时先顶掉口上别的来源的线（自己拿走的行除外
            // ——它们正要转移落上）。
            setLiftedWire(null);
            const segId = targetKey.slice(8);
            const port = drag.targetPort as ProjectNodeLink["to_port"];
            displacePortLinks(segId, port, {
              rows: new Set(lifted.rows.map((r) => r.id)),
              pendings: lifted.pendings,
            });
            if (lifted.pendings.length) {
              persistPendingLinks([
                ...pendingLinks.filter((l) => !lifted.pendings.includes(l)),
                ...lifted.pendings.map((p) => ({ fromKey: p.fromKey, toSegmentId: segId, toPort: port })),
              ]);
            }
            if (lifted.rows.length) {
              lifted.rows.forEach((row) => {
                void unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port, row.owner_key);
              });
              lifted.rows.forEach((row) => {
                void linkNode(episodeId, row.from_kind, row.from_id, segId, port, row.owner_key);
              });
            }
          } else if (wireRelease === "commit" && targetKey && lifted) {
            setLiftedWire(null);
            const source = nodeKeyParts(targetKey);
            const targetGroup = targetKey.startsWith("grp:")
              ? infoGroups.find((group) => `grp:${group.id}` === targetKey)
              : null;
            const targetSources = targetGroup
              ? targetGroup.members.map((id) => ({ kind: targetGroup.kind, id }))
              : source
                ? [source]
                : [];
            // 换源：口上全部线（暂存线 + 正式线）一并转到新源；落点就是
            // 原源之一时视为放回，不动。
            const pendSameAsOld = lifted.pendings.length > 0 &&
              lifted.pendings.every((p) => targetKey === p.fromKey);
            const rowSameAsOld = lifted.rows.length > 0 &&
              lifted.rows.every((r) => ownerKeyOfLink(r) === targetKey);
            if (targetSources.length > 0 && !pendSameAsOld && !rowSameAsOld) {
              if (lifted.pendings.length) {
                persistPendingLinks(pendingLinks.filter((l) => !lifted.pendings.includes(l)));
                lifted.pendings.forEach((p) => {
                  targetSources.forEach((nextSource) => {
                    void linkNode(
                      episodeId, nextSource.kind, nextSource.id,
                      p.toSegmentId, p.toPort as ProjectNodeLink["to_port"],
                    );
                  });
                });
              }
              // 换源后的线归属 = 落点节点（组落点带组 owner；单实体落点
              // owner 空串），与组拖线落口同一套记账。
              const nextOwner = targetGroup ? targetKey : "";
              lifted.rows.forEach((row) => {
                void unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port, row.owner_key);
                targetSources.forEach((nextSource) => {
                  void linkNode(episodeId, nextSource.kind, nextSource.id, row.to_segment, row.to_port, nextOwner);
                });
              });
            } else if (!source && !targetGroup && !pendSameAsOld && targetKey !== "output") {
              // 无库身份目标（空白资料占位/提示词纸片）：落不了正式 node_link，
              // 但暂存线是画布层状态、fromKey 任意——整组改插到新目标；
              // 正式线保持原样（lifted 已清，渲染自动恢复）。成片（output）
              // 同为无库身份但没有输出口可作线的来源，改插会让渲染锚点
              // 消失——不转接，随上面的放回分支恢复原线。
              if (lifted.pendings.length) {
                persistPendingLinks([
                  ...pendingLinks.filter((l) => !lifted.pendings.includes(l)),
                  ...lifted.pendings.map((p) => ({ fromKey: targetKey, toSegmentId: p.toSegmentId, toPort: p.toPort })),
                ]);
              }
            }
          } else if (wireRelease === "picker" && lifted) {
            // 松手在画布内才谈「空白弹菜单」；出界（窗外松手）一律放回。
            if (vpRect) {
              setAddMenu({
                sx: e.clientX - vpRect.left,
                sy: e.clientY - vpRect.top,
                wx: (e.clientX - vpRect.left - view.x) / view.scale,
                wy: (e.clientY - vpRect.top - view.y) / view.scale,
                wire: {
                  fromKey: drag.fromKey ?? "",
                  fromDir: "in",
                  fromAccepts: drag.fromAccepts,
                  fromPortId: drag.fromPortId,
                },
                detached: { pendings: lifted.pendings, rows: lifted.rows },
              });
              setAddMenuQuery("");
            } else {
              setLiftedWire(null);
            }
          } else {
            setLiftedWire(null);
          }
        } else if (wireRelease === "commit" && drag.targetKey && drag.fromKey) {
          // 反拖（从输入口出发）时落点才是数据的来源方；落到成片节点
          // （key "output"）即设置本集总输出；落到片段的某个输入口则写
          // 一条 node_link（角色/场景/道具/剧本/素材/镜头/片段 → 片段）。
          const [outKey, inKey] = drag.fromDir === "in" ? [drag.targetKey, drag.fromKey] : [drag.fromKey, drag.targetKey];
          if (inKey === "output") {
            // 片段按拼接序隐式汇入成片（无库表可写）；镜头卡才落总输出。
            if (!outKey.startsWith("segment:")) {
              void setEpisodeOutput(episodeId, outKey);
            }
          } else if (inKey.startsWith("segment:")) {
            const segId = inKey.slice(8);
            if (outKey.startsWith("eph:") || outKey.startsWith("prompt:") || outKey.startsWith("script:")) {
              // 未加载的空白占位/提示词纸片/剧本纸片：暂存线记在画布层。
              // 空白占位加载实体后转正为 node_link（promotePendingLinks）；
              // 提示词/剧本纸片不转正（画布层即最终形态）。
              const port = drag.fromDir === "in" ? drag.fromPortId : drag.targetPort;
              // 占位落到资料口＝新来源占口：顶掉既有线，保留自己已有的
              // 暂存线（重复拖同占位到同口是幂等改写）。
              if (port) displacePortLinks(segId, port, { pendingFromKey: outKey });
              if (port) {
                persistPendingLinks([
                  ...pendingLinks.filter((l) => !(l.fromKey === outKey && l.toSegmentId === segId && l.toPort === port)),
                  { fromKey: outKey, toSegmentId: segId, toPort: port },
                ]);
              }
            } else if (outKey.startsWith("grp:")) {
              // 组节点一条线 = 组内全部成员分别落一条 node_link（owner 记
              // 组身份）；且无论拖到哪个口，都按组类型进对应口。资料口
              // 顶掉既有来源（组线整条断开，新组顶上）。
              const group = infoGroups.find((g) => `grp:${g.id}` === outKey);
              if (group) {
                displacePortLinks(segId, group.kind);
                group.members.forEach((memberId) => {
                  void linkNode(episodeId, group.kind, memberId, segId, group.kind, outKey);
                });
              }
            } else {
              const source = nodeKeyParts(outKey);
              const port = drag.fromDir === "in" ? drag.fromPortId : drag.targetPort;
              if (source && port) {
                // 单实体落资料口＝新来源占口：顶掉既有线再落。
                displacePortLinks(segId, port);
                void linkNode(
                  episodeId,
                  source.kind,
                  source.id,
                  segId,
                  port as ProjectNodeLink["to_port"],
                );
              }
            }
          }
        } else if (wireRelease === "picker" && drag.fromKey) {
          // ComfyUI 惯例：拖到空白松手 → 弹节点选择框，创建的节点自动
          // 接上这条线；落在任何节点/浮层上松手视为取消，不弹。
          if (vpRect) {
            setAddMenu({
              sx: e.clientX - vpRect.left,
              sy: e.clientY - vpRect.top,
              wx: (e.clientX - vpRect.left - view.x) / view.scale,
              wy: (e.clientY - vpRect.top - view.y) / view.scale,
              wire: {
                fromKey: drag.fromKey,
                fromDir: drag.fromDir ?? "out",
                fromType: drag.fromType,
                fromAccepts: drag.fromAccepts,
                fromPortId: drag.fromPortId,
              },
            });
            setAddMenuQuery("");
          }
        }
      } else if (drag.kind === "outnode") {
        if (drag.moved) {
          saveOutputPos({
            x: (drag.ox ?? 0) + (e.clientX - drag.sx) / view.scale,
            y: (drag.oy ?? 0) + (e.clientY - drag.sy) / view.scale,
          });
          pushUndo({ type: "move", entries: [{ key: "output", x: drag.ox ?? 0, y: drag.oy ?? 0 }] });
        }
      } else if (drag.kind === "segment") {
        if (drag.moved) {
          const segId = drag.frameKey ?? "";
          setSegPos((prev) => {
            const next = {
              ...prev,
              [segId]: {
                x: (drag.ox ?? 0) + (e.clientX - drag.sx) / view.scale,
                y: (drag.oy ?? 0) + (e.clientY - drag.sy) / view.scale,
              },
            };
            persistSegments(next);
            return next;
          });
          pushUndo({
            type: "move",
            entries: [{ key: `segment:${segId}`, x: drag.ox ?? 0, y: drag.oy ?? 0 }],
          });
        }
      } else if (drag.kind === "resize") {
        // 改尺寸松手：尺寸已在移动中按角实时算好，这里落盘；西/北角
        // 缩放挪过的位置一并持久化。
        const key = drag.frameKey ?? "";
        if (drag.moved && key) {
          setNodeSizes((prev) => {
            if (prev[key]) persistSizes(prev);
            return prev;
          });
          pushUndo({
            type: "resize",
            key,
            size: { w: drag.ox ?? 0, h: drag.oy ?? 0 },
            pos: drag.px0 != null && drag.py0 != null ? { x: drag.px0, y: drag.py0 } : undefined,
          });
          const corner = drag.corner ?? "se";
          if (corner !== "se") {
            // mouseup 闭包里的 pos/segPos/notes 可能落后于拖拽中的
            // 实时更新，用 drag 对象上的最终坐标覆盖后再落盘。
            const finalX = drag.px;
            const finalY = drag.py;
            const moved2 = finalX != null && finalY != null ? { x: finalX, y: finalY } : null;
            if (key.startsWith("segment:")) {
              const segId = key.slice(8);
              const p = segPos[segId];
              persistSegments({ ...segPos, [segId]: moved2 ?? p });
            } else if (key.startsWith("shot:")) {
              const shotId = key.slice(5);
              const p = pos.cards[shotId];
              if (moved2) persistCards({ ...pos.cards, [shotId]: moved2 });
              else if (p) persistCards(pos.cards);
            } else if (key.startsWith("note:")) {
              const noteId = key.slice(5);
              persistNotes(
                notes.map((item) => (item.id === noteId && moved2 ? { ...item, ...moved2 } : item)),
              );
            } else if (key === "output") {
              if (moved2) saveOutputPos(moved2);
            } else if (moved2) {
              // 资料节点/空白资料占位：位置覆盖层持久化。
              setInfoOffsets((prev) => {
                const next = { ...prev, [key]: moved2 };
                persistInfoOffsets(next);
                return next;
              });
            }
          }
        }
      } else if (drag.kind === "infonode") {
        if (drag.moved) {
          const key = drag.frameKey ?? "";
          setInfoOffsets((prev) => {
            const next = {
              ...prev,
              [key]: {
                x: (drag.ox ?? 0) + (e.clientX - drag.sx) / view.scale,
                y: (drag.oy ?? 0) + (e.clientY - drag.sy) / view.scale,
              },
            };
            persistInfoOffsets(next);
            return next;
          });
          pushUndo({ type: "move", entries: [{ key, x: drag.ox ?? 0, y: drag.oy ?? 0 }] });
        }
      } else if (drag.kind === "note") {
        if (drag.moved) {
          persistNotes(
            notes.map((item) =>
              item.id === drag.frameKey
                ? {
                    ...item,
                    x: (drag.ox ?? 0) + (e.clientX - drag.sx) / view.scale,
                    y: (drag.oy ?? 0) + (e.clientY - drag.sy) / view.scale,
                  }
                : item,
            ),
          );
          pushUndo({
            type: "move",
            entries: [{ key: `note:${drag.frameKey}`, x: drag.ox ?? 0, y: drag.oy ?? 0 }],
          });
        }
      } else if (drag.kind === "multidrag") {
        // 组拖松手：按总位移算出整组最终位置，一次落盘并记入撤销栈。
        if (drag.moved && drag.members?.length) {
          const dxW = (e.clientX - drag.sx) / view.scale;
          const dyW = (e.clientY - drag.sy) / view.scale;
          const finalMembers = drag.members.map((m) => ({ key: m.key, x: m.x + dxW, y: m.y + dyW }));
          moveGroupTo(finalMembers);
          persistPositions(finalMembers);
          pushUndo({ type: "move", entries: drag.members.map((m) => ({ key: m.key, x: m.x, y: m.y })) });
        }
      } else if (drag.kind === "addnode") {
        // 点击（未拖动）落双击点；按住拖到画布松手落松手点；从「拖线
        // 到空白」菜单进入时（drag.wire），创建的节点自动接上那条线。
        const rect = vpRef.current?.getBoundingClientRect();
        const dropPos = drag.moved && rect
          ? {
              x: (e.clientX - rect.left - view.x) / view.scale,
              y: (e.clientY - rect.top - view.y) / view.scale,
            }
          : { x: drag.fox ?? 0, y: drag.foy ?? 0 };
        // 摘线到空白后建节点的收尾：新节点接回原口（pending 转接或正式
        // 行换源），并删除被摘的旧行；便签（无口）等放回。
        const finishDetached = (newKey: string | null) => {
          const d = drag.detached;
          if (!d) return;
          setLiftedWire(null);
          if (!newKey) return;
          // 摘线语义优先「换目标」：线从某片段输入口摘下、新节点又有同名
          // 输入口（片段家族）时，这个口上的全部线（暂存线 + 正式线）改插
          // 到新节点的同端口——「整条线交给新节点」，原口不留残留。这是
          // 摘线+空白建节点最符合直觉的落点：用户拿着的是「通往片段 #1 的
          // 线」，要的是接去新片段。
          const newIns = portsOf(newKey).ins;
          const movedPorts = [...new Set([
            ...d.pendings.map((p) => p.toPort),
            ...d.rows.map((r) => r.to_port),
          ])];
          if (movedPorts.length > 0 && movedPorts.every((p) => newIns.some((item) => item.id === p))) {
            const segId = newKey.slice(8);
            if (d.pendings.length) {
              persistPendingLinks([
                ...pendingLinks.filter((l) => !d.pendings.includes(l)),
                ...d.pendings.map((p) => ({ fromKey: p.fromKey, toSegmentId: segId, toPort: p.toPort })),
              ]);
            }
            if (d.rows.length) {
              d.rows.forEach((row) => {
                void unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port, row.owner_key);
              });
              d.rows.forEach((row) => {
                void linkNode(episodeId, row.from_kind, row.from_id, segId, row.to_port as ProjectNodeLink["to_port"], row.owner_key);
              });
            }
            return;
          }
          // 退回「换源头」：占位新源没有库身份，线换新源原样转接；实体新
          // 源按原口兼容性落正式线；不兼容保留原线不动（不写入即保留）。
          const parts = nodeKeyParts(newKey);
          if (d.pendings.length) {
            const p0 = d.pendings[0];
            const targetPort = portsOf(`segment:${p0.toSegmentId}`).ins.find(
              (item) => item.id === p0.toPort,
            );
            const outType = portsOf(newKey).out?.type;
            if (!parts) {
              persistPendingLinks([
                ...pendingLinks.filter((l) => !d.pendings.includes(l)),
                ...d.pendings.map((p) => ({ fromKey: newKey, toSegmentId: p.toSegmentId, toPort: p.toPort })),
              ]);
            } else if (targetPort && outType && targetPort.accepts.includes(outType)) {
              persistPendingLinks(pendingLinks.filter((l) => !d.pendings.includes(l)));
              d.pendings.forEach((p) => {
                void linkNode(
                  episodeId, parts.kind, parts.id,
                  p.toSegmentId, p.toPort as ProjectNodeLink["to_port"],
                );
              });
            }
          }
          if (d.rows.length) {
            d.rows.forEach((row) => {
              void unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port, row.owner_key);
            });
            if (parts) {
              d.rows.forEach((row) => {
                void linkNode(episodeId, parts.kind, parts.id, row.to_segment, row.to_port);
              });
            } else {
              const r0 = d.rows[0];
              persistPendingLinks([
                ...pendingLinks,
                { fromKey: newKey, toSegmentId: r0.to_segment, toPort: r0.to_port },
              ]);
            }
          }
        };
        if (drag.frameKey === "note") {
          addNote(dropPos.x, dropPos.y);
          finishDetached(null);
        } else if (drag.frameKey === "segment") {
          void addSegment(episodeId).then((segment) => {
            if (segment) {
              void saveCanvasLayout({
                assets: [], shots: [], scenes: [],
                segments: [{ id: segment.id, x: dropPos.x, y: dropPos.y }],
              });
              // addSegment 把新片段并入概览的瞬间，segPos effect 会抢先用
              // 默认列位初始化它，位置落库排在后面就丢了松手点——表现为
              // 新片段不在鼠标位置而在默认列。落库后直接覆写。
              setSegPos((prev) => ({ ...prev, [segment.id]: dropPos }));
              // 摘线流程不走 autoConnect 的「按类型任意搜口」：预期是接回
              // 被摘的原口，由 finishDetached 按兼容性落线；autoConnect 只
              // 服务普通拖线到空白的建节点流程。
              autoConnectNewNode(`segment:${segment.id}`, drag.detached ? null : drag.wire);
              finishDetached(`segment:${segment.id}`);
            } else {
              finishDetached(null);
            }
          });
        } else if (
          drag.frameKey === "character" ||
          drag.frameKey === "location" ||
          drag.frameKey === "prop"
        ) {
          // 「角色/场景/道具」：创建空白资料占位节点（不入库、不弹挑选
          // 面板），双击占位节点从详情窗加载实体；加载后原位变成实体节点。
          const phId = addEntityPh(drag.frameKey, dropPos.x, dropPos.y);
          finishDetached(`eph:${phId}`);
        } else if (drag.frameKey === "prompt") {
          // 「提示词」：创建空提示词纸片（不入库、不弹挑选面板），出生在
          // 松手点，双击从提示词库选一条；连线走画布暂存线。
          const phId = addPromptPh(dropPos.x, dropPos.y);
          finishDetached(`prompt:${phId}`);
        }
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
            const inBox = (p: Pos | undefined, w: number, h: number) => {
              if (!p) return false;
              const cx = p.x + w / 2;
              const cy = p.y + h / 2;
              return cx >= rx1 && cx <= rx2 && cy >= ry1 && cy <= ry2;
            };
            layout.cards.forEach((card) => {
              const size = sizeOfNode(card.key) ?? shotCardSize(card.shot);
              if (inBox(pos.cards[card.shot.id], size.w, size.h)) list.push(card.key);
            });
            // 资料节点（含组/剧本/提示词）、空白资料占位、片段、成片：
            // 框选与点选同一套选中态（边缘点亮），删除也走同一套 Delete。
            infoNodes.forEach((node) => {
              const size = sizeOfNode(node.key) ?? { w: node.w, h: node.h };
              if (inBox(infoNodePos(node.key), size.w, size.h)) list.push(node.key);
            });
            entityPhs.forEach((ph) => {
              const size = sizeOfNode(`eph:${ph.id}`) ?? { w: INFO_W, h: INFO_H };
              if (inBox(infoNodePos(`eph:${ph.id}`), size.w, size.h)) list.push(`eph:${ph.id}`);
            });
            promptPhs.forEach((ph) => {
              const size = sizeOfNode(`prompt:${ph.id}`) ?? { w: SCRIPT_W, h: INFO_H + 40 };
              if (inBox(infoNodePos(`prompt:${ph.id}`), size.w, size.h)) list.push(`prompt:${ph.id}`);
            });
            segments.forEach((segment) => {
              const size = sizeOfNode(`segment:${segment.id}`);
              if (inBox(segPos[segment.id], size?.w ?? SEG_W, size?.h ?? SEG_H)) list.push(`segment:${segment.id}`);
            });
            if (outputBox) {
              const size = sizeOfNode("output") ?? { w: outputBox.w, h: outputBox.h };
              if (inBox({ x: outputBox.x, y: outputBox.y }, size.w, size.h)) list.push("output");
            }
            notes.forEach((note) => {
              const size = sizeOfNode(`note:${note.id}`);
              const noteElW = size?.w ?? 172;
              const noteElH = size?.h ?? 96;
              if (inBox({ x: note.x, y: note.y }, noteElW, noteElH)) list.push(`note:${note.id}`);
            });
          }
        }
        setSelection(list);
        drag.mq?.remove();
      } else if (drag.kind === "card" && drag.moved) {
        persistCards(pos.cards);
        pushUndo({
          type: "move",
          entries: (drag.moves ?? []).map((mv) => ({ key: `shot:${mv.key}`, x: mv.x, y: mv.y })),
        });
      } else if (drag.kind === "group" && drag.moved) {
        const fk = drag.frameKey ?? "";
        const frame = layout.frames.find((f) => f.id === fk);
        const p = scenePos[fk];
        if (frame?.scene && p) {
          void saveCanvasLayout({
            assets: [], shots: [],
            scenes: [{ id: fk, x: p.x, y: p.y }],
          });
        }
      } else if (drag.kind === "infoframe" && drag.moved) {
        saveInfoFramePos(infoPos.frame);
      }
      cleanupPointerVisuals(drag.moved ?? false);
    };
    const onCancel = (e: PointerEvent) => onUp(e, true);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
    };
  }, [layout, pos, view, scenePos, infoPos, boxOf, portsOf, outPointOf, inPointOf, persistCards, saveCanvasLayout, saveInfoFramePos, saveView, setSelection, saveOutputPos, setEpisodeOutput, episodeId, notes, persistNotes, addNote, addEntityPh, addPromptPh, persistSegments, linkNode, unlinkNode, nodeKeyParts, addSegment, autoConnectNewNode, persistSizes, persistInfoOffsets, infoGroups, infoNodes, infoNodePos, entityPhs, promptPhs, segments, segPos, sizeOfNode, outputBox, moveGroupTo, persistPositions, pushUndo, pendingLinks, persistPendingLinks, setInfoFramePos, setInfoOffsets, setNodeSizes, setNotes, setOutputPos, openNodeDetail, ownerKeyOfLink, displacePortLinks, nodeWireColorOf]);

  return {
    scenePos,
    onViewportPointerDown,
    dragRef,
    suppressClickRef,
    wireDraft,
    liftedWire,
    cutTrailRef,
    cutTrailUnderRef,
    openInfoDetail,
    discardDetachedWire,
    setLiftedWire,
  };
}
