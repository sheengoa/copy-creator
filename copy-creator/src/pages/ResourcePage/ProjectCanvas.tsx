import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  useProjectStore,
  type ProjectAsset,
  type ProjectAssetLink,
  type ProjectScene,
  type ProjectShot,
} from "../../stores/projectStore";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ResourceFileImage, ResourceVideoPoster } from "./ResourceMedia";
import { Icons } from "../../components/Icons";
import { openResourceFile, readResourceTextPreview } from "../../domain/mediaAssets";
import {
  intExtLabelKey,
  joinLibraryPath,
  locationSubtitleParts,
  timeHintLabelKey,
} from "../../domain/projectView";

// ── 布局常量（世界像素） ──────────────────────────────────────
const FRAME_MIN_W = 440;
const FRAME_MIN_H = 300;
const FRAME_PAD_X = 36;
const FRAME_PAD_TOP = 64;
const GRID_GAP = 22;
const TAG_ZONE = 26; // 节点上方便镜归属签的呼吸空间
const MEDIA_RATIO = 0.62; // 画布统一节点比例（盒稳定，连线/框尺寸可算）
const TEXT_RATIO = 0.72;
const MISSING_W = 170;
const MISSING_H = 120;
const SHOTCARD_W = 210;
const SHOTCARD_H = 96;
const DEFAULT_NODE_W = 220;
const WORLD_MARGIN = 60;
const SCENE_PITCH = 480; // 未摆放场景的横向间距
const MINI_W = 150;
const MINI_H = 96;

type Pos = { x: number; y: number; w?: number };
type PosMap = { nodes: Record<string, Pos>; frames: Record<string, Pos> };

interface CanvasNode {
  key: string; // `asset:<id>` | `shot:<id>`
  kind: "asset" | "shotcard";
  group: string; // sceneId 或 "loose"
  asset?: ProjectAsset;
  shot?: ProjectShot;
  w: number;
  h: number;
}

interface CanvasFrame {
  id: string; // sceneId 或 "loose"
  scene: ProjectScene | null;
  w: number;
  h: number;
}

interface CanvasLayout {
  nodes: CanvasNode[];
  frames: CanvasFrame[];
  nodePos: Record<string, Pos>;
  framePos: Record<string, Pos>;
  worldW: number;
  worldH: number;
}

interface WireBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function nodeSize(asset: ProjectAsset, w: number): { w: number; h: number } {
  if (asset.missing) return { w: MISSING_W, h: MISSING_H };
  if (asset.kind === "text") return { w, h: Math.round(w * TEXT_RATIO) };
  return { w, h: Math.round(w * MEDIA_RATIO) };
}

function wirePathD(a: WireBox, b: WireBox): string {
  const aMX = a.x + a.w / 2;
  const aMY = a.y + a.h / 2;
  const bMX = b.x + b.w / 2;
  const bMY = b.y + b.h / 2;
  const hOverlap = b.x < a.x + a.w && b.x + b.w > a.x;
  if (hOverlap && b.y >= a.y + a.h) {
    const c = Math.max(40, (b.y - a.y - a.h) * 0.5);
    return `M ${aMX} ${a.y + a.h} C ${aMX} ${a.y + a.h + c}, ${bMX} ${b.y - c}, ${bMX} ${b.y}`;
  }
  if (hOverlap && a.y >= b.y + b.h) {
    const c = Math.max(40, (a.y - b.y - b.h) * 0.5);
    return `M ${aMX} ${a.y} C ${aMX} ${a.y - c}, ${bMX} ${b.y + b.h + c}, ${bMX} ${b.y + b.h}`;
  }
  if (b.x - (a.x + a.w) > -40) {
    const c = Math.max(46, (b.x - a.x - a.w) * 0.5);
    return `M ${a.x + a.w} ${aMY} C ${a.x + a.w + c} ${aMY}, ${b.x - c} ${bMY}, ${b.x} ${bMY}`;
  }
  const c = Math.max(46, (a.x - b.x - b.w) * 0.5);
  return `M ${a.x} ${aMY} C ${a.x - c} ${aMY}, ${b.x + b.w + c} ${bMY}, ${b.x + b.w} ${bMY}`;
}

/** 确定性自动布局：已摆放的实体用存储坐标，未摆放的按场景横排 +
 *  组内网格 + 散件集级网格铺开。纯函数（overview 变化即重建）。 */
function buildLayout(
  scenes: ProjectScene[],
  looseAssets: ProjectAsset[],
): CanvasLayout {
  const nodePos: Record<string, Pos> = {};
  const framePos: Record<string, Pos> = {};
  const nodes: CanvasNode[] = [];
  const frames: CanvasFrame[] = [];
  let worldW = 1200;
  let worldH = 900;

  scenes.forEach((scene, index) => {
    const fx = scene.canvas_x ?? WORLD_MARGIN + index * SCENE_PITCH;
    const fy = scene.canvas_y ?? 110;
    framePos[scene.id] = { x: fx, y: fy };
    const placed: { key: string; w: number; h: number }[] = [];
    const pending: { key: string; w: number; h: number; asset: ProjectAsset | null }[] = [];
    scene.shots.forEach((shot) => {
      if (shot.assets.length === 0) {
        nodePos[`shot:${shot.id}`] =
          shot.canvas_x != null && shot.canvas_y != null
            ? { x: shot.canvas_x, y: shot.canvas_y }
            : { x: 0, y: 0 };
        pending.push({ key: `shot:${shot.id}`, w: SHOTCARD_W, h: SHOTCARD_H, asset: null });
      }
      shot.assets.forEach((asset) => {
        const size = nodeSize(asset, asset.canvas_w ?? DEFAULT_NODE_W);
        const fixed = asset.canvas_x != null && asset.canvas_y != null;
        nodePos[`asset:${asset.id}`] = fixed
          ? { x: asset.canvas_x as number, y: asset.canvas_y as number, w: size.w }
          : { x: 0, y: 0, w: size.w };
        if (fixed) {
          placed.push({ key: `asset:${asset.id}`, w: size.w, h: size.h });
        } else {
          pending.push({ key: `asset:${asset.id}`, w: size.w, h: size.h, asset });
        }
      });
    });
    // 未摆放成员按组内网格补位（避开已摆放成员的包围区）。
    let col = 0;
    let rowH = 0;
    let cursorX = fx + FRAME_PAD_X;
    let cursorY = fy + FRAME_PAD_TOP;
    pending.forEach((member) => {
      if (col === 3) {
        col = 0;
        cursorX = fx + FRAME_PAD_X;
        cursorY += rowH + GRID_GAP + TAG_ZONE;
        rowH = 0;
      }
      nodePos[member.key] = { x: cursorX, y: cursorY, w: member.w };
      cursorX += member.w + GRID_GAP;
      rowH = Math.max(rowH, member.h);
      col += 1;
    });
    void rowH;
    const all = [...placed, ...pending.map((m) => ({ key: m.key, w: m.w, h: m.h }))];
    const maxX = Math.max(fx + FRAME_MIN_W, ...all.map((m) => nodePos[m.key].x + m.w));
    const maxY = Math.max(fy + FRAME_MIN_H, ...all.map((m) => nodePos[m.key].y + m.h));
    frames.push({ id: scene.id, scene, w: maxX - fx, h: maxY - fy });
    worldW = Math.max(worldW, maxX + 60);
    worldH = Math.max(worldH, maxY + 60);
  });

  // 集级散件：铺在所有场景框下方。
  const scenesBottom = frames.reduce((acc, frame) => {
    const fp = framePos[frame.id];
    return frame.id === "loose" ? acc : Math.max(acc, fp.y + frame.h);
  }, 0);
  const looseY = Math.max(620, scenesBottom + 48);
  framePos["loose"] = { x: WORLD_MARGIN, y: looseY };
  looseAssets.forEach((asset, index) => {
    const size = nodeSize(asset, asset.canvas_w ?? DEFAULT_NODE_W);
    nodePos[`asset:${asset.id}`] =
      asset.canvas_x != null && asset.canvas_y != null
        ? { x: asset.canvas_x, y: asset.canvas_y, w: size.w }
        : {
            x: WORLD_MARGIN + FRAME_PAD_X + (index % 4) * (DEFAULT_NODE_W + GRID_GAP),
            y: looseY + FRAME_PAD_TOP + Math.floor(index / 4) * (size.h + GRID_GAP + TAG_ZONE),
            w: size.w,
          };
    nodes.push({
      key: `asset:${asset.id}`, kind: "asset", group: "loose", asset,
      w: size.w, h: size.h,
    });
  });
  const looseMaxX = Math.max(
    WORLD_MARGIN + FRAME_MIN_W,
    ...looseAssets.map((a) => {
      const p = nodePos[`asset:${a.id}`];
      return (p?.x ?? 0) + (p?.w ?? 0);
    }),
  );
  const looseMaxY = Math.max(
    looseY + FRAME_MIN_H,
    ...looseAssets.map((a) => {
      const p = nodePos[`asset:${a.id}`];
      return (p?.y ?? looseY) + nodeSize(a, a.canvas_w ?? DEFAULT_NODE_W).h;
    }),
  );
  frames.push({
    id: "loose", scene: null,
    w: looseMaxX - WORLD_MARGIN, h: looseMaxY - looseY,
  });
  worldW = Math.max(worldW, looseMaxX + 60);
  worldH = Math.max(worldH, looseMaxY + 60);

  // 场景成员进渲染列表。
  scenes.forEach((scene) => {
    scene.shots.forEach((shot) => {
      if (shot.assets.length === 0) {
        nodes.push({
          key: `shot:${shot.id}`, kind: "shotcard", group: scene.id, shot,
          w: SHOTCARD_W, h: SHOTCARD_H,
        });
      }
      shot.assets.forEach((asset) => {
        const size = nodeSize(asset, asset.canvas_w ?? DEFAULT_NODE_W);
        nodes.push({
          key: `asset:${asset.id}`, kind: "asset", group: scene.id, asset,
          w: size.w, h: size.h,
        });
      });
    });
  });

  return { nodes, frames, nodePos, framePos, worldW, worldH };
}

/** 文本纸片内容（读资源文本头部，组件内自持请求）。 */
function TextPaperBody({ path, name }: { path: string; name: string }) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    readResourceTextPreview(path)
      .then((result) => {
        if (!cancelled) setPreview(result.content);
      })
      .catch(() => {
        if (!cancelled) setPreview("");
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return (
    <div className="pc-paper">
      <h5>
        {Icons.file}
        <span>{name}</span>
      </h5>
      <p>{preview === null ? "…" : preview}</p>
    </div>
  );
}

interface WireItem {
  from: string; // asset id
  to: string;
  label: string;
  kind: "gen" | "manual";
}

/** 工程画布：集素材的无限画布（看/摆/连）。节点与分组框坐标持久化进
 *  工程库；视口按集记 localStorage。交互：中键平移、滚轮缩放、左键
 *  框选、多选拖动、拖场景标签牌整组移动、节点右下锚点拖出手动连线、
 *  双击素材开详情。生成链（gen_from_asset）自动画实线箭头。 */
export default function ProjectCanvas({
  libraryRoot,
  overlay,
  onOpenAsset,
  onPickForShot,
  onRelinkAsset,
}: {
  libraryRoot: string;
  /** 集信息玻璃卡内容（标题/状态/角色/剧本入口），由 ProjectView 组装。 */
  overlay?: React.ReactNode;
  onOpenAsset: (asset: ProjectAsset) => void;
  onPickForShot: (shotId: string) => void;
  onRelinkAsset: (asset: ProjectAsset) => void;
}) {
  const { t } = useTranslation();
  const {
    overview,
    locations,
    loadLocations,
    saveCanvasLayout,
    linkAssets,
    unlinkAssets,
    unlinkAsset,
    saveScene,
    deleteScene,
    saveShot,
    deleteShot,
  } = useProjectStore(
    useShallow((state) => ({
      overview: state.overview,
      locations: state.locations,
      loadLocations: state.loadLocations,
      saveCanvasLayout: state.saveCanvasLayout,
      linkAssets: state.linkAssets,
      unlinkAssets: state.unlinkAssets,
      unlinkAsset: state.unlinkAsset,
      saveScene: state.saveScene,
      deleteScene: state.deleteScene,
      saveShot: state.saveShot,
      deleteShot: state.deleteShot,
    })),
  );
  const episodeId = overview?.episode.id ?? "";
  const scenes = useMemo(() => overview?.scenes ?? [], [overview]);
  const looseAssets = useMemo(() => overview?.loose_assets ?? [], [overview]);
  const links = useMemo(() => overview?.links ?? [], [overview]);

  // ── 布局与位置（state 驱动渲染；拖动经 setPos 更新） ──
  const layout = useMemo(() => buildLayout(scenes, looseAssets), [scenes, looseAssets]);
  const [pos, setPos] = useState<PosMap>({ nodes: layout.nodePos, frames: layout.framePos });
  useEffect(() => {
    setPos({ nodes: layout.nodePos, frames: layout.framePos });
  }, [layout]);

  // ── 视口：按集记 localStorage ──
  const vpRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ x: 24, y: 12, scale: 0.85 });
  const [vpSize, setVpSize] = useState<{ w: number; h: number } | null>(null);
  const saveView = useCallback(
    (next: { x: number; y: number; scale: number }) => {
      try {
        window.localStorage.setItem(`project_canvas_view_${episodeId}`, JSON.stringify(next));
      } catch {
        // 存储不可用：仅不记忆视口。
      }
    },
    [episodeId],
  );

  // 视口尺寸（小地图视口框需要）。
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const update = () => setVpSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fitAll = useCallback(() => {
    const el = vpRef.current;
    if (!el) return;
    const scale = Math.min(el.clientWidth / layout.worldW, el.clientHeight / layout.worldH, 1);
    const next = {
      x: Math.max(12, (el.clientWidth - layout.worldW * scale) / 2),
      y: Math.max(8, (el.clientHeight - layout.worldH * scale) / 2),
      scale,
    };
    setView(next);
    saveView(next);
  }, [layout, saveView]);

  // 切集时恢复/初始化视口。
  const initializedRef = useRef("");
  useEffect(() => {
    if (!episodeId || initializedRef.current === episodeId) return;
    initializedRef.current = episodeId;
    let stored: { x: number; y: number; scale: number } | null;
    try {
      const raw = window.localStorage.getItem(`project_canvas_view_${episodeId}`);
      stored = raw ? (JSON.parse(raw) as { x: number; y: number; scale: number }) : null;
    } catch {
      stored = null;
    }
    if (stored && Number.isFinite(stored.scale)) {
      setView(stored);
    } else {
      fitAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId]);

  const zoomAt = useCallback(
    (mx: number, my: number, factor: number) => {
      setView((prev) => {
        const ns = Math.min(2.2, Math.max(0.3, prev.scale * factor));
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

  // ── 连线数据：生成链 + 手动 ──
  const wires = useMemo(() => {
    const ids = new Set(
      layout.nodes.filter((n) => n.kind === "asset").map((n) => n.key.slice(6)),
    );
    const list: WireItem[] = [];
    const pushGen = (asset: ProjectAsset) => {
      if (asset.gen_from_asset && ids.has(asset.gen_from_asset)) {
        list.push({
          from: asset.gen_from_asset,
          to: asset.id,
          label: t("project.canvas.wireGen"),
          kind: "gen",
        });
      }
    };
    scenes.forEach((scene) => scene.shots.forEach((shot) => shot.assets.forEach(pushGen)));
    looseAssets.forEach(pushGen);
    links.forEach((link: ProjectAssetLink) => {
      if (ids.has(link.from_asset) && ids.has(link.to_asset)) {
        list.push({
          from: link.from_asset,
          to: link.to_asset,
          label: link.label || t("project.canvas.wireRef"),
          kind: "manual",
        });
      }
    });
    return list;
  }, [layout, scenes, looseAssets, links, t]);

  const boxOf = useCallback(
    (assetId: string): WireBox | null => {
      const node = layout.nodes.find((n) => n.key === `asset:${assetId}`);
      const p = pos.nodes[node?.key ?? ""];
      if (!node || !p) return null;
      return { x: p.x, y: p.y, w: node.w, h: node.h };
    },
    [layout, pos],
  );

  // ── 选中与拖拽 ──
  const [selKeys, setSelKeys] = useState<string[]>([]);
  const selRef = useRef<string[]>([]);
  const setSelection = useCallback((keys: string[]) => {
    selRef.current = keys;
    setSelKeys(keys);
  }, []);

  const persistLayout = useCallback(
    (next: PosMap) => {
      const assets: { id: string; x: number; y: number; w: number | null }[] = [];
      const shots: { id: string; x: number; y: number }[] = [];
      const sceneList: { id: string; x: number; y: number }[] = [];
      layout.nodes.forEach((node) => {
        const p = next.nodes[node.key];
        if (!p) return;
        if (node.kind === "asset" && node.asset) {
          assets.push({ id: node.asset.id, x: p.x, y: p.y, w: p.w ?? node.w });
        } else if (node.kind === "shotcard" && node.shot) {
          shots.push({ id: node.shot.id, x: p.x, y: p.y });
        }
      });
      layout.frames.forEach((frame) => {
        const p = next.frames[frame.id];
        if (p && frame.id !== "loose") sceneList.push({ id: frame.id, x: p.x, y: p.y });
      });
      void saveCanvasLayout({ assets, shots, scenes: sceneList });
    },
    [layout, saveCanvasLayout],
  );

  interface DragState {
    kind: "pan" | "marquee" | "node" | "group" | "wire";
    sx: number;
    sy: number;
    moved?: boolean;
    ox?: number;
    oy?: number;
    mq?: HTMLDivElement;
    moves?: { key: string; x: number; y: number }[];
    frameKey?: string;
    fox?: number;
    foy?: number;
    starts?: { key: string; x: number; y: number }[];
    fromKey?: string;
    targetKey?: string | null;
  }
  const dragRef = useRef<DragState | null>(null);
  const [wireDraft, setWireDraft] = useState<string | null>(null);

  const onViewportMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (
        target?.closest(".pc-node-tools") ||
        target?.closest(".pc-glass") ||
        target?.closest(".pc-lb") ||
        target?.closest(".pc-frame-ops")
      ) {
        return;
      }
      const vp = vpRef.current;
      if (!vp) return;
      if (e.button === 1) {
        dragRef.current = {
          kind: "pan", sx: e.clientX, sy: e.clientY,
          ox: view.x, oy: view.y, moved: false,
        };
        vp.classList.add("pc-panning");
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      const anchor = target?.closest(".pc-anchor");
      if (anchor) {
        const nodeEl = anchor.closest(".pc-node");
        const key = nodeEl?.getAttribute("data-key") ?? "";
        if (key.startsWith("asset:")) {
          dragRef.current = { kind: "wire", sx: e.clientX, sy: e.clientY, fromKey: key, targetKey: null };
          e.preventDefault();
          return;
        }
      }
      const nodeEl = target?.closest(".pc-node");
      if (nodeEl) {
        const key = nodeEl.getAttribute("data-key") ?? "";
        const nextSel = selRef.current.includes(key) ? selRef.current : [key];
        setSelection(nextSel);
        dragRef.current = {
          kind: "node", sx: e.clientX, sy: e.clientY, moved: false,
          moves: nextSel
            .map((k) => {
              const p = pos.nodes[k];
              return p ? { key: k, x: p.x, y: p.y } : null;
            })
            .filter((item): item is { key: string; x: number; y: number } => item !== null),
        };
        e.preventDefault();
        return;
      }
      const labelEl = target?.closest(".pc-frame-label");
      if (labelEl) {
        const frameEl = labelEl.closest(".pc-frame");
        const frameKey = frameEl?.getAttribute("data-frame") ?? "";
        if (frameKey && frameKey !== "loose") {
          dragRef.current = {
            kind: "group", sx: e.clientX, sy: e.clientY, frameKey,
            fox: pos.frames[frameKey]?.x ?? 0, foy: pos.frames[frameKey]?.y ?? 0,
            starts: layout.nodes
              .filter((n) => n.group === frameKey)
              .map((n) => ({
                key: n.key,
                x: pos.nodes[n.key]?.x ?? 0,
                y: pos.nodes[n.key]?.y ?? 0,
              })),
            moved: false,
          };
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
    [layout, pos, setSelection, view],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
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
        setPos((prev) => {
          const nodesNext = { ...prev.nodes };
          drag.starts?.forEach((start) => {
            nodesNext[start.key] = {
              ...nodesNext[start.key],
              x: start.x + dx / view.scale,
              y: start.y + dy / view.scale,
            };
          });
          const fk = drag.frameKey ?? "";
          return {
            nodes: nodesNext,
            frames: {
              ...prev.frames,
              [fk]: {
                ...prev.frames[fk],
                x: (drag.fox ?? 0) + dx / view.scale,
                y: (drag.foy ?? 0) + dy / view.scale,
              },
            },
          };
        });
      } else if (drag.kind === "wire") {
        const el = vpRef.current;
        if (!el || !drag.fromKey) return;
        const rect = el.getBoundingClientRect();
        const wx = (e.clientX - rect.left - view.x) / view.scale;
        const wy = (e.clientY - rect.top - view.y) / view.scale;
        const fromNode = layout.nodes.find((n) => n.key === drag.fromKey);
        const fromPos = pos.nodes[drag.fromKey];
        if (!fromNode || !fromPos) return;
        setWireDraft(
          wirePathD(
            { x: fromPos.x, y: fromPos.y, w: fromNode.w, h: fromNode.h },
            { x: wx - 1, y: wy - 1, w: 2, h: 2 },
          ),
        );
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const tEl = hit instanceof Element ? hit.closest(".pc-node") : null;
        const tKey = tEl?.getAttribute("data-key") ?? null;
        drag.targetKey = tKey && tKey !== drag.fromKey ? tKey : null;
      } else {
        setPos((prev) => {
          const nodesNext = { ...prev.nodes };
          drag.moves?.forEach((mv) => {
            nodesNext[mv.key] = {
              ...nodesNext[mv.key],
              x: mv.x + dx / view.scale,
              y: mv.y + dy / view.scale,
            };
          });
          return { ...prev, nodes: nodesNext };
        });
      }
    };
    const onUp = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.kind === "pan") {
        if (drag.moved) saveView(view);
      } else if (drag.kind === "wire") {
        setWireDraft(null);
        if (drag.targetKey && drag.fromKey) {
          void linkAssets(
            drag.fromKey.replace("asset:", ""),
            drag.targetKey.replace("asset:", ""),
            "",
          );
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
            layout.nodes.forEach((node) => {
              const p = pos.nodes[node.key];
              if (!p) return;
              const cx = p.x + node.w / 2;
              const cy = p.y + node.h / 2;
              if (cx >= rx1 && cx <= rx2 && cy >= ry1 && cy <= ry2) list.push(node.key);
            });
          }
        }
        setSelection(list);
        drag.mq?.remove();
      } else if (drag.kind === "node" && drag.moved) {
        persistLayout(pos);
      } else if (drag.kind === "group" && drag.moved) {
        persistLayout(pos);
      }
      vpRef.current?.classList.remove("pc-panning");
      dragRef.current = null;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [layout, pos, view, linkAssets, persistLayout, saveView, setSelection]);

  // ── 节点操作 ──
  const handleNodeTool = useCallback(
    (asset: ProjectAsset, act: string) => {
      if (act === "view") onOpenAsset(asset);
      else if (act === "locate") void openResourceFile(joinLibraryPath(libraryRoot, asset.file_path));
      else if (act === "relink") onRelinkAsset(asset);
      else if (act === "remove") void unlinkAsset(asset.id);
    },
    [libraryRoot, onOpenAsset, onRelinkAsset, unlinkAsset],
  );

  // ── 场景/镜头快速管理 ──
  const [sceneForm, setSceneForm] = useState<{ id?: string; heading: string; locationId: string } | null>(null);
  const [shotForm, setShotForm] = useState<{ id: string; sceneId: string; description: string; dialogue: string } | null>(null);
  const [deleteSceneTarget, setDeleteSceneTarget] = useState<ProjectScene | null>(null);
  const [deleteShotTarget, setDeleteShotTarget] = useState<ProjectShot | null>(null);

  useEffect(() => {
    if ((sceneForm || shotForm) && locations.length === 0) void loadLocations();
  }, [sceneForm, shotForm, locations.length, loadLocations]);

  const submitSceneForm = () => {
    const draft = sceneForm;
    setSceneForm(null);
    if (!draft || !draft.heading.trim()) return;
    void saveScene({
      id: draft.id,
      episodeId,
      heading: draft.heading.trim(),
      locationId: draft.locationId,
      note: "",
    });
  };

  const submitShotForm = () => {
    const draft = shotForm;
    setShotForm(null);
    if (!draft) return;
    void saveShot({
      id: draft.id || undefined,
      sceneId: draft.sceneId,
      description: draft.description.trim(),
      dialogue: draft.dialogue.trim(),
      status: "none",
      camera: "",
      duration: "",
    });
  };

  const shotTagLabel = useCallback(
    (shotId: string): string | null => {
      for (const scene of scenes) {
        const index = scene.shots.findIndex((shot) => shot.id === shotId);
        if (index >= 0) {
          const shot = scene.shots[index];
          return t("project.canvas.shotTag", {
            no: index + 1,
            name: shot.description || t("project.shot.untitled"),
          });
        }
      }
      return null;
    },
    [scenes, t],
  );

  const miniRatio = Math.min(
    MINI_W / Math.max(layout.worldW, 1),
    MINI_H / Math.max(layout.worldH, 1),
  );

  return (
    <div className="pc-root">
      <div
        ref={vpRef}
        className="pc-viewport"
        onMouseDown={onViewportMouseDown}
        onWheel={(e) => {
          e.preventDefault();
          const rect = vpRef.current?.getBoundingClientRect();
          if (!rect) return;
          zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
        }}
        onDoubleClick={(e) => {
          const nodeEl = e.target instanceof Element ? e.target.closest(".pc-node") : null;
          if (!nodeEl) return;
          const key = nodeEl.getAttribute("data-key") ?? "";
          if (!key.startsWith("asset:")) return;
          const node = layout.nodes.find((n) => n.key === key);
          if (node?.asset) onOpenAsset(node.asset);
        }}
      >
        <div
          className="pc-world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {/* 分组框 */}
          {layout.frames.map((frame) => {
            const isLoose = frame.id === "loose";
            const scene = frame.scene;
            const sceneIndex = scene ? scenes.findIndex((item) => item.id === scene.id) : -1;
            const fpos = pos.frames[frame.id] ?? { x: WORLD_MARGIN, y: 110 };
            const memberCount = layout.nodes.filter((n) => n.group === frame.id).length;
            return (
              <div
                key={frame.id}
                data-frame={frame.id}
                className="pc-frame"
                style={{ left: fpos.x, top: fpos.y, width: frame.w, height: frame.h }}
              >
                <div className="pc-frame-label">
                  {isLoose ? (
                    <>
                      <span className="pc-frame-name">{t("project.asset.title")}</span>
                      <small>{memberCount}</small>
                    </>
                  ) : (
                    scene && (
                      <>
                        <small className="pc-frame-no">
                          {t("project.canvas.sceneNo", { no: sceneIndex + 1 })}
                        </small>
                        <span className="pc-frame-name">
                          {scene.heading || t("project.scene.untitled")}
                        </span>
                        {scene.location && (
                          <span className="pc-int" title={scene.location.name}>
                            {Icons.resources}
                            {scene.location.name}
                            {locationSubtitleParts(scene.location.int_ext, scene.location.time_hint).length > 0 && (
                              <em>
                                {locationSubtitleParts(scene.location.int_ext, scene.location.time_hint)
                                  .map((part) =>
                                    t(
                                      part === scene.location?.int_ext
                                        ? intExtLabelKey(part)
                                        : timeHintLabelKey(part),
                                    ),
                                  )
                                  .join("/")}
                              </em>
                            )}
                          </span>
                        )}
                        <small>
                          {t("project.canvas.frameStats", {
                            shots: scene.shots.length,
                            assets: memberCount,
                          })}
                        </small>
                      </>
                    )
                  )}
                  <span className="pc-frame-ops">
                    {scene && (
                      <>
                        <button
                          type="button"
                          data-tooltip={t("common.edit")}
                          onClick={() =>
                            setSceneForm({ id: scene.id, heading: scene.heading, locationId: scene.location_id })
                          }
                        >
                          {Icons.edit}
                        </button>
                        <button
                          type="button"
                          data-tooltip={t("project.canvas.addShot")}
                          onClick={() =>
                            setShotForm({ id: "", sceneId: scene.id, description: "", dialogue: "" })
                          }
                        >
                          {Icons.add}
                        </button>
                        <button
                          type="button"
                          data-tooltip={t("common.delete")}
                          onClick={() => setDeleteSceneTarget(scene)}
                        >
                          {Icons.delete}
                        </button>
                      </>
                    )}
                    {isLoose && (
                      <button type="button" data-tooltip={t("project.asset.link")} onClick={() => onPickForShot("")}>
                        {Icons.add}
                      </button>
                    )}
                  </span>
                </div>
              </div>
            );
          })}

          {/* 连线层（节点之下） */}
          <svg className="pc-wires" aria-hidden="true">
            <defs>
              <marker id="pc-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" fill="#4a4a54" />
              </marker>
            </defs>
            {wires.map((wire) => {
              const fromBox = boxOf(wire.from);
              const toBox = boxOf(wire.to);
              if (!fromBox || !toBox) return null;
              const d = wirePathD(fromBox, toBox);
              const midX = (fromBox.x + fromBox.w / 2 + toBox.x + toBox.w / 2) / 2;
              const midY = (fromBox.y + fromBox.h / 2 + toBox.y + toBox.h / 2) / 2 - 7;
              return (
                <g key={`${wire.from}->${wire.to}`} className="pc-wire">
                  <path className="pc-wire-hit" d={d} />
                  <path
                    className={`pc-wire-line ${wire.kind}`}
                    d={d}
                    markerEnd={wire.kind === "gen" ? "url(#pc-arrow)" : undefined}
                  />
                  <text className="pc-wire-label" x={midX} y={midY}>
                    {wire.label}
                  </text>
                  {wire.kind === "manual" && (
                    <g
                      className="pc-wire-del"
                      data-tooltip={t("project.canvas.wireRemove")}
                      onClick={() => void unlinkAssets(wire.from, wire.to)}
                    >
                      <circle cx={midX + 36} cy={midY - 4} r="9" />
                      <path d={`M${midX + 32} ${midY - 8} l8 8 M${midX + 40} ${midY - 8} l-8 8`} />
                    </g>
                  )}
                </g>
              );
            })}
            {wireDraft && <path className="pc-wire-temp" d={wireDraft} />}
          </svg>

          {/* 节点 */}
          {layout.nodes.map((node) => {
            const p = pos.nodes[node.key] ?? { x: 0, y: 0 };
            const selected = selKeys.includes(node.key);
            if (node.kind === "shotcard" && node.shot) {
              const shot = node.shot;
              return (
                <div
                  key={node.key}
                  data-key={node.key}
                  className={`pc-node pc-shotcard${selected ? " pc-selected" : ""}`}
                  style={{ left: p.x, top: p.y, width: node.w }}
                >
                  <div className="pc-media-wrap">
                    <div className="pc-shotcard-body">
                      <b>{shot.description || t("project.shot.untitled")}</b>
                      {shot.dialogue && <i>{shot.dialogue}</i>}
                    </div>
                  </div>
                  <span className="pc-node-tools">
                    <button type="button" data-tooltip={t("project.asset.link")} onClick={() => onPickForShot(shot.id)}>
                      {Icons.file}
                    </button>
                    <button
                      type="button"
                      data-tooltip={t("common.edit")}
                      onClick={() =>
                        setShotForm({ id: shot.id, sceneId: shot.scene_id, description: shot.description, dialogue: shot.dialogue })
                      }
                    >
                      {Icons.edit}
                    </button>
                    <button
                      type="button"
                      data-tooltip={t("common.delete")}
                      className="danger"
                      onClick={() => setDeleteShotTarget(shot)}
                    >
                      {Icons.delete}
                    </button>
                  </span>
                </div>
              );
            }
            const asset = node.asset;
            if (!asset) return null;
            const mediaPath = joinLibraryPath(libraryRoot, asset.file_path);
            const tag = asset.shot_id ? shotTagLabel(asset.shot_id) : null;
            return (
              <div
                key={node.key}
                data-key={node.key}
                className={`pc-node${selected ? " pc-selected" : ""}`}
                style={{ left: p.x, top: p.y, width: node.w }}
              >
                <div className="pc-media-wrap">
                  {asset.missing ? (
                    <div className="pc-miss-card" style={{ height: node.h }}>
                      {Icons.image}
                      {t("project.asset.fileMissing")}
                    </div>
                  ) : asset.kind === "image" ? (
                    <div className="pc-media" style={{ height: node.h }}>
                      <ResourceFileImage
                        path={mediaPath}
                        alt={asset.name}
                        version={asset.updated_at}
                        className="pc-media-img"
                      />
                    </div>
                  ) : asset.kind === "video" ? (
                    <div className="pc-media" style={{ height: node.h }}>
                      <ResourceVideoPoster
                        path={mediaPath}
                        version={asset.updated_at}
                        fallbackLabel={asset.name || asset.file_path}
                      />
                      <span className="pc-play">{Icons.play}</span>
                    </div>
                  ) : asset.kind === "text" ? (
                    <TextPaperBody path={mediaPath} name={asset.name || asset.file_path} />
                  ) : (
                    <div className="pc-media pc-media-file" style={{ height: node.h }}>
                      {Icons.file}
                      <span>{asset.name || asset.file_path}</span>
                    </div>
                  )}
                </div>
                {tag && (
                  <span className="pc-shot-tag" title={tag}>
                    {Icons.clapperboard}
                    {tag}
                  </span>
                )}
                {asset.gen_from_asset && (
                  <span className="pc-gen-tag">{Icons.link}{t("project.canvas.genTag")}</span>
                )}
                <span className="pc-node-tools">
                  <button type="button" data-tooltip={t("project.canvas.view")} onClick={() => handleNodeTool(asset, "view")}>
                    {Icons.expand}
                  </button>
                  <button type="button" data-tooltip={t("project.canvas.openFile")} onClick={() => handleNodeTool(asset, "locate")}>
                    {Icons.externalLink}
                  </button>
                  {asset.missing && (
                    <button type="button" data-tooltip={t("project.sheet.relink")} onClick={() => handleNodeTool(asset, "relink")}>
                      {Icons.swap}
                    </button>
                  )}
                  <button
                    type="button"
                    data-tooltip={t("project.canvas.remove")}
                    className="danger"
                    onClick={() => handleNodeTool(asset, "remove")}
                  >
                    {Icons.close}
                  </button>
                </span>
                <span className="pc-anchor" data-tooltip={t("project.canvas.wireHint")} />
              </div>
            );
          })}
        </div>

        {/* 集信息玻璃卡（内容由 ProjectView 组装）+ 画布统计 */}
        <div className="pc-glass pc-ep-card">
          {overlay}
          <div className="pc-ep-stats">
            <span>{t("project.canvas.statScenes", { count: scenes.length })}</span>
            <span>{t("project.canvas.statShots", { count: scenes.reduce((acc, s) => acc + s.shots.length, 0) })}</span>
            <span>{t("project.canvas.statAssets", { count: layout.nodes.filter((n) => n.kind === "asset").length })}</span>
            <span>{t("project.canvas.statWires", { count: wires.length })}</span>
          </div>
        </div>

        <div className="pc-tip">{t("project.canvas.tip")}</div>

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
          <span className="pc-sep" />
          <button type="button" data-tooltip={t("project.canvas.fit")} onClick={fitAll}>
            {Icons.expand}
          </button>
        </div>

        <div className="pc-glass pc-minimap" data-tooltip={t("project.canvas.minimap")}>
          <svg
            width={MINI_W}
            height={MINI_H}
            viewBox={`0 0 ${MINI_W} ${MINI_H}`}
            onMouseDown={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              const wx = e.clientX - rect.left;
              const wy = e.clientY - rect.top;
              const vpRect = vpRef.current?.getBoundingClientRect();
              if (!vpRect) return;
              setView((prev) => {
                const next = {
                  ...prev,
                  x: vpRect.width / 2 - wx / miniRatio * prev.scale,
                  y: vpRect.height / 2 - wy / miniRatio * prev.scale,
                };
                saveView(next);
                return next;
              });
            }}
          >
            {layout.frames.map((frame) => {
              const fpos = pos.frames[frame.id];
              if (!fpos) return null;
              return (
                <rect
                  key={frame.id}
                  x={fpos.x * miniRatio}
                  y={fpos.y * miniRatio}
                  width={frame.w * miniRatio}
                  height={frame.h * miniRatio}
                  rx="3"
                  fill="none"
                  stroke="var(--text-tertiary)"
                  strokeDasharray="2,2"
                />
              );
            })}
            {layout.nodes.map((node) => {
              const p = pos.nodes[node.key];
              if (!p) return null;
              return (
                <rect
                  key={node.key}
                  x={p.x * miniRatio}
                  y={p.y * miniRatio}
                  width={Math.max(3, node.w * miniRatio)}
                  height={Math.max(2.5, node.h * miniRatio)}
                  rx="1.5"
                  fill="var(--text-tertiary)"
                />
              );
            })}
            <rect
              x={(-view.x / view.scale) * miniRatio}
              y={(-view.y / view.scale) * miniRatio}
              width={(vpSize?.w ?? 1200) / view.scale * miniRatio}
              height={(vpSize?.h ?? 700) / view.scale * miniRatio}
              fill="rgba(127,127,140,.1)"
              stroke="var(--text-primary)"
              strokeWidth="1.2"
              rx="2"
            />
          </svg>
        </div>

        <div className="pc-glass pc-addbtn">
          <button type="button" onClick={() => onPickForShot("")}>
            {Icons.folderOpen}
            {t("project.canvas.pickFromLibrary")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => setSceneForm({ heading: "", locationId: "" })}
          >
            {Icons.add}
            {t("project.canvas.newScene")}
          </button>
        </div>
      </div>

      {/* 场景快速编辑 */}
      {sceneForm && (
        <div className="pc-dialog-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) setSceneForm(null); }}>
          <div className="pc-dialog">
            <h4>{sceneForm.id ? t("project.canvas.editScene") : t("project.canvas.newScene")}</h4>
            <label>
              <span>{t("project.scene.field.heading")}</span>
              <input
                value={sceneForm.heading}
                placeholder={t("project.scene.field.headingPlaceholder")}
                onChange={(event) => setSceneForm({ ...sceneForm, heading: event.target.value })}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitSceneForm();
                  if (event.key === "Escape") setSceneForm(null);
                }}
              />
            </label>
            <label>
              <span>{t("project.scene.field.location")}</span>
              <select
                value={sceneForm.locationId}
                onChange={(event) => setSceneForm({ ...sceneForm, locationId: event.target.value })}
              >
                <option value="">{t("project.scene.field.freeLocation")}</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="pc-dialog-foot">
              <button type="button" onClick={() => setSceneForm(null)}>{t("common.cancel")}</button>
              <button type="button" className="primary" onClick={submitSceneForm}>{t("common.save")}</button>
            </div>
          </div>
        </div>
      )}

      {/* 镜头快速编辑 */}
      {shotForm && (
        <div className="pc-dialog-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) setShotForm(null); }}>
          <div className="pc-dialog">
            <h4>{shotForm.id ? t("project.canvas.editShot") : t("project.canvas.addShot")}</h4>
            <label>
              <span>{t("project.shot.field.description")}</span>
              <textarea
                rows={2}
                value={shotForm.description}
                placeholder={t("project.shot.untitled")}
                onChange={(event) => setShotForm({ ...shotForm, description: event.target.value })}
                autoFocus
              />
            </label>
            <label>
              <span>{t("project.shot.field.dialogue")}</span>
              <textarea
                rows={2}
                value={shotForm.dialogue}
                onChange={(event) => setShotForm({ ...shotForm, dialogue: event.target.value })}
              />
            </label>
            <div className="pc-dialog-foot">
              <button type="button" onClick={() => setShotForm(null)}>{t("common.cancel")}</button>
              <button type="button" className="primary" onClick={submitShotForm}>{t("common.save")}</button>
            </div>
          </div>
        </div>
      )}

      {deleteSceneTarget && (
        <ConfirmDialog
          message={t("project.scene.deleteConfirm", {
            heading: deleteSceneTarget.heading || t("project.scene.untitled"),
          })}
          onConfirm={() => {
            const target = deleteSceneTarget;
            setDeleteSceneTarget(null);
            void deleteScene(target.id);
          }}
          onCancel={() => setDeleteSceneTarget(null)}
        />
      )}
      {deleteShotTarget && (
        <ConfirmDialog
          message={t("project.shot.deleteConfirm")}
          onConfirm={() => {
            const target = deleteShotTarget;
            setDeleteShotTarget(null);
            void deleteShot(target.id);
          }}
          onCancel={() => setDeleteShotTarget(null)}
        />
      )}
    </div>
  );
}
