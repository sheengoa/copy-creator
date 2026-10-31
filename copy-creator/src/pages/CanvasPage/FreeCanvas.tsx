import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Icons } from "../../components/Icons";
import { ImageLightbox } from "../../components/ImageLightbox";
import { openResourceFile } from "../../domain/mediaAssets";
import { resolveResourceMediaUrl } from "../../domain/mediaUrl";
import { joinLibraryPath } from "../../domain/projectView";
import ProjectFilePickerDialog from "../ResourcePage/ProjectFilePickerDialog";
import { ResourceMediaPlayer } from "../ResourcePage/ResourceMedia";
import { useSettingsStore } from "../../stores/settingsStore";
import { resolveWireRelease } from "../../utils/projectWireRelease";
import {
  useCanvasStore,
  type CanvasLayoutEntry,
  type CanvasNode,
  type CanvasNodeType,
} from "../../stores/canvasStore";

// 自由生图工作流画布（画布区方案 3.3 + 节点体系 v2）：以 ProjectCanvas 为
// 基座 fork——引擎框架（视口/连线/切线/框选/分组/菜单）自工程画布搬运；
// 连线为「类型化端口」语义（用户 2026-10-31 定案）：生成/加载/输出三类
// 链路，多输入口 + 口名常显 + 类型匹配校验（accepts 矩阵），生成节点的
// 生成前提 = 文本口已连非空文本 + 输出口已连保存/预览。产物由保存节点
// 决定去向（入库 / 另存任意路径），生成节点只暂存在托管目录。

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.2;
const WIRES_VIEWPORT_PAD = 64;
const MINI_W = 150;
const MINI_H = 96;
const UNDO_LIMIT = 50;

/** 建节点落库的默认尺寸（B+ 视觉标准）：高度不落库 = 内容自适应撑开；
 *  text 类节点正文是常驻编辑框需固定高。拖过尺寸手柄后 height 落库转固定。 */
const NODE_DEFAULT_SIZE: Record<CanvasNodeType, { w: number; h: number | null }> = {
  gen_image: { w: 280, h: null },
  gen_video: { w: 280, h: null },
  gen_audio: { w: 260, h: null },
  load_text: { w: 260, h: null },
  load_image: { w: 260, h: null },
  load_video: { w: 280, h: null },
  load_audio: { w: 260, h: null },
  save_image: { w: 250, h: null },
  save_video: { w: 280, h: null },
  save_audio: { w: 260, h: null },
  preview_image: { w: 320, h: null },
  preview_video: { w: 360, h: null },
  preview_audio: { w: 280, h: null },
  collection_image: { w: 240, h: null },
  collection_text: { w: 240, h: null },
  collection_video: { w: 260, h: null },
  note: { w: 220, h: null },
};

/** 连线锚点在 nodeMetrics 实测前的兜底尺寸（实测优先，常量只是首帧）。 */
const NODE_FALLBACK_SIZE: Record<CanvasNodeType, { w: number; h: number }> = {
  gen_image: { w: 280, h: 300 },
  gen_video: { w: 280, h: 240 },
  gen_audio: { w: 260, h: 180 },
  load_text: { w: 260, h: 150 },
  load_image: { w: 260, h: 220 },
  load_video: { w: 280, h: 220 },
  load_audio: { w: 260, h: 140 },
  save_image: { w: 250, h: 170 },
  save_video: { w: 280, h: 150 },
  save_audio: { w: 260, h: 130 },
  preview_image: { w: 320, h: 260 },
  preview_video: { w: 360, h: 240 },
  preview_audio: { w: 280, h: 130 },
  collection_image: { w: 240, h: 160 },
  collection_text: { w: 240, h: 160 },
  collection_video: { w: 260, h: 160 },
  note: { w: 220, h: 120 },
};

/** 各类型缩放下限（对齐工程画布 resize 分类型的 minW/minH 惯例）。 */
const NODE_MIN_SIZE: Record<CanvasNodeType, { w: number; h: number }> = {
  gen_image: { w: 200, h: 180 },
  gen_video: { w: 200, h: 160 },
  gen_audio: { w: 180, h: 130 },
  load_text: { w: 180, h: 120 },
  load_image: { w: 160, h: 140 },
  load_video: { w: 180, h: 140 },
  load_audio: { w: 180, h: 110 },
  save_image: { w: 180, h: 130 },
  save_video: { w: 180, h: 120 },
  save_audio: { w: 180, h: 110 },
  preview_image: { w: 200, h: 160 },
  preview_video: { w: 220, h: 160 },
  preview_audio: { w: 180, h: 110 },
  collection_image: { w: 180, h: 110 },
  collection_text: { w: 180, h: 110 },
  collection_video: { w: 180, h: 110 },
  note: { w: 120, h: 80 },
};

/** 媒体类型色（节点 accent / 线色 / 端口点色同源：线色跟上游类型）。
 *  用户 2026-11-01 定案：文本黄、图像蓝、视频紫、音频绿；文本取深琥珀
 *  黄而非系统黄 #FFCC00，保证 2.6px 连线在浅色画布上可读。 */
const MEDIA_COLOR: Record<"text" | "image" | "video" | "audio", string> = {
  text: "#E6A700",
  image: "#007AFF",
  video: "#AF52DE",
  audio: "#34C759",
};

/** 节点类型色通道（B+ 视觉标准）：按所属媒体链路取色。 */
const NODE_ACCENT: Record<CanvasNodeType, string> = {
  gen_image: MEDIA_COLOR.image,
  gen_video: MEDIA_COLOR.video,
  gen_audio: MEDIA_COLOR.audio,
  load_text: MEDIA_COLOR.text,
  load_image: MEDIA_COLOR.image,
  load_video: MEDIA_COLOR.video,
  load_audio: MEDIA_COLOR.audio,
  save_image: MEDIA_COLOR.image,
  save_video: MEDIA_COLOR.video,
  save_audio: MEDIA_COLOR.audio,
  preview_image: MEDIA_COLOR.image,
  preview_video: MEDIA_COLOR.video,
  preview_audio: MEDIA_COLOR.audio,
  collection_image: MEDIA_COLOR.image,
  collection_text: MEDIA_COLOR.text,
  collection_video: MEDIA_COLOR.video,
  note: "#E6A700",
};

/** 生成参数预设（下拉清单；输入框仍可自由键入任意值）。尺寸值取后端
 *  可直接接受的「宽x高」（对齐 ai.rs SIZE_PRESETS_1K/2K），auto 交给
 *  模型自选；hint 作弱化尾注（比例/档位）。 */
const SIZE_PRESET_ITEMS: { value: string; label: string; hint?: string }[] = [
  { value: "auto", label: "auto", hint: "跟随模型" },
  { value: "1024x1024", label: "1024x1024", hint: "1:1" },
  { value: "1536x1024", label: "1536x1024", hint: "3:2" },
  { value: "1024x1536", label: "1024x1536", hint: "2:3" },
  { value: "1536x864", label: "1536x864", hint: "16:9" },
  { value: "864x1536", label: "864x1536", hint: "9:16" },
  { value: "1024x768", label: "1024x768", hint: "4:3" },
  { value: "768x1024", label: "768x1024", hint: "3:4" },
  { value: "2048x1152", label: "2048x1152", hint: "16:9 · 2K" },
  { value: "1152x2048", label: "1152x2048", hint: "9:16 · 2K" },
];
const MODEL_PRESET_BASE = ["gpt-image-1", "gemini-2.5-flash-image"];

/** 尺寸取值展示（用户 2026-11-01 定案）：命中预设时展示「主值 + 比例
 *  尾注」双段（与下拉条目同款），自定义值原样展示。 */
const formatSizeDisplay = (v: string): { main: string; tail?: string } => {
  const item = SIZE_PRESET_ITEMS.find((i) => i.value === v);
  return item ? { main: item.label, tail: item.hint } : { main: v };
};

interface PortDef {
  /** 输入口 id（连线 to_port / 实测锚点键）。 */
  id: string;
  /** 接受的上游节点类型（类型匹配校验）。 */
  accepts: CanvasNodeType[];
  mediaKind: "text" | "image" | "video" | "audio";
  /** 多线入口（仅合集节点）：落线追加不顶掉；其余口单线，落线顶掉旧线。 */
  multi?: boolean;
}

/** 类型化端口矩阵（用户 2026-10-31 定案）：生成节点的文本口必连、
 *  图像口可选（纯文生图）；输出节点的入口接受对应生成/加载节点。 */
const PORT_DEFS: Record<CanvasNodeType, { ins: PortDef[]; out: { mediaKind: "text" | "image" | "video" | "audio" } | null }> = {
  gen_image: {
    ins: [
      { id: "text", accepts: ["load_text", "collection_text"], mediaKind: "text" },
      { id: "image", accepts: ["load_image", "collection_image"], mediaKind: "image" },
    ],
    out: { mediaKind: "image" },
  },
  gen_video: {
    ins: [
      { id: "text", accepts: ["load_text", "collection_text"], mediaKind: "text" },
      { id: "video", accepts: ["load_video", "collection_video"], mediaKind: "video" },
      { id: "image", accepts: ["load_image", "collection_image"], mediaKind: "image" },
    ],
    out: { mediaKind: "video" },
  },
  gen_audio: {
    ins: [{ id: "text", accepts: ["load_text", "collection_text"], mediaKind: "text" }],
    out: { mediaKind: "audio" },
  },
  load_text: { ins: [], out: { mediaKind: "text" } },
  load_image: { ins: [], out: { mediaKind: "image" } },
  load_video: { ins: [], out: { mediaKind: "video" } },
  load_audio: { ins: [], out: { mediaKind: "audio" } },
  save_image: { ins: [{ id: "in", accepts: ["gen_image"], mediaKind: "image" }], out: null },
  save_video: { ins: [{ id: "in", accepts: ["gen_video"], mediaKind: "video" }], out: null },
  save_audio: { ins: [{ id: "in", accepts: ["gen_audio"], mediaKind: "audio" }], out: null },
  preview_image: { ins: [{ id: "in", accepts: ["gen_image", "load_image"], mediaKind: "image" }], out: null },
  preview_video: { ins: [{ id: "in", accepts: ["gen_video", "load_video"], mediaKind: "video" }], out: null },
  preview_audio: { ins: [{ id: "in", accepts: ["gen_audio", "load_audio"], mediaKind: "audio" }], out: null },
  // 合集：画布上唯一的多线入口；成员为对应加载节点与对应生成产物。
  collection_image: {
    ins: [{ id: "image", accepts: ["load_image", "gen_image"], mediaKind: "image", multi: true }],
    out: { mediaKind: "image" },
  },
  collection_text: {
    ins: [{ id: "text", accepts: ["load_text"], mediaKind: "text", multi: true }],
    out: { mediaKind: "text" },
  },
  collection_video: {
    ins: [{ id: "video", accepts: ["load_video", "gen_video"], mediaKind: "video", multi: true }],
    out: { mediaKind: "video" },
  },
  note: { ins: [], out: null },
};

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const VIDEO_EXTS = ["mp4", "webm", "mkv", "mov", "avi"];
const AUDIO_EXTS = ["mp3", "m4a", "aac", "flac", "ogg", "wav", "opus"];

function extOf(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

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

/** ComfyUI 风格连线贝塞尔（自 ProjectCanvas.tsx 零改动搬运）。 */
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
      frameKey: CanvasNodeType;
      /** 拖线到空白建节点：创建后自动接上这条线。 */
      wire?: { fromKey: string; fromDir: "in" | "out"; fromPortId: string };
      /** 摘线到空白建节点：创建后线改接新节点（原连线行删除）。 */
      detached?: { connId: string; fromKey: string };
    };

type UndoAction =
  | { kind: "layout"; prev: CanvasLayoutEntry[]; next: CanvasLayoutEntry[] }
  | {
      kind: "delete";
      nodes: CanvasNode[];
      connections: { from_node: string; to_node: string; to_port: string }[];
    }
  | { kind: "create"; ids: string[] };

/** 画布媒体路径归一：resource_path 的相对路径语义是「资源库相对」
 *  （选择器回填/旧 ref 数据），而 mediaUrl 域层把相对路径拼到存储根
 *  （≠资源库根）——这里先转绝对再交给域层，存量相对路径数据同样修复。 */
async function resolveCanvasMediaPath(path: string): Promise<string> {
  const trimmed = path.trim();
  if (!trimmed
    || /^(?:https?:|data:|blob:|asset:|file:)/i.test(trimmed)
    || /^[A-Za-z]:[\\/]/.test(trimmed)
    || trimmed.startsWith("\\\\")) {
    return trimmed;
  }
  const root = await invoke<string>("get_resource_library_path").catch(() => "");
  return joinLibraryPath(root, trimmed);
}

/** 画布媒体 URL：路径归一 + 域层解析（token 媒体服务）。 */
async function resolveCanvasMediaUrl(path: string, version?: string): Promise<string> {
  return resolveResourceMediaUrl(await resolveCanvasMediaPath(path), version);
}

/** 资源缩略图：mediaUrl 域层唯一出口，路径变化重解析。 */
function ResourceThumb({ path, className }: { path: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    resolveCanvasMediaUrl(path)
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

/** 资源媒体 URL（视频/音频播放用），路径变化重解析。 */
function useMediaUrl(path: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    resolveCanvasMediaUrl(path)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);
  return url;
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
    wire?: { fromKey: string; fromDir: "in" | "out"; fromPortId: string };
    /** 摘线到空白：菜单创建的节点接走这条线（原连线行删除）。 */
    detached?: { connId: string; fromKey: string };
  } | null>(null);
  const [addMenuQuery, setAddMenuQuery] = useState("");
  /** 合集列表拖拽排序（dnd-kit sortable 同款模型）：拖拽全程 DOM 顺序
   *  不变——被抓行 1:1 跟手（指针位移直写 transform），其余行按槽位
   *  让位（React 过渡）；松手才提交最终顺序并补一个落位动画。 */
  const [collectionDrag, setCollectionDrag] = useState<{
    nodeId: string;
    baseOrder: string[];
    slotTops: number[];
    stride: number;
    fromIndex: number;
    dragIndex: number;
    dy: number;
    order: string[];
  } | null>(null);
  /** 松手落位动画待办：被抓行松手时的视觉 top 与落位槽 top（均为屏幕
   *  几何），最终顺序渲染后由布局效果按差值滑入。 */
  const collectionDropRef = useRef<{ nodeId: string; connId: string; fromTop: number; toTop: number } | null>(null);

  // 松手落位：最终顺序渲染后，被抓行从松手视觉位置滑到落位槽。
  useLayoutEffect(() => {
    const drop = collectionDropRef.current;
    collectionDropRef.current = null;
    if (!drop) return;
    const row = document.querySelector<HTMLElement>(
      `.pc-node[data-key="${drop.nodeId}"] .fc-collection-item[data-conn="${drop.connId}"]`,
    );
    if (!row) return;
    const delta = (drop.fromTop - drop.toTop) / view.scale;
    // 收尾：内联过渡还原为类定义。transitionend 在后台标签页可能不触发，
    // 加超时兜底（幂等）。
    const settle = () => {
      row.style.transition = "";
      row.removeEventListener("transitionend", settle);
    };
    row.addEventListener("transitionend", settle);
    window.setTimeout(settle, 240);
    if (Math.abs(delta) < 1) {
      // 落点几乎就是目标槽位：无需反向补偿，但拖拽跟手的残值 transform
      // 还挂在行上（行是 keyed 复用的同一 DOM），必须过渡归零——否则行
      // 永久停在松手位置，还撑出表单滚动区把后续行藏进去。
      row.style.transition = "transform 0.16s cubic-bezier(0.2, 0.8, 0.3, 1)";
      row.style.transform = "";
      return;
    }
    row.style.transition = "none";
    row.style.transform = `translateY(${delta}px)`;
    void row.offsetHeight; // 强制回流：让反向位移立刻生效
    row.style.transition = "transform 0.16s cubic-bezier(0.2, 0.8, 0.3, 1)";
    row.style.transform = "";
  }, [collectionDrag, view.scale]);
  const [wireDraft, setWireDraft] = useState<{ d: string; invalid: boolean; color?: string } | null>(null);
  /** 摘线拿着（rewire）中：该连线暂隐藏，松手转接或放回。 */
  const [liftedWire, setLiftedWire] = useState<{ connId: string; fromKey: string } | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [genStarting, setGenStarting] = useState(false);
  const [nodeErrors, setNodeErrors] = useState<Record<string, string>>({});
  const [pulseKeys, setPulseKeys] = useState<string[]>([]);
  /** 资源库选择浮层：load 节点的「从资源库选择」。 */
  const [pickerForNode, setPickerForNode] = useState<string | null>(null);
  /** 大图预览（预览图像节点双击）：暂存产物路径。 */
  const [lightboxSrc, setLightboxSrc] = useState("");

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

  /** 撤销（Ctrl+Z）：layout 恢复布局；delete 重建节点/连线；create 移除。 */
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
          if (restoredMeta.kind === "gen_image" && restoredMeta.status === "generating") {
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
          await store.getState().connect(canvasId, from, to, conn.to_port);
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
      .map((c) => ({ from_node: c.from_node, to_node: c.to_node, to_port: c.to_port }));
    if (targets.length) {
      pushUndo({ kind: "delete", nodes: targets, connections: conns });
    }
    for (const node of targets) {
      // 生成中的节点先取消后端任务再删：否则孤儿请求继续跑完。
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

  // ── 节点实测尺寸与端口位置（自 ProjectCanvas 搬运）：连线锚点跟随
  //    真实 DOM（pc-port[data-port-id] 实测，常量只是首帧兜底） ──

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
    const els = Array.from(vpRef.current?.querySelectorAll<HTMLElement>(".pc-node[data-key]") ?? []);
    els.forEach((el) => ro.observe(el));
    // 节点尺寸/内容刚由 React 提交时，连线本帧就必须拿到最新端口偏移；
    // ResizeObserver 的 rAF 合帧只负责后续外部布局变化，不能成为首个测量。
    measureNodes();
    scheduleMeasureNodes();
    return () => els.forEach((el) => ro.unobserve(el));
  }, [view.scale, nodes, measureNodes, scheduleMeasureNodes]);

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
    (key: string, portId: string): { x: number; y: number } | null => {
      const box = boxOf(key);
      if (!box) return null;
      const off = nodeMetrics.ports[key]?.[portId];
      if (off) return { x: box.x + off.x, y: box.y + off.y };
      const def = PORT_DEFS[nodes.find((n) => n.id === key)?.type ?? "note"];
      const index = Math.max(0, def.ins.findIndex((p) => p.id === portId));
      const rows = Math.max(1, def.ins.length);
      return { x: box.x, y: box.y + (box.h * (index + 1)) / (rows + 1) };
    },
    [boxOf, nodeMetrics, nodes],
  );

  // ── 出生锚点脉冲：新建节点出生在用户视线附近时脉冲高亮。 ──
  useEffect(() => {
    if (pulseKeys.length === 0) return;
    const timer = window.setTimeout(() => setPulseKeys([]), 2400);
    return () => window.clearTimeout(timer);
  }, [pulseKeys]);
  const pulseNodes = useCallback((ids: string[]) => {
    if (ids.length) setPulseKeys(ids);
  }, []);

  // ── 多选组拖 / 位置批量写入 ─────────────────────────────

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
  /** 批量写入各成员的绝对位置（组拖实时移动与撤销恢复共用）。 */
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

  /** 成员当前包围盒（世界坐标；节点已删除则 null）。 */
  const memberFrame = useCallback(
    (key: string): { x: number; y: number; w: number; h: number } | null => {
      const node = nodesRef.current.find((n) => n.id === key);
      if (!node) return null;
      const size = nodeSize(node);
      return { x: node.pos_x, y: node.pos_y, w: size.w, h: size.h };
    },
    [],
  );

  // ── 复制 / 粘贴（Ctrl+C/V） ──────────────────────────────

  const clipRef = useRef<{ nodes: CanvasNode[]; wires: { from_node: string; to_node: string; to_port: string }[]; ax: number; ay: number } | null>(null);
  const copySelection = useCallback(() => {
    const members = groupSnapshot(1);
    if (!members) return;
    const ax = Math.min(...members.map((m) => m.x));
    const ay = Math.min(...members.map((m) => m.y));
    const ids = members.map((m) => m.key);
    const copied = nodesRef.current.filter((n) => ids.includes(n.id));
    const wires = connectionsRef.current
      .filter((c) => ids.includes(c.from_node) && ids.includes(c.to_node))
      .map((c) => ({ from_node: c.from_node, to_node: c.to_node, to_port: c.to_port }));
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
        if (from && to) await st.connect(canvasId, from, to, wire.to_port);
      }
      if (newIds.length) {
        pushUndo({ kind: "create", ids: newIds });
        setSelection(newIds);
      }
    } finally {
      pastingRef.current = false;
    }
  }, [canvasId, pushUndo, setSelection, store]);

  // ── 连线手势（类型化端口语义 + 工程画布手势骨架） ─────────

  /** 摘线到空白后取消菜单（Esc/点外部）＝线就此断开（ComfyUI 语义）。 */
  const discardDetachedWire = useCallback(
    (detached: { connId: string }) => {
      setLiftedWire(null);
      void store.getState().deleteConnection(detached.connId);
    },
    [store],
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
          void store.getState().deleteConnection(connId);
        },
      });
    });
    return targets;
  }, [store]);

  const openAddMenu = useCallback(
    (sx: number, sy: number, wx: number, wy: number, pending?: { wire?: { fromKey: string; fromDir: "in" | "out"; fromPortId: string }; detached?: { connId: string; fromKey: string } }) => {
      setAddMenu({ sx, sy, wx, wy, wire: pending?.wire, detached: pending?.detached });
      setAddMenuQuery("");
    },
    [],
  );

  /** 菜单建节点接回连线：算新节点上可接住的输入口 id（无可接口 = 空串
   *  不接）；菜单项过滤同样用它。 */
  const incomingPortFor = useCallback(
    (newType: CanvasNodeType, fromType: CanvasNodeType): string =>
      PORT_DEFS[newType].ins.find((p) => p.accepts.includes(fromType))?.id ?? "",
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
      if (e.button === 0 && target?.closest("input, textarea, button, video, audio")) return;

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
        if (node && PORT_DEFS[node.type].out !== null || node) {
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
    [addMenu, buildCutTargets, discardDetachedWire, groupSnapshot, groups, memberFrame, setSelection, view],
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
        store.getState().commitLayout(canvasId, [
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
        //   正拖（out）：落点节点的某个输入口 accepts 包含源节点类型，
        //     多口时吸附光标最近的口（实测行位）。
        //   反拖/摘线（in）：落点节点必须有 out 且其类型被源输入口接受。
        let targetPort: string | null = null;
        let compatible = false;
        if (drag.fromDir === "out") {
          const sourceType = fromNode?.type;
          if (tNode && tKey && sourceType && tKey !== drag.fromKey) {
            const ins = PORT_DEFS[tNode.type].ins.filter((p) => p.accepts.includes(sourceType));
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
          const inDef = PORT_DEFS[fromNode?.type ?? "note"].ins.find((p) => p.id === drag.fromPortId);
          if (tNode && inDef && tKey !== drag.fromKey) {
            compatible = inDef.accepts.includes(tNode.type);
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
        const draftColor = fromNode ? NODE_ACCENT[fromNode.type] : undefined;
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
              // 双击节点：便签进编辑；预览图像开大图；其余无全局动作。
              const node = nodesRef.current.find((n) => n.id === key);
              if (node?.type === "note" && node.metadata.kind === "note") {
                setEditingNoteId(key);
                setNoteDraft(node.metadata.content);
              } else if (node?.type === "preview_image") {
                const upstream = upstreamMediaOf(node.id);
                const primary = upstream?.paths.find((_, i) => i === 0);
                if (primary) setLightboxSrc(primary);
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
            const toNode = nodesRef.current.find((n) => n.id === targetKey);
            const multi = toNode ? PORT_DEFS[toNode.type].ins.find((p) => p.id === targetPort)?.multi : false;
            if (!multi) {
              const old = connectionsRef.current.find((c) => c.to_node === targetKey && c.to_port === targetPort && c.id !== lifted.connId);
              if (old) void store.getState().deleteConnection(old.id);
            }
            void store.getState().rewire(lifted.connId, targetKey, targetPort);
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
          const toNode = nodesRef.current.find((n) => n.id === toKey);
          const multi = toNode ? PORT_DEFS[toNode.type].ins.find((p) => p.id === toPort)?.multi : false;
          if (!multi) {
            const old = connectionsRef.current.find((c) => c.to_node === toKey && c.to_port === toPort && c.from_node !== fromKey);
            if (old) void store.getState().deleteConnection(old.id);
          }
          void store.getState().connect(canvasId, fromKey, toKey, toPort);
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
        // 到空白」菜单进入时，创建的节点自动接上那条线。
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
          const fromNode = drag.wire ? nodesRef.current.find((n) => n.id === drag.wire!.fromKey) : undefined;
          if (drag.detached) {
            // 摘线转接：线改接新节点（新节点需要能接住原上游的口）。
            setLiftedWire(null);
            const toPort = fromNode ? incomingPortFor(created.type, fromNode.type) : "";
            await store.getState().rewire(drag.detached.connId, created.id, toPort);
          } else if (drag.wire && fromNode) {
            if (drag.wire.fromDir === "out") {
              // 正拖：新节点是下游，找它可接住上游的输入口。
              const toPort = incomingPortFor(created.type, fromNode.type);
              await store.getState().connect(canvasId, drag.wire.fromKey, created.id, toPort);
            } else {
              // 反拖：新节点是上游，接进源输入口。
              await store.getState().connect(canvasId, created.id, drag.wire.fromKey, drag.wire.fromPortId);
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

  // ── 键盘：删除选中、撤销、全选、复制粘贴、打组 ─────────────

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
    // 先剪枝：成员已被删除的组清掉死成员（空组丢弃）。
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      // 面板保挂载：画布被 display:none 隐藏（用户在其他顶级区）时不响应。
      if (!vpRef.current || vpRef.current.offsetParent === null) return;
      // 弹层打开时不响应（对齐工程画布惯例）。
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
  }, [addMenu, copySelection, deleteSelected, pasteClipboard, runUndo, setSelection, toggleGroup]);

  // ── 上游媒体解析（预览/保存节点取上游产物） ────────────────

  /** 入线第一根的上游节点（预览/保存节点都是单入口）。 */
  function upstreamNodeOf(nodeId: string): CanvasNode | undefined {
    const conn = connections.find((c) => c.to_node === nodeId);
    return conn ? nodes.find((n) => n.id === conn.from_node) : undefined;
  }

  /** 上游产物聚合。null 严格表示「没有上游连接」；连了但暂无产物（生成
   *  中 / 未生成 / 加载节点还没选文件）返回空 paths，供占位文案区分
   *  「未连接上游」与「已连接，等待产物」。 */
  function upstreamMediaOf(nodeId: string): { paths: string[]; text: string } | null {
    const from = upstreamNodeOf(nodeId);
    if (!from) return null;
    if (from.type === "gen_image" && from.metadata.kind === "gen_image") {
      const sorted = [...from.metadata.images].sort((a, b) => (a.primary === b.primary ? 0 : a.primary ? -1 : 1));
      return { paths: sorted.map((img) => img.resource_path), text: "" };
    }
    if (from.type === "gen_video" || from.type === "gen_audio") {
      // 视频/音频生成协议未接入：连接成立但恒无产物。
      return { paths: [], text: "" };
    }
    if (from.type === "load_text" && from.metadata.kind === "load_text") {
      return { paths: [], text: from.metadata.content };
    }
    if (from.resource_path) {
      return { paths: [from.resource_path], text: "" };
    }
    // 加载节点已连上但还没选文件。
    return { paths: [], text: "" };
  }

  /** 生成前提校验（用户定案）：文本口已连非空文本 + 输出口已连保存/预览；
   *  图像口（参考图）可选。文本来源可以是文本合集（有成员即视为就绪，
   *  空内容成员由后端聚合时跳过）。返回缺失清单供按钮旁提示。 */
  function genReadinessOf(node: CanvasNode): string[] {
    const missing: string[] = [];
    const textConn = connections.some((c) => {
      if (c.to_node !== node.id || c.to_port !== "text") return false;
      const from = nodes.find((n) => n.id === c.from_node);
      if (!from) return false;
      if (from.type === "load_text") {
        return from.metadata.kind === "load_text" && from.metadata.content.trim().length > 0;
      }
      if (from.type === "collection_text") {
        return connections.some((m) => m.to_node === from.id);
      }
      return false;
    });
    if (!textConn) missing.push(t("canvas.genMissingText"));
    const outConn = connections.some((c) => c.from_node === node.id);
    if (!outConn) missing.push(t("canvas.genMissingOut"));
    return missing;
  }

  // ── 合集节点（唯一多线入口）：成员解析 + 拖拽排序 ─────────

  /** 合集成员按用户排序（metadata.order，重排进行时用草稿）展开；
   *  未登记的新连线按连线创建时间补尾。 */
  function collectionItemsOf(node: CanvasNode): {
    connId: string;
    from: CanvasNode;
    kind: "image" | "text" | "video";
    path: string;
    label: string;
  }[] {
    const meta = node.metadata;
    if (meta.kind !== "collection_image" && meta.kind !== "collection_text" && meta.kind !== "collection_video") return [];
    const conns = connections
      .filter((c) => c.to_node === node.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const byFrom = new Map(conns.map((c) => [c.from_node, c]));
    // 拖拽进行时按开始顺序渲染（DOM 顺序全程不变，靠 transform 表达位移）。
    const drag = collectionDrag?.nodeId === node.id ? collectionDrag : null;
    const order = drag ? drag.baseOrder : meta.order;
    const orderedIds: string[] = [];
    for (const id of order) {
      if (byFrom.has(id) && !orderedIds.includes(id)) orderedIds.push(id);
    }
    for (const c of conns) {
      if (!orderedIds.includes(c.from_node)) orderedIds.push(c.from_node);
    }
    return orderedIds
      .map((fromId) => {
        const conn = byFrom.get(fromId);
        const from = nodes.find((n) => n.id === fromId);
        if (!conn || !from) return null;
        if (node.type === "collection_text") {
          const content = from.metadata.kind === "load_text" ? from.metadata.content.trim() : "";
          return { connId: conn.id, from, kind: "text" as const, path: "", label: content || t("canvas.collectionItemEmpty") };
        }
        // 图像 / 视频合集：加载节点取资源路径，生成节点取主产物。
        let path = from.resource_path;
        if (!path && from.metadata.kind === "gen_image") {
          path = [...from.metadata.images]
            .sort((a, b) => (a.primary === b.primary ? 0 : a.primary ? -1 : 1))[0]?.resource_path ?? "";
        }
        return {
          connId: conn.id,
          from,
          kind: node.type === "collection_image" ? ("image" as const) : ("video" as const),
          path,
          label: path.split(/[\\/]/).pop() ?? "",
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }

  /** 列表把手拖拽排序（剪切板/快捷输入 dnd-kit 手感的指针实现）：抓起
   *  的行 1:1 跟手，其他行在跨槽时让位过渡；松手提交最终顺序并落位。 */
  const startCollectionReorder = (node: CanvasNode, index: number, e: React.PointerEvent<HTMLButtonElement>) => {
    const items = collectionItemsOf(node);
    if (items.length < 2) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const listEl = handle.closest(".fc-collection-list");
    if (!listEl) return;
    const meta = node.metadata;
    if (meta.kind !== "collection_image" && meta.kind !== "collection_text" && meta.kind !== "collection_video") return;
    const baseOrder = items.map((i) => i.from.id);
    const rowTops = items.map((_, i) => {
      const r = listEl.querySelector<HTMLElement>(`.fc-collection-item[data-idx="${i}"]`);
      return r ? r.getBoundingClientRect().top : 0;
    });
    const stride = items.length > 1 ? rowTops[1] - rowTops[0] : 0;
    if (stride <= 0) return;
    const draggedId = baseOrder[index];
    const draggedConnId = items[index].connId;
    const rowEl = handle.closest<HTMLElement>(".fc-collection-item");
    rowEl?.classList.add("is-dragging");
    // 上轮落位的内联过渡若还在（超时兜底前再次抓取），先清掉——内联
    // 样式优先于 .is-dragging 的类定义，会让跟手产生 0.16s 的过渡延迟。
    if (rowEl) rowEl.style.transition = "";
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // 指针不可捕获（合成事件等）：退化为元素监听。
    }
    const y0 = e.clientY;
    let dragIndex = index;
    const logical = [...baseOrder];
    let dy = 0;
    const onMove = (ev: PointerEvent) => {
      dy = ev.clientY - y0;
      // 跟手：行在缩放世界内，transform 必须换算成世界坐标——否则画布
      // 缩放 k≠1 时行移动 k×指针位移，「滑一下跑老远」。
      const dyWorld = dy / view.scale;
      rowEl?.style.setProperty("transform", `translateY(${dyWorld}px)`);
      // 槽位判定：被抓行中心点落在哪个基准槽位（几何计算，不受动画影响）。
      const centerY = rowTops[index] + dy + stride / 2;
      let idx = Math.floor((centerY - rowTops[0]) / stride);
      idx = Math.max(0, Math.min(items.length - 1, idx));
      if (idx !== dragIndex) {
        const pos = logical.indexOf(draggedId);
        const [moved] = logical.splice(pos, 1);
        logical.splice(idx, 0, moved);
        dragIndex = idx;
        setCollectionDrag({
          nodeId: node.id, baseOrder, slotTops: rowTops, stride,
          fromIndex: index, dragIndex, dy, order: [...logical],
        });
      }
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      // transform 保持跟手值不动：DOM 重排提交后，布局效果会在绘制前
      // 把 transform 换成「视觉保持不动」的落位补偿值再过渡归零——
      // 提前设置会以旧布局为基准，松手瞬间跳一下。
      const finalOrder = [...logical];
      collectionDropRef.current = {
        nodeId: node.id, connId: draggedConnId,
        fromTop: rowTops[index] + dy, toTop: rowTops[dragIndex],
      };
      setCollectionDrag(null);
      void store.getState().updateNode(node.id, {
        metadata: JSON.stringify({ ...meta, order: finalOrder }),
      });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  // ── 生图（图像生成节点）：参数编辑、生成、主图切换 ─────────

  const commitContent = (node: CanvasNode, content: string) => {
    if (node.metadata.kind !== "load_text" && node.metadata.kind !== "note") return;
    const meta = { ...node.metadata, content } as CanvasNode["metadata"];
    void store.getState().updateNode(node.id, { metadata: JSON.stringify(meta) });
  };

  const commitImageParams = (
    node: CanvasNode,
    patch: { model?: string; size?: string; count?: number },
  ) => {
    if (node.metadata.kind !== "gen_image" && node.metadata.kind !== "gen_video" && node.metadata.kind !== "gen_audio") return;
    const meta = { ...node.metadata, params: { ...node.metadata.params, ...patch } };
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

  // ── 加载节点：资源库选择 / 本地文件 / 拖入 ────────────────

  const pickFromLibrary = (node: CanvasNode, kind: string) => {
    setPickerForNode(node.id);
    // kind 供浮层标题区分（图像/视频/音频/文本）。
    void kind;
  };

  const pickFromDisk = async (node: CanvasNode) => {
    try {
      const picked = await invoke<{ path: string }>("canvas_pick_media_file");
      await store.getState().updateNode(node.id, { resourcePath: picked.path });
    } catch (err) {
      // 用户在系统对话框取消：静默；其余错误在节点上提示。
      const msg = String(err);
      if (!msg.includes("cancelled") && !msg.includes("取消")) {
        setNodeErrors((prev) => ({ ...prev, [node.id]: msg }));
      }
    }
  };

  // ── 保存节点：入库 / 另存 ─────────────────────────────────

  const saveUpstreamToLibrary = async (node: CanvasNode) => {
    const upstream = upstreamMediaOf(node.id);
    if (!upstream?.paths.length) return;
    const savedPaths: string[] = [];
    try {
      for (const path of upstream.paths) {
        const result = await invoke<{ file_path: string }>("canvas_save_to_library", { sourcePath: path });
        savedPaths.push(result.file_path);
      }
      if (node.metadata.kind === "save_image" || node.metadata.kind === "save_video" || node.metadata.kind === "save_audio") {
        const meta = {
          ...node.metadata,
          status: "saved",
          error: "",
          target: "library",
          saved_path: savedPaths[0] ?? "",
        };
        void store.getState().updateNode(node.id, { metadata: JSON.stringify(meta) });
      }
    } catch (err) {
      if (node.metadata.kind === "save_image" || node.metadata.kind === "save_video" || node.metadata.kind === "save_audio") {
        const meta = { ...node.metadata, status: "error", error: String(err) };
        void store.getState().updateNode(node.id, { metadata: JSON.stringify(meta) });
      } else {
        setNodeErrors((prev) => ({ ...prev, [node.id]: String(err) }));
      }
    }
  };

  const saveUpstreamToPath = async (node: CanvasNode, sourcePath: string, defaultName: string) => {
    try {
      const target = await invoke<string>("canvas_pick_save_path", { defaultName });
      if (!target) return; // 用户取消
      await invoke("canvas_export_to_path", { sourcePath, target });
      if (node.metadata.kind === "save_image" || node.metadata.kind === "save_video" || node.metadata.kind === "save_audio") {
        const meta = { ...node.metadata, status: "saved", error: "", target: "path", saved_path: target };
        void store.getState().updateNode(node.id, { metadata: JSON.stringify(meta) });
      }
    } catch (err) {
      const msg = String(err);
      if (msg.includes("cancelled") || msg.includes("取消")) return;
      if (node.metadata.kind === "save_image" || node.metadata.kind === "save_video" || node.metadata.kind === "save_audio") {
        const meta = { ...node.metadata, status: "error", error: msg };
        void store.getState().updateNode(node.id, { metadata: JSON.stringify(meta) });
      } else {
        setNodeErrors((prev) => ({ ...prev, [node.id]: msg }));
      }
    }
  };

  /** 多产物「另存到…」：选目标文件夹，产物按原文件名逐张导出（重名覆盖，
   *  与单文件另存同一显式动作语义）。单产物时走单文件对话框更精确。 */
  const saveUpstreamToDir = async (node: CanvasNode, paths: string[]) => {
    if (paths.length === 1) {
      await saveUpstreamToPath(node, paths[0], paths[0].split(/[\\/]/).pop() ?? "产物");
      return;
    }
    const writeMeta = (patch: { status: string; error: string; target?: string; saved_path?: string }) => {
      if (node.metadata.kind === "save_image" || node.metadata.kind === "save_video" || node.metadata.kind === "save_audio") {
        void store.getState().updateNode(node.id, {
          metadata: JSON.stringify({ ...node.metadata, ...patch }),
        });
      } else {
        if (patch.status === "error") setNodeErrors((prev) => ({ ...prev, [node.id]: patch.error }));
      }
    };
    try {
      const dir = await invoke<string>("canvas_pick_save_dir");
      if (!dir) return; // 用户取消
      const base = dir.replace(/[\\/]+$/, "");
      for (const path of paths) {
        const name = path.split(/[\\/]/).pop() ?? "产物";
        await invoke("canvas_export_to_path", { sourcePath: path, target: `${base}/${name}` });
      }
      writeMeta({ status: "saved", error: "", target: "path", saved_path: base });
    } catch (err) {
      const msg = String(err);
      if (msg.includes("cancelled") || msg.includes("取消")) return;
      writeMeta({ status: "error", error: msg });
    }
  };

  /** 清除加载节点已选文件（右上角悬浮 ×）：resource_path 置空串即回到
   *  未加载态，节点保留可重选。 */
  const clearLoadedMedia = (node: CanvasNode) => {
    void store.getState().updateNode(node.id, { resourcePath: "" });
  };

  // ── 空画布示意（方案 3.6）：一键创建 文本→图像生成→预览 工作流 ──

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
      nodeType: "load_text",
      posX: center.x - 420,
      posY: center.y - 60,
      width: NODE_DEFAULT_SIZE.load_text.w,
      height: NODE_DEFAULT_SIZE.load_text.h,
      metadata: JSON.stringify({ kind: "load_text", content: t("canvas.seedPrompt") }),
    });
    if (!text) return;
    const img = await st.createNode({
      canvasId,
      nodeType: "gen_image",
      posX: center.x - 60,
      posY: center.y - 130,
      width: NODE_DEFAULT_SIZE.gen_image.w,
      height: NODE_DEFAULT_SIZE.gen_image.h,
    });
    if (!img) return;
    const preview = await st.createNode({
      canvasId,
      nodeType: "preview_image",
      posX: center.x + 330,
      posY: center.y - 110,
      width: NODE_DEFAULT_SIZE.preview_image.w,
      height: NODE_DEFAULT_SIZE.preview_image.h,
    });
    await st.connect(canvasId, text.id, img.id, "text");
    if (preview) await st.connect(canvasId, img.id, preview.id, "in");
    pushUndo({ kind: "create", ids: [text.id, img.id, ...(preview ? [preview.id] : [])] });
    pulseNodes([text.id, img.id, ...(preview ? [preview.id] : [])]);
    setSelection([text.id, img.id]);
    // 种子完成后整体适配窗口。
    if (fitAll(store.getState().nodes)) {
      fitAttemptedRef.current = true;
    }
  }, [canvasId, fitAll, pushUndo, pulseNodes, setSelection, store, t, view.scale, view.x, view.y]);

  // ── OS 文件拖入：命中加载节点 = 加载到该节点；空白 = 新建加载节点 ──

  const [dropHint, setDropHint] = useState(false);

  const handleFileDrop = useCallback(
    async (paths: string[], logical: { x: number; y: number }) => {
      const rect = vpRef.current?.getBoundingClientRect();
      const world = rect
        ? {
            x: (logical.x - rect.left - view.x) / view.scale,
            y: (logical.y - rect.top - view.y) / view.scale,
          }
        : { x: 0, y: 0 };
      // 命中加载节点：按节点类型过滤扩展名，加载到该节点（多文件取首张）。
      const hitEl = document.elementFromPoint(logical.x, logical.y) as Element | null;
      const targetNodeEl = hitEl?.closest(".pc-node[data-key]");
      const targetId = targetNodeEl?.getAttribute("data-key") ?? "";
      const targetNode = nodesRef.current.find((n) => n.id === targetId);
      if (targetNode && (targetNode.type === "load_image" || targetNode.type === "load_video" || targetNode.type === "load_audio")) {
        const allowed = targetNode.type === "load_image" ? IMAGE_EXTS : targetNode.type === "load_video" ? VIDEO_EXTS : AUDIO_EXTS;
        const match = paths.find((p) => allowed.includes(extOf(p)));
        if (match) {
          await invoke("canvas_authorize_media", { path: match }).catch(() => {});
          await store.getState().updateNode(targetNode.id, { resourcePath: match });
          return;
        }
        return;
      }
      // 空白：图片 → 新建加载图像节点（每张一个，错开 24px）。
      let offset = 0;
      const createdIds: string[] = [];
      for (const path of paths) {
        if (!IMAGE_EXTS.includes(extOf(path))) continue;
        try {
          await invoke("canvas_authorize_media", { path }).catch(() => {});
          const node = await store.getState().createNode({
            canvasId,
            nodeType: "load_image",
            posX: world.x + offset,
            posY: world.y + offset,
            width: NODE_DEFAULT_SIZE.load_image.w,
            height: NODE_DEFAULT_SIZE.load_image.h,
            resourcePath: path,
          });
          if (node) createdIds.push(node.id);
          offset += 24;
        } catch (err) {
          console.error("拖入加载失败:", err);
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

  // ── 批量生成：多选图像生成节点 → 队列顺序执行 ─────────────

  const batchRunningRef = useRef(false);
  const selectedGenIds = selKeys.filter((id) => nodes.find((n) => n.id === id)?.type === "gen_image");
  const runBatch = useCallback(async () => {
    if (batchRunningRef.current) return;
    batchRunningRef.current = true;
    try {
      for (const id of selectedGenIds) {
        const node = nodesRef.current.find((n) => n.id === id);
        if (node) await startGenerate(node);
      }
    } finally {
      batchRunningRef.current = false;
    }
    // startGenerate 依赖 canvasId/store，经其闭包稳定；选中集变化由渲染期值传入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGenIds.join(",")]);

  // ── 渲染 ───────────────────────────────────────────────────

  // 连线层（卡片之下）：按视口尺寸渲染 + 平移组换算世界坐标。
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

  // 端口行（对齐工程画布）：每行一个输入口（点 + 名称），首行右端输出
  // 口。口点色按媒体类型；data-port-id 供实测锚点与摘线/落点识别。
  function portBarOf(node: CanvasNode): ReactNode {
    const def = PORT_DEFS[node.type];
    if (def.ins.length === 0 && !def.out) return null;
    const rows = Math.max(def.ins.length, def.out ? 1 : 0);
    return (
      <div className="pc-port-bar">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="pc-port-row">
            {def.ins[i] ? (
              <>
                <span
                  className="pc-port pc-port-in"
                  data-port="in"
                  data-port-id={def.ins[i].id}
                  style={{ background: MEDIA_COLOR[def.ins[i].mediaKind] }}
                />
                <span className="pc-port-name">{t(`canvas.port.${def.ins[i].mediaKind}`)}</span>
              </>
            ) : null}
            {i === 0 && def.out ? (
              <>
                <span className="pc-port-name pc-port-name-out">{t(`canvas.port.${def.out.mediaKind}`)}</span>
                <span
                  className="pc-port pc-port-out"
                  data-port="out"
                  data-port-id="__out"
                  style={{ background: NODE_ACCENT[node.type] }}
                />
              </>
            ) : null}
          </div>
        ))}
      </div>
    );
  }

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

  // 菜单条目（按三类链路分组 + 便签）：搜索过滤 + 连线续接的 accepts
  // 过滤（拖线/摘线到空白时只列能接上的节点类型）。
  const menuGroups: { key: string; types: CanvasNodeType[] }[] = [
    { key: "gen", types: ["gen_image", "gen_video", "gen_audio"] },
    { key: "load", types: ["load_text", "load_image", "load_video", "load_audio"] },
    { key: "collection", types: ["collection_text", "collection_image", "collection_video"] },
    { key: "output", types: ["save_image", "preview_image", "save_video", "preview_video", "save_audio", "preview_audio"] },
    { key: "misc", types: ["note"] },
  ];
  const menuIconOf = (type: CanvasNodeType): ReactNode => {
    switch (type) {
      case "gen_image": return Icons.image;
      case "gen_video": case "load_video": case "preview_video": case "collection_video": return Icons.video;
      case "gen_audio": case "load_audio": case "save_audio": case "preview_audio": return Icons.audio;
      case "load_text": return Icons.file;
      case "load_image": return Icons.image;
      case "collection_image": return Icons.copy;
      case "collection_text": return Icons.copy;
      case "save_image": case "save_video": return Icons.resources;
      case "preview_image": return Icons.expand;
      default: return Icons.edit;
    }
  };
  const menuFilterType = (type: CanvasNodeType): boolean => {
    const pending = addMenu?.wire ?? (addMenu?.detached ? { fromKey: addMenu.detached.fromKey, fromDir: "in" as const, fromPortId: "" } : null);
    if (!pending) return true;
    const fromNode = nodes.find((n) => n.id === pending.fromKey);
    if (!fromNode) return true;
    if (pending.fromDir === "out") {
      // 正拖：新节点需要能接住上游类型的输入口。
      return PORT_DEFS[type].ins.some((p) => p.accepts.includes(fromNode.type));
    }
    if (pending.fromDir === "in" && !addMenu?.detached) {
      // 反拖：新节点是上游，需有 out 且被源输入口接受。
      const inDef = PORT_DEFS[fromNode.type].ins.find((p) => p.id === pending.fromPortId);
      return !!PORT_DEFS[type].out && (!inDef || inDef.accepts.includes(type));
    }
    // 摘线：新节点作为下游，需要能接住原上游的口。
    return PORT_DEFS[type].ins.some((p) => p.accepts.includes(fromNode.type));
  };

  const lightboxUrl = useMediaUrl(lightboxSrc);

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
                const from = nodes.find((n) => n.id === conn.from_node);
                const to = nodes.find((n) => n.id === conn.to_node);
                if (!from || !to) return null;
                const a = outPointOf(from.id);
                const b = inPointOf(to.id, conn.to_port || PORT_DEFS[to.type].ins[0]?.id || "in");
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

          {/* 节点分组框（Ctrl+G）：框自适应成员包围盒，渲染在节点层之下。 */}
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
            const autoHeight = node.height == null;
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
              // 便签节点：标准头栏卡 + 琥珀内嵌便签体，双击进入编辑。
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
                      height: autoHeight ? undefined : size.h,
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
                  {resizeHandle}
                </div>
              );
            }

            // ── 节点体（按类型）：生成 / 加载 / 输出三类链路 ──
            let body: ReactNode = null;
            if (node.type === "load_text" && meta.kind === "load_text") {
              body = (
                <div className="fc-node-form">
                  <textarea
                    className="fc-node-edit is-inline"
                    key={`t-${node.id}-${node.updated_at}`}
                    defaultValue={meta.content}
                    placeholder={t("canvas.loadTextPlaceholder")}
                    onBlur={(e) => commitContent(node, e.target.value)}
                  />
                </div>
              );
            } else if (node.type === "load_image" || node.type === "load_video" || node.type === "load_audio") {
              body = (
                <div className="fc-node-form">
                  {node.resource_path ? (
                    <div className="fc-load-media">
                      {node.type === "load_image" ? (
                        <ResourceThumb path={node.resource_path} className="fc-thumb-cover" />
                      ) : node.type === "load_video" ? (
                        <ResourceMediaPlayer kind="video" path={node.resource_path} />
                      ) : (
                        <ResourceMediaPlayer kind="audio" path={node.resource_path} />
                      )}
                      {/* 悬浮右上角的圆形 ×：清除已选文件回到未加载态，
                          不必删节点重来。 */}
                      <NodeHint text={t("canvas.clearLoaded")}>
                        <button
                          type="button"
                          className="fc-load-clear"
                          aria-label={t("canvas.clearLoaded")}
                          onClick={(e) => {
                            e.stopPropagation();
                            clearLoadedMedia(node);
                          }}
                        >
                          {Icons.close}
                        </button>
                      </NodeHint>
                    </div>
                  ) : (
                    <div className="fc-node-placeholder">{t("canvas.loadEmpty")}</div>
                  )}
                  <div className="fc-node-row">
                    <NodeHint text={t("canvas.loadFromLibrary")} className="is-grow">
                      <button
                        className="fc-node-btn ghost is-icon grow"
                        aria-label={t("canvas.loadFromLibrary")}
                        onClick={() => pickFromLibrary(node, node.type)}
                      >
                        {Icons.resources}
                      </button>
                    </NodeHint>
                    <NodeHint text={t("canvas.loadFromFile")} className="is-grow">
                      <button
                        className="fc-node-btn ghost is-icon grow"
                        aria-label={t("canvas.loadFromFile")}
                        onClick={() => void pickFromDisk(node)}
                      >
                        {Icons.folderOpen}
                      </button>
                    </NodeHint>
                  </div>
                  <div className="fc-load-hint">{t("canvas.loadDropHint")}</div>
                  {nodeErrors[node.id] && <div className="fc-gen-warn">{nodeErrors[node.id]}</div>}
                </div>
              );
            } else if (node.type === "gen_image" && meta.kind === "gen_image") {
              const missing = genReadinessOf(node);
              body = (
                <div className="fc-node-form">
                  <div className="fc-param">
                    <NodeHint text={t("canvas.genModelLabel")} className="fc-param-ico-host">
                      <span className="fc-param-ico">{Icons.chip}</span>
                    </NodeHint>
                    <ParamCombo
                      comboKey={`gm-${node.id}-${node.updated_at}`}
                      value={meta.params.model}
                      items={[...new Set([modelFallback, ...MODEL_PRESET_BASE])].map((m) => ({ value: m, label: m }))}
                      placeholder={modelFallback}
                      toggleTitle={t("canvas.comboPresets")}
                      onCommit={(model) => commitImageParams(node, { model })}
                    />
                  </div>
                  <div className="fc-param">
                    <NodeHint text={t("canvas.genSizeLabel")} className="fc-param-ico-host">
                      <span className="fc-param-ico">{Icons.crop}</span>
                    </NodeHint>
                    <ParamCombo
                      comboKey={`gs-${node.id}-${node.updated_at}`}
                      value={meta.params.size}
                      items={SIZE_PRESET_ITEMS}
                      placeholder="auto"
                      display={formatSizeDisplay}
                      toggleTitle={t("canvas.comboPresets")}
                      onCommit={(size) => commitImageParams(node, { size })}
                    />
                    <NodeHint text={t("canvas.genCountLabel")}>
                      <div className="fc-stepper">
                        <button
                          type="button"
                          className="fc-stepper-btn"
                          aria-label={t("canvas.genCountLabel")}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => commitImageParams(node, { count: Math.max(1, meta.params.count - 1) })}
                        >
                          {Icons.minus}
                        </button>
                        <span className="fc-stepper-val">{meta.params.count}</span>
                        <button
                          type="button"
                          className="fc-stepper-btn"
                          aria-label={t("canvas.genCountLabel")}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => commitImageParams(node, { count: Math.min(15, meta.params.count + 1) })}
                        >
                          {Icons.add}
                        </button>
                      </div>
                    </NodeHint>
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
                    <NodeHint text={missing.length > 0 ? t("canvas.genNotReady", { items: missing.join("、") }) : ""}>
                      <button
                        className="fc-node-btn accent"
                        disabled={genStarting || missing.length > 0}
                        onClick={() => void startGenerate(node)}
                      >
                        {meta.status === "done" ? t("canvas.regenerate") : t("canvas.genButton")}
                      </button>
                    </NodeHint>
                  )}
                  {nodeErrors[node.id] && <div className="fc-gen-warn">{nodeErrors[node.id]}</div>}
                  {meta.status === "error" && meta.error && <div className="fc-gen-warn">{meta.error}</div>}
                  {meta.images.length > 0 && (
                    <div className="fc-gen-thumbs">
                      {meta.images.map((thumb, i) => (
                        <NodeHint
                          key={i}
                          text={thumb.primary ? t("canvas.genPrimary") : t("canvas.genSetPrimary")}
                        >
                          <button
                            className={`fc-gen-thumb${thumb.primary ? " primary" : ""}`}
                            onClick={() => {
                              const images = meta.images.map((img, j) => ({ ...img, primary: j === i }));
                              void store.getState().updateNode(node.id, {
                                metadata: JSON.stringify({ ...meta, images } as CanvasNode["metadata"]),
                              });
                            }}
                          >
                            <ResourceThumb path={thumb.resource_path} className="fc-thumb" />
                            {thumb.primary && <span className="fc-gen-primary-badge">{t("canvas.genPrimary")}</span>}
                          </button>
                        </NodeHint>
                      ))}
                    </div>
                  )}
                </div>
              );
            } else if (node.type === "gen_video" || node.type === "gen_audio") {
              const notReadyKey = node.type === "gen_video" ? "canvas.genVideoNotReady" : "canvas.genAudioNotReady";
              body = (
                <div className="fc-node-form">
                  <div className="fc-param">
                    <NodeHint text={t("canvas.genModelLabel")} className="fc-param-ico-host">
                      <span className="fc-param-ico">{Icons.chip}</span>
                    </NodeHint>
                    <ParamCombo
                      comboKey={`gm-${node.id}-${node.updated_at}`}
                      value={meta.kind === "gen_video" || meta.kind === "gen_audio" ? meta.params.model : ""}
                      items={[...new Set([modelFallback, ...MODEL_PRESET_BASE])].map((m) => ({ value: m, label: m }))}
                      placeholder={modelFallback}
                      toggleTitle={t("canvas.comboPresets")}
                      onCommit={(model) => commitImageParams(node, { model })}
                    />
                  </div>
                  <NodeHint text={t(notReadyKey)}>
                    <button className="fc-node-btn accent" disabled aria-label={t(notReadyKey)}>
                      {t("canvas.genButton")}
                    </button>
                  </NodeHint>
                  {nodeErrors[node.id] && <div className="fc-gen-warn">{nodeErrors[node.id]}</div>}
                </div>
              );
            } else if (node.type === "collection_image" || node.type === "collection_text" || node.type === "collection_video") {
              // 合集节点：多线汇入的有序列表——序号 + 缩略/内容 + 拖拽
              // 把手（剪切板/快捷输入同款）+ 悬停移除。节点体不再放其他
              // 内容，为生成等待动画留白。
              const items = collectionItemsOf(node);
              body = (
                <div className="fc-node-form">
                  {items.length === 0 ? (
                    <div className="fc-node-placeholder">{t("canvas.collectionEmpty")}</div>
                  ) : (
                    <div className="fc-collection-list">
                      {items.map((item, i) => {
                        const drag = collectionDrag?.nodeId === node.id ? collectionDrag : null;
                        const orig = drag ? drag.baseOrder.indexOf(item.from.id) : -1;
                        const isDragged = !!drag && orig === drag.fromIndex;
                        // 让位位移：stride 是屏幕几何，transform 在缩放世界内，需换算。
                        let shift = 0;
                        if (drag && orig >= 0 && !isDragged) {
                          if (drag.fromIndex < drag.dragIndex && orig > drag.fromIndex && orig <= drag.dragIndex) shift = -drag.stride / view.scale;
                          else if (drag.fromIndex > drag.dragIndex && orig >= drag.dragIndex && orig < drag.fromIndex) shift = drag.stride / view.scale;
                        }
                        return (
                        <div
                          key={item.connId}
                          className={`fc-collection-item${isDragged ? " is-dragging" : ""}`}
                          data-idx={i}
                          data-conn={item.connId}
                          style={shift ? { transform: `translateY(${shift}px)` } : undefined}
                        >
                          <span className="fc-collection-idx">{i + 1}</span>
                          {item.kind === "image" && item.path ? (
                            <ResourceThumb path={item.path} className="fc-collection-thumb" />
                          ) : (
                            <span className={`fc-collection-text${item.kind !== "text" && !item.path ? " is-empty" : ""}`}>
                              {item.kind === "text" || item.label ? item.label : t("canvas.collectionItemEmpty")}
                            </span>
                          )}
                          <NodeHint text={t("canvas.collectionSortHint")} className="is-handle">
                            <button
                              type="button"
                              className="fc-collection-handle"
                              aria-label={t("canvas.collectionSortHint")}
                              onPointerDown={(e) => startCollectionReorder(node, i, e)}
                            >
                              {Icons.drag}
                            </button>
                          </NodeHint>
                          <NodeHint text={t("common.delete")} className="is-remove">
                            <button
                              type="button"
                              className="fc-collection-remove"
                              aria-label={t("common.delete")}
                              onClick={(e) => {
                                e.stopPropagation();
                                void store.getState().deleteConnection(item.connId);
                              }}
                            >
                              {Icons.close}
                            </button>
                          </NodeHint>
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            } else if (node.type === "save_image" || node.type === "save_video" || node.type === "save_audio") {
              const upstreamNode = upstreamNodeOf(node.id);
              const upstream = upstreamMediaOf(node.id);
              const hasProduct = !!upstream?.paths.length;
              const saved = meta.kind === "save_image" || meta.kind === "save_video" || meta.kind === "save_audio" ? meta : null;
              body = (
                <div className="fc-node-form">
                  {!upstreamNode ? (
                    <div className="fc-node-placeholder">{t("canvas.previewEmpty")}</div>
                  ) : !hasProduct ? (
                    <div className="fc-node-placeholder">{t("canvas.waitingUpstream")}</div>
                  ) : (
                    <div className="fc-gen-thumbs">
                      {upstream!.paths.map((path, i) => (
                        <span key={i} className="fc-save-item">
                          {node.type === "save_image" ? (
                            <ResourceThumb path={path} className="fc-thumb" />
                          ) : (
                            <span className="fc-save-name">{path.split(/[\\/]/).pop()}</span>
                          )}
                          <NodeHint text={t("canvas.saveSaveAs")}>
                            <button
                              className="fc-node-btn ghost is-tiny is-icon"
                              aria-label={t("canvas.saveSaveAs")}
                              onClick={() => void saveUpstreamToPath(node, path, path.split(/[\\/]/).pop() ?? "产物")}
                            >
                              {Icons.floppy}
                            </button>
                          </NodeHint>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="fc-node-row">
                    <NodeHint text={t("canvas.saveToLibrary")} className="is-grow">
                      <button
                        className="fc-node-btn accent is-icon grow"
                        disabled={!hasProduct}
                        aria-label={t("canvas.saveToLibrary")}
                        onClick={() => void saveUpstreamToLibrary(node)}
                      >
                        {Icons.saveTray}
                      </button>
                    </NodeHint>
                    <NodeHint text={t("canvas.saveSaveAs")} className="is-grow">
                      <button
                        className="fc-node-btn ghost is-icon grow"
                        disabled={!hasProduct}
                        aria-label={t("canvas.saveSaveAs")}
                        onClick={() => void saveUpstreamToDir(node, upstream?.paths ?? [])}
                      >
                        {Icons.floppy}
                      </button>
                    </NodeHint>
                  </div>
                  {saved?.status === "saved" && saved.saved_path && (
                    <button
                      className="fc-node-btn ghost"
                      onClick={() => {
                        if (saved.target === "library") void openResourceFile(saved.saved_path);
                      }}
                    >
                      {t("canvas.saveSaved", { path: saved.saved_path })}
                    </button>
                  )}
                  {saved?.status === "error" && saved.error && <div className="fc-gen-warn">{saved.error}</div>}
                  {nodeErrors[node.id] && <div className="fc-gen-warn">{nodeErrors[node.id]}</div>}
                </div>
              );
            } else if (node.type === "preview_image" || node.type === "preview_video" || node.type === "preview_audio") {
              const upstreamNode = upstreamNodeOf(node.id);
              const upstream = upstreamMediaOf(node.id);
              const path = upstream?.paths[0] ?? "";
              body = (
                <div className="fc-node-form">
                  {!upstreamNode ? (
                    <div className="fc-node-placeholder">{t("canvas.previewEmpty")}</div>
                  ) : node.type === "preview_image" ? (
                    path ? (
                      <NodeHint text={t("canvas.previewOpen")}>
                        <button className="fc-preview-media" onClick={() => setLightboxSrc(path)}>
                          <ResourceThumb path={path} className="fc-thumb-cover" />
                        </button>
                      </NodeHint>
                    ) : (
                      <div className="fc-node-placeholder">{t("canvas.waitingUpstream")}</div>
                    )
                  ) : node.type === "preview_video" ? (
                    path ? <ResourceMediaPlayer kind="video" path={path} /> : <div className="fc-node-placeholder">{t("canvas.waitingUpstream")}</div>
                  ) : (
                    path ? <ResourceMediaPlayer kind="audio" path={path} /> : <div className="fc-node-placeholder">{t("canvas.waitingUpstream")}</div>
                  )}
                  {upstream?.text && <div className="fc-preview-text">{upstream.text}</div>}
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
                    // 视觉标准（B+）：未拖过尺寸手柄的节点高度由内容撑开，
                    // 文本常驻编辑框节点除外。
                    height: !autoHeight || node.type === "load_text" ? size.h : undefined,
                    "--node-accent": accent,
                  } as CSSProperties
                }
              >
                <div className="pc-node-head">
                  <span className="pc-node-kind">{t(`canvas.node.${node.type}`)}</span>
                  {node.title && <b className="pc-node-title">{node.title}</b>}
                </div>
                {portBarOf(node)}
                {body}
                {tools}
                {resizeHandle}
              </div>
            );
          })}
        </div>

        {/* 刀切痕层：视口直下的绝对定位层（pc-world 之后 → 盖在卡片上）。 */}
        <svg className="pc-trailayer" aria-hidden="true">
          <polyline ref={cutTrailUnderRef} className="pc-wire-cut-under" points="" />
          <polyline ref={cutTrailRef} className="pc-wire-cut" points="" />
        </svg>

        {/* 双击空白的节点选择框（ComfyUI 搜索框的对应物）：按生成/加载/
            输出三类分组。左上角锚在指针处；贴近视口下缘时按剩余空间限高，
            分组列表区内滚动——底部被裁掉又滚不到的项等于选不了。 */}
        {addMenu && (
          <WheelGate>
            <div
              className="pc-addmenu"
              style={{
                left: Math.max(8, Math.min(addMenu.sx, (vpRef.current?.clientWidth ?? 600) - 266)),
                top: addMenu.sy,
                maxHeight: Math.max(150, (vpRef.current?.clientHeight ?? 600) - addMenu.sy - 12),
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
            <input
              className="pc-addmenu-search"
              placeholder={t("project.canvas.addNodeSearch")}
              value={addMenuQuery}
              onChange={(event) => setAddMenuQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  // 取消菜单＝不建节点直接退出：摘下的线就此断开。
                  if (addMenu.detached) discardDetachedWire(addMenu.detached);
                  setAddMenu(null);
                }
              }}
              // 聚焦必须带 preventScroll：默认聚焦会滚动视口容器把输入框
              // 露出来，表现为整个画布节点集体平移。
              ref={(el) => {
                el?.focus({ preventScroll: true });
              }}
            />
            <div className="pc-addmenu-list">
            {menuGroups
              .map((group) => ({
                ...group,
                types: group.types.filter(
                  (type) =>
                    t(`canvas.node.${type}`).toLowerCase().includes(addMenuQuery.trim().toLowerCase()) &&
                    menuFilterType(type),
                ),
              }))
              .filter((group) => group.types.length > 0)
              .map((group) => (
                <div key={group.key} className="pc-addmenu-group">
                  <div className="pc-addmenu-group-title">{t(`canvas.menu.${group.key}`)}</div>
                  {group.types.map((type) => (
                    <button
                      key={type}
                      type="button"
                      className="pc-addmenu-item"
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.stopPropagation();
                        event.preventDefault();
                        // 立即捕获指针：菜单按钮随 setAddMenu(null) 卸载，
                        // 卸载后浏览器释放捕获，pointerup 按 hit-test 落到
                        // 视口、照常冒泡给 window 的 onUp 收尾。
                        try {
                          event.currentTarget.setPointerCapture(event.pointerId);
                        } catch {
                          // 指针已不可捕获（合成事件等）：退化为无捕获。
                        }
                        dragRef.current = {
                          kind: "addnode", sx: event.clientX, sy: event.clientY, moved: false,
                          fox: addMenu.wx, foy: addMenu.wy, frameKey: type,
                          wire: addMenu.wire,
                          detached: addMenu.detached,
                        };
                        setAddMenu(null);
                        setAddMenuQuery("");
                      }}
                    >
                      {menuIconOf(type)}
                      <span>{t(`canvas.node.${type}`)}</span>
                      <small>{t(`canvas.typeHint.${type}`)}</small>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            </div>
          </WheelGate>
        )}

        {/* 空画布示意：一键创建 文本→图像生成→预览 最小工作流 */}
        {!nodes.length && !connections.length && !addMenu && (
          <button className="fc-seed" onClick={() => void seedTemplate()}>
            <span className="fc-seed-title">{t("canvas.seedCta")}</span>
            <span className="fc-seed-sub">{t("canvas.seedHint")}</span>
          </button>
        )}

        {/* 拖放遮罩：OS 文件拖入提示 */}
        {dropHint && (
          <div className="fc-drop-overlay">
            <span>{t("canvas.dropHint")}</span>
          </div>
        )}

        {/* 批量生成浮动条：多选图像生成节点时出现 */}
        {selectedGenIds.length >= 2 && !genStarting && (
          <div className="fc-batchbar" onPointerDown={(e) => e.stopPropagation()}>
            <button onClick={() => void runBatch()}>
              {t("canvas.batchGenerate", { count: selectedGenIds.length })}
            </button>
          </div>
        )}

        {/* 资源库选择浮层：加载节点的「从资源库选择」入口 */}
        {pickerForNode && (
          <WheelGate>
            <LazyLibraryPicker
              onPick={(filePath) => {
                const targetId = pickerForNode;
                setPickerForNode(null);
                void store.getState().updateNode(targetId, { resourcePath: filePath });
              }}
              onClose={() => setPickerForNode(null)}
            />
          </WheelGate>
        )}

        {/* 大图预览（预览图像节点双击） */}
        {lightboxUrl && (
          <WheelGate>
            <ImageLightbox src={lightboxUrl} alt="" onClose={() => setLightboxSrc("")} />
          </WheelGate>
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

/** 弹层滚轮隔离：视口滚轮缩放挂在原生非被动监听上（React 合成事件的
 *  stopPropagation 拦不住它），弹层内的滚轮必须在原生层停掉冒泡——否则
 *  缩放监听的 preventDefault 会把弹层自身的默认滚动一并杀掉，表现为
 *  「列表滚不动、画布在缩放」。资源库弹窗 / 大图灯箱 / 节点选择框都用。 */
function WheelGate({ children }: { children: ReactNode }) {
  const gateRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = gateRef.current;
    if (!el) return;
    const isolate = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", isolate);
    return () => el.removeEventListener("wheel", isolate);
  }, []);
  return <div ref={gateRef}>{children}</div>;
}

/** 参数组合框（用户 2026-11-01 定案：预设下拉 + 自定义输入）。输入框
 *  始终可自由键入（失焦提交），右侧箭头展开预设清单，点选立即提交。
 *  清单 portal 到 body：节点表单是 overflow 滚动容器，内联浮层会被裁。 */
/** 节点风悬浮说明：悬停约 0.3s 后在目标上方淡入一枚深玻璃小胶囊
 *  （portal 到 body，fixed 定位）——替代原生 title 的系统样式，与节点
 *  体的圆角/毛玻璃/0.5px 细环同一视觉语言；不随画布缩放、不被节点滚
 *  动区裁切。text 为空时只做透明包裹。禁用按钮的指针事件会落到包裹
 *  层，因此禁用态同样能触发。 */
function NodeHint({ text, children, className }: { text: string; children: ReactNode; className?: string }) {
  const [tip, setTip] = useState<{ left: number; top: number; below?: boolean } | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const show = () => {
    if (!text) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      // 包裹层可能零尺寸（内部是绝对定位的箭头钮），优先取子元素矩形。
      const el = (anchorRef.current?.firstElementChild as HTMLElement | null) ?? anchorRef.current;
      const rect = el?.getBoundingClientRect();
      if (!rect) return;
      // 贴近视口顶缘时改在下方弹出，避免胶囊越出窗口。
      const below = rect.top < 48;
      setTip({ left: rect.left + rect.width / 2, top: below ? rect.bottom + 7 : rect.top - 7, below });
    }, 300);
  };
  const hide = () => {
    window.clearTimeout(timerRef.current);
    setTip(null);
  };

  return (
    <span
      ref={anchorRef}
      className={`fc-hint-anchor${className ? ` ${className}` : ""}`}
      onPointerEnter={show}
      onPointerLeave={hide}
      onPointerDown={hide}
    >
      {children}
      {tip && text && createPortal(
        <div className={`fc-hint${tip.below ? " is-below" : ""}`} style={{ left: tip.left, top: tip.top }}>{text}</div>,
        document.body,
      )}
    </span>
  );
}

function ParamCombo({
  comboKey,
  value,
  items,
  placeholder,
  toggleTitle,
  display,
  onCommit,
}: {
  comboKey: string;
  value: string;
  items: { value: string; label: string; hint?: string }[];
  placeholder?: string;
  toggleTitle: string;
  /** 非编辑态的取值展示：按当前值格式化为「主值 + 弱化尾注」（与下拉
   *  条目同款双段），点按换回原始输入框编辑——面板显示的是「选择后的
   *  样子」而非原始存储串。 */
  display?: (value: string) => { main: string; tail?: string } | null;
  onCommit: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 外点关闭（捕获阶段：画布空白按下不该先触发框选）。portal 弹层不在
  // rootRef 内，须放行——否则按下瞬间卸载弹层，条目的 click 永远收不到。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    // 展示态下输入框未挂载，锚点统一取容器矩形（宽度与控件一致）。
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ left: rect.left, top: rect.bottom + 4, width: rect.width });
    setOpen(true);
  };

  const applyPreset = (v: string) => {
    if (inputRef.current) inputRef.current.value = v;
    setEditing(false);
    setOpen(false);
    onCommit(v);
  };

  const fmt = display ? display(value) : null;
  const showDisplay = !editing && !!value && !!fmt?.tail;

  return (
    <div className="fc-combo" ref={rootRef}>
      {showDisplay && fmt ? (
        <button
          type="button"
          className="fc-node-input fc-combo-display"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setEditing(true)}
        >
          <span className="fc-combo-display-main">{fmt.main}</span>
          {fmt.tail && <span className="fc-combo-display-tail">{fmt.tail}</span>}
        </button>
      ) : (
        <input
          ref={inputRef}
          className="fc-node-input fc-combo-input"
          key={comboKey}
          defaultValue={value}
          placeholder={placeholder}
          autoFocus={editing}
          onBlur={(e) => {
            onCommit(e.target.value.trim());
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        />
      )}
      <NodeHint text={toggleTitle}>
        <button
          type="button"
          className={`fc-combo-toggle${open ? " is-open" : ""}`}
          aria-label={toggleTitle}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={toggle}
        >
          {Icons.chevronDown}
        </button>
      </NodeHint>
      {open && anchor && createPortal(
        <WheelGate>
          <div
            ref={popRef}
            className="fc-combo-pop"
            style={{ left: anchor.left, top: anchor.top, width: anchor.width }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {items.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`fc-combo-item${item.value === value ? " is-current" : ""}`}
                onClick={() => applyPreset(item.value)}
              >
                <span className="fc-combo-label">{item.label}</span>
                {item.hint && <span className="fc-combo-hint">{item.hint}</span>}
                {item.value === value && <i aria-hidden="true">{Icons.check}</i>}
              </button>
            ))}
          </div>
        </WheelGate>,
        document.body,
      )}
    </div>
  );
}

/** 懒加载的资源库选择浮层：画布加载节点「从资源库选择」入口，薄壳复用
 *  工程域的通用选择浮层（搜索/分页/缩略图/导入），点选即回填节点路径。
 *  选择器给的是库内相对路径——mediaUrl 域层把相对路径拼到存储根（≠资源
 *  库根），必须在这里转成绝对路径落节点，否则缩略图/媒体全部裂图。 */
function LazyLibraryPicker({
  onPick,
  onClose,
}: {
  onPick: (filePath: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [libraryRoot, setLibraryRoot] = useState("");
  useEffect(() => {
    let alive = true;
    invoke<string>("get_resource_library_path")
      .then((root) => {
        if (alive) setLibraryRoot(root);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return (
    <ProjectFilePickerDialog
      title={t("canvas.loadPickerTitle")}
      onPick={(file) => onPick(joinLibraryPath(libraryRoot, file.filePath))}
      onClose={onClose}
    />
  );
}
