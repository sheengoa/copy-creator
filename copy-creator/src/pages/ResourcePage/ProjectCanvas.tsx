import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
import { usePerEpisodeStorage } from "./usePerEpisodeStorage";
import {
  useProjectStore,
  type ProjectAsset,
  type ProjectAssetLink,
  type ProjectNodeLink,
  type ProjectScene,
  type ProjectShot,
} from "../../stores/projectStore";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import ProjectFilePickerDialog from "./ProjectFilePickerDialog";
import ProjectNodeDetailDialog, { type NodeDetailEntry } from "./ProjectNodeDetailDialog";
import ProjectLibraryPanel from "./ProjectLibraryPanel";
import { ResourceFileImage, ResourceVideoPoster, ResourceImage } from "./ResourceMedia";
import { Icons } from "../../components/Icons";
import { resolveWireRelease } from "../../utils/projectWireRelease";
import { openResourceFile, readResourceTextPreview } from "../../domain/mediaAssets";
import {
  characterAvatarInitial,
  characterAvatarPaletteIndex,
  intExtLabelKey,
  joinLibraryPath,
  locationSubtitleParts,
  promptCategoryKey,
  scriptFileLabel,
  timeHintLabelKey,
} from "../../domain/projectView";

// ── 布局常量（世界像素） ──────────────────────────────────────
const FRAME_MIN_W = 340;
const FRAME_MIN_H = 260;
const FRAME_PAD_X = 32;
const FRAME_PAD_TOP = 60;
const FRAME_PAD_BOTTOM = 32;
const CARD_GAP = 24;
const CARD_W = 268; // 镜头卡宽
const CARD_HEAD_H = 44; // 卡头（镜头号 + 描述）
const THUMB_W = 116; // 卡内素材缩略宽（两列）
const THUMB_RATIO = 0.68;
const THUMB_GAP = 8;
const INFO_W = 132; // 资料卡宽（角色/道具/剧本）
const INFO_H = 180; // 含标题条 + 接口行 + 预览卡（接口行内移后增高的估算值）
const SCRIPT_W = 210;
const WORLD_MARGIN = 60;
/** 连线层视口外沿的世界余量（把可见区外一点的线也画进来，避免边缘裁切）。 */
const WIRES_VIEWPORT_PAD = 64;
const MINI_W = 150;
const MINI_H = 96;
const OUTPUT_W = 176; // 成片输出节点（每集工作流的总输出口）
const OUTPUT_H = 72;
const SEG_W = 208; // 片段节点（AI 分段生成的视频分段）
const SEG_H = 108;

type Pos = { x: number; y: number };
type PosMap = { cards: Record<string, Pos>; info?: Pos };

interface CardAsset {
  asset: ProjectAsset;
  w: number;
  h: number;
}

/** 镜头卡（含素材网格）/ 散件 / 资料节点的统一渲染模型。 */
interface CanvasCard {
  key: string; // `shot:<id>`
  shot: ProjectShot;
  sceneId: string;
  w: number;
  h: number;
  assets: CardAsset[];
}
interface CanvasInfo {
  key: string; // `char:<id>` | `loc:<id>` | `prop:<id>` | `script`
  kind: "character" | "location" | "prop" | "script";
  name: string;
  avatarPath: string; // 角色/场景参考图（相对库根）
  textPath: string; // 剧本正文（相对库根）
  w: number;
  h: number;
}

/** 画布便签节点（ComfyUI Note 的对应物），按集存 localStorage。 */
interface CanvasNote {
  id: string;
  text: string;
  x: number;
  y: number;
}

type EntityPhKind = "character" | "location" | "prop";
/** 空白资料占位节点（角色/场景/道具未加载实体前的画布占位）。 */
interface EntityPh { id: string; kind: EntityPhKind; x: number; y: number }

/** 剧本纸片（多实例）：空纸片双击挂文件；本集无剧本时首个挂接转正为主剧本。 */
interface ScriptPh { id: string; path: string }

/** 提示词纸片（多实例）：空纸片双击从提示词库选一条，promptId 为空即未填充；
 *  出生点存 x/y（与空白资料占位一致），拖动后的位置走 infoOffsets。 */
interface PromptPh { id: string; promptId: string; x: number; y: number }

/** 资料组节点：一个节点装多个同类实体，一条线接入片段。 */
interface InfoGroup {
  id: string;
  kind: EntityPhKind;
  members: string[];
}

/** 占位节点/剧本纸片连到片段口的暂存线（画布层，localStorage 按集）。 */
interface PendingLink { fromKey: string; toSegmentId: string; toPort: string }

/** 节点分组（Ctrl+G，ComfyUI Group 的对应物）。 */
interface NodeGroup { id: string; label: string; members: string[] }

// usePerEpisodeStorage 的 fallback/parse 会进 effect 依赖，必须是模块级
// 常量/纯函数（引用稳定），故统一定义在此。
const EMPTY_NOTES: CanvasNote[] = [];
const EMPTY_SCRIPT_PHS: ScriptPh[] = [];
const EMPTY_PROMPT_PHS: PromptPh[] = [];
const EMPTY_ENTITY_PHS: EntityPh[] = [];
const EMPTY_INFO_GROUPS: InfoGroup[] = [];
const EMPTY_SIZES: Record<string, { w: number; h: number }> = {};
const EMPTY_INFO_OFFSETS: Record<string, Pos> = {};
const EMPTY_PENDING_LINKS: PendingLink[] = [];
const EMPTY_NODE_GROUPS: NodeGroup[] = [];
// 剧本纸片做形状防御：历史脏数据（非数组/缺字段）不进画布，直接回退空。
const parseScriptPhs = (raw: string): ScriptPh[] => {
  const list = JSON.parse(raw) as ScriptPh[];
  return Array.isArray(list) ? list.filter((item) => item && typeof item.id === "string") : [];
};
// 提示词纸片同款形状防御。
const parsePromptPhs = (raw: string): PromptPh[] => {
  const list = JSON.parse(raw) as PromptPh[];
  return Array.isArray(list) ? list.filter((item) => item && typeof item.id === "string") : [];
};
// 素材占位节点已整体移除：加载暂存线时顺手过滤历史遗留的占位来源，
// 画布层不再出现该类线（存储直清见组件内的存量清理 effect）。
const parsePendingLinks = (raw: string): PendingLink[] => {
  const parsed = JSON.parse(raw) as PendingLink[];
  return Array.isArray(parsed)
    ? parsed.filter((l) => l && typeof l.fromKey === "string" && !l.fromKey.startsWith("placeholder:"))
    : [];
};
// 线段相交（同横坐标单调判定，经典叉积法）——切线的扫过判定用。
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
interface CanvasFrame {
  id: string; // sceneId | "info"
  scene: ProjectScene | null;
  label: string;
  w: number;
  h: number;
}

interface CanvasLayout {
  cards: CanvasCard[];
  infos: CanvasInfo[];
  frames: CanvasFrame[];
  cardPos: Record<string, Pos>;
  /** 场景框默认位置（顺序累计排布），未摆放过场景时使用。 */
  framePos: Record<string, Pos>;
  infoFramePos: Pos;
  worldW: number;
  worldH: number;
}

interface WireBox extends Pos {
  w: number;
  h: number;
}

/** ComfyUI 风格连线：直接接收两端端口点（输出在节点右缘、输入在左缘），
 *  控制点沿水平方向延伸两点距离的 1/4，任意角度都是平滑弯出的贝塞尔，
 *  不存在直线或拐角形态。 */
function wirePathD(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const offset = Math.hypot(b.x - a.x, b.y - a.y) * 0.25;
  return `M ${a.x} ${a.y} C ${a.x + offset} ${a.y}, ${b.x - offset} ${b.y}, ${b.x} ${b.y}`;
}

/** 输入端口列的垂直比例：第 i 口（0 起）位于节点高度的 (i+1)/(n+1) 处
 *  （ComfyUI 槽位分布），单口即中点。 */
function portRatio(index: number, count: number): number {
  return (index + 1) / (count + 1);
}

/** 镜头卡尺寸：卡头 + 素材两列网格（空镜头为挂靠占位高度）。 */
function shotCardSize(shot: ProjectShot): { w: number; h: number } {
  const rows = Math.ceil(shot.assets.length / 2);
  const gridH = shot.assets.length
    ? rows * (THUMB_W * THUMB_RATIO + THUMB_GAP) + 10
    : 64;
  return { w: CARD_W, h: CARD_HEAD_H + gridH };
}

/** 确定性自动布局：已摆放的镜头卡/散件用存储坐标；未摆放的按场景
 *  横排 + 框内网格补位（跳过已占用格位，避免新卡叠在旧卡下）。 */
function buildLayout(
  scenes: ProjectScene[],
): Omit<CanvasLayout, "infoFramePos"> {
  const cardPos: Record<string, Pos> = {};
  const cards: CanvasCard[] = [];
  const frames: CanvasFrame[] = [];
  let worldW = 1200;
  let worldH = 900;
  // 场景框默认位置：按上一帧右缘顺序累计（固定间距会让变宽的框互相
  // 重叠）；用户摆过的场景用存储坐标，但游标仍吸收其占位。
  const framePos: Record<string, Pos> = {};
  let sceneCursorX = WORLD_MARGIN;

  scenes.forEach((scene) => {
    const fx = scene.canvas_x ?? sceneCursorX;
    const fy = scene.canvas_y ?? 110;
    const sceneCards: CanvasCard[] = [];
    const occupied = new Set<string>(); // 已摆放卡占用的网格格位
    const CELL_W = CARD_W + CARD_GAP;
    const cellKey = (col: number, row: number) => `${col}:${row}`;

    scene.shots.forEach((shot) => {
      const size = shotCardSize(shot);
      const fixed =
        shot.canvas_x != null && shot.canvas_y != null
          ? { x: shot.canvas_x, y: shot.canvas_y }
          : null;
      if (fixed) {
        cardPos[shot.id] = fixed;
        // 反推占用格位（以框原点为网格原点）。
        const col = Math.round((fixed.x - fx - FRAME_PAD_X) / CELL_W);
        const row = Math.round((fixed.y - fy - FRAME_PAD_TOP) / CELL_W);
        for (let dc = -1; dc <= 1; dc++) {
          for (let dr = -1; dr <= 1; dr++) occupied.add(cellKey(col + dc, row + dr));
        }
      }
      const assets: CardAsset[] = shot.assets.map((asset) => {
        const w = THUMB_W;
        return { asset, w, h: Math.round(w * THUMB_RATIO) };
      });
      sceneCards.push({ key: `shot:${shot.id}`, shot, sceneId: scene.id, w: size.w, h: size.h, assets });
    });

    // 未摆放卡按网格找空位（3 列，跳过占用）。
    let col = 0;
    let row = 0;
    sceneCards.forEach((card) => {
      if (cardPos[card.shot.id]) return;
      while (occupied.has(cellKey(col, row))) {
        col += 1;
        if (col === 3) {
          col = 0;
          row += 1;
        }
      }
      cardPos[card.shot.id] = { x: fx + FRAME_PAD_X + col * CELL_W, y: fy + FRAME_PAD_TOP + row * CELL_W };
      occupied.add(cellKey(col, row));
      const colNext = col + 1;
      if (colNext === 3) {
        col = 0;
        row += 1;
      } else {
        col = colNext;
      }
    });

    sceneCards.forEach((card) => {
      const pos = cardPos[card.shot.id];
      card.w = CARD_W;
      card.h = shotCardSize(card.shot).h;
      void pos;
    });
    cards.push(...sceneCards);

    const maxX = Math.max(
      fx + FRAME_MIN_W,
      ...sceneCards.map((c) => cardPos[c.shot.id].x + c.w),
    );
    const maxY = Math.max(
      fy + FRAME_MIN_H,
      ...sceneCards.map((c) => cardPos[c.shot.id].y + c.h),
    );
    frames.push({
      id: scene.id, scene, label: scene.heading || "",
      w: maxX - fx, h: maxY - fy,
    });
    framePos[scene.id] = { x: fx, y: fy };
    sceneCursorX = Math.max(sceneCursorX, maxX + 80);
    worldW = Math.max(worldW, maxX + 60);
    worldH = Math.max(worldH, maxY + 60);
  });

  // 集级散件已不再上画布（素材节点整体移除）：场景框之外只有资料框与
  // 片段列，世界尺寸按场景框推导。
  let scenesMaxY = 0;
  scenes.forEach((scene) => {
    const fy = scene.canvas_y ?? 110;
    const frame = frames.find((f) => f.id === scene.id);
    scenesMaxY = Math.max(scenesMaxY, fy + (frame?.h ?? 0));
  });
  worldW = Math.max(worldW, WORLD_MARGIN + 60);
  worldH = Math.max(worldH, scenesMaxY + 60);

  return { cards, infos: [], frames, cardPos, framePos, worldW, worldH };
}

/** 文本纸片内容（读资源文本头部，组件内自持请求）。 */
function TextPaperBody({ path, name, lines, adaptive = false }: { path: string; name: string; lines?: number; adaptive?: boolean }) {
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
      <p style={lines && !adaptive ? { WebkitLineClamp: lines } : undefined}>{preview === null ? "…" : preview}</p>
    </div>
  );
}

interface WireItem {
  fromKey: string; // 容器 key：shot:<id>
  toKey: string;
  kind: "gen" | "manual";
  type: string; // 线上流动的数据类型 = 来源素材的 kind
}

/** 连线数据类型色（ComfyUI 每类型一色的惯例）。 */
const WIRE_TYPE_COLORS: Record<string, string> = {
  image: "#4ade80",
  video: "#a78bfa",
  text: "#fb923c",
  prompt: "#22d3ee",
  audio: "#facc15",
  file: "#94a3b8",
};

/** 节点类型色（标题条与类型名用，向 ComfyUI 的彩色节点语言对齐）。 */
const NODE_ACCENTS: Record<string, string> = {
  shot: "#60a5fa",
  segment: "#a78bfa",
  output: "#c084fc",
  character: "#f472b6",
  location: "#34d399",
  prop: "#fbbf24",
  script: "#fb923c",
  prompt: "#22d3ee",
  note: "#f6e6a8",
  image: "#4ade80",
  video: "#a78bfa",
  text: "#fb923c",
  audio: "#facc15",
  file: "#94a3b8",
};

/** 参考类输入口可接的数据类型（图/视频/文本/提示词）。 */
const REF_ACCEPTS = ["image", "video", "text", "prompt"];

/** 片段输入口专属色：每口一色，与对应节点类型色一致，一眼分辨谁是谁；
 *  「其他」口不限类型，用中性灰。未命中的口（镜头/成片/素材的通用口）
 *  回退连线类型色。 */
const PORT_COLORS: Record<string, string> = {
  character: "#f472b6",
  location: "#34d399",
  prop: "#fbbf24",
  prompt: "#22d3ee",
  script: "#fb923c",
  other: "#94a3b8",
};

/** 本集镜头挂靠的全部素材（散件不上画布，仅用于成片来源显示等回退）。 */
function allAssetsOf(scenes: ProjectScene[]): ProjectAsset[] {
  const list: ProjectAsset[] = [];
  scenes.forEach((scene) => scene.shots.forEach((shot) => list.push(...shot.assets)));
  return list;
}

/** 工程画布：集素材的无限画布（看/摆/连）。镜头卡与散件坐标持久化进
 *  工程库；资料框（出场角色/出镜道具/剧本）与视口按集记 localStorage。
 *  交互：中键平移、滚轮缩放、左键框选、多选拖动、拖场景标签牌整组
 *  移动、卡头锚点拖出手动连线、点击卡内素材开详情。生成链
 *  （gen_from_asset）自动在容器（镜头卡/散件）之间画实线箭头。 */
export default function ProjectCanvas({
  libraryRoot,
  overlay,
  onOpenAsset,
  onPickForShot,
}: {
  libraryRoot: string;
  /** 集信息玻璃卡内容（标题/状态/角色/剧本入口），由 ProjectView 组装。 */
  overlay?: React.ReactNode;
  onOpenAsset: (asset: ProjectAsset) => void;
  onPickForShot: (shotId: string) => void;
}) {
  const { t } = useTranslation();
  const {
    overview,
    locations,
    loadLocations,
    saveCanvasLayout,
    unlinkAssets,
    saveScene,
    deleteScene,
    saveShot,
    deleteShot,
    setEpisodeOutput,
    setEpisodeLocations,
    setEpisodeProps,
    setEpisodeCharacters,
    updateEpisode,
    addSegment,
    removeSegment,
    moveSegment,
    setSegmentAsset,
    selectEpisode,
    linkNode,
    unlinkNode,
    linkAsset,
    characters,
    props,
    prompts,
    loadPrompts,
  } = useProjectStore(
    useShallow((state) => ({
      overview: state.overview,
      locations: state.locations,
      loadLocations: state.loadLocations,
      saveCanvasLayout: state.saveCanvasLayout,
      unlinkAssets: state.unlinkAssets,
      saveScene: state.saveScene,
      deleteScene: state.deleteScene,
      saveShot: state.saveShot,
      deleteShot: state.deleteShot,
      setEpisodeOutput: state.setEpisodeOutput,
      setEpisodeLocations: state.setEpisodeLocations,
      setEpisodeProps: state.setEpisodeProps,
      setEpisodeCharacters: state.setEpisodeCharacters,
      updateEpisode: state.updateEpisode,
      addSegment: state.addSegment,
      removeSegment: state.removeSegment,
      moveSegment: state.moveSegment,
      setSegmentAsset: state.setSegmentAsset,
      selectEpisode: state.selectEpisode,
      linkNode: state.linkNode,
      unlinkNode: state.unlinkNode,
      linkAsset: state.linkAsset,
      characters: state.characters,
      props: state.props,
      prompts: state.prompts,
      loadPrompts: state.loadPrompts,
    })),
  );
  const episodeId = overview?.episode.id ?? "";
  const scenes = useMemo(() => overview?.scenes ?? [], [overview]);
  const looseAssets = useMemo(() => overview?.loose_assets ?? [], [overview]);
  const links = useMemo(() => overview?.links ?? [], [overview]);
  const episodeLocations = useMemo(() => overview?.locations ?? [], [overview]);
  const episodeProps = useMemo(() => overview?.props ?? [], [overview]);
  const segments = useMemo(() => overview?.segments ?? [], [overview]);
  const nodeLinks = useMemo(() => overview?.node_links ?? [], [overview]);

  // 出场角色/出场场景/出场道具/剧本：资料框数据源（均为 overview 带出）。
  const castCharacters = useMemo(() => overview?.characters ?? [], [overview]);

  // ── 资料框位置（localStorage 按集） ──
  // ── 资料框位置：按集记 localStorage（拖标签牌挪动整个资料框）──
  const [infoFramePos, setInfoFramePos, saveInfoFramePos] = usePerEpisodeStorage<Pos | null>(episodeId, "info", null);

  // ── 成片输出节点位置（localStorage 按集；默认挂世界右侧居中） ──
  const [outputPos, setOutputPos, saveOutputPos] = usePerEpisodeStorage<Pos | null>(episodeId, "output", null);

  // 选中状态（selRef 供鼠标事件同步读取，setSelKeys 驱动渲染）；位置
  // 批量写入 / 撤销栈等下层机制都依赖它，故提前声明。
  const [selKeys, setSelKeys] = useState<string[]>([]);
  const selRef = useRef<string[]>([]);
  const setSelection = useCallback((keys: string[]) => {
    selRef.current = keys;
    setSelKeys(keys);
  }, []);

  // ── 便签节点（ComfyUI Note 的对应物）：文本与位置按集记 localStorage ──
  const [notes, setNotes, persistNotes] = usePerEpisodeStorage<CanvasNote[]>(episodeId, "notes", EMPTY_NOTES);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  // 切集（含刷新瞬态）退出便签编辑态：编辑中的草稿属于旧集。
  useEffect(() => {
    setEditingNoteId(null);
  }, [episodeId]);
  const addNote = useCallback(
    (x: number, y: number) => {
      const note: CanvasNote = {
        id: `n${Date.now()}${Math.floor(Math.random() * 1e4)}`,
        text: "",
        x,
        y,
      };
      persistNotes([...notes, note]);
      return note.id;
    },
    [notes, persistNotes],
  );

  // ── 双击空白添加节点（ComfyUI 搜索框的对应物）；拖线到空白松手也
  // 弹出本菜单，创建的节点自动接上那条线（wire 字段） ──
  const [addMenu, setAddMenu] = useState<{
    sx: number;
    sy: number;
    wx: number;
    wy: number;
    wire?: {
      fromKey: string;
      fromDir: "out" | "in";
      fromType?: string;
      fromAccepts?: string[];
      fromPortId?: string;
    };
    // 摘线到空白弹出的菜单：被摘的线（隐藏态）。菜单创建节点后转接并
    // 删旧行；取消（点空白/Esc/建无口节点）则放回原口。
    detached?: { pendings: PendingLink[]; rows: ProjectNodeLink[] };
  } | null>(null);
  const [addMenuQuery, setAddMenuQuery] = useState("");
  // 资料关联面板开关（挂产出走片段详情窗口，见 detailFor）。
  const [locationPickOpen, setLocationPickOpen] = useState(false);
  // 挂剧本：双击空纸片从库选文件（两段式与其他节点统一）。
  const [scriptPickOpen, setScriptPickOpen] = useState(false);
  // 本次挂接的目标节点 key："script" = 主剧本重挂；"script:<id>" = 剧本纸片。
  const [scriptPickTarget, setScriptPickTarget] = useState<string | null>(null);
  // 剧本纸片（多实例，与其他节点统一）：添加菜单每次放一个空纸片，双击
  // 从库选文件。本集还没剧本时，首个挂接的文件「转正」为主剧本节点
  // （script_path 落库、自动接入全部片段）；其余纸片独立持文件、只存在
  // 于画布层——剧本连线在后端以集为锚（from_id 必须是集 id），纸片的
  // 连线走画布暂存线，不入库。
  const scriptPhsKey = `project_canvas_scriptphs_${episodeId}`;
  const scriptNodeKey = `project_canvas_scriptnode_${episodeId}`;
  const [scriptPhs, , persistScriptPhs] = usePerEpisodeStorage<ScriptPh[]>(
    episodeId, "scriptphs", EMPTY_SCRIPT_PHS, parseScriptPhs,
  );
  const addScriptPh = useCallback(() => {
    persistScriptPhs([
      ...scriptPhs,
      { id: `sph${Date.now()}${Math.floor(Math.random() * 1e4)}`, path: "" },
    ]);
  }, [scriptPhs, persistScriptPhs]);
  // 旧版「空主剧本」标志迁移：标志在且本集没挂剧本时补一个空纸片，迁移
  // 完移除旧键（避免删光纸片后被复活）。直接读存储而非 state，绕开加载
  // 时序竞争。
  const scriptLegacyMigratedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!episodeId || !overview) return;
    if (scriptLegacyMigratedRef.current === episodeId) return;
    scriptLegacyMigratedRef.current = episodeId;
    let legacy: boolean;
    try {
      legacy = window.localStorage.getItem(scriptNodeKey) === "1";
    } catch {
      legacy = false;
    }
    if (!legacy) return;
    try {
      window.localStorage.removeItem(scriptNodeKey);
    } catch {
      // 忽略。
    }
    if (overview.episode.script_path) return; // 已挂接：主剧本节点照旧渲染。
    let existing: { id: string; path: string }[];
    try {
      existing = JSON.parse(window.localStorage.getItem(scriptPhsKey) ?? "[]");
    } catch {
      existing = [];
    }
    if (Array.isArray(existing) && existing.length > 0) return;
    persistScriptPhs([{ id: `sph${Date.now()}${Math.floor(Math.random() * 1e4)}`, path: "" }]);
  }, [episodeId, overview, scriptNodeKey, scriptPhsKey, persistScriptPhs]);

  // ── 提示词纸片（多实例）：添加菜单每次放一个空纸片，双击从提示词库
  // 选一条；连线走画布暂存线（提示词是画布层记忆，不入库）。 ──
  const [promptPhs, , persistPromptPhs] = usePerEpisodeStorage<PromptPh[]>(
    episodeId, "promptphs", EMPTY_PROMPT_PHS, parsePromptPhs,
  );
  const addPromptPh = useCallback(
    (x: number, y: number) => {
      const id = `pph${Date.now()}${Math.floor(Math.random() * 1e4)}`;
      persistPromptPhs([...promptPhs, { id, promptId: "", x, y }]);
      return id;
    },
    [promptPhs, persistPromptPhs],
  );
  // 双击空纸片弹提示词选择：目标节点 key（"prompt:<id>"）。
  const [promptPickOpen, setPromptPickOpen] = useState(false);
  const [promptPickTarget, setPromptPickTarget] = useState<string | null>(null);
  const [promptPickQuery, setPromptPickQuery] = useState("");
  // 纸片标题要显示已选提示词的名字：切集时刷新提示词库。
  useEffect(() => {
    if (!episodeId) return;
    void loadPrompts();
  }, [episodeId, loadPrompts]);

  // ── 空白资料占位节点（菜单选 角色/场景/道具 即创建，创建时绝不弹
  // 挑选面板；双击节点从详情窗加载实体，加载后原位变成实体节点）：
  // 按集存 localStorage ──
  const [entityPhs, , persistEntityPhs] = usePerEpisodeStorage<EntityPh[]>(
    episodeId, "entityph", EMPTY_ENTITY_PHS,
  );
  const addEntityPh = useCallback(
    (kind: EntityPhKind, x: number, y: number) => {
      const id = `e${Date.now()}${Math.floor(Math.random() * 1e4)}`;
      persistEntityPhs([
        ...entityPhs,
        { id, kind, x, y },
      ]);
      return id;
    },
    [entityPhs, persistEntityPhs],
  );

  // ── 资料组节点（一个节点装多个同类实体，一条线接入片段——线的含义
  // = 片段要用组内全部成员）：按集存 localStorage。成员在组间互斥；
  // 未被组认领的集关联实体仍各自渲染为默认单实体节点，旧数据零迁移。 ──
  const [infoGroups, , persistInfoGroups] = usePerEpisodeStorage<InfoGroup[]>(
    episodeId, "infogroups", EMPTY_INFO_GROUPS,
  );
  // 组成员自愈：实体已不存在（库里被删）时从组里剔除，避免僵尸认领
  // 挡住后续同名 id 的实体入集。存在性按全局库判定而非集关联（概览）：
  // 「装入」先写组、后 associateEntities 关联实体，两者之间概览尚未
  // 带出新成员——凭集级列表会把这个空档误判成「成员已删」整组误删
  // （裸占位装入没有暂存线转正的逐条 IPC 推刷新，空档必然出现）。
  // 某个全局库尚未拉取时跳过该类组的判定，拉到后 effect 重跑再补判。
  useEffect(() => {
    if (!overview) return;
    const exists = (kind: EntityPhKind, id: string) =>
      (kind === "character" ? characters : kind === "location" ? locations : props).some(
        (e) => e.id === id,
      );
    let changed = false;
    const next = infoGroups
      .map((g) => {
        const pool = g.kind === "character" ? characters : g.kind === "location" ? locations : props;
        if (pool.length === 0) return g;
        const members = g.members.filter((id) => exists(g.kind, id));
        if (members.length === g.members.length) return g;
        changed = true;
        return { ...g, members };
      })
      .filter((g) => g.members.length > 0);
    if (changed) persistInfoGroups(next);
  }, [overview, infoGroups, characters, locations, props, persistInfoGroups]);

  // ── 布局与位置（state 驱动渲染） ──
  const layout = useMemo(() => buildLayout(scenes), [scenes]);

  // 资料节点（出场角色/出场场景/出镜道具/剧本）：默认每个集关联实体
  // 一个节点；被组认领的实体不再单独渲染，组节点以照片堆放呈现成员
  // （首位成员大图 + 其余成员图边），高度与单实体节点相同。
  const infoNodes = useMemo(() => {
    const list: CanvasInfo[] = [];
    const claimed = new Set(infoGroups.flatMap((g) => g.members));
    castCharacters
      .filter((character) => !claimed.has(character.id))
      .forEach((character) => {
        list.push({
          key: `char:${character.id}`, kind: "character", name: character.name,
          avatarPath: character.avatar_path, textPath: "", w: INFO_W, h: INFO_H,
        });
      });
    episodeLocations
      .filter((location) => !claimed.has(location.id))
      .forEach((location) => {
        list.push({
          key: `loc:${location.id}`, kind: "location", name: location.name,
          avatarPath: location.ref_path, textPath: "", w: INFO_W, h: INFO_H,
        });
      });
    episodeProps
      .filter((prop) => !claimed.has(prop.id))
      .forEach((prop) => {
        list.push({ key: `prop:${prop.id}`, kind: "prop", name: prop.name, avatarPath: prop.ref_path, textPath: "", w: INFO_W, h: INFO_H });
      });
    infoGroups.forEach((group) => {
      // 只统计仍存在的成员（库里被删的 id 不占位）。
      const members = group.members.filter((id) =>
        (group.kind === "character"
          ? castCharacters
          : group.kind === "location"
            ? episodeLocations
            : episodeProps
        ).some((e) => e.id === id),
      );
      if (members.length === 0) return;
      list.push({
        // 标题只留 ×N：类型名在标题条左侧常显，重复会读成「角色 角色 ×2」。
        key: `grp:${group.id}`, kind: group.kind, name: `×${members.length}`,
        avatarPath: "", textPath: "", w: INFO_W, h: INFO_H,
      });
    });
    if (overview?.episode.script_path) {
      list.push({
        key: "script", kind: "script", name: scriptFileLabel(overview.episode.script_path),
        avatarPath: "", textPath: overview.episode.script_path, w: SCRIPT_W, h: INFO_H + 40,
      });
    }
    // 剧本纸片（多实例）：空纸片显示「未挂接」，双击从库选文件；本集没
    // 剧本时首个挂接的文件转正为主剧本节点（见 handleScriptPick）。
    scriptPhs.forEach((ph) => {
      list.push({
        key: `script:${ph.id}`, kind: "script",
        name: ph.path ? scriptFileLabel(ph.path) : t("project.canvas.scriptUntitled"),
        avatarPath: "", textPath: ph.path, w: SCRIPT_W, h: INFO_H + 40,
      });
    });
    return list;
  }, [castCharacters, episodeLocations, episodeProps, infoGroups, overview, scriptPhs, t]);

  const infoPos = useMemo(() => {
    const frame = infoFramePos ?? { x: WORLD_MARGIN, y: layout.worldH + 48 };
    const map: Record<string, Pos> = {};
    infoNodes.forEach((node, index) => {
      map[node.key] = {
        x: frame.x + FRAME_PAD_X + (index % 3) * (INFO_W + CARD_GAP),
        y: frame.y + FRAME_PAD_TOP + Math.floor(index / 3) * (INFO_H + CARD_GAP),
      };
    });
    return { frame, map };
  }, [infoNodes, infoFramePos, layout.worldH]);

  const [pos, setPos] = useState<PosMap>({ cards: layout.cardPos });
  useEffect(() => {
    setPos({ cards: layout.cardPos });
  }, [layout]);

  // 成片输出节点盒：默认挂世界右侧居中，位置按集记忆。
  const outputBox: WireBox | null = useMemo(() => {
    if (!overview) return null;
    const p = outputPos ?? {
      x: layout.worldW + 80,
      y: Math.max(WORLD_MARGIN, layout.worldH / 2 - OUTPUT_H / 2),
    };
    return { x: p.x, y: p.y, w: OUTPUT_W, h: OUTPUT_H };
  }, [overview, outputPos, layout]);

  // 片段位置：canvas 存储之外叠本地实时层；默认在成片节点左侧按拼接序
  // 排成一列（工作流读向：剧本 → 片段列 → 成片）。
  const [segPos, setSegPos] = useState<Record<string, Pos>>({});
  useEffect(() => {
    setSegPos((prev) => {
      const next: Record<string, Pos> = {};
      const baseX = (outputBox?.x ?? layout.worldW + 260) - SEG_W - 160;
      segments.forEach((segment, index) => {
        next[segment.id] = prev[segment.id] ?? {
          x: segment.canvas_x ?? baseX,
          y: segment.canvas_y ?? Math.max(WORLD_MARGIN, 110 + index * 260),
        };
      });
      return next;
    });
  }, [segments, outputBox, layout.worldW]);
  const persistSegments = useCallback(
    (next: Record<string, Pos>) => {
      void saveCanvasLayout({
        assets: [],
        shots: [],
        scenes: [],
        segments: Object.entries(next).map(([id, p]) => ({ id, x: p.x, y: p.y })),
      });
    },
    [saveCanvasLayout],
  );

  // ── 节点尺寸（ComfyUI 式右下角手柄拖拽）：按集存 localStorage 覆盖层，
  // 只记录改过的节点，渲染时未记录的回默认尺寸；线锚点由节点实测跟随。 ──
  const [nodeSizes, setNodeSizes, persistSizes] = usePerEpisodeStorage<Record<string, { w: number; h: number }>>(
    episodeId, "sizes", EMPTY_SIZES,
  );
  const sizeOfNode = useCallback(
    (key: string): { w: number; h: number } | null => {
      const over = nodeSizes[key];
      if (key === "output") {
        return { w: over?.w ?? OUTPUT_W, h: over?.h ?? OUTPUT_H };
      }
      if (key.startsWith("shot:")) {
        const card = layout.cards.find((c) => c.key === key);
        if (!card) return null;
        return { w: over?.w ?? card.w, h: over?.h ?? card.h };
      }
      if (key.startsWith("segment:")) {
        return { w: over?.w ?? SEG_W, h: over?.h ?? SEG_H };
      }
      if (key.startsWith("eph:")) {
        return { w: over?.w ?? INFO_W, h: over?.h ?? INFO_H };
      }
      // 资料节点（角色/场景/道具/组/剧本）：默认用网格尺寸。
      const info = infoNodes.find((item) => item.key === key);
      if (info) return { w: over?.w ?? info.w, h: over?.h ?? info.h };
      // 便签无固定默认尺寸（内容自适应），只在拖过之后有值。
      if (key.startsWith("note:")) return over ?? null;
      return null;
    },
    [nodeSizes, layout, infoNodes],
  );

  // ── 资料节点（角色/场景/道具/剧本）自由位置：默认仍在资料框网格，
  // 拖动后按节点绝对位置记忆——框退化为背景分组框，节点不再被钉死。 ──
  const [infoOffsets, setInfoOffsets, persistInfoOffsets] = usePerEpisodeStorage<Record<string, Pos>>(
    episodeId, "infonodes", EMPTY_INFO_OFFSETS,
  );
  const persistCards = useCallback(
    (nextCards: Record<string, Pos>) => {
      const entries = Object.entries(nextCards);
      void saveCanvasLayout({
        assets: [],
        shots: entries.map(([id, p]) => ({ id, x: p.x, y: p.y })),
        scenes: [],
      });
    },
    [saveCanvasLayout],
  );
  const infoNodePos = useCallback(
    (key: string): Pos => {
      if (infoOffsets[key]) return infoOffsets[key];
      // 空白资料占位节点：默认落创建点（拖动后同样走 infoOffsets）。
      if (key.startsWith("eph:")) {
        const ph = entityPhs.find((item) => `eph:${item.id}` === key);
        if (ph) return { x: ph.x, y: ph.y };
      }
      // 提示词纸片：同空白占位，默认落创建点。
      if (key.startsWith("prompt:")) {
        const ph = promptPhs.find((item) => `prompt:${item.id}` === key);
        if (ph) return { x: ph.x, y: ph.y };
      }
      return infoPos.map[key];
    },
    [infoOffsets, infoPos, entityPhs, promptPhs],
  );

  // ── 多选组拖 / 位置批量写入 / 复制粘贴 / 撤销栈 ──
  // 选中组快照：全部选中节点（世界坐标）。任一成员位置未知则返回 null
  // （调用方退回单节点行为）。minCount 控制最少成员数（组拖 2、复制 1）。
  interface GroupMember { key: string; x: number; y: number }
  const groupSnapshot = useCallback(
    (minCount = 2): GroupMember[] | null => {
      const sel = selRef.current;
      if (sel.length < minCount) return null;
      const members: GroupMember[] = [];
      for (const key of sel) {
        let p: Pos | undefined;
        if (key.startsWith("shot:")) p = pos.cards[key.slice(5)];
        else if (key.startsWith("segment:")) p = segPos[key.slice(8)];
        else if (key.startsWith("note:")) {
          const note = notes.find((item) => item.id === key.slice(5));
          p = note ? { x: note.x, y: note.y } : undefined;
        } else if (key === "output") {
          p = outputBox ? { x: outputBox.x, y: outputBox.y } : undefined;
        } else {
          p = infoNodePos(key);
        }
        if (!p) return null;
        members.push({ key, x: p.x, y: p.y });
      }
      return members;
    },
    [pos, segPos, notes, outputBox, infoNodePos],
  );
  // 批量写入各成员的绝对位置（组拖实时移动与撤销恢复共用）。
  const moveGroupTo = useCallback((members: GroupMember[]) => {
    const at = new Map(members.map((m) => [m.key, { x: m.x, y: m.y }]));
    const pick = (prefix: string) => members.filter((m) => m.key.startsWith(prefix));
    const cards = pick("shot:");
    if (cards.length) {
      setPos((prev) => ({
        cards: { ...prev.cards, ...Object.fromEntries(cards.map((m) => [m.key.slice(5), at.get(m.key)!])) },
      }));
    }
    const segs = pick("segment:");
    if (segs.length) setSegPos((prev) => ({ ...prev, ...Object.fromEntries(segs.map((m) => [m.key.slice(8), at.get(m.key)!])) }));
    const noteSel = pick("note:");
    if (noteSel.length) {
      const map = new Map(noteSel.map((m) => [m.key.slice(5), at.get(m.key)!]));
      setNotes((prev) => prev.map((item) => (map.has(item.id) ? { ...item, ...map.get(item.id)! } : item)));
    }
    const infos = members.filter((m) => !/^(shot|segment|note):/.test(m.key) && m.key !== "output");
    if (infos.length) setInfoOffsets((prev) => ({ ...prev, ...Object.fromEntries(infos.map((m) => [m.key, at.get(m.key)!])) }));
    const out = at.get("output");
    if (out) setOutputPos(out);
    // hook 返回的 setter 是 useState 稳定引用，列出不引发重建。
  }, [setInfoOffsets, setNotes, setOutputPos]);
  // 批量位置落盘（组拖松手与撤销恢复共用）：各切片合并后走对应持久化。
  const persistPositions = useCallback(
    (members: GroupMember[]) => {
      const round = (m: GroupMember) => ({ x: Math.round(m.x), y: Math.round(m.y) });
      const by = (prefix: string) => members.filter((m) => m.key.startsWith(prefix));
      const cards = Object.fromEntries(by("shot:").map((m) => [m.key.slice(5), round(m)]));
      const segs = Object.fromEntries(by("segment:").map((m) => [m.key.slice(8), round(m)]));
      if (Object.keys(cards).length) persistCards({ ...pos.cards, ...cards });
      if (Object.keys(segs).length) persistSegments({ ...segPos, ...segs });
      const noteMap = new Map(by("note:").map((m) => [m.key.slice(5), round(m)]));
      if (noteMap.size) persistNotes(notes.map((item) => (noteMap.has(item.id) ? { ...item, ...noteMap.get(item.id)! } : item)));
      const infos = members.filter((m) => !/^(shot|segment|note):/.test(m.key) && m.key !== "output");
      if (infos.length) persistInfoOffsets({ ...infoOffsets, ...Object.fromEntries(infos.map((m) => [m.key, round(m)])) });
      const out = members.find((m) => m.key === "output");
      if (out) saveOutputPos(round(out));
    },
    [pos, segPos, notes, infoOffsets, persistCards, persistSegments, persistNotes, persistInfoOffsets, saveOutputPos],
  );
  // ── 占位节点的暂存连线（pendingLinks）──
  // 空白资料占位/提示词/剧本纸片还没接入正式连线时，连到片段口的线
  // 先记在画布层（localStorage 按集）；占位加载实体后转正为 node_link；
  // 提示词/剧本纸片不转正（画布层即最终形态）。
  const [pendingLinks, , persistPendingLinks] = usePerEpisodeStorage<PendingLink[]>(
    episodeId, "pendinglinks", EMPTY_PENDING_LINKS, parsePendingLinks,
  );
  const dropPendingLinksOf = useCallback(
    (fromKey: string) => persistPendingLinks(pendingLinks.filter((l) => l.fromKey !== fromKey)),
    [pendingLinks, persistPendingLinks],
  );

  // ── 存量清理：素材节点（占位与散件）已整体移除。老画布遗留的素材
  // 占位（localStorage）、其暂存线与 DB 里的素材连线（from_kind='asset'）
  // 打开本集时清一次；此后已无任何创建入口，清理幂等无害。 ──
  const assetLinksCleanedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!episodeId) return;
    // 素材占位暂存线：直改存储（不经 state——切集首帧 state 可能还是
    // 上一集的旧值，写回会污染本集）；加载侧另有 parse 过滤兜底。
    try {
      const key = `project_canvas_pendinglinks_${episodeId}`;
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as PendingLink[];
        if (Array.isArray(parsed)) {
          const kept = parsed.filter((l) => l && !String(l.fromKey ?? "").startsWith("placeholder:"));
          if (kept.length !== parsed.length) window.localStorage.setItem(key, JSON.stringify(kept));
        }
      }
    } catch {
      // 存储不可用：无碍，加载侧 parse 已兜底。
    }
  }, [episodeId]);
  useEffect(() => {
    if (!episodeId || !overview) return;
    if (assetLinksCleanedRef.current === episodeId) return;
    assetLinksCleanedRef.current = episodeId;
    try {
      window.localStorage.removeItem(`project_canvas_placeholders_${episodeId}`);
    } catch {
      // 存储不可用：无碍，占位已无渲染入口。
    }
    void invoke("project_cleanup_asset_links", { episodeId }).catch(() => {
      // 清理失败不阻断画布：素材连线已无渲染入口，下次打开再试。
      assetLinksCleanedRef.current = null;
    });
  }, [episodeId, overview]);

  // ── 节点分组（Ctrl+G，ComfyUI Group 的对应物）──
  // 选中一个或多个节点打组成框（框自适应成员包围盒）；拖组框标题整组
  // 移动（复用组拖管线）；选中整组再按 Ctrl+G 解组。按集存 localStorage。
  const [nodeGroups, , persistNodeGroups] = usePerEpisodeStorage<NodeGroup[]>(
    episodeId, "nodegroups", EMPTY_NODE_GROUPS,
  );
  // 成员当前包围盒（世界坐标；节点已删除则 null，渲染与包围盒计算时
  // 自动剔除——组员被删后框随之收缩）。
  const memberFrame = useCallback(
    (key: string): { x: number; y: number; w: number; h: number } | null => {
      let p: Pos | undefined;
      if (key.startsWith("shot:")) p = pos.cards[key.slice(5)];
      else if (key.startsWith("segment:")) p = segPos[key.slice(8)];
      else if (key.startsWith("note:")) {
        const note = notes.find((item) => item.id === key.slice(5));
        p = note ? { x: note.x, y: note.y } : undefined;
      } else if (key === "output") {
        p = outputBox ? { x: outputBox.x, y: outputBox.y } : undefined;
      } else {
        p = infoNodePos(key);
      }
      if (!p) return null;
      const size = sizeOfNode(key);
      return {
        x: p.x,
        y: p.y,
        w: size?.w ?? (key.startsWith("note:") ? 172 : 100),
        h: size?.h ?? (key.startsWith("note:") ? 96 : 60),
      };
    },
    [pos, segPos, notes, outputBox, infoNodePos, sizeOfNode],
  );

  // 撤销栈：移动（单/组）、缩放、粘贴、可完整恢复的删除（便签/空白占位）。
  // 镜头/片段等后端实体的删除涉及连线与挂接，无法无损重建，不入栈。
  type UndoAction =
    | { type: "move"; entries: GroupMember[] }
    | { type: "resize"; key: string; size: { w: number; h: number } | null; pos?: Pos }
    | { type: "paste"; keys: string[] }
    | {
        type: "restore";
        notes?: CanvasNote[];
        ephs?: { id: string; kind: EntityPhKind; x: number; y: number }[];
        scriptPhs?: { id: string; path: string }[];
        // 剧本纸片的位置在 infoOffsets（不在纸片对象上），删除时一并抓取。
        scriptOffsets?: { key: string; pos: Pos }[];
        promptPhs?: PromptPh[];
        // 提示词纸片同款：拖动过的位置在 infoOffsets，删除时一并抓取。
        promptOffsets?: { key: string; pos: Pos }[];
        // 被删占位的暂存线随删除一并清除，撤销恢复时一并还原。
        pending?: PendingLink[];
      };
  const undoStackRef = useRef<UndoAction[]>([]);
  const pushUndo = useCallback((action: UndoAction) => {
    undoStackRef.current.push(action);
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
  }, []);
  const runUndo = useCallback(() => {
    if (undoingRef.current) return;
    undoingRef.current = true;
    try {
      const action = undoStackRef.current.pop();
      if (!action) return;
      if (action.type === "move") {
        moveGroupTo(action.entries);
        persistPositions(action.entries);
      } else if (action.type === "resize") {
        setNodeSizes((prev) => {
          const next = { ...prev };
          if (action.size) next[action.key] = action.size;
          else delete next[action.key];
          persistSizes(next);
          return next;
        });
        if (action.pos) {
          moveGroupTo([{ key: action.key, ...action.pos }]);
          persistPositions([{ key: action.key, ...action.pos }]);
        }
      } else if (action.type === "paste") {
        const noteIds = new Set(action.keys.filter((k) => k.startsWith("note:")).map((k) => k.slice(5)));
        const ephIds = new Set(action.keys.filter((k) => k.startsWith("eph:")).map((k) => k.slice(4)));
        if (noteIds.size) persistNotes(notes.filter((item) => !noteIds.has(item.id)));
        if (ephIds.size) persistEntityPhs(entityPhs.filter((item) => !ephIds.has(item.id)));
        for (const key of action.keys) {
          if (key.startsWith("segment:")) void removeSegment(key.slice(8));
        }
        setSelection([]);
      } else if (action.type === "restore") {
        if (action.notes?.length) persistNotes([...notes, ...action.notes]);
        if (action.ephs?.length) persistEntityPhs([...entityPhs, ...action.ephs]);
        if (action.scriptPhs?.length) persistScriptPhs([...scriptPhs, ...action.scriptPhs]);
        if (action.promptPhs?.length) persistPromptPhs([...promptPhs, ...action.promptPhs]);
        if (action.scriptOffsets?.length || action.promptOffsets?.length) {
          persistInfoOffsets({
            ...infoOffsets,
            ...Object.fromEntries([...(action.scriptOffsets ?? []), ...(action.promptOffsets ?? [])].map((item) => [item.key, item.pos])),
          });
        }
        if (action.pending?.length) persistPendingLinks([...pendingLinks, ...action.pending]);
      }
    } finally {
      // 撤销里的后端动作（片段删除）是异步的，锁放到下一宏任务才放开。
      window.setTimeout(() => {
        undoingRef.current = false;
      }, 0);
    }
  }, [moveGroupTo, persistPositions, persistSizes, notes, entityPhs, scriptPhs, promptPhs, infoOffsets, persistNotes, persistEntityPhs, persistScriptPhs, persistPromptPhs, persistInfoOffsets, persistPendingLinks, pendingLinks, removeSegment, setSelection, setNodeSizes]);
  // 复制 / 粘贴（Ctrl+C/V）：画布私有节点可复制（便签/空白资料占位/片段）。
  // 镜头卡、资料实体节点是库实体的画布投影（一实体一节点），复制语义
  // 不成立，不参与。粘贴整组出现在原组右下 28px 处、组内相对位置保持，
  // 粘贴后选中新组（可整体拖走 / Ctrl+Z 撤销）。
  type ClipItem =
    | { kind: "note"; text: string; dx: number; dy: number }
    | { kind: "eph"; phKind: EntityPhKind; dx: number; dy: number }
    | { kind: "segment"; dx: number; dy: number };
  const clipRef = useRef<{ items: ClipItem[]; ax: number; ay: number } | null>(null);
  // 防重入：StrictMode 开发态会双挂载键盘监听，一次 Ctrl+V 触发两次
  // 粘贴、一次 Ctrl+Z 连撤两级、一次 Ctrl+G 建组又解组；同步锁保证
  // 首个调用独占直到完成。
  const pastingRef = useRef(false);
  const undoingRef = useRef(false);
  const groupingRef = useRef(false);
  const copySelection = useCallback(() => {
    const members = groupSnapshot(1);
    if (!members) return;
    const ax = Math.min(...members.map((m) => m.x));
    const ay = Math.min(...members.map((m) => m.y));
    const items: ClipItem[] = [];
    for (const m of members) {
      const dx = m.x - ax;
      const dy = m.y - ay;
      if (m.key.startsWith("note:")) {
        const note = notes.find((item) => item.id === m.key.slice(5));
        if (note) items.push({ kind: "note", text: note.text, dx, dy });
      } else if (m.key.startsWith("eph:")) {
        const ph = entityPhs.find((item) => item.id === m.key.slice(4));
        if (ph) items.push({ kind: "eph", phKind: ph.kind, dx, dy });
      } else if (m.key.startsWith("segment:")) {
        items.push({ kind: "segment", dx, dy });
      }
    }
    if (items.length === 0) return;
    clipRef.current = { items, ax, ay };
  }, [groupSnapshot, notes, entityPhs]);
  const pasteClipboard = useCallback(async () => {
    if (pastingRef.current) return;
    pastingRef.current = true;
    try {
      const clip = clipRef.current;
      if (!clip || clip.items.length === 0) return;
      const ax = clip.ax + 28;
      const ay = clip.ay + 28;
      const newKeys: string[] = [];
      for (const item of clip.items) {
        const x = Math.round(ax + item.dx);
        const y = Math.round(ay + item.dy);
        if (item.kind === "note") {
          newKeys.push(`note:${addNote(x, y)}`);
        } else if (item.kind === "eph") {
          newKeys.push(`eph:${addEntityPh(item.phKind, x, y)}`);
        } else {
          const segment = await addSegment(episodeId);
          if (segment) {
            await saveCanvasLayout({ assets: [], shots: [], scenes: [], segments: [{ id: segment.id, x, y }] });
            newKeys.push(`segment:${segment.id}`);
          }
        }
      }
      if (newKeys.length === 0) return;
      setSelection(newKeys);
      pushUndo({ type: "paste", keys: newKeys });
    } finally {
      pastingRef.current = false;
    }
  }, [addNote, addEntityPh, addSegment, episodeId, saveCanvasLayout, setSelection, pushUndo]);

  // ── 新节点出生锚点：任何「加载」动作（添加菜单挑实体/挂剧本/详情窗
  // 添加）在触发瞬间记录世界坐标，概览刷新后新出现的资料节点直接出生
  // 在那里并脉冲高亮——节点必须出现在用户视线（鼠标）附近，而不是默默
  // 落到资料框网格里让人以为加载失败。同一次面板连选多个时按 28px 错开。 ──
  const spawnAnchorRef = useRef<{ wx: number; wy: number; used: number; snapshot?: string[] } | null>(null);
  const [pulseKeys, setPulseKeys] = useState<string[]>([]);
  // 脉冲高亮 2.4s 后自动退场（effect 驱动，不用 timer ref——ref 会让
  // 传递触底函数的写法被 react-hooks/refs 拦下）。
  useEffect(() => {
    if (pulseKeys.length === 0) return;
    const timer = window.setTimeout(() => setPulseKeys([]), 2400);
    return () => window.clearTimeout(timer);
  }, [pulseKeys]);
  const armSpawnAt = useCallback(
    (wx: number, wy: number) => {
      // 武装时带上「当前存在节点集合」快照：锚点消费 effect 的首跑
      // （prevInfoKeysRef 尚为 null——刚重挂、整页刷新或首次进画布）会
      // 整体跳过 fresh 判定，武装进来的锚点将永远等不到消费，新节点
      // 全部落回资料框网格。effect 侧以快照兜底首跑的 prev，此后新增
      // 的节点才能被识别为 fresh。
      spawnAnchorRef.current = { wx, wy, used: 0, snapshot: infoNodes.map((node) => node.key) };
    },
    [infoNodes],
  );
  const prevInfoKeysRef = useRef<string[] | null>(null);
  useEffect(() => {
    // 概览刷新途中 selectEpisode 会先置空（infoNodes 短暂为空）：这个
    // 空档不是「节点删光了」，跳过——否则刷新后所有节点都会被误判为
    // 新出生，锚点也会在空档里被误消耗。
    if (infoNodes.length === 0) return;
    const anchor = spawnAnchorRef.current;
    const prev = prevInfoKeysRef.current ?? anchor?.snapshot ?? null;
    prevInfoKeysRef.current = infoNodes.map((node) => node.key);
    if (!prev || !anchor) return;
    const fresh = infoNodes.filter((node) => !prev.includes(node.key));
    if (fresh.length === 0) return;
    const next = { ...infoOffsets };
    const marks: string[] = [];
    fresh.forEach((node, index) => {
      const step = anchor.used + index;
      next[node.key] = { x: Math.round(anchor.wx + step * 28), y: Math.round(anchor.wy + step * 28) };
      marks.push(node.key);
    });
    anchor.used += fresh.length;
    persistInfoOffsets(next);
    setPulseKeys(marks);
  }, [infoNodes, infoOffsets, persistInfoOffsets]);

  // ── 节点详情窗口：双击节点弹出的独立预览窗口（预览 + 信息 + 上传/
  // 库选）。资料类带 当前/全部 切换；片段窗口按 角色/场景/道具 三区块
  // 各自独立切换。 ──
  type DetailScope = "current" | "all";
  const [detailFor, setDetailFor] = useState<
    | { kind: "entityPh"; id: string }
    | { kind: "promptPh"; id: string }
    | { kind: "segment"; id: string; scopes: { chars: DetailScope; locs: DetailScope; props: DetailScope } }
    | { kind: "info"; group: EntityPhKind; sourceKey: string; scope: DetailScope }
    | { kind: "script"; phId?: string }
    | null
  >(null);
  // 成员装入面板（多选 + 装入确认）：eph 加载 / 组追加裁剪 / 默认节点转组。
  // （pending 只是面板内的勾选草稿，点「装入」才由 applyMemberPick 落地。）
  const [memberPick, setMemberPick] = useState<
    | { mode: "eph"; ephId: string; kind: EntityPhKind; pending: string[] }
    | { mode: "grp"; groupId: string; kind: EntityPhKind; pending: string[] }
    | { mode: "convert"; sourceKey: string; kind: EntityPhKind; pending: string[] }
    | null
  >(null);
  // 详情窗口内「从资源库选择」的二级选择器目标（片段挂产出）。
  const [pickerFor, setPickerFor] = useState<`segment:${string}` | null>(null);
  const [detailError, setDetailError] = useState("");
  // 真切集（两个非空集 id 之间切换）才关闭详情窗口与其二级选择器，并
  // 丢弃未消费的出生锚点与脉冲。episodeId 为空串是 selectEpisode 刷新
  // 途中的瞬态（概览先置空再取回）；空档与随后的「回到原集」都不算切
  // 集——否则每次刷新都会把打开中的窗口、出生锚点误杀。
  const prevRealEpisodeRef = useRef(episodeId);
  useEffect(() => {
    if (!episodeId) return;
    if (prevRealEpisodeRef.current === episodeId) return;
    prevRealEpisodeRef.current = episodeId;
    setDetailFor(null);
    setPickerFor(null);
    setMemberPick(null);
    setDetailError("");
    setPulseKeys([]);
    spawnAnchorRef.current = null;
  }, [episodeId]);
  useEffect(() => {
    setDetailError("");
  }, [detailFor]);

  // 详情窗口动作：本机上传（选文件 → 复制入库 → 回调挂接；与库选择器
  // 的导入同一条链路）。
  const uploadViaImport = async (after: (file: { filePath: string; kind: string; name: string }) => void) => {
    setDetailError("");
    try {
      const { path } = await invoke<{ path: string }>("select_resource_trace_file");
      const file = await invoke<{ file_path: string; kind: string; name: string }>(
        "import_resource_file",
        { sourcePath: path },
      );
      after({ filePath: file.file_path, kind: file.kind, name: file.name });
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : String(error));
    }
  };
  // 详情窗口 → 从资源库选择：片段挂产出。
  const attachSegmentFromLibrary = (segmentId: string, file: { filePath: string; kind: string; name: string }) => {
    // linkAsset 内部会整刷概览（画布随之重挂、UI 状态清空），窗口主动关；
    // setSegmentAsset 只落库且发生在重取快照之后，末尾再刷一次让片段
    // 缩略图立即出现，否则要等下次刷新。
    setPickerFor(null);
    setDetailFor(null);
    void linkAsset({
      filePath: file.filePath,
      kind: file.kind,
      name: file.name,
      episodeId,
      shotId: "",
    }).then(async (asset) => {
      if (!asset) return;
      await setSegmentAsset(segmentId, asset.id);
      await selectEpisode(episodeId);
    });
  };
  // 空白资料节点的「加载」已并入成员装入面板（applyMemberPick 的 eph 分支）：

  const outputKey = overview?.episode.output_asset_id ?? null;

  // 成片来源显示名：镜头描述或素材名（散件不上画布，旧数据仍可回退显示）。
  const outputSourceLabel: string | null = useMemo(() => {
    if (!outputKey) return null;
    if (outputKey.startsWith("shot:")) {
      const shot = scenes.flatMap((s) => s.shots).find((item) => item.id === outputKey.slice(5));
      return shot?.description || null;
    }
    return (
      looseAssets.find((a) => a.id === outputKey)?.name ||
      allAssetsOf(scenes).find((a) => a.id === outputKey)?.name ||
      null
    );
  }, [outputKey, scenes, looseAssets]);

  const cardSizeOf = useCallback(
    (shotId: string) => {
      const card = layout.cards.find((c) => c.shot.id === shotId);
      return { w: card?.w ?? CARD_W, h: card?.h ?? 120 };
    },
    [layout],
  );

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
  // 出生锚点的屏幕坐标换算版（vpRef 在本节声明，故放在此处）。
  const armSpawnFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      const rect = vpRef.current?.getBoundingClientRect();
      if (!rect) return;
      armSpawnAt((clientX - rect.left - view.x) / view.scale, (clientY - rect.top - view.y) / view.scale);
    },
    [armSpawnAt, view.x, view.y, view.scale],
  );

  // 工作流缺项检查（ComfyUI 缺节点的对应提醒）；「未连成片」可点击
  // 定位到成片节点。有片段时成片由片段按序聚合，不再要求单素材连线。
  const issues = useMemo(() => {
    const list: { key: string; label: string }[] = [];
    if (overview && !overview.episode.script_path) {
      list.push({ key: "script", label: t("project.canvas.checkScript") });
    }
    const emptySegments = segments.filter((item) => !item.asset).length;
    if (emptySegments > 0) {
      list.push({ key: "segAssets", label: t("project.canvas.checkSegAssets", { count: emptySegments }) });
    }
    if (overview && !outputKey && segments.length === 0) {
      list.push({ key: "output", label: t("project.canvas.checkOutput") });
    }
    return list;
  }, [overview, outputKey, segments, t]);

  const locateOutput = useCallback(() => {
    const el = vpRef.current;
    if (!el || !outputBox) return;
    const next = {
      x: el.clientWidth / 2 - (outputBox.x + outputBox.w / 2) * view.scale,
      y: el.clientHeight / 2 - (outputBox.y + outputBox.h / 2) * view.scale,
      scale: view.scale,
    };
    setView(next);
    saveView(next);
  }, [outputBox, view.scale, setView, saveView]);

  // 提醒条「N 个片段未挂产出」：定位到第一个空片段。
  const locateEmptySegment = useCallback(() => {
    const el = vpRef.current;
    const target = segments.find((item) => !item.asset);
    const p = target ? segPos[target.id] : null;
    if (!el || !p) return;
    const next = {
      x: el.clientWidth / 2 - (p.x + SEG_W / 2) * view.scale,
      y: el.clientHeight / 2 - (p.y + SEG_H / 2) * view.scale,
      scale: view.scale,
    };
    setView(next);
    saveView(next);
  }, [segments, segPos, view.scale, setView, saveView]);

  // ── 默认工作流模板：首次进入某集画布且集内尚无任何工作流数据时，
  // 自动铺一套连线完整的骨架——两个空片段，每个片段各配 5 个空白占位
  // 节点（角色/场景/道具/提示词/剧本）并连好对应输入口，「其他」口留空；
  // 片段→成片是隐式聚合线。占位节点双击填充具体内容，用户在其上自由
  // 增删连线。标记落 localStorage，此后即使删光片段也不再重建。 ──
  const templateFlagKey = `project_canvas_templated_${episodeId}`;
  useEffect(() => {
    if (!episodeId || !overview) return;
    let templated: boolean;
    try {
      templated = window.localStorage.getItem(templateFlagKey) === "1";
    } catch {
      templated = false;
    }
    if (templated) return;
    try {
      window.localStorage.setItem(templateFlagKey, "1");
    } catch {
      // 存储不可用：仅不记忆（下次进入可能重铺一次，无碍）。
    }
    if (overview.segments.length > 0 || overview.node_links.length > 0 || overview.episode.output_asset_id) {
      return; // 已有工作流数据的老集：保持原样。
    }
    void (async () => {
      const created: string[] = [];
      for (let i = 0; i < 2; i++) {
        const segment = await addSegment(episodeId);
        if (segment) created.push(segment.id);
      }
      if (created.length === 0) return;
      // 绕开加载时序竞争：切集首帧的 state 可能还是上一集的旧值（按集
      // 加载 effect 与本 effect 同批提交），直接读存储里本集的当前列表，
      // 模板内容拼在其后一次性落盘（同 tick 多次追加会互相覆盖）。
      const readStored = <T,>(name: string): T | null => {
        try {
          const raw = window.localStorage.getItem(`project_canvas_${name}_${episodeId}`);
          return raw == null ? null : (JSON.parse(raw) as T);
        } catch {
          return null;
        }
      };
      const listOf = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value.filter((item) => item && typeof item === "object") as T[]) : []);
      const offsetsRaw = readStored<Record<string, Pos>>("infonodes");
      const newEphs: EntityPh[] = [];
      const newPrompts: PromptPh[] = [];
      const newScripts: ScriptPh[] = [];
      const scriptOffsets: Record<string, Pos> = {};
      const pendings: PendingLink[] = [];
      // 片段默认列位与 segPos effect 同基准（成片节点默认挂 worldW+80）。
      const segX = layout.worldW + 80 - SEG_W - 160;
      created.forEach((segId, i) => {
        const segY = Math.max(WORLD_MARGIN, 110 + i * 260);
        // 片段左侧三列两行：角色/场景/道具靠片段，提示词/剧本纸片在最左
        // （纸片更宽）。
        const c0 = segX - 40 - INFO_W;
        const c1 = c0 - 24 - INFO_W;
        const c2 = c1 - 24 - SCRIPT_W;
        const r0 = segY - 140;
        const r1 = r0 + INFO_H + 28;
        const r2 = r1 + INFO_H + 28;
        const charId = `eph${Date.now()}${Math.floor(Math.random() * 1e4)}a${i}`;
        const locId = `eph${Date.now()}${Math.floor(Math.random() * 1e4)}b${i}`;
        const propId = `eph${Date.now()}${Math.floor(Math.random() * 1e4)}c${i}`;
        const promptId = `pph${Date.now()}${Math.floor(Math.random() * 1e4)}${i}`;
        const scriptId = `sph${Date.now()}${Math.floor(Math.random() * 1e4)}${i}`;
        newEphs.push({ id: charId, kind: "character", x: c0, y: r0 });
        newEphs.push({ id: locId, kind: "location", x: c1, y: r0 });
        newEphs.push({ id: propId, kind: "prop", x: c0, y: r1 });
        newPrompts.push({ id: promptId, promptId: "", x: c2, y: r1 });
        newScripts.push({ id: scriptId, path: "" });
        scriptOffsets[`script:${scriptId}`] = { x: c2, y: r2 };
        pendings.push(
          { fromKey: `eph:${charId}`, toSegmentId: segId, toPort: "character" },
          { fromKey: `eph:${locId}`, toSegmentId: segId, toPort: "location" },
          { fromKey: `eph:${propId}`, toSegmentId: segId, toPort: "prop" },
          { fromKey: `prompt:${promptId}`, toSegmentId: segId, toPort: "prompt" },
          { fromKey: `script:${scriptId}`, toSegmentId: segId, toPort: "script" },
        );
      });
      persistEntityPhs([...listOf<EntityPh>(readStored<EntityPh[]>("entityph")), ...newEphs]);
      persistPromptPhs([...listOf<PromptPh>(readStored<PromptPh[]>("promptphs")), ...newPrompts]);
      persistScriptPhs([...listOf<ScriptPh>(readStored<ScriptPh[]>("scriptphs")), ...newScripts]);
      persistInfoOffsets({ ...(offsetsRaw && typeof offsetsRaw === "object" && !Array.isArray(offsetsRaw) ? offsetsRaw : {}), ...scriptOffsets });
      persistPendingLinks([...listOf<PendingLink>(readStored<PendingLink[]>("pendinglinks")), ...pendings]);
    })();
  }, [episodeId, overview, addSegment, layout.worldW, persistEntityPhs, persistPromptPhs, persistScriptPhs, persistInfoOffsets, persistPendingLinks, templateFlagKey]);

  // 剧本节点定位（视口居中到剧本纸片；纸片可被拖离资料框，用覆盖位置）。
  // key 缺省为主剧本节点，缺项提醒定位空纸片时传纸片 key。
  const locateScript = useCallback(
    (key = "script") => {
      const el = vpRef.current;
      const p = infoNodePos(key);
      if (!el || !p) return;
      const size = sizeOfNode(key) ?? { w: SCRIPT_W, h: INFO_H + 40 };
      const next = {
        x: el.clientWidth / 2 - (p.x + size.w / 2) * view.scale,
        y: el.clientHeight / 2 - (p.y + size.h / 2) * view.scale,
        scale: view.scale,
      };
      setView(next);
      saveView(next);
    },
    [infoNodePos, sizeOfNode, view.scale, setView, saveView],
  );

  // 挂剧本（双击空纸片 / 详情窗重挂后从库选文件），按目标节点分派：
  // - 主剧本节点（"script"）：换库内文件做本集剧本，挂接成功即自动接入
  //   所有已有片段的剧本口（linkNode 幂等，重复挂接不会写重）。
  // - 剧本纸片：本集还没剧本时该纸片「转正」为主剧本——位置/尺寸移交、
  //   暂存线由全量接入覆盖、纸片移除；已有剧本时纸片独立持自己的文件
  //   （画布层记忆），不动本集剧本。
  const handleScriptPick = useCallback(
    (filePath: string) => {
      const episode = overview?.episode;
      const target = scriptPickTarget;
      setScriptPickTarget(null);
      if (!episode || !target) {
        setScriptPickOpen(false);
        return;
      }
      const attachEpisode = () => {
        void updateEpisode(episode.id, {
          title: episode.title,
          status: episode.status,
          script_path: filePath,
        }).then(() => {
          segments.forEach((segment) => {
            void linkNode(episode.id, "script", episode.id, segment.id, "script");
          });
          setScriptPickOpen(false);
        });
      };
      if (target === "script") {
        attachEpisode();
        return;
      }
      const phId = target.slice(7);
      if (!scriptPhs.some((item) => item.id === phId)) {
        setScriptPickOpen(false);
        return;
      }
      if (episode.script_path) {
        persistScriptPhs(scriptPhs.map((item) => (item.id === phId ? { ...item, path: filePath } : item)));
        setScriptPickOpen(false);
        return;
      }
      const nextOffsets = { ...infoOffsets };
      const phPos = nextOffsets[target];
      delete nextOffsets[target];
      if (phPos) nextOffsets.script = phPos;
      persistInfoOffsets(nextOffsets);
      const nextSizes = { ...nodeSizes };
      const phSize = nextSizes[target];
      delete nextSizes[target];
      if (phSize) nextSizes.script = phSize;
      persistSizes(nextSizes);
      persistScriptPhs(scriptPhs.filter((item) => item.id !== phId));
      dropPendingLinksOf(target);
      // 清掉出生锚点：转正出的主剧本节点要留在纸片原位，不能被锚点挪走。
      spawnAnchorRef.current = null;
      attachEpisode();
    },
    [
      overview, scriptPickTarget, scriptPhs, segments, updateEpisode, linkNode,
      persistScriptPhs, infoOffsets, persistInfoOffsets, nodeSizes, persistSizes, dropPendingLinksOf,
    ],
  );

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
    // 包围盒 = 基础布局 ∪ 拖动过的资料节点实际位置 ∪ 片段实际位置 ∪
    // 成片节点：自由拖动/改尺寸之后，「适配全部」仍覆盖所有内容。
    let worldW = layout.worldW;
    let worldH = layout.worldH;
    infoNodes.forEach((node) => {
      const p = infoNodePos(node.key);
      worldW = Math.max(worldW, p.x + node.w + 40);
      worldH = Math.max(worldH, p.y + node.h + 40);
    });
    // 空白资料节点可能被拖到世界任意角落，同样要进包围盒。
    entityPhs.forEach((ph) => {
      const p = infoNodePos(`eph:${ph.id}`);
      worldW = Math.max(worldW, p.x + INFO_W + 40);
      worldH = Math.max(worldH, p.y + INFO_H + 40);
    });
    Object.values(segPos).forEach((p) => {
      worldW = Math.max(worldW, p.x + SEG_W + 40);
      worldH = Math.max(worldH, p.y + SEG_H + 200);
    });
    const outputRight = outputBox ? outputBox.x + outputBox.w + 60 : 0;
    // 空资料框不渲染，也不参与包围盒（否则空集会多出一块 invisible 区域）。
    const infoGridBottom = infoNodes.length > 0
      ? infoPos.frame.y + FRAME_PAD_TOP + Math.ceil(infoNodes.length / 3) * (INFO_H + CARD_GAP)
      : 0;
    worldW = Math.max(worldW, infoNodes.length > 0 ? infoPos.frame.x + FRAME_MIN_W + 60 : 0, outputRight);
    worldH = Math.max(worldH, infoGridBottom + 60);
    const scale = Math.min(el.clientWidth / worldW, el.clientHeight / worldH, 1);
    const next = {
      x: Math.max(12, (el.clientWidth - worldW * scale) / 2),
      y: Math.max(8, (el.clientHeight - worldH * scale) / 2),
      scale,
    };
    setView(next);
    saveView(next);
  }, [layout, infoPos, infoNodes, infoNodePos, segPos, saveView, outputBox, entityPhs]);

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
  }, [episodeId, infoPos]);

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
  }, [view.scale, layout, nodeSizes, infoNodes, segments, promptPhs, entityPhs, measureNodes, scheduleMeasureNodes]);

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

  // 片段输入口连线：按承载节点去重——组内多个成员各自落的 node_link
  // 在画布上只画一条线（线的含义 = 组内全部成员接入；删线 = 全部断开）。
  const segWires = useMemo(() => {
    const list: { key: string; fromKey: string; links: typeof nodeLinks }[] = [];
    const index = new Map<string, number>();
    nodeLinks.forEach((link) => {
      const fromKey = ownerKeyOf(link.from_kind, link.from_id);
      const dedup = `${fromKey}|${link.to_segment}|${link.to_port}`;
      const at = index.get(dedup);
      if (at !== undefined) {
        list[at].links.push(link);
        return;
      }
      index.set(dedup, list.length);
      list.push({ key: `segwire-${link.id}`, fromKey, links: [link] });
    });
    return list;
  }, [nodeLinks, ownerKeyOf]);

  // 节点接口（ComfyUI 式）：输入口列在左缘、输出口在右缘，口带名称与
  // 数据类型；类型不兼容的连线在拖拽与落下时都会被拒绝。
  // 片段节点是核心生成单元：六输入口（角色/场景/道具/提示词/剧本/其他）+
  // 片段视频输出口。兼容分三档：角色/场景/道具同为图片类可互相穿插；
  // 剧本与提示词同为文本类可互相穿插；「其他」口不限类型全兼容。
  // 口 id 沿用历史：port "script" 即剧本口（存量剧本连线落此口），
  // port "prompt" 为提示词口。
  const portsOf = useCallback(
    (key: string): { ins: { id: string; label: string; accepts: string[] }[]; out?: { label: string; type: string } } => {
      if (key.startsWith("segment:")) {
        return {
          ins: [
            { id: "character", label: t("project.canvas.typeCharacter"), accepts: ["image"] },
            { id: "location", label: t("project.canvas.typeLocation"), accepts: ["image"] },
            { id: "prop", label: t("project.canvas.typeProp"), accepts: ["image"] },
            { id: "prompt", label: t("project.canvas.typePrompt"), accepts: ["prompt", "text"] },
            { id: "script", label: t("project.canvas.typeScript"), accepts: ["text", "prompt"] },
            { id: "other", label: t("project.canvas.typeOther"), accepts: ["image", "video", "audio", "file", "text", "prompt"] },
          ],
          out: { label: t("project.canvas.portSegment"), type: "video" },
        };
      }
      if (key === "output") {
        return { ins: [{ id: "in", label: t("project.canvas.portFinal"), accepts: ["video"] }] };
      }
      if (key.startsWith("shot:")) {
        const shot = scenes.flatMap((s) => s.shots).find((item) => item.id === key.slice(5));
        if (!shot) return { ins: [] };
        const hasVideo = shot.assets.some((a) => a.kind === "video");
        return {
          ins: [{ id: "in", label: t("project.canvas.portRef"), accepts: REF_ACCEPTS }],
          out: { label: t(hasVideo ? "project.canvas.portFootage" : "project.canvas.typeImage"), type: hasVideo ? "video" : "image" },
        };
      }
      // 空白资料占位（未加载的角色/场景/道具）：与加载后的实体节点同款
      // 参考图输出口——节点一上画布就能接入工作流，加载实体后暂存线转正。
      if (key.startsWith("eph:")) {
        return { ins: [], out: { label: t("project.canvas.portRefImg"), type: "image" } };
      }
      // 提示词纸片：输出口为提示词类型（青色），接片段「提示词」口。
      if (key.startsWith("prompt:")) {
        return { ins: [], out: { label: t("project.canvas.typePrompt"), type: "prompt" } };
      }
      if (key === "script" || key.startsWith("script:")) {
        return { ins: [], out: { label: t("project.canvas.typeScript"), type: "text" } };
      }
      if (key.startsWith("char:") || key.startsWith("loc:") || key.startsWith("prop:") || key.startsWith("grp:")) {
        return { ins: [], out: { label: t("project.canvas.portRefImg"), type: "image" } };
      }
      return { ins: [] };
    },
    [scenes, t],
  );

  const inPointOf = useCallback(
    (key: string, portId?: string): { x: number; y: number } | null => {
      const box = boxOf(key);
      if (!box) return null;
      const ins = portsOf(key).ins;
      const pid = portId ?? ins[0]?.id;
      const off = pid ? nodeMetrics.ports[key]?.[pid] : undefined;
      if (off) return { x: box.x + off.x, y: box.y + off.y };
      const index = portId ? ins.findIndex((p) => p.id === portId) : 0;
      return { x: box.x, y: box.y + box.h * portRatio(index < 0 ? 0 : index, Math.max(ins.length, 1)) };
    },
    [boxOf, portsOf, nodeMetrics],
  );

  // 画布节点 key → node_link 来源（片段输入口连线的落库形态）。
  const nodeKeyParts = useCallback(
    (key: string): { kind: ProjectNodeLink["from_kind"]; id: string } | null => {
      if (key.startsWith("char:")) return { kind: "character", id: key.slice(5) };
      if (key.startsWith("loc:")) return { kind: "location", id: key.slice(4) };
      if (key.startsWith("prop:")) return { kind: "prop", id: key.slice(5) };
      if (key.startsWith("segment:")) return { kind: "segment", id: key.slice(8) };
      if (key.startsWith("shot:")) return { kind: "shot", id: key.slice(5) };
      if (key === "script") return { kind: "script", id: episodeId };
      return null;
    },
    [episodeId],
  );

  // 「拖线到空白 → 创建节点」后自动把新节点接上那条线（ComfyUI 行为）。
  const autoConnectNewNode = useCallback(
    (
      newKey: string,
      wire:
        | {
            fromKey: string;
            fromDir: "out" | "in";
            fromType?: string;
            fromAccepts?: string[];
            fromPortId?: string;
          }
        | null
        | undefined,
    ) => {
      if (!wire) return;
      const [outKey, inKey] = wire.fromDir === "in" ? [newKey, wire.fromKey] : [wire.fromKey, newKey];
      if (inKey === "output") {
        if (outKey.startsWith("shot:")) void setEpisodeOutput(episodeId, outKey);
        return;
      }
      if (inKey.startsWith("segment:")) {
        const fromType = wire.fromType ?? portsOf(outKey).out?.type;
        // 反拖（从片段输入口拖出到空白建节点）：线回到出发的那个口——
        // 用户拿着的是「通往这个口」的线，不是「通往第一个兼容口」的线；
        // 口仍需兼容来源类型（拖出去的线换了个不兼容的新源则放不回）。
        // 正拖或无口记录时按数据类型找第一个兼容口。
        const port =
          (wire.fromDir === "in" && wire.fromPortId
            ? portsOf(inKey).ins.find(
                (item) => item.id === wire.fromPortId && (!fromType || item.accepts.includes(fromType)),
              )
            : undefined) ??
          portsOf(inKey).ins.find((item) =>
            fromType ? item.accepts.includes(fromType) : false,
          );
        if (!port) return;
        if (outKey.startsWith("script:")) {
          // 剧本纸片的连线不入库（后端剧本连线以集为锚），落画布暂存线。
          const segId = inKey.slice(8);
          persistPendingLinks([
            ...pendingLinks.filter((l) => !(l.fromKey === outKey && l.toSegmentId === segId && l.toPort === port.id)),
            { fromKey: outKey, toSegmentId: segId, toPort: port.id },
          ]);
          return;
        }
        const source = nodeKeyParts(outKey);
        if (!source) {
          // 空白资料/提示词纸片源没有库身份（nodeKeyParts 解析不出）：
          // 正式线无处可落，改记画布暂存线，加载实体后照常转正（提示词
          // 纸片始终画布层记忆，暂存线即最终形态）。
          const segId = inKey.slice(8);
          if (outKey.startsWith("eph:") || outKey.startsWith("prompt:")) {
            persistPendingLinks([
              ...pendingLinks.filter((l) => !(l.fromKey === outKey && l.toSegmentId === segId && l.toPort === port.id)),
              { fromKey: outKey, toSegmentId: segId, toPort: port.id },
            ]);
          }
          return;
        }
        void linkNode(
          episodeId,
          source.kind,
          source.id,
          inKey.slice(8),
          port.id as ProjectNodeLink["to_port"],
        );
        return;
      }
    },
    [episodeId, nodeKeyParts, portsOf, linkNode, setEpisodeOutput, pendingLinks, persistPendingLinks],
  );

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

  interface DragState {
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
    //（pending 一条或 db 多行），创建成功即删旧写新，取消则放回。
    detached?: { pendings: PendingLink[]; rows: ProjectNodeLink[] };
    wire?: { // addnode：从「拖线到空白」菜单创建节点后要自动接的线
      fromKey: string;
      fromDir: "out" | "in";
      fromType?: string;
      fromAccepts?: string[];
      fromPortId?: string;
    };
  }
  const dragRef = useRef<DragState | null>(null);
  // 拖动后 mouseup 落在卡内按钮（挂靠/缩略图）上会派发 click，需吞掉这次误触。
  const suppressClickRef = useRef(false);
  const [wireDraft, setWireDraft] = useState<{ d: string; invalid: boolean; color?: string } | null>(null);
  // 拖线悬停高亮的目标节点（ComfyUI 落点亮框），松手/取消时清除。
  const wireHoverRef = useRef<Element | null>(null);
  // ComfyUI 摘线：点击已连线的输入口把线「摘下来拿着」——这个口上的
  // 全部线（暂存线 + 正式线）进入隐藏态（渲染层过滤），松手时整组转接 /
  // 交给添加菜单（建新节点即转接）/ 无效落点原样放回。行数据不预先删除，
  // 收尾才落库。摘一个口 = 拿走这个口上所有线，不留残留。
  interface LiftedWire {
    fromKey: string; // 视觉线的源节点 key（组线为整组承载节点）
    pendings: PendingLink[];
    rows: ProjectNodeLink[];
  }
  const [liftedWire, setLiftedWire] = useState<LiftedWire | null>(null);
  const liftedRef = useRef<LiftedWire | null>(null);
  useEffect(() => {
    liftedRef.current = liftedWire;
  }, [liftedWire]);
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
              void unlinkNode(l.from_kind, l.from_id, l.to_segment, l.to_port);
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
      // 摘线场景同时恢复原连接，不能继续落入画布空白的框选分支。
      if (addMenu && !target?.closest(".pc-addmenu")) {
        if (addMenu.detached) setLiftedWire(null);
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
              : ownerKeyOf(rows[0].from_kind, rows[0].from_id);
            setLiftedWire({ fromKey, pendings, rows });
            vp.classList.add("pc-wiring");
            port.classList.add("pc-port-active");
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
    [layout, pos, setSelection, view, infoPos, scenePos, portsOf, outputBox, notes, segPos, sizeOfNode, infoNodePos, nodeSizes, groupSnapshot, nodeGroups, memberFrame, addMenu, nodeLinks, pendingLinks, ownerKeyOf, buildCutTargets, setLiftedWire],
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
              const isSameNode = tKey === drag.fromKey;
              const hoverPortId =
                hit instanceof Element
                  ? hit.closest('.pc-port[data-port="in"]')?.getAttribute("data-port-id") ?? null
                  : null;
              const ins = ports.ins;
              const hovered =
                hoverPortId && ins.some((item) => item.id === hoverPortId) ? hoverPortId : null;
              const sameName =
                !isSameNode &&
                drag.fromPortId &&
                ins.some((item) => item.id === drag.fromPortId)
                  ? drag.fromPortId
                  : null;
              targetPort = hovered ?? sameName;
              compatible = !!targetPort && (!isSameNode || targetPort !== drag.fromPortId);
            } else if (tKey !== drag.fromKey) {
              compatible = !!ports.out && !!drag.fromAccepts?.includes(ports.out.type);
            }
          } else if (drag.fromType && tKey !== drag.fromKey) {
            // 吸附优先级：光标就近的可接输入口（ComfyUI 落点即所接口），
            // 不就近时回退为第一个可接口。
            let best: { id: string } | undefined;
            let bestDist = Infinity;
            const box = boxOf(tKey);
            ports.ins.forEach((item, index) => {
              if (!item.accepts.includes(drag.fromType!)) return;
              const dist = box
                ? Math.abs(box.y + box.h * portRatio(index, ports.ins.length) - wy)
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
            ? WIRE_TYPE_COLORS[portsOf(lifted.fromKey).out?.type ?? ""] ?? undefined
            : drag.fromType
              ? WIRE_TYPE_COLORS[drag.fromType]
              : undefined,
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
            setLiftedWire(null);
            const segId = targetKey.slice(8);
            const port = drag.targetPort as ProjectNodeLink["to_port"];
            if (lifted.pendings.length) {
              persistPendingLinks([
                ...pendingLinks.filter((l) => !lifted.pendings.includes(l)),
                ...lifted.pendings.map((p) => ({ fromKey: p.fromKey, toSegmentId: segId, toPort: port })),
              ]);
            }
            if (lifted.rows.length) {
              lifted.rows.forEach((row) => {
                void unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port);
              });
              lifted.rows.forEach((row) => {
                void linkNode(episodeId, row.from_kind, row.from_id, segId, port);
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
              lifted.rows.every((r) => ownerKeyOf(r.from_kind, r.from_id) === targetKey);
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
              lifted.rows.forEach((row) => {
                void unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port);
                targetSources.forEach((nextSource) => {
                  void linkNode(episodeId, nextSource.kind, nextSource.id, row.to_segment, row.to_port);
                });
              });
            } else if (!source && !targetGroup && !pendSameAsOld) {
              // 无库身份目标（空白资料占位/素材占位）：落不了正式 node_link，
              // 但暂存线是画布层状态、fromKey 任意——整组改插到新目标；
              // 正式线保持原样（lifted 已清，渲染自动恢复）。
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
              if (port) {
                persistPendingLinks([
                  ...pendingLinks.filter((l) => !(l.fromKey === outKey && l.toSegmentId === segId && l.toPort === port)),
                  { fromKey: outKey, toSegmentId: segId, toPort: port },
                ]);
              }
            } else if (outKey.startsWith("grp:")) {
              // 组节点一条线 = 组内全部成员分别落一条 node_link；且无论
              // 拖到哪个口，都按组类型进对应口（角色组进角色口）。
              const group = infoGroups.find((g) => `grp:${g.id}` === outKey);
              if (group) {
                group.members.forEach((memberId) => {
                  void linkNode(episodeId, group.kind, memberId, segId, group.kind);
                });
              }
            } else {
              const source = nodeKeyParts(outKey);
              const port = drag.fromDir === "in" ? drag.fromPortId : drag.targetPort;
              if (source && port) {
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
                void unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port);
              });
              d.rows.forEach((row) => {
                void linkNode(episodeId, row.from_kind, row.from_id, segId, row.to_port as ProjectNodeLink["to_port"]);
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
              void unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port);
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
  }, [layout, pos, view, scenePos, infoPos, boxOf, portsOf, outPointOf, inPointOf, persistCards, saveCanvasLayout, saveInfoFramePos, saveView, setSelection, saveOutputPos, setEpisodeOutput, episodeId, notes, persistNotes, addNote, addEntityPh, addPromptPh, persistSegments, linkNode, unlinkNode, nodeKeyParts, addSegment, autoConnectNewNode, persistSizes, persistInfoOffsets, infoGroups, infoNodes, infoNodePos, entityPhs, promptPhs, segments, segPos, sizeOfNode, outputBox, moveGroupTo, persistPositions, pushUndo, pendingLinks, persistPendingLinks, setInfoFramePos, setInfoOffsets, setNodeSizes, setNotes, setOutputPos, openNodeDetail, ownerKeyOf]);

  // ── 节点操作 ──
  // 节点接口圆点（ComfyUI 式）：输入口列在左缘（片段六口按列分布）、
  // 输出口在右缘实心类型色，hover 浮现接口名称；按下即拖出连线，从
  // 节点接口（ComfyUI K 采样器同款行位）：实心类型色圆点落在卡内、
  // 紧贴左右两缘；输入列自顶部起贴左缘，输出贴右缘且与首行输入同一
  // 水平行；接口名称常显。端口坐标由实测驱动连线锚点。
  // 输入口优先用端口专属色（片段六口每口一色），未命中回退类型色。
  const portBar = (key: string) => {
    const { ins, out } = portsOf(key);
    if (ins.length === 0 && !out) return null;
    const rows = Math.max(ins.length, out ? 1 : 0);
    return (
      <div className="pc-port-bar">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="pc-port-row">
            {ins[i] ? (
              <>
                <span
                  className="pc-port pc-port-in"
                  data-port="in"
                  data-port-id={ins[i].id}
                  style={{ background: PORT_COLORS[ins[i].id] ?? WIRE_TYPE_COLORS[ins[i].accepts[0] ?? ""] ?? undefined }}
                />
                <span className="pc-port-name">{ins[i].label}</span>
              </>
            ) : null}
            {i === 0 && out ? (
              <>
                <span className="pc-port-name pc-port-name-out">{out.label}</span>
                <span
                  className="pc-port pc-port-out"
                  data-port="out"
                  style={{ background: WIRE_TYPE_COLORS[out.type] ?? "#94a3b8" }}
                />
              </>
            ) : null}
          </div>
        ))}
      </div>
    );
  };

  const shotNoOf = useCallback(
    (sceneId: string, shotId: string): number => {
      const scene = scenes.find((item) => item.id === sceneId);
      const index = scene ? scene.shots.findIndex((shot) => shot.id === shotId) : -1;
      return index + 1;
    },
    [scenes],
  );

  const handleLocate = useCallback(
    (asset: ProjectAsset) => {
      void openResourceFile(joinLibraryPath(libraryRoot, asset.file_path));
    },
    [libraryRoot],
  );

  // ── 场景/镜头快速管理 ──
  const [sceneForm, setSceneForm] = useState<{ id?: string; heading: string; locationId: string } | null>(null);
  const [shotForm, setShotForm] = useState<{ id: string; sceneId: string; description: string; dialogue: string } | null>(null);
  const [deleteSceneTarget, setDeleteSceneTarget] = useState<ProjectScene | null>(null);

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



  const miniRatio = Math.min(
    MINI_W / Math.max(layout.worldW, 1),
    MINI_H / Math.max(layout.worldH + 320, 1),
  );

  // 连线层几何：SVG 尺寸恒等于视口（世界单位，外沿加少量余量），世界
  // 坐标经一层平移换算为 SVG 局部坐标。此前 SVG 按整个世界范围铺（宽度
  // 可达近万 px 的巨型图层），在部分 WebView2 的 GPU 栅格化下超限整层
  // 不绘制，用户端表现为所有连线与拖线草稿不可见；等视口图层在任何
  // 缩放下屏幕栅格尺寸都恒等于视口，从根上消除该问题。
  const wiresVis = {
    x: -view.x / view.scale - WIRES_VIEWPORT_PAD,
    y: -view.y / view.scale - WIRES_VIEWPORT_PAD,
    w: ((vpSize?.w ?? 0) || 1600) / view.scale + WIRES_VIEWPORT_PAD * 2,
    h: ((vpSize?.h ?? 0) || 900) / view.scale + WIRES_VIEWPORT_PAD * 2,
  };

  // 尺寸手柄（四角）：双击不冒泡到节点，避免连点手柄误开详情窗口。
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

  // ── 节点详情窗口：按 detailFor 组装条目（预览 + 信息 + 动作）──
  const closeDetail = () => {
    setDetailFor(null);
    setPickerFor(null);
    setMemberPick(null);
    setDetailError("");
  };
  // 窗口惯例：Esc 关闭最上层（二级选择器/装入面板开着时先关它）。
  useEffect(() => {
    if (!detailFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (memberPick) {
        setMemberPick(null);
        return;
      }
      if (pickerFor) {
        setPickerFor(null);
        return;
      }
      setDetailFor(null);
      setDetailError("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailFor, pickerFor, memberPick]);
  // ── 组成员操作：装入/移除/自动同步连线。连线语义 = 组内全部成员
  // 接入片段，所以成员变化要把 node_link 同步到位。 ──
  const entitiesOfKind = useCallback(
    (kind: EntityPhKind) =>
      kind === "character" ? castCharacters : kind === "location" ? episodeLocations : episodeProps,
    [castCharacters, episodeLocations, episodeProps],
  );
  // 资料卡新预览：首图大卡片。实体参考图取角色头像/场景与道具参考图；
  // 无图时用类型色淡底 + 名字首字占位（同一卡片形态）。
  const entityRefOf = useCallback(
    (kind: EntityPhKind, entity: { avatar_path?: string; ref_path?: string }) =>
      kind === "character" ? (entity.avatar_path ?? "") : (entity.ref_path ?? ""),
    [],
  );
  const photoMainOf = (name: string, refPath: string) =>
    refPath ? (
      <ResourceImage
        path={joinLibraryPath(libraryRoot, refPath)}
        alt={name}
        className="pc-photo-img"
      />
    ) : (
      <>
        <span className="pc-photo-init">{characterAvatarInitial(name)}</span>
        <span className="pc-photo-sub">{t("project.canvas.noRefImage")}</span>
      </>
    );
  const kindTextOf = useCallback(
    (kind: EntityPhKind) =>
      t(kind === "character" ? "project.canvas.typeCharacter" : kind === "location" ? "project.canvas.typeLocation" : "project.canvas.typeProp"),
    [t],
  );
  const groupWiredPorts = useCallback(
    (group: InfoGroup) => {
      const seen = new Set<string>();
      const out: { to_segment: string; to_port: string }[] = [];
      (overview?.node_links ?? []).forEach((l) => {
        if (l.from_kind !== group.kind || !group.members.includes(l.from_id)) return;
        const k = `${l.to_segment}|${l.to_port}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ to_segment: l.to_segment, to_port: l.to_port });
      });
      return out;
    },
    [overview],
  );
  const unlinkEntityLinks = useCallback(
    async (kind: EntityPhKind, entityId: string) => {
      const rows = (overview?.node_links ?? []).filter((l) => l.from_kind === kind && l.from_id === entityId);
      for (const row of rows) await unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port);
    },
    [overview, unlinkNode],
  );
  const associateEntities = useCallback(
    async (kind: EntityPhKind, ids: string[]) => {
      if (!episodeId || !overview || ids.length === 0) return;
      const episode = overview.episode;
      if (kind === "character") await setEpisodeCharacters(episodeId, [...new Set([...(episode.character_ids ?? []), ...ids])]);
      else if (kind === "location") await setEpisodeLocations(episodeId, [...new Set([...(episode.location_ids ?? []), ...ids])]);
      else await setEpisodeProps(episodeId, [...new Set([...(episode.prop_ids ?? []), ...ids])]);
    },
    [episodeId, overview, setEpisodeCharacters, setEpisodeLocations, setEpisodeProps],
  );
  const removeGroupMember = useCallback(
    async (groupId: string, entityId: string) => {
      const group = infoGroups.find((g) => g.id === groupId);
      if (!group) return;
      await unlinkEntityLinks(group.kind, entityId);
      const members = group.members.filter((m) => m !== entityId);
      persistInfoGroups(
        members.length
          ? infoGroups.map((g) => (g.id === groupId ? { ...g, members } : g))
          : infoGroups.filter((g) => g.id !== groupId),
      );
      // 被移除的实体回到默认单实体节点，出生在组旁看得见的位置。
      const pos = infoNodePos(`grp:${groupId}`);
      persistInfoOffsets({
        ...infoOffsets,
        [`${group.kind === "character" ? "char" : group.kind === "location" ? "loc" : "prop"}:${entityId}`]: {
          x: Math.round(pos.x + INFO_W + 24),
          y: Math.round(pos.y),
        },
      });
    },
    [infoGroups, infoNodePos, infoOffsets, persistInfoGroups, persistInfoOffsets, unlinkEntityLinks],
  );
  const addGroupMember = useCallback(
    async (groupId: string, entityId: string) => {
      const group = infoGroups.find((g) => g.id === groupId);
      if (!group || group.members.includes(entityId)) return;
      // 连线与组员落账先于概览整刷（重挂读 localStorage，见 applyMemberPick）。
      const wired = groupWiredPorts(group);
      for (const w of wired) await linkNode(episodeId, group.kind, entityId, w.to_segment, w.to_port as ProjectNodeLink["to_port"]);
      persistInfoGroups(infoGroups.map((g) => (g.id === groupId ? { ...g, members: [...g.members, entityId] } : g)));
      await associateEntities(group.kind, [entityId]);
    },
    [infoGroups, associateEntities, groupWiredPorts, linkNode, episodeId, persistInfoGroups],
  );
  // ── 节点删除（工具条与 Delete 键共用同一套语义）──
  // 资料实体节点：解除连线 + 移出本集关联（实体保留在库里，可再关联）。
  const removeInfoEntity = useCallback(
    async (kind: EntityPhKind, entityId: string) => {
      if (!episodeId || !overview) return;
      await unlinkEntityLinks(kind, entityId);
      const episode = overview.episode;
      if (kind === "character") await setEpisodeCharacters(episodeId, (episode.character_ids ?? []).filter((id) => id !== entityId));
      else if (kind === "location") await setEpisodeLocations(episodeId, (episode.location_ids ?? []).filter((id) => id !== entityId));
      else await setEpisodeProps(episodeId, (episode.prop_ids ?? []).filter((id) => id !== entityId));
    },
    [episodeId, overview, setEpisodeCharacters, setEpisodeLocations, setEpisodeProps, unlinkEntityLinks],
  );
  // 组节点：解散分组（成员实体与连线保留，自动回到默认单实体节点）。
  const removeGroup = useCallback(
    (groupId: string) => {
      persistInfoGroups(infoGroups.filter((g) => g.id !== groupId));
    },
    [infoGroups, persistInfoGroups],
  );
  // 主剧本节点：解除挂接（剧本文件留在库内），提示词连线一并清理；
  // 删除后彻底从画布移除（空纸片走 removeScriptPh，互不相干）。
  const detachScript = useCallback(async () => {
    const episode = overview?.episode;
    if (!episodeId || !episode?.script_path) return;
    const rows = (overview?.node_links ?? []).filter((l) => l.from_kind === "script");
    for (const row of rows) await unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port);
    await updateEpisode(episodeId, { title: episode.title, status: episode.status, script_path: "" });
  }, [episodeId, overview, unlinkNode, updateEpisode]);
  // 剧本纸片：从画布移除纸片记录、位置记忆与暂存线（不影响本集剧本）。
  const removeScriptPh = useCallback(
    (phId: string) => {
      const key = `script:${phId}`;
      const next = { ...infoOffsets };
      delete next[key];
      persistInfoOffsets(next);
      persistScriptPhs(scriptPhs.filter((item) => item.id !== phId));
      dropPendingLinksOf(key);
    },
    [scriptPhs, infoOffsets, persistScriptPhs, persistInfoOffsets, dropPendingLinksOf],
  );
  // 提示词纸片：移除纸片、位置记忆与暂存线。
  const removePromptPh = useCallback(
    (phId: string) => {
      const key = `prompt:${phId}`;
      const next = { ...infoOffsets };
      delete next[key];
      persistInfoOffsets(next);
      persistPromptPhs(promptPhs.filter((item) => item.id !== phId));
      dropPendingLinksOf(key);
    },
    [promptPhs, infoOffsets, persistPromptPhs, persistInfoOffsets, dropPendingLinksOf],
  );
  // 提示词选择：把选中的提示词 id 写回目标纸片。
  const handlePromptPick = useCallback(
    (promptId: string) => {
      const target = promptPickTarget;
      setPromptPickOpen(false);
      setPromptPickTarget(null);
      if (!target || !target.startsWith("prompt:")) return;
      const phId = target.slice(7);
      if (!promptPhs.some((item) => item.id === phId)) return;
      persistPromptPhs(promptPhs.map((item) => (item.id === phId ? { ...item, promptId } : item)));
    },
    [promptPickTarget, promptPhs, persistPromptPhs],
  );
  const closePromptPick = useCallback(() => {
    setPromptPickOpen(false);
    setPromptPickTarget(null);
    setPromptPickQuery("");
  }, []);
  // 空白资料占位：删除占位并清掉它拖动过的位置记忆与暂存线。
  const removeEntityPh = useCallback(
    (phId: string) => {
      const next = { ...infoOffsets };
      delete next[`eph:${phId}`];
      persistInfoOffsets(next);
      persistEntityPhs(entityPhs.filter((item) => item.id !== phId));
      dropPendingLinksOf(`eph:${phId}`);
    },
    [entityPhs, infoOffsets, persistEntityPhs, persistInfoOffsets, dropPendingLinksOf],
  );
  // ── 键盘：Delete/Backspace 删除选中节点（与各节点工具条同一套语义；
  // 镜头卡有确认对话框，走同一确认流程）；Ctrl+C/V 复制粘贴选中组；
  // Ctrl+Z 撤销。输入框聚焦或任一弹层打开时不响应。 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (
        detailFor || pickerFor || memberPick || addMenu || wireDraft ||
        scriptPickOpen || locationPickOpen || sceneForm || shotForm ||
        deleteSceneTarget
      ) {
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === "c") {
          copySelection();
          return;
        }
        if (k === "v") {
          void pasteClipboard();
          return;
        }
        if (k === "z") {
          e.preventDefault();
          // 恢复出的资料节点不是「新加载」：先清掉可能残留的出生锚点，
          // 免得恢复的节点被锚点重新定位、偏离删除前的原位。
          spawnAnchorRef.current = null;
          runUndo();
          return;
        }
        if (k === "g") {
          // 打组 / 解组（ComfyUI Group）：选中若干节点 → 组框自适应包围
          // 盒；选中恰好是某组全部成员 → 解组。成员从其他组移出（互斥）。
          e.preventDefault();
          if (groupingRef.current) return;
          groupingRef.current = true;
          window.setTimeout(() => {
            groupingRef.current = false;
          }, 0);
          if (selKeys.length === 0) return;
          // 先剪枝：成员已被删除的组清掉死成员（空组丢弃），保证解组
          // 判定与组框都基于存活成员。
          const pruned = nodeGroups
            .map((g) => ({ ...g, members: g.members.filter((key) => memberFrame(key) !== null) }))
            .filter((g) => g.members.length > 0);
          const fullGroup = pruned.find(
            (g) => g.members.length === selKeys.length && selKeys.every((key) => g.members.includes(key)),
          );
          if (fullGroup) {
            persistNodeGroups(pruned.filter((g) => g.id !== fullGroup.id));
          } else {
            const kept = pruned
              .map((g) => ({ ...g, members: g.members.filter((key) => !selKeys.includes(key)) }))
              .filter((g) => g.members.length > 0);
            persistNodeGroups([
              ...kept,
              { id: `ng${Date.now()}${Math.floor(Math.random() * 1e4)}`, label: t("project.canvas.nodeGroup"), members: [...selKeys] },
            ]);
          }
          return;
        }
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (selKeys.length === 0) return;
      e.preventDefault();
      // 可完整恢复的删除（便签/空白占位/剧本纸片）先抓原对象与暂存线，
      // 整批删除记一条撤销；恢复时原样还原（含线）。
      const restore: {
        notes?: CanvasNote[];
        ephs?: { id: string; kind: EntityPhKind; x: number; y: number }[];
        scriptPhs?: { id: string; path: string }[];
        scriptOffsets?: { key: string; pos: Pos }[];
        promptPhs?: PromptPh[];
        promptOffsets?: { key: string; pos: Pos }[];
        pending?: PendingLink[];
      } = {};
      for (const key of selKeys) {
        if (key === "output") {
          if (episodeId) void setEpisodeOutput(episodeId, null);
        } else if (key.startsWith("shot:")) {
          void deleteShot(key.slice(5));
        } else if (key.startsWith("note:")) {
          const removed = notes.find((item) => item.id === key.slice(5));
          setNotes((prev) => {
            const next = prev.filter((item) => item.id !== key.slice(5));
            persistNotes(next);
            return next;
          });
          if (removed) (restore.notes ??= []).push(removed);
        } else if (key.startsWith("segment:")) {
          void removeSegment(key.slice(8));
        } else if (key.startsWith("eph:")) {
          const removed = entityPhs.find((item) => item.id === key.slice(4));
          const dropped = pendingLinks.filter((l) => l.fromKey === key);
          removeEntityPh(key.slice(4));
          if (removed) (restore.ephs ??= []).push(removed);
          if (dropped.length) (restore.pending ??= []).push(...dropped);
        } else if (key.startsWith("grp:")) {
          removeGroup(key.slice(4));
        } else if (key === "script") {
          void detachScript();
        } else if (key.startsWith("script:")) {
          const removed = scriptPhs.find((item) => item.id === key.slice(7));
          const dropped = pendingLinks.filter((l) => l.fromKey === key);
          // 无论纸片是否拖动过都按解析位置还原（拖过的=覆盖位置，
          // 没拖过的=当前网格位），撤销后回到删除前的原位。
          const phPos = infoNodePos(key);
          removeScriptPh(key.slice(7));
          if (removed) (restore.scriptPhs ??= []).push(removed);
          if (phPos) (restore.scriptOffsets ??= []).push({ key, pos: phPos });
          if (dropped.length) (restore.pending ??= []).push(...dropped);
        } else if (key.startsWith("prompt:")) {
          const removed = promptPhs.find((item) => item.id === key.slice(7));
          const dropped = pendingLinks.filter((l) => l.fromKey === key);
          const phPos = infoNodePos(key);
          removePromptPh(key.slice(7));
          if (removed) (restore.promptPhs ??= []).push(removed);
          if (phPos) (restore.promptOffsets ??= []).push({ key, pos: phPos });
          if (dropped.length) (restore.pending ??= []).push(...dropped);
        } else if (key.startsWith("char:") || key.startsWith("loc:") || key.startsWith("prop:")) {
          const kind: EntityPhKind = key.startsWith("char:") ? "character" : key.startsWith("loc:") ? "location" : "prop";
          void removeInfoEntity(kind, key.slice(key.indexOf(":") + 1));
        }
      }
      if (restore.notes || restore.ephs || restore.scriptPhs || restore.promptPhs || restore.pending) {
        pushUndo({
          type: "restore", notes: restore.notes,
          ephs: restore.ephs, scriptPhs: restore.scriptPhs, pending: restore.pending,
          scriptOffsets: restore.scriptOffsets, promptPhs: restore.promptPhs, promptOffsets: restore.promptOffsets,
        });
      }
      setSelection([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    selKeys, detailFor, pickerFor, memberPick, addMenu, wireDraft, scriptPickOpen, locationPickOpen,
    sceneForm, shotForm, deleteSceneTarget, episodeId, notes, entityPhs, scriptPhs, promptPhs, infoOffsets, infoNodePos,
    setEpisodeOutput, deleteShot, setNotes, persistNotes, removeSegment,
    removeEntityPh, removeGroup, detachScript, removeScriptPh, removePromptPh, removeInfoEntity, setSelection,
    copySelection, pasteClipboard, runUndo, pushUndo, nodeGroups, persistNodeGroups, t,
    pendingLinks, memberFrame,
  ]);
  // 成员装入面板（多选 + 装入确认）：eph 加载 / 组追加裁剪 / 默认节点转组。
  const applyMemberPick = useCallback(async () => {
    const pick = memberPick;
    if (!pick || !episodeId) return;
    setMemberPick(null);
    // 防御：已被其他组认领的实体不参与本次装入（成员在组间互斥）。
    const claimedElsewhere = new Set(
      infoGroups
        .filter((g) => !(pick.mode === "grp" && g.id === pick.groupId))
        .flatMap((g) => g.members),
    );
    const pending = pick.pending.filter((id) => !claimedElsewhere.has(id));
    const groupIdOf = () => `g${Date.now()}${Math.floor(Math.random() * 1e4)}`;
    // 概览整刷（associateEntities → selectEpisode 先置空 overview）会令画布
    // 卸载重挂，重挂后的按集状态读自 localStorage。因此画布层落账（位置/
    // 组/占位/暂存线）与转正连线必须全部发生在刷新之前，且连线要逐条等
    // 落库完成——否则重挂读到旧账：占位与暂存线成幽灵残影（伪连接）、
    // 组节点落回网格旧位。
    if (pick.mode === "eph") {
      const ph = entityPhs.find((p) => p.id === pick.ephId);
      if (!ph || pending.length === 0) return;
      const groupId = groupIdOf();
      const pos = infoNodePos(`eph:${ph.id}`);
      const nextOffsets = { ...infoOffsets, [`grp:${groupId}`]: pos };
      delete nextOffsets[`eph:${ph.id}`];
      persistInfoOffsets(nextOffsets);
      persistEntityPhs(entityPhs.filter((p) => p.id !== ph.id));
      persistInfoGroups([...infoGroups, { id: groupId, kind: pick.kind, members: [...pending] }]);
      // 占位节点的暂存线随加载转正：组内每个成员各落一条 node_link。
      const ephKey = `eph:${ph.id}`;
      const myPending = pendingLinks.filter((l) => l.fromKey === ephKey);
      for (const l of myPending) {
        for (const memberId of pending) {
          await linkNode(episodeId, pick.kind, memberId, l.toSegmentId, l.toPort as ProjectNodeLink["to_port"]);
        }
      }
      if (myPending.length) persistPendingLinks(pendingLinks.filter((l) => l.fromKey !== ephKey));
      await associateEntities(pick.kind, pending);
      setPulseKeys([`grp:${groupId}`]);
      setDetailFor({ kind: "info", group: pick.kind, sourceKey: `grp:${groupId}`, scope: "current" });
      return;
    }
    if (pick.mode === "grp") {
      const group = infoGroups.find((g) => g.id === pick.groupId);
      if (!group) return;
      const additions = pending.filter((id) => !group.members.includes(id));
      const removals = group.members.filter((id) => !pending.includes(id));
      const wired = groupWiredPorts(group);
      for (const id of additions) {
        for (const w of wired) await linkNode(episodeId, pick.kind, id, w.to_segment, w.to_port as ProjectNodeLink["to_port"]);
      }
      for (const id of removals) await unlinkEntityLinks(pick.kind, id);
      persistInfoGroups(infoGroups.map((g) => (g.id === group.id ? { ...g, members: [...pending] } : g)));
      await associateEntities(pick.kind, additions);
      return;
    }
    // convert：默认单实体节点继续装入 → 升级为组节点（原位；primary 已有
    // 连线随归属解析自动归到组名下，新成员自动接入同样片段口）。
    const srcId = pick.sourceKey.slice((pick.kind === "character" ? "char:" : pick.kind === "location" ? "loc:" : "prop:").length);
    if (pending.length <= 1 || !pending.includes(srcId)) return;
    const groupId = groupIdOf();
    const pos = infoNodePos(pick.sourceKey);
    const nextOffsets = { ...infoOffsets, [`grp:${groupId}`]: pos };
    delete nextOffsets[pick.sourceKey];
    persistInfoOffsets(nextOffsets);
    persistInfoGroups([...infoGroups, { id: groupId, kind: pick.kind, members: [...pending] }]);
    const wiredRows = (overview?.node_links ?? []).filter((l) => l.from_kind === pick.kind && l.from_id === srcId);
    const seen = new Set<string>();
    for (const row of wiredRows) {
      const k = `${row.to_segment}|${row.to_port}`;
      if (seen.has(k)) continue;
      seen.add(k);
      for (const id of pending) {
        if (id !== srcId) await linkNode(episodeId, pick.kind, id, row.to_segment, row.to_port);
      }
    }
    await associateEntities(pick.kind, pending);
    setDetailFor({ kind: "info", group: pick.kind, sourceKey: `grp:${groupId}`, scope: "current" });
  }, [
    memberPick, episodeId, entityPhs, infoNodePos, infoOffsets, persistInfoOffsets, persistEntityPhs,
    infoGroups, persistInfoGroups, associateEntities, groupWiredPorts, linkNode, overview,
    unlinkEntityLinks, pendingLinks, persistPendingLinks,
  ]);

  const detailDialog = (() => {
    if (!detailFor || !overview) return null;
    const fileHint = (relative: string) => joinLibraryPath(libraryRoot, relative);
    // 某类资源（character/location/prop）已连到哪些片段（#序号）。
    const linkedSegmentLabel = (kind: string, id: string) => {
      const segIds = overview.node_links
        .filter((l) => l.from_kind === kind && l.from_id === id)
        .map((l) => l.to_segment);
      const labels = segments
        .map((segment, index) => ({ id: segment.id, label: `#${index + 1}` }))
        .filter(({ id }) => segIds.includes(id))
        .map(({ label }) => label);
      return labels.length > 0 ? labels.join("、") : "—";
    };
    // 「当前」集合：与某片段直连的该类资源；或与来源资源共片段的同 类资源（无则退为来源自身）。
    const linkedToSegment = (kind: string, segId: string) =>
      overview.node_links.filter((l) => l.to_segment === segId && l.from_kind === kind).map((l) => l.from_id);
    const kindLabelOf = (group: "characters" | "locations" | "props") =>
      t(group === "characters" ? "project.canvas.typeCharacter" : group === "locations" ? "project.canvas.typeLocation" : "project.canvas.typeProp");
    const scopeLabelsOf = (group: EntityPhKind) => ({
      current: t(
        group === "character"
          ? "project.canvas.scopeCurrentChars"
          : group === "location"
            ? "project.canvas.scopeCurrentLocs"
            : "project.canvas.scopeCurrentProps",
      ),
      all: t(
        group === "character"
          ? "project.canvas.scopeAllChars"
          : group === "location"
            ? "project.canvas.scopeAllLocs"
            : "project.canvas.scopeAllProps",
      ),
    });
    const avatarPreview = (name: string, path: string | null, fallback: React.ReactNode) =>
      path ? (
        <ResourceImage path={fileHint(path)} alt={name} className="pc-detail-img" />
      ) : (
        <span className={`pc-detail-ava pc-ava-p${characterAvatarPaletteIndex(name)}`}>{fallback}</span>
      );

    if (detailFor.kind === "promptPh") {
      const ph = promptPhs.find((item) => item.id === detailFor.id);
      if (!ph) return null;
      const prompt = prompts.find((item) => item.id === ph.promptId);
      return (
        <ProjectNodeDetailDialog
          title={prompt ? prompt.title : t("project.canvas.promptUntitled")}
          accent={NODE_ACCENTS.prompt}
          error={detailError}
          entries={[{
            key: `prompt:${ph.id}`,
            title: prompt ? prompt.title : t("project.canvas.promptUntitled"),
            badge: t("project.canvas.typePrompt"),
            preview: prompt ? (
              <div className="pc-detail-prompt">{prompt.content}</div>
            ) : (
              <div className="pc-detail-preview-empty">{Icons.file}{t("project.canvas.promptEmpty")}</div>
            ),
            info: prompt?.category
              ? [{ label: t("project.prompt.field.category"), value: t(promptCategoryKey(prompt.category)) }]
              : [],
            actions: (
              <button
                type="button"
                className="pc-detail-btn"
                onClick={() => {
                  setDetailFor(null);
                  setPromptPickTarget(`prompt:${ph.id}`);
                  setPromptPickOpen(true);
                }}
              >
                {Icons.resources}{t("project.canvas.promptReselect")}
              </button>
            ),
          }]}
          onClose={closeDetail}
        />
      );
    }
    if (detailFor.kind === "segment") {
      const segment = segments.find((item) => item.id === detailFor.id);
      if (!segment) return null;
      const segIndex = segments.indexOf(segment) + 1;
      const { chars, locs, props } = detailFor.scopes;
      const linkedCharIds = linkedToSegment("character", segment.id);
      const linkedLocIds = linkedToSegment("location", segment.id);
      const linkedPropIds = linkedToSegment("prop", segment.id);
      const segEntries = {
        characters: (chars === "current" ? castCharacters.filter((c) => linkedCharIds.includes(c.id)) : castCharacters).map((character) => ({
          key: `char:${character.id}`,
          title: character.name,
          badge: kindLabelOf("characters"),
          preview: avatarPreview(character.name, character.avatar_path, characterAvatarInitial(character.name)),
          info: [{ label: t("project.canvas.detailLinks"), value: linkedSegmentLabel("character", character.id) }],
        })),
        locations: (locs === "current" ? episodeLocations.filter((l) => linkedLocIds.includes(l.id)) : episodeLocations).map((location) => ({
          key: `loc:${location.id}`,
          title: location.name,
          badge: kindLabelOf("locations"),
          preview: avatarPreview(location.name, location.ref_path, Icons.resources),
          info: [{ label: t("project.canvas.detailLinks"), value: linkedSegmentLabel("location", location.id) }],
        })),
        props: (props === "current" ? episodeProps.filter((p) => linkedPropIds.includes(p.id)) : episodeProps).map((prop) => ({
          key: `prop:${prop.id}`,
          title: prop.name,
          badge: kindLabelOf("props"),
          preview: avatarPreview(prop.name, prop.ref_path, Icons.star),
          info: [{ label: t("project.canvas.detailLinks"), value: linkedSegmentLabel("prop", prop.id) }],
        })),
      };
      const setSegScope = (part: "chars" | "locs" | "props", scope: "current" | "all") =>
        setDetailFor({ kind: "segment", id: segment.id, scopes: { ...detailFor.scopes, [part]: scope } });
      const startAttach = (file: { filePath: string; kind: string; name: string }) => attachSegmentFromLibrary(segment.id, file);
      return (
        <ProjectNodeDetailDialog
          title={segment.note || `${t("project.canvas.segName")} #${segIndex}`}
          accent={NODE_ACCENTS.segment}
          error={detailError}
          count={segEntries.characters.length + segEntries.locations.length + segEntries.props.length}
          sections={[
            {
              key: "chars",
              title: kindLabelOf("characters"),
              scope: chars,
              scopeLabels: scopeLabelsOf("character"),
              onScopeChange: (scope) => setSegScope("chars", scope),
              entries: segEntries.characters,
            },
            {
              key: "locs",
              title: kindLabelOf("locations"),
              scope: locs,
              scopeLabels: scopeLabelsOf("location"),
              onScopeChange: (scope) => setSegScope("locs", scope),
              entries: segEntries.locations,
            },
            {
              key: "props",
              title: kindLabelOf("props"),
              scope: props,
              scopeLabels: scopeLabelsOf("prop"),
              onScopeChange: (scope) => setSegScope("props", scope),
              entries: segEntries.props,
            },
          ]}
          extra={(
            <div className="pc-detail-extra">
              <div className="pc-detail-extra-head">{t("project.canvas.segAttach")}</div>
              {segment.asset && (
                <div className="pc-detail-extra-body">
                  <div className="pc-detail-video small">
                    <ResourceVideoPoster
                      path={fileHint(segment.asset.file_path)}
                      version={segment.asset.updated_at}
                      fallbackLabel={segment.asset.name || segment.asset.file_path}
                    />
                  </div>
                  <div className="pc-detail-extra-info">
                    <b>{segment.asset.name || segment.asset.file_path}</b>
                    <small>{segment.asset.file_path}</small>
                    <button type="button" className="pc-detail-btn" onClick={() => handleLocate(segment.asset as ProjectAsset)}>
                      {Icons.externalLink}{t("project.canvas.openFile")}
                    </button>
                  </div>
                </div>
              )}
              {/* 挂产出动作常驻：已有产出时可再次上传/库选直接更换。 */}
              <div className="pc-detail-extra-actions">
                <button type="button" className="pc-detail-btn primary" onClick={() => void uploadViaImport(startAttach)}>
                  {Icons.add}{t("project.canvas.detailUpload")}
                </button>
                <button type="button" className="pc-detail-btn" onClick={() => setPickerFor(`segment:${segment.id}`)}>
                  {Icons.resources}{t("project.canvas.detailPickLibrary")}
                </button>
              </div>
            </div>
          )}
          onClose={closeDetail}
        />
      );
    }
    if (detailFor.kind === "entityPh") {
      const ph = entityPhs.find((item) => item.id === detailFor.id);
      if (!ph) return null;
      const kindLabel = kindTextOf(ph.kind);
      const openBind = () => setMemberPick({ mode: "eph", ephId: ph.id, kind: ph.kind, pending: [] });
      return (
        <ProjectNodeDetailDialog
          title={kindLabel}
          accent={NODE_ACCENTS[ph.kind] ?? "#94a3b8"}
          error={detailError}
          entries={[{
            key: `eph:${ph.id}`,
            title: t("project.canvas.ephUnloaded"),
            badge: kindLabel,
            preview: (
              <button type="button" className="pc-detail-drop" onClick={openBind}>
                {ph.kind === "character" ? Icons.clipboard : ph.kind === "location" ? Icons.resources : Icons.star}
                {t("project.canvas.ephPickHint")}
              </button>
            ),
            info: [{ label: t("project.canvas.detailStatus"), value: t("project.canvas.ephUnloaded") }],
            actions: (
              <button type="button" className="pc-detail-btn primary" onClick={openBind}>
                {Icons.resources}{t("project.canvas.ephLoad")}
              </button>
            ),
          }]}
          onClose={closeDetail}
        />
      );
    }
    if (detailFor.kind === "info") {
      const { group, sourceKey, scope } = detailFor;
      const srcId = sourceKey.slice(sourceKey.indexOf(":") + 1);
      const isGroup = sourceKey.startsWith("grp:");
      const grp = isGroup ? infoGroups.find((g) => `grp:${g.id}` === sourceKey) : null;
      const kindLabel = kindTextOf(group);
      const entities = entitiesOfKind(group);
      const members = grp ? grp.members : [srcId];
      const scopeList = scope === "current" ? entities.filter((e) => members.includes(e.id)) : entities;
      const entries: NodeDetailEntry[] = scopeList.map((entity) => {
        const isMember = members.includes(entity.id);
        const refPath = group === "character" ? (entity as { avatar_path: string }).avatar_path : (entity as { ref_path: string }).ref_path;
        let actions: React.ReactNode;
        if (isGroup && grp) {
          actions = isMember ? (
            <button type="button" className="pc-detail-btn" onClick={() => void removeGroupMember(grp.id, entity.id)}>
              {Icons.close}{t("project.canvas.detailRemoveMember")}
            </button>
          ) : (
            <button type="button" className="pc-detail-btn primary" onClick={() => void addGroupMember(grp.id, entity.id)}>
              {Icons.add}{t("project.canvas.detailAddMember")}
            </button>
          );
        }
        return {
          key: `${group}:${entity.id}`,
          title: entity.name,
          badge: kindLabel,
          preview: avatarPreview(entity.name, refPath, group === "prop" ? Icons.star : characterAvatarInitial(entity.name)),
          info: [{ label: t("project.canvas.detailLinks"), value: linkedSegmentLabel(group, entity.id) }],
          actions,
        };
      });
      // 继续装入：多选库面板 + 装入确认。默认节点装入第二个成员即升级
      // 为组节点（原位、连线随归属解析自动归组）。
      const openMemberPanel = () => {
        setMemberPick(
          grp
            ? { mode: "grp", groupId: grp.id, kind: group, pending: [...grp.members] }
            : { mode: "convert", sourceKey, kind: group, pending: [srcId] },
        );
      };
      return (
        <ProjectNodeDetailDialog
          title={isGroup && grp ? `${kindLabel} ×${grp.members.length}` : kindLabel}
          accent={NODE_ACCENTS[group] ?? "#94a3b8"}
          entries={entries}
          scope={scope}
          scopeLabels={scopeLabelsOf(group)}
          onScopeChange={(next) => setDetailFor({ kind: "info", group, sourceKey, scope: next })}
          extra={(
            <div className="pc-detail-extra">
              <div className="pc-detail-extra-head">{t("project.canvas.detailAddMore")}</div>
              <div className="pc-detail-extra-actions">
                <button type="button" className="pc-detail-btn primary" onClick={openMemberPanel}>
                  {Icons.add}{t("project.canvas.detailAdd", { kind: kindLabel })}
                </button>
              </div>
            </div>
          )}
          onClose={closeDetail}
        />
      );
    }
    // script：单文件窗口（文本预览 + 路径 + 打开）。主剧本节点读本集
    // script_path；剧本纸片读自己的文件（重新挂接也只换纸片的文件）。
    const scriptPh = detailFor.phId ? scriptPhs.find((item) => item.id === detailFor.phId) : null;
    const scriptPath = scriptPh ? scriptPh.path : overview.episode.script_path;
    if (!scriptPath) return null;
    const scriptName = scriptFileLabel(scriptPath);
    return (
      <ProjectNodeDetailDialog
        title={scriptName}
        accent={NODE_ACCENTS.script}
        entries={[{
          key: "script",
          title: scriptName,
          badge: t("project.canvas.typeScript"),
          preview: <TextPaperBody path={fileHint(scriptPath)} name={scriptName} lines={16} />,
          info: [{ label: t("project.canvas.detailPath"), value: scriptPath }],
          actions: (
            <>
              <button type="button" className="pc-detail-btn" onClick={() => void openResourceFile(fileHint(scriptPath))}>
                {Icons.externalLink}{t("project.canvas.openFile")}
              </button>
              {/* 重新挂接：换库内其他文件（窗口保持打开，重选后条目就地
                  刷新；节点留在原位；主剧本换的是本集剧本，纸片只换自己）。 */}
              <button
                type="button"
                className="pc-detail-btn"
                onClick={() => {
                  setScriptPickTarget(scriptPh ? `script:${scriptPh.id}` : "script");
                  setScriptPickOpen(true);
                }}
              >
                {Icons.link}{t("project.canvas.detailRelinkScript")}
              </button>
            </>
          ),
        }]}
        onClose={closeDetail}
      />
    );
  })();

  return (
    <div className="pc-root">
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
          {/* 场景分组框 + 集级框 + 资料框 */}
          {scenes.map((scene, sceneIndex) => {
            const spos = scenePos[scene.id] ?? layout.framePos[scene.id] ?? { x: WORLD_MARGIN, y: 110 };
            const sceneCards = layout.cards.filter((c) => c.sceneId === scene.id);
            const frameW = Math.max(
              FRAME_MIN_W,
              ...sceneCards.map((c) => {
                const p = pos.cards[c.shot.id] ?? { x: spos.x + FRAME_PAD_X, y: spos.y };
                const size = shotCardSize(c.shot);
                return p.x - spos.x + size.w + FRAME_PAD_X;
              }),
            );
            const frameH = Math.max(
              FRAME_MIN_H,
              ...sceneCards.map((c) => {
                const p = pos.cards[c.shot.id] ?? { x: spos.x, y: spos.y };
                const size = shotCardSize(c.shot);
                return p.y - spos.y + size.h + FRAME_PAD_BOTTOM;
              }),
            );
            const assetsCount = scene.shots.reduce((acc, s) => acc + s.assets.length, 0);
            return (
              <div
                key={scene.id}
                data-frame={scene.id}
                className="pc-frame"
                style={{ left: spos.x, top: spos.y, width: frameW, height: frameH }}
              >
                <div className="pc-frame-label">
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
                    {t("project.canvas.frameStats", { shots: scene.shots.length, assets: assetsCount })}
                  </small>
                  <span className="pc-frame-ops">
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
                      onClick={() => setShotForm({ id: "", sceneId: scene.id, description: "", dialogue: "" })}
                    >
                      {Icons.add}
                    </button>
                    <button type="button" data-tooltip={t("common.delete")} onClick={() => setDeleteSceneTarget(scene)}>
                      {Icons.delete}
                    </button>
                  </span>
                </div>
              </div>
            );
          })}

          {/* 连线层（卡片之下）。按视口尺寸渲染 + 平移组换算世界坐标，
              不再铺世界范围的巨型图层（部分 WebView2 GPU 栅格化超限时
              会整层不绘制，表现为连线全不可见）。 */}
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
            {wires.map((wire) => {
              const a = outPointOf(wire.fromKey);
              const b = inPointOf(wire.toKey);
              if (!a || !b) return null;
              const d = wirePathD(a, b);
              const color = WIRE_TYPE_COLORS[wire.type] ?? "#94a3b8";
              return (
                <g
                  key={`${wire.fromKey}->${wire.toKey}`}
                  className="pc-wire"
                  data-cut={wire.kind === "manual" ? `m:${wire.fromKey}|${wire.toKey}` : undefined}
                >
                  <path className="pc-wire-hit" d={d} />
                  <path className="pc-wire-line" d={d} style={{ stroke: color }} />
                </g>
              );
            })}
            {/* 片段输入口连线（角色/场景/道具/剧本/素材/片段 → 片段口）。
                组节点的多条成员连线按承载节点去重成一条，删线全断。 */}
            {segWires.map((wire) => {
              // 被摘下的线（拿着换源中）暂时隐藏，收尾时转接或放回。
              if (liftedWire && wire.links.some((l) => liftedWire.rows.some((r) => r.id === l.id))) return null;
              const link = wire.links[0];
              const a = outPointOf(wire.fromKey);
              const b = inPointOf(`segment:${link.to_segment}`, link.to_port);
              if (!a || !b) return null;
              const d = wirePathD(a, b);
              // 线色随来源数据类型（角色/场景/道具图绿、剧本橙、片段紫）。
              const fromType = portsOf(wire.fromKey).out?.type;
              return (
                <g key={wire.key} className="pc-wire" data-cut={`s:${link.id}`}>
                  <path className="pc-wire-hit" d={d} />
                  <path
                    className="pc-wire-line"
                    d={d}
                    style={{ stroke: WIRE_TYPE_COLORS[fromType ?? ""] ?? WIRE_TYPE_COLORS.video, strokeOpacity: 0.55 }}
                  />
                </g>
              );
            })}
            {/* 占位/剧本纸片 → 片段的暂存线：一律实线（连线无虚线是全局
                视觉约定）；占位线不透明度略高作区分，加载实体后转正为
                正式 node_link 连线。 */}
            {pendingLinks.map((link) => {
              if (liftedWire?.pendings.includes(link)) return null;
              const a = outPointOf(link.fromKey);
              const b = inPointOf(`segment:${link.toSegmentId}`, link.toPort);
              if (!a || !b) return null;
              const d = wirePathD(a, b);
              const fromType = portsOf(link.fromKey).out?.type;
              const solid = link.fromKey.startsWith("script:") || link.fromKey.startsWith("prompt:");
              return (
                <g
                  key={`pending-${link.fromKey}-${link.toSegmentId}-${link.toPort}`}
                  className="pc-wire"
                  data-cut={`p:${link.fromKey}|${link.toSegmentId}|${link.toPort}`}
                >
                  <path className="pc-wire-hit" d={d} />
                  <path
                    className="pc-wire-line"
                    d={d}
                    style={{
                      stroke: WIRE_TYPE_COLORS[fromType ?? ""] ?? "#94a3b8",
                      strokeOpacity: solid ? 0.55 : 0.7,
                    }}
                  />
                </g>
              );
            })}
            {/* 片段 → 成片：按拼接序隐式聚合（无需连线数据，恒显示） */}
            {outputBox &&
              segments.map((segment) => {
                const a = outPointOf(`segment:${segment.id}`);
                // 终点 = 实测「成片」输入口（端口在卡内，随卡体尺寸实测）。
                const b = inPointOf("output");
                if (!a || !b) return null;
                const d = wirePathD(a, b);
                return (
                  <g key={`seg-out-${segment.id}`} className="pc-wire">
                    <path className="pc-wire-hit" d={d} />
                    <path
                      className="pc-wire-line"
                      d={d}
                      style={{ stroke: WIRE_TYPE_COLORS.video, strokeOpacity: 0.55 }}
                    />
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
            {/* 成片连线：总输出来源 → 成片节点（由 output_asset_id 推导） */}
            {(() => {
              const outputKey = overview?.episode.output_asset_id;
              if (!outputKey || !outputBox) return null;
              const a = outPointOf(outputKey.startsWith("shot:") ? outputKey : `asset:${outputKey}`);
              const b = inPointOf("output");
              if (!a || !b) return null;
              const d = wirePathD(a, b);
              return (
                <g className="pc-wire" data-cut="o">
                  <path className="pc-wire-hit" d={d} />
                  <path
                    className="pc-wire-line"
                    d={d}
                    style={{ stroke: WIRE_TYPE_COLORS.video }}
                  />
                </g>
              );
            })()}
            </g>
          </svg>

          {/* 镜头卡 */}
          {layout.cards.map((card) => {
            const p = pos.cards[card.shot.id] ?? { x: 0, y: 0 };
            const selected = selKeys.includes(card.key);
            const shot = card.shot;
            const cardSize = sizeOfNode(card.key);
            const resized = Boolean(nodeSizes[card.key]);
            return (
              <div
                key={card.key}
                data-key={card.key}
                data-frame={card.sceneId}
                className={`pc-node pc-shotcard${resized ? " pc-resized" : ""}${selected ? " pc-selected" : ""}`}
                style={{
                  left: p.x, top: p.y,
                  width: cardSize?.w ?? card.w,
                  height: resized ? cardSize?.h : undefined,
                  // 覆盖高度作 minHeight：内容不足时留白，内容超出时撑开。
                  minHeight: resized ? undefined : cardSize && cardSize.h !== card.h ? cardSize.h : undefined,
                  ["--node-accent" as string]: NODE_ACCENTS.shot,
                } as React.CSSProperties}
              >
                <div className="pc-shot-head">
                  <span className="pc-shot-no">{shotNoOf(card.sceneId, card.shot.id)}</span>
                  <b className="pc-shot-desc">{shot.description || t("project.shot.untitled")}</b>
                  {shot.dialogue && <i className="pc-shot-dialogue">{shot.dialogue}</i>}
                </div>
                {portBar(card.key)}
                  {shot.assets.length > 0 ? (
                    <div className="pc-shot-grid">
                      {card.assets.map(({ asset, w, h }) => {
                        const mediaPath = joinLibraryPath(libraryRoot, asset.file_path);
                        return (
                          <button
                            key={asset.id}
                            type="button"
                            className={`pc-shot-asset-thumb${asset.missing ? " is-missing" : ""}`}
                            data-asset={asset.id}
                            style={resized ? undefined : { width: w, height: h }}
                            title={asset.missing ? `${t("project.asset.fileMissing")} · ${asset.file_path}` : asset.name}
                          >
                            {asset.missing ? (
                              <span className="pc-thumb-miss">
                                {Icons.image}
                                {t("project.asset.fileMissing")}
                              </span>
                            ) : asset.kind === "image" ? (
                              <ResourceFileImage
                                path={mediaPath}
                                alt={asset.name}
                                version={asset.updated_at}
                                className="pc-thumb-img"
                              />
                            ) : asset.kind === "video" ? (
                              <>
                                <ResourceVideoPoster
                                  path={mediaPath}
                                  version={asset.updated_at}
                                  fallbackLabel={asset.name || asset.file_path}
                                />
                                <span className="pc-thumb-play">{Icons.play}</span>
                              </>
                            ) : asset.kind === "text" ? (
                              <span className="pc-thumb-text">
                                {Icons.file}
                                {asset.name || asset.file_path}
                              </span>
                            ) : (
                              <span className="pc-thumb-text">
                                {Icons.file}
                                {asset.name || asset.file_path}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="pc-shot-empty">
                      {Icons.link}
                      {t("project.canvas.shotEmpty")}
                    </div>
                  )}
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
                    onClick={() => void deleteShot(shot.id)}
                  >
                    {Icons.delete}
                  </button>
                </span>
                {resizeHandle}
              </div>
            );
          })}

          {/* 节点分组框（Ctrl+G）：框自适应成员包围盒，渲染在节点层之下；
              拖标题条整组移动（复用组拖管线），组员被删后框随之收缩。 */}
          {nodeGroups.map((group) => {
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
          {infoNodes.map((node) => {
            const p = infoNodePos(node.key);
            const nodeSize = sizeOfNode(node.key);
            const resized = Boolean(nodeSizes[node.key]);
            return (
              <div
                key={node.key}
                data-key={node.key}
                className={`pc-node pc-info${resized ? " pc-resized" : ""}${pulseKeys.includes(node.key) ? " pc-spawn" : ""}${selKeys.includes(node.key) ? " pc-selected" : ""}`}
                style={{
                  left: p.x, top: p.y,
                  width: nodeSize?.w ?? node.w,
                  height: resized ? nodeSize?.h : undefined,
                  minHeight: resized ? undefined : nodeSize && nodeSize.h !== node.h ? nodeSize.h : undefined,
                  ["--node-accent" as string]: NODE_ACCENTS[node.kind] ?? "#94a3b8",
                } as React.CSSProperties}
              >
                <div className="pc-node-head">
                  <span className="pc-node-kind">
                    {t(
                      node.kind === "character"
                        ? "project.canvas.typeCharacter"
                        : node.kind === "location"
                          ? "project.canvas.typeLocation"
                          : node.kind === "prop"
                            ? "project.canvas.typeProp"
                            : "project.canvas.typeScript",
                    )}
                  </span>
                  <b className="pc-node-title">{node.name}</b>
                </div>
                {portBar(node.key)}
                <div className="pc-info-body">
                  {node.key.startsWith("grp:") ? (
                    // 组节点：照片堆放——首位成员的大图在上，其余成员的图
                    // 边向右堆（层数上限 2，更多成员看标题 ×N 与详情窗成员
                    // 列表）；成员已不可解析时退化为普通照片卡。
                    (() => {
                      const members = (infoGroups.find((g) => `grp:${g.id}` === node.key)?.members ?? [])
                        .map((id) => {
                          const kind = node.kind as EntityPhKind;
                          const entity = entitiesOfKind(kind).find((e) => e.id === id) as
                            | { id: string; name: string; avatar_path?: string; ref_path?: string }
                            | undefined;
                          return entity
                            ? { id, name: entity.name, ref: entityRefOf(kind, entity) }
                            : null;
                        })
                        .filter((m): m is { id: string; name: string; ref: string } => m !== null);
                      const stack = members.slice(1, 3);
                      const main = members[0];
                      if (!main) return null;
                      return (
                        <div className={`pc-photo${stack.length > 0 ? " has-stack" : ""}`}>
                          {stack.map((member, index) => (
                            <span key={member.id} className={`pc-photo-layer l${index + 1}`}>
                              {member.ref ? (
                                <ResourceImage
                                  path={joinLibraryPath(libraryRoot, member.ref)}
                                  alt=""
                                  className="pc-photo-img"
                                />
                              ) : null}
                            </span>
                          ))}
                          <div className={`pc-photo-main${main.ref ? "" : " pc-photo-empty"}`}>
                            {photoMainOf(main.name, main.ref)}
                          </div>
                        </div>
                      );
                    })()
                  ) : node.kind === "script" ? (
                    node.textPath ? (
                      <div className="pc-info-script">
                        <TextPaperBody path={joinLibraryPath(libraryRoot, node.textPath)} name={node.name} lines={5} adaptive={resized} />
                      </div>
                    ) : (
                      // 剧本两段式：空节点（未挂文件），双击从库选文件。
                      <div className="pc-info-body pc-eph-body">
                        {Icons.file}
                        <span>{t("project.canvas.scriptEmpty")}</span>
                      </div>
                    )
                  ) : (
                    <div className="pc-photo">
                      <div className={`pc-photo-main${node.avatarPath ? "" : " pc-photo-empty"}`}>
                        {photoMainOf(node.name, node.avatarPath)}
                      </div>
                    </div>
                  )}
                </div>
                <span className="pc-node-tools">
                  <button type="button" data-tooltip={t("project.canvas.view")} onClick={() => openInfoDetail(node)}>
                    {Icons.expand}
                  </button>
                  <button
                    type="button"
                    data-tooltip={t("common.delete")}
                    className="danger"
                    onClick={() => {
                      if (node.key.startsWith("grp:")) removeGroup(node.key.slice(4));
                      else if (node.key === "script") void detachScript();
                      else if (node.kind === "script") removeScriptPh(node.key.slice(7));
                      else void removeInfoEntity(node.kind as EntityPhKind, node.key.slice(node.key.indexOf(":") + 1));
                    }}
                  >
                    {Icons.delete}
                  </button>
                </span>
                {resizeHandle}
              </div>
            );
          })}

          {/* 空白资料占位节点：菜单创建（角色/场景/道具），双击从详情窗
              加载实体，加载后原位变成实体节点 */}
          {entityPhs.map((ph) => {
            const key = `eph:${ph.id}`;
            const p = infoNodePos(key);
            const phSize = sizeOfNode(key);
            const resized = Boolean(nodeSizes[key]);
            const label = t(
              ph.kind === "character"
                ? "project.canvas.typeCharacter"
                : ph.kind === "location"
                  ? "project.canvas.typeLocation"
                  : "project.canvas.typeProp",
            );
            return (
              <div
                key={key}
                data-key={key}
                className={`pc-node pc-info pc-eph${resized ? " pc-resized" : ""}${selKeys.includes(key) ? " pc-selected" : ""}`}
                style={{
                  left: p.x, top: p.y,
                  width: phSize?.w ?? INFO_W,
                  height: resized ? phSize?.h : undefined,
                  minHeight: resized ? undefined : phSize?.h,
                  ["--node-accent" as string]: NODE_ACCENTS[ph.kind] ?? "#94a3b8",
                } as React.CSSProperties}
              >
                <div className="pc-node-head">
                  <span className="pc-node-kind">{label}</span>
                  <b className="pc-node-title">{t("project.canvas.ephTitle")}</b>
                </div>
                {portBar(key)}
                <div className="pc-info-body pc-eph-body">
                  {ph.kind === "character" ? Icons.clipboard : ph.kind === "location" ? Icons.resources : Icons.star}
                  <span>{t("project.canvas.ephHint")}</span>
                </div>
                <span className="pc-node-tools">
                  <button type="button" data-tooltip={t("project.canvas.view")} onClick={() => setDetailFor({ kind: "entityPh", id: ph.id })}>
                    {Icons.expand}
                  </button>
                  <button
                    type="button"
                    data-tooltip={t("common.delete")}
                    className="danger"
                    onClick={() => removeEntityPh(ph.id)}
                  >
                    {Icons.delete}
                  </button>
                </span>
                {resizeHandle}
              </div>
            );
          })}

          {/* 提示词纸片：双击空纸片从提示词库选一条，内容直接显示在纸片上 */}
          {promptPhs.map((ph) => {
            const key = `prompt:${ph.id}`;
            const p = infoNodePos(key);
            const phSize = sizeOfNode(key);
            const resized = Boolean(nodeSizes[key]);
            const prompt = prompts.find((item) => item.id === ph.promptId);
            const openPrompt = () => {
              if (!ph.promptId) {
                setPromptPickTarget(key);
                setPromptPickOpen(true);
              } else {
                setDetailFor({ kind: "promptPh", id: ph.id });
              }
            };
            return (
              <div
                key={key}
                data-key={key}
                className={`pc-node pc-info pc-eph${resized ? " pc-resized" : ""}${selKeys.includes(key) ? " pc-selected" : ""}`}
                style={{
                  left: p.x, top: p.y,
                  width: phSize?.w ?? SCRIPT_W,
                  height: resized ? phSize?.h : undefined,
                  minHeight: resized ? undefined : phSize?.h,
                  ["--node-accent" as string]: NODE_ACCENTS.prompt,
                } as React.CSSProperties}
              >
                <div className="pc-node-head">
                  <span className="pc-node-kind">{t("project.canvas.typePrompt")}</span>
                  <b className="pc-node-title">{prompt ? prompt.title : t("project.canvas.promptUntitled")}</b>
                </div>
                {portBar(key)}
                {prompt ? (
                  <div className="pc-prompt-text">{prompt.content}</div>
                ) : (
                  <div className="pc-info-body pc-eph-body">
                    {Icons.file}
                    <span>{t("project.canvas.promptEmpty")}</span>
                  </div>
                )}
                <span className="pc-node-tools">
                  <button type="button" data-tooltip={t("project.canvas.view")} onClick={openPrompt}>
                    {Icons.expand}
                  </button>
                  <button
                    type="button"
                    data-tooltip={t("common.delete")}
                    className="danger"
                    onClick={() => removePromptPh(ph.id)}
                  >
                    {Icons.delete}
                  </button>
                </span>
                {resizeHandle}
              </div>
            );
          })}

          {/* 片段节点：AI 分段生成的视频分段，按拼接序汇入本集成片 */}
          {segments.map((segment, index) => {
            const p = segPos[segment.id];
            if (!p) return null;
            const key = `segment:${segment.id}`;
            const segSize = sizeOfNode(key);
            const resized = Boolean(nodeSizes[key]);
            return (
              <div
                key={segment.id}
                data-key={key}
                className={`pc-node pc-segment${resized ? " pc-resized" : ""}${selKeys.includes(key) ? " pc-selected" : ""}`}
                style={{
                  left: p.x, top: p.y, width: segSize?.w ?? SEG_W,
                  height: resized ? segSize?.h : undefined,
                  // 存量高度语义是节点总高：用 minHeight 兜底，缩小不裁切内容。
                  minHeight: resized ? undefined : segSize && segSize.h !== SEG_H ? segSize.h : undefined,
                  ["--node-accent" as string]: NODE_ACCENTS.segment,
                } as React.CSSProperties}
              >
                <div className="pc-node-head">
                  <span className="pc-node-kind">{t("project.canvas.segName")}</span>
                  <b className="pc-node-title">{segment.note || `#${index + 1}`}</b>
                </div>
                <div className="pc-seg-ports">{portBar(key)}</div>
                {segment.asset ? (
                    <button
                      type="button"
                      className={`pc-seg-thumb${segment.asset.missing ? " is-missing" : ""}`}
                      title={segment.asset.missing ? t("project.asset.fileMissing") : segment.asset.name}
                      data-asset={segment.asset.id}
                    >
                      <ResourceVideoPoster
                        path={joinLibraryPath(libraryRoot, segment.asset.file_path)}
                        version={segment.asset.updated_at}
                        fallbackLabel={segment.asset.name || segment.asset.file_path}
                      />
                      <span className="pc-thumb-play">{Icons.play}</span>
                    </button>
                  ) : (
                    <div className="pc-seg-empty">
                      {Icons.link}
                      {t("project.canvas.segEmpty")}
                    </div>
                  )}
                <span className="pc-node-tools">
                  <button
                    type="button"
                    data-tooltip={t("project.canvas.segMoveUp")}
                    onClick={() => void moveSegment(segment.id, -1)}
                  >
                    {Icons.chevronUp}
                  </button>
                  <button
                    type="button"
                    data-tooltip={t("project.canvas.segMoveDown")}
                    onClick={() => void moveSegment(segment.id, 1)}
                  >
                    {Icons.chevronDown}
                  </button>
                  <button
                    type="button"
                    data-tooltip={t("project.canvas.segAttach")}
                    onClick={() => setDetailFor({ kind: "segment", id: segment.id, scopes: { chars: "current", locs: "current", props: "current" } })}
                  >
                    {Icons.file}
                  </button>
                  <button
                    type="button"
                    data-tooltip={t("common.delete")}
                    className="danger"
                    onClick={() => void removeSegment(segment.id)}
                  >
                    {Icons.delete}
                  </button>
                </span>
                {resizeHandle}
              </div>
            );
          })}

          {/* 成片输出节点：本集工作流的总输出口（拖卡体挪位，按集记忆） */}
          {outputBox && (
            <div
              data-key="output"
              className={`pc-node pc-outnode${nodeSizes.output ? " pc-resized" : ""}${selKeys.includes("output") ? " pc-selected" : ""}`}
              style={{
                left: outputBox.x, top: outputBox.y,
                width: sizeOfNode("output")?.w ?? outputBox.w,
                height: nodeSizes.output ? sizeOfNode("output")?.h : undefined,
                minHeight: nodeSizes.output ? undefined : sizeOfNode("output")?.h,
                ["--node-accent" as string]: NODE_ACCENTS.output,
              } as React.CSSProperties}
            >
              <div className="pc-node-head">
                <span className="pc-node-kind">{t("project.canvas.outputNode")}</span>
              </div>
              <div className="pc-outnode-body">
                <span className="pc-outnode-icon">{Icons.clapperboard}</span>
                <small>
                  {segments.length > 0
                    ? t("project.canvas.outputSummary", { count: segments.length })
                    : (outputSourceLabel ?? t("project.canvas.outputEmpty"))}
                </small>
              </div>
              <div className="pc-seg-ports">{portBar("output")}</div>
              <span className="pc-node-tools">
                <button
                  type="button"
                  data-tooltip={t("project.canvas.remove")}
                  className="danger"
                  onClick={() => {
                    if (episodeId) void setEpisodeOutput(episodeId, null);
                  }}
                >
                  {Icons.delete}
                </button>
              </span>
              {resizeHandle}
            </div>
          )}

          {/* 便签节点：双击编辑、拖动挪位、按集记 localStorage */}
          {notes.map((note) => (
            <div
              key={note.id}
              data-note={note.id}
              className={`pc-note${selKeys.includes(`note:${note.id}`) ? " pc-selected" : ""}`}
              style={{
                left: note.x, top: note.y,
                width: sizeOfNode(`note:${note.id}`)?.w,
                height: sizeOfNode(`note:${note.id}`)?.h,
              }}
            >
              {editingNoteId === note.id ? (
                <textarea
                  className="pc-note-input"
                  autoFocus
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  onBlur={() => {
                    persistNotes(
                      notes.map((item) =>
                        item.id === note.id ? { ...item, text: noteDraft.trim() } : item,
                      ),
                    );
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
                <div className="pc-note-body">
                  {note.text || <i>{t("project.canvas.noteEmpty")}</i>}
                </div>
              )}
              <span className="pc-note-tools">
                <button
                  type="button"
                  data-tooltip={t("common.edit")}
                  onClick={() => {
                    setEditingNoteId(note.id);
                    setNoteDraft(note.text);
                  }}
                >
                  {Icons.edit}
                </button>
                <button
                  type="button"
                  data-tooltip={t("common.delete")}
                  className="danger"
                  onClick={() => persistNotes(notes.filter((item) => item.id !== note.id))}
                >
                  {Icons.close}
                </button>
              </span>
              {resizeHandle}
            </div>
          ))}
        </div>

        {/* 刀切痕层：视口直下的绝对定位层（pc-world 之后 → 盖在卡片上），
            用视口屏幕坐标画折线——不进 pc-world（祖先 transform 会连
            non-scaling-stroke 一起缩放），也不用 fixed（坐标系会被
            transform 祖先劫持且部分环境逐帧重绘闪烁）。滑动中 ref 直写
            双描边（暗衬 + 白芯），松手清空即隐形。 */}
        <svg className="pc-trailayer" aria-hidden="true">
          <polyline ref={cutTrailUnderRef} className="pc-wire-cut-under" points="" />
          <polyline ref={cutTrailRef} className="pc-wire-cut" points="" />
        </svg>

        {/* 缺失提醒条（ComfyUI 缺节点警示的对应物）：缺项可点击定位 */}
        {issues.length > 0 && (
          <div className="pc-checkbar">
            <span className="pc-checkbar-title">{t("project.canvas.checkTitle")}</span>
            {issues.map((issue) => (
              <button
                key={issue.key}
                type="button"
                className="pc-checkbar-chip"
                onClick={(event) => {
                  if (issue.key === "output") locateOutput();
                  if (issue.key === "script") {
                    // 剧本两段式：有空纸片 → 定位到它（双击选文件）；
                    // 没有 → 放一个空纸片（出生在点击位置）。
                    const emptyPh = scriptPhs.find((item) => !item.path);
                    if (emptyPh) {
                      locateScript(`script:${emptyPh.id}`);
                    } else {
                      armSpawnFromEvent(event.clientX, event.clientY);
                      addScriptPh();
                    }
                  }
                  if (issue.key === "segAssets") {
                    locateEmptySegment();
                    // 定位之余直接打开片段详情窗口，形成"提醒→填充"闭环。
                    const firstEmpty = segments.find((item) => !item.asset);
                    if (firstEmpty) setDetailFor({ kind: "segment", id: firstEmpty.id, scopes: { chars: "current", locs: "current", props: "current" } });
                  }
                }}
              >
                {issue.label}
              </button>
            ))}
          </div>
        )}

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
                  // 取消菜单：摘线交给菜单而未落定时放回原口。
                  if (addMenu.detached) setLiftedWire(null);
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
            {[
              {
                key: "segment",
                label: t("project.canvas.segName"),
                hint: t("project.canvas.typeSegmentHint"),
                icon: Icons.clapperboard,
                panel: "",
              },
              {
                key: "episodeScript",
                label: t("project.canvas.typeEpisode"),
                hint: t("project.canvas.typeEpisodeHint"),
                icon: Icons.file,
                panel: "script",
              },
              {
                key: "character",
                label: t("project.canvas.typeCharacter"),
                hint: t("project.canvas.typeCharacterHint"),
                icon: Icons.clipboard,
                panel: "",
              },
              {
                key: "location",
                label: t("project.canvas.typeLocation"),
                hint: t("project.canvas.typeLocationHint"),
                icon: Icons.resources,
                panel: "",
              },
              {
                // 关联场景：把库内已有场景关联到本集（原「本集资料」框标签
                // 条的 + 入口随框移除，改挂到添加菜单，功能不丢）。
                key: "linkScene",
                label: t("project.canvas.linkScene"),
                hint: t("project.canvas.linkSceneHint"),
                icon: Icons.resources,
                panel: "linkScene",
              },
              {
                key: "prop",
                label: t("project.canvas.typeProp"),
                hint: t("project.canvas.typePropHint"),
                icon: Icons.star,
                panel: "",
              },
              {
                key: "note",
                label: t("project.canvas.typeNote"),
                hint: t("project.canvas.typeNoteHint"),
                icon: Icons.edit,
                panel: "",
              },
              {
                key: "prompt",
                label: t("project.canvas.typePrompt"),
                hint: t("project.canvas.typePromptHint"),
                icon: Icons.file,
                panel: "",
              },
            ]
              .filter((item) => item.label.toLowerCase().includes(addMenuQuery.trim().toLowerCase()))
              .map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="pc-addmenu-item"
                  // 剧本项：每次点击都放一个空纸片（双击纸片再选文件，
                  // 与其他节点的加载节奏统一）；「关联场景」打开库场景挑选
                  // 面板；
                  // 其余项（片段/角色/场景/道具/便签/提示词/素材）支持
                  // 点击与按住拖到画布松手两种落位（ComfyUI 搜索框惯例），
                  // 资料类先落空白节点、绝不先弹挑选面板；从「拖线到空
                  // 白」进入时创建的节点自动接上那条线（占位未加载实体，
                  // 连线先走暂存线）。
                  {...(item.panel === "script"
                    ? {
                        onClick: () => {
                          // 纸片不接线：被摘的线放回原口。
                          if (addMenu.detached) setLiftedWire(null);
                          setAddMenu(null);
                          setAddMenuQuery("");
                          // 与其他节点统一：每次都放一个空剧本纸片（出生在
                          // 双击位置），双击纸片再从库选文件；本集还没剧本
                          // 时首个挂接的文件转正为主剧本。
                          armSpawnAt(addMenu.wx, addMenu.wy);
                          addScriptPh();
                        },
                      }
                    : item.panel === "linkScene"
                      ? {
                          onClick: () => {
                            // 场景挑选面板不自接线：被摘的线放回原口。
                            if (addMenu.detached) setLiftedWire(null);
                            setAddMenu(null);
                            setAddMenuQuery("");
                            // 新关联的场景节点出生在双击位置（视线附近）。
                            armSpawnAt(addMenu.wx, addMenu.wy);
                            setLocationPickOpen(true);
                          },
                        }
                      : {
                          onPointerDown: (event: React.PointerEvent) => {
                            if (event.button !== 0) return;
                            event.stopPropagation();
                            event.preventDefault();
                            dragRef.current = {
                              kind: "addnode", sx: event.clientX, sy: event.clientY, moved: false,
                              fox: addMenu.wx, foy: addMenu.wy, frameKey: item.key,
                              wire: addMenu.wire,
                              detached: addMenu.detached,
                            };
                            setAddMenu(null);
                            setAddMenuQuery("");
                          },
                        })}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  <small>{item.hint}</small>
                </button>
              ))}
          </div>
        )}

        {/* 集信息玻璃卡 + 统计 */}
        <div className="pc-glass pc-ep-card">
          {overlay}
          <div className="pc-ep-stats">
            <span>{t("project.canvas.statScenes", { count: scenes.length })}</span>
            <span>{t("project.canvas.statShots", { count: scenes.reduce((acc, s) => acc + s.shots.length, 0) })}</span>
            <span>{t("project.canvas.statAssets", { count: scenes.reduce((acc, s) => acc + s.shots.reduce((a, sh) => a + sh.assets.length, 0), 0) + looseAssets.length })}</span>
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
            onPointerDown={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              const wx = (e.clientX - rect.left) / miniRatio;
              const wy = (e.clientY - rect.top) / miniRatio;
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
            {scenes.map((scene) => {
              const spos = scenePos[scene.id];
              if (!spos) return null;
              return (
                <rect
                  key={scene.id}
                  x={spos.x * miniRatio}
                  y={spos.y * miniRatio}
                  width={FRAME_MIN_W * miniRatio}
                  height={FRAME_MIN_H * miniRatio}
                  rx="3"
                  fill="none"
                  stroke="var(--text-tertiary)"
                  strokeDasharray="2,2"
                />
              );
            })}
            {layout.cards.map((card) => {
              const p = pos.cards[card.shot.id];
              if (!p) return null;
              const size = shotCardSize(card.shot);
              return (
                <rect
                  key={card.key}
                  x={p.x * miniRatio}
                  y={p.y * miniRatio}
                  width={Math.max(3, size.w * miniRatio)}
                  height={Math.max(2.5, size.h * miniRatio)}
                  rx="1.5"
                  fill="var(--text-tertiary)"
                />
              );
            })}
            <rect
              x={(-view.x / view.scale) * miniRatio}
              y={(-view.y / view.scale) * miniRatio}
              width={((vpSize?.w ?? 1200) / view.scale) * miniRatio}
              height={((vpSize?.h ?? 700) / view.scale) * miniRatio}
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
      {/* 节点详情预览窗口：双击节点的独立窗口（预览 + 信息 + 上传/库选） */}
      {detailDialog}
      {/* 详情窗口内的「从资源库选择」二级选择器（片段挂产出） */}
      {pickerFor?.startsWith("segment:") && (
        <ProjectFilePickerDialog
          title={t("project.canvas.segAttach")}
          takenPaths={new Set()}
          takenLabel=""
          onClose={() => setPickerFor(null)}
          onPick={(file) => attachSegmentFromLibrary(pickerFor.slice(8), file)}
        />
      )}
      {/* 挂剧本：目标 = 主剧本时选文件设为本集剧本，挂接即自动连全部片段
          剧本口；目标 = 剧本纸片时挂到纸片自己（本集无剧本则转正为主剧本） */}
      {scriptPickOpen && (
        <ProjectFilePickerDialog
          title={t("project.canvas.linkScript")}
          takenPaths={new Set()}
          takenLabel=""
          onClose={() => {
            setScriptPickOpen(false);
            setScriptPickTarget(null);
          }}
          onPick={(file) => handleScriptPick(file.filePath)}
        />
      )}
      {/* 提示词选择：空提示词纸片双击后从提示词库选一条写入纸片 */}
      {promptPickOpen && (
        <div className="pc-dialog-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) closePromptPick(); }}>
          <div className="pc-dialog pc-prompt-pick">
            <h4>{t("project.canvas.promptPickTitle")}</h4>
            <input
              value={promptPickQuery}
              placeholder={t("project.canvas.addNodeSearch")}
              onChange={(event) => setPromptPickQuery(event.target.value)}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Escape") closePromptPick();
              }}
            />
            <div className="pc-prompt-pick-list">
              {prompts
                .filter((prompt) => {
                  const q = promptPickQuery.trim().toLowerCase();
                  if (!q) return true;
                  return (
                    prompt.title.toLowerCase().includes(q) ||
                    prompt.content.toLowerCase().includes(q) ||
                    (prompt.category && t(promptCategoryKey(prompt.category)).toLowerCase().includes(q))
                  );
                })
                .map((prompt) => (
                  <button
                    key={prompt.id}
                    type="button"
                    className="pc-prompt-pick-item"
                    onClick={() => handlePromptPick(prompt.id)}
                  >
                    <span className="pc-prompt-pick-head">
                      <span className="pc-prompt-pick-title">{prompt.title}</span>
                      {prompt.category ? (
                        <span className="pc-prompt-pick-cat">{t(promptCategoryKey(prompt.category))}</span>
                      ) : null}
                    </span>
                    <span className="pc-prompt-pick-content">{prompt.content}</span>
                  </button>
                ))}
              {prompts.length === 0 && (
                <div className="pc-prompt-pick-empty">{t("project.canvas.promptPickEmpty")}</div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* 资料框「关联场景」：多选切换，与出场角色同一交互模式 */}
      {locationPickOpen && (
        <ProjectLibraryPanel
          kind="locations"
          mode="pick"
          multi
          selectedIds={overview?.episode.location_ids ?? []}
          onClose={() => setLocationPickOpen(false)}
          pickTitle={t("project.canvas.linkScene")}
          onTogglePick={(id) => {
            if (!episodeId) return;
            const existing = overview?.episode.location_ids ?? [];
            const next = existing.includes(id)
              ? existing.filter((item) => item !== id)
              : [...existing, id];
            void setEpisodeLocations(episodeId, next);
          }}
        />
      )}
      {/* 成员装入面板（多选勾选 + 装入确认）：空白节点加载 / 组追加裁剪 /
          默认节点转组共用；勾选只是草稿，点「装入 N 项」一次性落地 */}
      {memberPick && (() => {
        const kindLabel = kindTextOf(memberPick.kind);
        const libKind = memberPick.kind === "character" ? "characters" : memberPick.kind === "location" ? "locations" : "props";
        // 已被其他组认领的实体不可选（成员在组间互斥）。
        const disabledIds = infoGroups
          .filter((g) => !(memberPick.mode === "grp" && g.id === memberPick.groupId))
          .flatMap((g) => g.members);
        return (
          <ProjectLibraryPanel
            kind={libKind}
            mode="pick"
            multi
            selectedIds={memberPick.pending}
            disabledIds={disabledIds}
            onClose={() => setMemberPick(null)}
            pickTitle={t("project.canvas.memberPickTitle", { kind: kindLabel })}
            onTogglePick={(id) => {
              setMemberPick((prev) =>
                prev
                  ? {
                      ...prev,
                      pending: prev.pending.includes(id)
                        ? prev.pending.filter((item) => item !== id)
                        : [...prev.pending, id],
                    }
                  : prev,
              );
            }}
            confirm={{
              count: memberPick.pending.length,
              label: t("project.canvas.memberPickConfirm", { count: memberPick.pending.length }),
              onConfirm: () => {
                void applyMemberPick();
              },
            }}
          />
        );
      })()}
    </div>
  );
}
