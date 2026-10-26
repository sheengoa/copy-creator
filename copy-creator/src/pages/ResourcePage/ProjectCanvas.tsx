import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
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
import { openResourceFile, readResourceTextPreview } from "../../domain/mediaAssets";
import {
  characterAvatarInitial,
  characterAvatarPaletteIndex,
  intExtLabelKey,
  joinLibraryPath,
  locationSubtitleParts,
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
const LOOSE_W = 200;
const LOOSE_RATIO = 0.62;
const MISSING_W = 170;
const MISSING_H = 96;
const INFO_W = 132; // 资料卡宽（角色/道具/剧本）
const INFO_H = 156;
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
type PosMap = { cards: Record<string, Pos>; loose: Record<string, Pos>; info?: Pos };

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
interface CanvasLoose {
  key: string; // `asset:<id>`
  asset: ProjectAsset;
  w: number;
  h: number;
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
/** 画布占位素材节点（「素材」菜单创建的空节点，双击填充后才入库为
 *  集级散件），按集存 localStorage。 */
interface CanvasPlaceholder {
  id: string;
  x: number;
  y: number;
}
interface CanvasFrame {
  id: string; // sceneId | "loose" | "info"
  scene: ProjectScene | null;
  label: string;
  w: number;
  h: number;
}

interface CanvasLayout {
  cards: CanvasCard[];
  looses: CanvasLoose[];
  infos: CanvasInfo[];
  frames: CanvasFrame[];
  cardPos: Record<string, Pos>;
  loosePos: Record<string, Pos>;
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

/** 素材类型 → hover 标注的 i18n 键。 */
function assetKindBadgeKey(kind: string): string {
  switch (kind) {
    case "image": return "project.canvas.typeImage";
    case "video": return "project.canvas.typeVideo";
    case "text": return "project.canvas.typeText";
    case "audio": return "project.canvas.typeAudio";
    case "prompt": return "project.canvas.typePrompt";
    default: return "project.canvas.typeFile";
  }
}

/** 确定性自动布局：已摆放的镜头卡/散件用存储坐标；未摆放的按场景
 *  横排 + 框内网格补位（跳过已占用格位，避免新卡叠在旧卡下）。 */
function buildLayout(
  scenes: ProjectScene[],
  looseAssets: ProjectAsset[],
): Omit<CanvasLayout, "infoFramePos"> {
  const cardPos: Record<string, Pos> = {};
  const loosePos: Record<string, Pos> = {};
  const cards: CanvasCard[] = [];
  const looses: CanvasLoose[] = [];
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

  // 集级散件：铺在所有场景框下方，4 列网格（已摆放的用存储坐标）。
  const scenesBottom = frames.reduce((acc, frame) => {
    const isScene = frame.id !== "loose" && frame.id !== "info";
    if (!isScene) return acc;
    // 场景框位置在调用方 pos state 里（布局纯函数只产尺寸），这里用
    // frame 的默认 y 推导：所有场景框 y 已定（fx/fy 在上方算好）。
    return acc;
  }, 0);
  void scenesBottom;
  // 场景框底部：直接由 frames 尺寸 + 已知 fy 推（fy 存在 frame.label 之外，
  // 这里用 scenes 的 canvas 或默认值重推一次，与上方一致）。
  let scenesMaxY = 0;
  scenes.forEach((scene) => {
    const fy = scene.canvas_y ?? 110;
    const frame = frames.find((f) => f.id === scene.id);
    scenesMaxY = Math.max(scenesMaxY, fy + (frame?.h ?? 0));
  });
  const looseY = Math.max(620, scenesMaxY + 48);
  frames.push({ id: "loose", scene: null, label: "", w: FRAME_MIN_W, h: FRAME_MIN_H });
  looseAssets.forEach((asset, index) => {
    loosePos[asset.id] =
      asset.canvas_x != null && asset.canvas_y != null
        ? { x: asset.canvas_x, y: asset.canvas_y }
        : {
            x: WORLD_MARGIN + FRAME_PAD_X + (index % 4) * (LOOSE_W + CARD_GAP),
            y: looseY + FRAME_PAD_TOP + Math.floor(index / 4) * (LOOSE_W * LOOSE_RATIO + CARD_GAP + 8),
          };
    looses.push({
      key: `asset:${asset.id}`, asset,
      w: asset.missing ? MISSING_W : asset.canvas_w ?? LOOSE_W,
      h: asset.missing ? MISSING_H : Math.round(LOOSE_W * LOOSE_RATIO),
    });
  });
  const looseFrame = frames.find((f) => f.id === "loose");
  if (looseFrame) {
    const maxX = Math.max(
      WORLD_MARGIN + FRAME_MIN_W,
      ...looseAssets.map((a) => loosePos[a.id].x + (looses.find((l) => l.key === `asset:${a.id}`)?.w ?? LOOSE_W)),
    );
    const maxY = Math.max(
      looseY + FRAME_MIN_H,
      ...looseAssets.map((a) => {
        const node = looses.find((l) => l.key === `asset:${a.id}`);
        return loosePos[a.id].y + (node?.h ?? LOOSE_W * LOOSE_RATIO);
      }),
    );
    looseFrame.w = maxX - WORLD_MARGIN;
    looseFrame.h = maxY - looseY;
  }
  worldW = Math.max(worldW, (looseFrame?.w ?? 0) + WORLD_MARGIN + 60);
  worldH = Math.max(worldH, looseY + (looseFrame?.h ?? 0) + 60);

  return { cards, looses, infos: [], frames, cardPos, loosePos, framePos, worldW, worldH };
}

/** 文本纸片内容（读资源文本头部，组件内自持请求）。 */
function TextPaperBody({ path, name, lines }: { path: string; name: string; lines?: number }) {
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
      <p style={lines ? { WebkitLineClamp: lines } : undefined}>{preview === null ? "…" : preview}</p>
    </div>
  );
}

interface WireItem {
  fromKey: string; // 容器 key：shot:<id> | asset:<id>
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
  note: "#f6e6a8",
  image: "#4ade80",
  video: "#a78bfa",
  text: "#fb923c",
  audio: "#facc15",
  file: "#94a3b8",
};

/** 参考类输入口可接的数据类型（图/视频/文本/提示词）。 */
const REF_ACCEPTS = ["image", "video", "text", "prompt"];

/** 全集素材（镜头挂靠 + 集级散件）。 */
function allAssetsOf(scenes: ProjectScene[], looseAssets: ProjectAsset[]): ProjectAsset[] {
  const list: ProjectAsset[] = [];
  scenes.forEach((scene) => scene.shots.forEach((shot) => list.push(...shot.assets)));
  list.push(...looseAssets);
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
  const [infoFramePos, setInfoFramePos] = useState<Pos | null>(null);
  useEffect(() => {
    // episodeId 为空串是 selectEpisode 刷新途中的瞬态（概览先置空），
    // 不能当作切集去清空按集记忆，否则每次刷新尺寸/位置/便签全部跳回默认。
    if (!episodeId) return;
    try {
      const raw = window.localStorage.getItem(`project_canvas_info_${episodeId}`);
      setInfoFramePos(raw ? (JSON.parse(raw) as Pos) : null);
    } catch {
      setInfoFramePos(null);
    }
  }, [episodeId]);
  const saveInfoFramePos = useCallback(
    (next: Pos) => {
      setInfoFramePos(next);
      try {
        window.localStorage.setItem(`project_canvas_info_${episodeId}`, JSON.stringify(next));
      } catch {
        // 存储不可用：仅不记忆。
      }
    },
    [episodeId],
  );

  // ── 成片输出节点位置（localStorage 按集；默认挂世界右侧居中） ──
  const [outputPos, setOutputPos] = useState<Pos | null>(null);
  useEffect(() => {
    if (!episodeId) return; // 刷新瞬态（见资料框位置处的说明）。
    try {
      const raw = window.localStorage.getItem(`project_canvas_output_${episodeId}`);
      setOutputPos(raw ? (JSON.parse(raw) as Pos) : null);
    } catch {
      setOutputPos(null);
    }
  }, [episodeId]);
  const saveOutputPos = useCallback(
    (next: Pos) => {
      setOutputPos(next);
      try {
        window.localStorage.setItem(`project_canvas_output_${episodeId}`, JSON.stringify(next));
      } catch {
        // 存储不可用：仅不记忆。
      }
    },
    [episodeId],
  );

  // ── 便签节点（ComfyUI Note 的对应物）：文本与位置按集记 localStorage ──
  const [notes, setNotes] = useState<CanvasNote[]>([]);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  useEffect(() => {
    if (!episodeId) return; // 刷新瞬态（见资料框位置处的说明）。
    try {
      const raw = window.localStorage.getItem(`project_canvas_notes_${episodeId}`);
      setNotes(raw ? (JSON.parse(raw) as CanvasNote[]) : []);
    } catch {
      setNotes([]);
    }
    setEditingNoteId(null);
  }, [episodeId]);
  const persistNotes = useCallback(
    (next: CanvasNote[]) => {
      setNotes(next);
      try {
        window.localStorage.setItem(`project_canvas_notes_${episodeId}`, JSON.stringify(next));
      } catch {
        // 存储不可用：仅不记忆。
      }
    },
    [episodeId],
  );
  const addNote = useCallback(
    (x: number, y: number) => {
      const note: CanvasNote = {
        id: `n${Date.now()}${Math.floor(Math.random() * 1e4)}`,
        text: "",
        x,
        y,
      };
      persistNotes([...notes, note]);
      setEditingNoteId(note.id);
      setNoteDraft("");
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
  } | null>(null);
  const [addMenuQuery, setAddMenuQuery] = useState("");
  // 资料关联面板开关（挂产出走片段详情窗口，见 detailFor）。
  const [locationPickOpen, setLocationPickOpen] = useState(false);
  // 挂剧本：选择库内文件设为本集 script_path；已有剧本时「剧本」菜单项
  // 与缺项提醒改为定位。
  const [scriptPickOpen, setScriptPickOpen] = useState(false);

  // ── 占位素材节点（双击填充后才入库为集级散件）：按集存 localStorage ──
  const [placeholders, setPlaceholders] = useState<CanvasPlaceholder[]>([]);
  useEffect(() => {
    if (!episodeId) return; // 刷新瞬态（见资料框位置处的说明）。
    try {
      const raw = window.localStorage.getItem(`project_canvas_placeholders_${episodeId}`);
      setPlaceholders(raw ? (JSON.parse(raw) as CanvasPlaceholder[]) : []);
    } catch {
      setPlaceholders([]);
    }
  }, [episodeId]);
  const persistPlaceholders = useCallback(
    (next: CanvasPlaceholder[]) => {
      setPlaceholders(next);
      try {
        window.localStorage.setItem(`project_canvas_placeholders_${episodeId}`, JSON.stringify(next));
      } catch {
        // 存储不可用：仅不记忆。
      }
    },
    [episodeId],
  );
  const addPlaceholder = useCallback(
    (x: number, y: number) => {
      persistPlaceholders([
        ...placeholders,
        { id: `p${Date.now()}${Math.floor(Math.random() * 1e4)}`, x, y },
      ]);
    },
    [placeholders, persistPlaceholders],
  );

  // ── 空白资料占位节点（菜单选 角色/场景/道具 即创建，创建时绝不弹
  // 挑选面板；双击节点从详情窗加载实体，加载后原位变成实体节点）：
  // 按集存 localStorage ──
  type EntityPhKind = "character" | "location" | "prop";
  interface EntityPh { id: string; kind: EntityPhKind; x: number; y: number }
  const [entityPhs, setEntityPhs] = useState<EntityPh[]>([]);
  const entityPhKey = `project_canvas_entityph_${episodeId}`;
  useEffect(() => {
    if (!episodeId) return; // 刷新瞬态（见资料框位置处的说明）。
    try {
      const raw = window.localStorage.getItem(entityPhKey);
      setEntityPhs(raw ? (JSON.parse(raw) as EntityPh[]) : []);
    } catch {
      setEntityPhs([]);
    }
  }, [entityPhKey, episodeId]);
  const persistEntityPhs = useCallback(
    (next: EntityPh[]) => {
      setEntityPhs(next);
      try {
        window.localStorage.setItem(entityPhKey, JSON.stringify(next));
      } catch {
        // 存储不可用：仅不记忆。
      }
    },
    [entityPhKey],
  );
  const addEntityPh = useCallback(
    (kind: EntityPhKind, x: number, y: number) => {
      persistEntityPhs([
        ...entityPhs,
        { id: `e${Date.now()}${Math.floor(Math.random() * 1e4)}`, kind, x, y },
      ]);
    },
    [entityPhs, persistEntityPhs],
  );

  // ── 资料组节点（一个节点装多个同类实体，一条线接入片段——线的含义
  // = 片段要用组内全部成员）：按集存 localStorage。成员在组间互斥；
  // 未被组认领的集关联实体仍各自渲染为默认单实体节点，旧数据零迁移。 ──
  interface InfoGroup {
    id: string;
    kind: EntityPhKind;
    members: string[];
  }
  const [infoGroups, setInfoGroups] = useState<InfoGroup[]>([]);
  const infoGroupsKey = `project_canvas_infogroups_${episodeId}`;
  useEffect(() => {
    if (!episodeId) return; // 刷新瞬态（见资料框位置处的说明）。
    try {
      const raw = window.localStorage.getItem(infoGroupsKey);
      setInfoGroups(raw ? (JSON.parse(raw) as InfoGroup[]) : []);
    } catch {
      setInfoGroups([]);
    }
  }, [infoGroupsKey, episodeId]);
  const persistInfoGroups = useCallback(
    (next: InfoGroup[]) => {
      setInfoGroups(next);
      try {
        window.localStorage.setItem(infoGroupsKey, JSON.stringify(next));
      } catch {
        // 存储不可用：仅不记忆。
      }
    },
    [infoGroupsKey],
  );
  // 组成员自愈：实体已不存在（库里被删）时从组里剔除，避免僵尸认领
  // 挡住后续同名 id 的实体入集。概览未加载（实体列表为空的瞬态）时跳过。
  useEffect(() => {
    if (!overview) return;
    const exists = (kind: EntityPhKind, id: string) =>
      (kind === "character"
        ? castCharacters
        : kind === "location"
          ? episodeLocations
          : episodeProps
      ).some((e) => e.id === id);
    let changed = false;
    const next = infoGroups
      .map((g) => {
        const members = g.members.filter((id) => exists(g.kind, id));
        if (members.length === g.members.length) return g;
        changed = true;
        return { ...g, members };
      })
      .filter((g) => g.members.length > 0);
    if (changed) persistInfoGroups(next);
  }, [overview, infoGroups, castCharacters, episodeLocations, episodeProps, persistInfoGroups]);

  // ── 布局与位置（state 驱动渲染） ──
  const layout = useMemo(() => {
    const base = buildLayout(scenes, looseAssets);
    return base;
  }, [scenes, looseAssets]);

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
        key: "script", kind: "script", name: scriptFileLabelOf(overview.episode.script_path),
        avatarPath: "", textPath: overview.episode.script_path, w: SCRIPT_W, h: INFO_H + 40,
      });
    }
    return list;
  }, [castCharacters, episodeLocations, episodeProps, infoGroups, overview]);

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

  const [pos, setPos] = useState<PosMap>({ cards: layout.cardPos, loose: layout.loosePos });
  useEffect(() => {
    setPos({ cards: layout.cardPos, loose: layout.loosePos });
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
  const [nodeSizes, setNodeSizes] = useState<Record<string, { w: number; h: number }>>({});
  const sizesKey = `project_canvas_sizes_${episodeId}`;
  useEffect(() => {
    if (!episodeId) return; // 刷新瞬态（见资料框位置处的说明）。
    try {
      const raw = window.localStorage.getItem(sizesKey);
      setNodeSizes(raw ? (JSON.parse(raw) as Record<string, { w: number; h: number }>) : {});
    } catch {
      setNodeSizes({});
    }
  }, [sizesKey, episodeId]);
  const persistSizes = useCallback(
    (next: Record<string, { w: number; h: number }>) => {
      setNodeSizes(next);
      try {
        window.localStorage.setItem(sizesKey, JSON.stringify(next));
      } catch {
        // 存储不可用：仅不记忆尺寸。
      }
    },
    [sizesKey],
  );
  const sizeOfNode = useCallback(
    (key: string): { w: number; h: number } | null => {
      const over = nodeSizes[key];
      if (key.startsWith("asset:")) {
        const loose = layout.looses.find((l) => l.key === key);
        if (!loose) return null;
        return { w: over?.w ?? loose.w, h: over?.h ?? loose.h };
      }
      if (key.startsWith("placeholder:")) {
        return { w: over?.w ?? LOOSE_W, h: over?.h ?? Math.round(LOOSE_W * LOOSE_RATIO) };
      }
      if (key.startsWith("segment:")) {
        return { w: over?.w ?? SEG_W, h: over?.h ?? SEG_H };
      }
      return null;
    },
    [nodeSizes, layout],
  );

  // ── 资料节点（角色/场景/道具/剧本）自由位置：默认仍在资料框网格，
  // 拖动后按节点绝对位置记忆——框退化为背景分组框，节点不再被钉死。 ──
  const [infoOffsets, setInfoOffsets] = useState<Record<string, Pos>>({});
  const infoOffsetsKey = `project_canvas_infonodes_${episodeId}`;
  useEffect(() => {
    if (!episodeId) return; // 刷新瞬态（见资料框位置处的说明）。
    try {
      const raw = window.localStorage.getItem(infoOffsetsKey);
      setInfoOffsets(raw ? (JSON.parse(raw) as Record<string, Pos>) : {});
    } catch {
      setInfoOffsets({});
    }
  }, [infoOffsetsKey, episodeId]);
  const persistInfoOffsets = useCallback(
    (next: Record<string, Pos>) => {
      setInfoOffsets(next);
      try {
        window.localStorage.setItem(infoOffsetsKey, JSON.stringify(next));
      } catch {
        // 存储不可用：仅不记忆位置。
      }
    },
    [infoOffsetsKey],
  );
  const infoNodePos = useCallback(
    (key: string): Pos => {
      if (infoOffsets[key]) return infoOffsets[key];
      // 空白资料占位节点：默认落创建点（拖动后同样走 infoOffsets）。
      if (key.startsWith("eph:")) {
        const ph = entityPhs.find((item) => `eph:${item.id}` === key);
        if (ph) return { x: ph.x, y: ph.y };
      }
      return infoPos.map[key];
    },
    [infoOffsets, infoPos, entityPhs],
  );

  // ── 新节点出生锚点：任何「加载」动作（添加菜单挑实体/挂剧本/详情窗
  // 添加）在触发瞬间记录世界坐标，概览刷新后新出现的资料节点直接出生
  // 在那里并脉冲高亮——节点必须出现在用户视线（鼠标）附近，而不是默默
  // 落到资料框网格里让人以为加载失败。同一次面板连选多个时按 28px 错开。 ──
  const spawnAnchorRef = useRef<{ wx: number; wy: number; used: number } | null>(null);
  const [pulseKeys, setPulseKeys] = useState<string[]>([]);
  // 脉冲高亮 2.4s 后自动退场（effect 驱动，不用 timer ref——ref 会让
  // 传递触底函数的写法被 react-hooks/refs 拦下）。
  useEffect(() => {
    if (pulseKeys.length === 0) return;
    const timer = window.setTimeout(() => setPulseKeys([]), 2400);
    return () => window.clearTimeout(timer);
  }, [pulseKeys]);
  const armSpawnAt = useCallback((wx: number, wy: number) => {
    spawnAnchorRef.current = { wx, wy, used: 0 };
  }, []);
  const prevInfoKeysRef = useRef<string[] | null>(null);
  useEffect(() => {
    // 概览刷新途中 selectEpisode 会先置空（infoNodes 短暂为空）：这个
    // 空档不是「节点删光了」，跳过——否则刷新后所有节点都会被误判为
    // 新出生，锚点也会在空档里被误消耗。
    if (infoNodes.length === 0) return;
    const prev = prevInfoKeysRef.current;
    prevInfoKeysRef.current = infoNodes.map((node) => node.key);
    const anchor = spawnAnchorRef.current;
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
    | { kind: "asset"; id: string }
    | { kind: "placeholder"; id: string }
    | { kind: "entityPh"; id: string }
    | { kind: "segment"; id: string; scopes: { chars: DetailScope; locs: DetailScope; props: DetailScope } }
    | { kind: "info"; group: EntityPhKind; sourceKey: string; scope: DetailScope }
    | { kind: "script" }
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
  // 详情窗口内「从资源库选择」的二级选择器目标。
  const [pickerFor, setPickerFor] = useState<`placeholder:${string}` | `segment:${string}` | null>(null);
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
  // 详情窗口 → 从资源库选择：占位填充（新散件落在占位位置并继承其尺寸）
  // 与片段挂产出。
  const fillPlaceholderFromLibrary = (phId: string, file: { filePath: string; kind: string; name: string }) => {
    const ph = placeholders.find((item) => item.id === phId);
    setPickerFor(null);
    setDetailFor(null);
    if (!ph) return;
    const phKey = `placeholder:${ph.id}`;
    const size = nodeSizes[phKey];
    void linkAsset({
      filePath: file.filePath,
      kind: file.kind,
      name: file.name,
      episodeId,
      shotId: "",
    }).then((asset) => {
      if (!asset) return;
      void saveCanvasLayout({
        assets: [{ id: asset.id, x: ph.x, y: ph.y, w: size?.w ?? LOOSE_W }],
        shots: [],
        scenes: [],
      });
      persistPlaceholders(placeholders.filter((item) => item.id !== ph.id));
      if (size) {
        const next = { ...nodeSizes, [`asset:${asset.id}`]: size };
        delete next[phKey];
        persistSizes(next);
      }
    });
  };
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

  // 成片来源显示名：镜头描述或素材名。
  const outputSourceLabel: string | null = useMemo(() => {
    if (!outputKey) return null;
    if (outputKey.startsWith("shot:")) {
      const shot = scenes.flatMap((s) => s.shots).find((item) => item.id === outputKey.slice(5));
      return shot?.description || null;
    }
    return (
      looseAssets.find((a) => a.id === outputKey)?.name ||
      allAssetsOf(scenes, looseAssets).find((a) => a.id === outputKey)?.name ||
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
  // 自动铺一套已连接骨架——两个空片段（片段→成片是隐式聚合线），已
  // 关联的角色/场景/道具接入片段一的对应口；剧本挂接后自动连提示词
  // 口。用户在其上双击填充、自由增删连线。标记落 localStorage，此后
  // 即使删光片段也不再重建。
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
      const first = await addSegment(episodeId);
      if (!first) return;
      const jobs: Promise<unknown>[] = [];
      overview.characters.slice(0, 2).forEach((c) => jobs.push(linkNode(episodeId, "character", c.id, first.id, "character")));
      overview.locations.slice(0, 2).forEach((l) => jobs.push(linkNode(episodeId, "location", l.id, first.id, "location")));
      overview.props.slice(0, 2).forEach((p) => jobs.push(linkNode(episodeId, "prop", p.id, first.id, "prop")));
      await Promise.all(jobs);
      await addSegment(episodeId);
    })();
  }, [episodeId, overview, addSegment, linkNode, templateFlagKey]);

  // 剧本节点定位（视口居中到剧本纸片；纸片可被拖离资料框，用覆盖位置）。
  const locateScript = useCallback(() => {
    const el = vpRef.current;
    const p = infoNodePos("script");
    if (!el || !p) return;
    const next = {
      x: el.clientWidth / 2 - (p.x + SCRIPT_W / 2) * view.scale,
      y: el.clientHeight / 2 - (p.y + (INFO_H + 40) / 2) * view.scale,
      scale: view.scale,
    };
    setView(next);
    saveView(next);
  }, [infoNodePos, view.scale, setView, saveView]);

  // 挂剧本：从资源库选文件设为本集剧本。剧本是全集共享输入，挂接成功
  // 即自动接入所有已有片段的提示词口（linkNode 幂等，重复挂接不会写
  // 重；挂接之后新建的片段仍手动连或拖线接）。
  const handleScriptPick = useCallback(
    (filePath: string) => {
      const episode = overview?.episode;
      if (!episode) return;
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
    },
    [overview, updateEpisode, segments, linkNode],
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

  // ── 连线：容器（镜头卡/散件）之间的生成链 + 手动线 ──
  const containerOf = useCallback(
    (assetId: string): string | null => {
      for (const scene of scenes) {
        for (const shot of scene.shots) {
          if (shot.assets.some((a) => a.id === assetId)) return `shot:${shot.id}`;
        }
      }
      return looseAssets.some((a) => a.id === assetId) ? `asset:${assetId}` : null;
    },
    [scenes, looseAssets],
  );

  const wires = useMemo(() => {
    const list: WireItem[] = [];
    const kindOf = new Map(allAssetsOf(scenes, looseAssets).map((a) => [a.id, a.kind]));
    const pushWire = (fromAsset: string, toAsset: string, kind: "gen" | "manual") => {
      const from = containerOf(fromAsset);
      const to = containerOf(toAsset);
      if (!from || !to || from === to) return;
      if (list.some((w) => w.fromKey === from && w.toKey === to && w.kind === kind)) return;
      list.push({ fromKey: from, toKey: to, kind, type: kindOf.get(fromAsset) ?? "file" });
    };
    allAssetsOf(scenes, looseAssets).forEach((asset) => {
      if (asset.gen_from_asset && kindOf.has(asset.gen_from_asset)) {
        pushWire(asset.gen_from_asset, asset.id, "gen");
      }
    });
    links.forEach((link: ProjectAssetLink) => {
      pushWire(link.from_asset, link.to_asset, "manual");
    });
    return list;
  }, [scenes, looseAssets, links, containerOf]);

  // ── 节点实测尺寸与端口位置：连线锚点跟随真实 DOM（内容自适应的
  // 标题条/端口行/缩略图都会改变卡体高度，常量只是首帧兜底） ──
  const [nodeMetrics, setNodeMetrics] = useState<{
    boxes: Record<string, { w: number; h: number }>;
    ports: Record<string, Record<string, Pos>>;
  }>({ boxes: {}, ports: {} });
  const nodeMetricsRef = useRef(nodeMetrics);
  const viewScaleRef = useRef(view.scale);
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
  const nodeRoRef = useRef<ResizeObserver | null>(null);
  useEffect(() => () => nodeRoRef.current?.disconnect(), []);
  useLayoutEffect(() => {
    viewScaleRef.current = view.scale;
    if (!nodeRoRef.current) {
      nodeRoRef.current = new ResizeObserver(() => measureNodes());
    }
    const ro = nodeRoRef.current;
    const els = Array.from(vpRef.current?.querySelectorAll<HTMLElement>(".pc-node[data-key]") ?? []);
    els.forEach((el) => ro.observe(el));
    measureNodes();
    return () => els.forEach((el) => ro.unobserve(el));
  });

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
        const size = cardSizeOf(key.slice(5));
        return finish(p.x, p.y, size.w, size.h);
      }
      if (key.startsWith("asset:")) {
        const assetId = key.slice(6);
        const loose = layout.looses.find((l) => l.asset.id === assetId);
        const p = pos.loose[assetId];
        if (!loose || !p) return null;
        const size = sizeOfNode(key);
        return finish(p.x, p.y, size?.w ?? loose.w, size?.h ?? loose.h);
      }
      if (key.startsWith("segment:")) {
        const p = segPos[key.slice(8)];
        const size = sizeOfNode(key);
        return p ? finish(p.x, p.y, size?.w ?? SEG_W, SEG_H) : null;
      }
      if (key === "output") {
        return outputBox ? finish(outputBox.x, outputBox.y, OUTPUT_W, OUTPUT_H) : null;
      }
      // 资料节点（角色/场景/道具/剧本）：拖动过的用覆盖位置，否则网格。
      const infoNode = infoNodes.find((item) => item.key === key);
      const infoP = infoNode ? infoNodePos(key) : undefined;
      return infoNode && infoP ? finish(infoP.x, infoP.y, infoNode.w, infoNode.h) : null;
    },
    [layout, pos, cardSizeOf, outputBox, segPos, infoNodes, nodeMetrics, sizeOfNode, infoNodePos],
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
                : fromKind === "shot"
                  ? `shot:${fromId}`
                  : `asset:${fromId}`;
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
  // 片段节点是核心生成单元：五输入口（角色/场景/道具/脚本/其他）+
  // 片段视频输出口；剧本与脚本同为 text，都连进片段的「脚本」口。
  const portsOf = useCallback(
    (key: string): { ins: { id: string; label: string; accepts: string[] }[]; out?: { label: string; type: string } } => {
      if (key.startsWith("segment:")) {
        return {
          ins: [
            { id: "character", label: t("project.canvas.typeCharacter"), accepts: ["image"] },
            { id: "location", label: t("project.canvas.typeLocation"), accepts: ["image"] },
            { id: "prop", label: t("project.canvas.typeProp"), accepts: ["image"] },
            { id: "script", label: t("project.canvas.typePrompt"), accepts: ["prompt", "text"] },
            { id: "other", label: t("project.canvas.typeOther"), accepts: ["video", "audio", "file", "image"] },
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
      if (key.startsWith("asset:")) {
        const assetId = key.slice(6);
        const loose = looseAssets.find((a) => a.id === assetId);
        const kind =
          loose?.kind ??
          allAssetsOf(scenes, looseAssets).find((a) => a.id === assetId)?.kind;
        if (!kind) return { ins: [] };
        return {
          ins: REF_ACCEPTS.includes(kind)
            ? [{ id: "in", label: t("project.canvas.portRef"), accepts: REF_ACCEPTS }]
            : [],
          out: { label: t(assetKindBadgeKey(kind)), type: kind },
        };
      }
      if (key === "script") return { ins: [], out: { label: t("project.canvas.typeScript"), type: "text" } };
      if (key.startsWith("char:") || key.startsWith("loc:") || key.startsWith("prop:") || key.startsWith("grp:")) {
        return { ins: [], out: { label: t("project.canvas.portRefImg"), type: "image" } };
      }
      return { ins: [] };
    },
    [scenes, looseAssets, t],
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
      if (key.startsWith("asset:")) return { kind: "asset", id: key.slice(6) };
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
        if (outKey.startsWith("asset:")) void setEpisodeOutput(episodeId, outKey.slice(6));
        else if (outKey.startsWith("shot:")) void setEpisodeOutput(episodeId, outKey);
        return;
      }
      if (inKey.startsWith("segment:")) {
        const source = nodeKeyParts(outKey);
        if (!source) return;
        const fromType = wire.fromType ?? portsOf(outKey).out?.type;
        const port = portsOf(inKey).ins.find((item) =>
          fromType ? item.accepts.includes(fromType) : false,
        );
        if (port) {
          void linkNode(
            episodeId,
            source.kind,
            source.id,
            inKey.slice(8),
            port.id as ProjectNodeLink["to_port"],
          );
        }
        return;
      }
      if (outKey.startsWith("asset:") && inKey.startsWith("asset:")) {
        void linkAssets(outKey.slice(6), inKey.slice(6), "");
      }
    },
    [episodeId, nodeKeyParts, portsOf, linkNode, linkAssets, setEpisodeOutput],
  );

  // ── 选中与拖拽 ──
  const [selKeys, setSelKeys] = useState<string[]>([]);
  const selRef = useRef<string[]>([]);
  const setSelection = useCallback((keys: string[]) => {
    selRef.current = keys;
    setSelKeys(keys);
  }, []);

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
  const persistLoose = useCallback(
    (nextLoose: Record<string, Pos>) => {
      const sizeOf = (id: string) => {
        const node = layout.looses.find((l) => l.asset.id === id);
        return node?.w ?? LOOSE_W;
      };
      void saveCanvasLayout({
        assets: Object.entries(nextLoose).map(([id, p]) => ({ id, x: p.x, y: p.y, w: sizeOf(id) })),
        shots: [],
        scenes: [],
      });
    },
    [layout, saveCanvasLayout],
  );

  interface DragState {
    kind: "pan" | "marquee" | "card" | "loose" | "group" | "infoframe" | "wire" | "outnode" | "note" | "addnode" | "segment" | "placeholder" | "resize" | "infonode";
    sx: number;
    sy: number;
    moved?: boolean;
    ox?: number;
    oy?: number;
    mq?: HTMLDivElement;
    moves?: { key: string; x: number; y: number }[];
    frameKey?: string;
    corner?: "nw" | "ne" | "sw" | "se";
    px?: number;
    py?: number;
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

  const onViewportMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      setAddMenu(null);
      // 便签卡：按下即拖动（编辑态除外）。
      const noteEl = target?.closest(".pc-note");
      if (noteEl && !target?.closest("textarea, button")) {
        const noteId = noteEl.getAttribute("data-note") ?? "";
        const note = notes.find((item) => item.id === noteId);
        if (note) {
          noteEl.classList.add("pc-dragging");
          dragRef.current = {
            kind: "note", sx: e.clientX, sy: e.clientY, moved: false,
            ox: note.x, oy: note.y, frameKey: noteId,
          };
          e.preventDefault();
          return;
        }
      }
      // 节点右下角尺寸手柄（ComfyUI 式）：按下即改尺寸，不挪位置。
      const resizeEl = target?.closest(".pc-resize");
      if (resizeEl) {
        const nodeEl = resizeEl.closest(".pc-node") as HTMLElement | null;
        const key = nodeEl?.getAttribute("data-key") ?? "";
        const size = sizeOfNode(key);
        if (key && size) {
          const corner = (resizeEl.getAttribute("data-corner") ?? "se") as DragState["corner"];
          // 西/北角缩放会挪动节点，按下时记下原始位置。
          let px: number | undefined;
          let py: number | undefined;
          if (key.startsWith("segment:")) {
            const p = segPos[key.slice(8)];
            px = p?.x;
            py = p?.y;
          } else if (key.startsWith("asset:")) {
            const p = pos.loose[key.slice(6)];
            px = p?.x;
            py = p?.y;
          } else if (key.startsWith("placeholder:")) {
            const p = placeholders.find((item) => item.id === key.slice(12));
            px = p?.x;
            py = p?.y;
          }
          nodeEl?.classList.add("pc-resizing");
          dragRef.current = {
            kind: "resize", sx: e.clientX, sy: e.clientY, moved: false,
            // 首次拖拽从实际渲染尺寸起算（覆盖层只存改过的节点）；片段的
            // 存量语义是节点总高，散件/占位是媒体区高度（默认值即吻合）。
            ox: nodeSizes[key]?.w ?? nodeEl?.offsetWidth ?? size.w,
            oy: nodeSizes[key]?.h ?? (key.startsWith("segment:") ? nodeEl?.offsetHeight ?? size.h : size.h),
            frameKey: key,
            corner,
            px,
            py,
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
      if (e.button !== 0) return;
      const port = target?.closest(".pc-port") as HTMLElement | null;
      if (port) {
        const nodeEl = port.closest(".pc-node");
        const key = nodeEl?.getAttribute("data-key") ?? "";
        const dir = port.dataset.port === "in" ? "in" : "out";
        const portId = port.dataset.portId ?? "";
        const ports = portsOf(key);
        const inPort = ports.ins.find((item) => item.id === portId);
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
          setSelection(selRef.current.includes(key) ? selRef.current : [key]);
          nodeEl.classList.add("pc-dragging");
          dragRef.current = {
            kind: "outnode", sx: e.clientX, sy: e.clientY, moved: false,
            ox: outputBox.x, oy: outputBox.y,
          };
          e.preventDefault();
          return;
        }
        if (key.startsWith("segment:")) {
          // 片段卡：按下即拖动，松手持久化坐标。
          const segId = key.slice(8);
          const p = segPos[segId];
          if (p) {
            setSelection(selRef.current.includes(key) ? selRef.current : [key]);
            nodeEl.classList.add("pc-dragging");
            dragRef.current = {
              kind: "segment", sx: e.clientX, sy: e.clientY, moved: false,
              ox: p.x, oy: p.y, frameKey: segId,
            };
            e.preventDefault();
            return;
          }
        }
        if (key.startsWith("placeholder:")) {
          // 占位素材节点：按下即拖动，松手持久化到 localStorage。
          const phId = key.slice(12);
          const ph = placeholders.find((item) => item.id === phId);
          if (ph) {
            setSelection(selRef.current.includes(key) ? selRef.current : [key]);
            nodeEl.classList.add("pc-dragging");
            dragRef.current = {
              kind: "placeholder", sx: e.clientX, sy: e.clientY, moved: false,
              ox: ph.x, oy: ph.y, frameKey: phId,
            };
            e.preventDefault();
            return;
          }
        }
        if (
          key.startsWith("char:") || key.startsWith("loc:") ||
          key.startsWith("prop:") || key === "script" || key.startsWith("eph:") ||
          key.startsWith("grp:")
        ) {
          // 资料节点（含组节点与空白资料占位）：按下即自由拖动（覆盖层
          // 按绝对位置记忆，资料框退化为背景分组框，节点不再被网格钉死）。
          // 按下即选中：配合选中点亮样式，「在操作哪个节点」一眼可见。
          const p = infoNodePos(key);
          setSelection(selRef.current.includes(key) ? selRef.current : [key]);
          nodeEl.classList.add("pc-dragging");
          dragRef.current = {
            kind: "infonode", sx: e.clientX, sy: e.clientY, moved: false,
            ox: p.x, oy: p.y, frameKey: key,
          };
          e.preventDefault();
          return;
        }
        const nextSel = selRef.current.includes(key) ? selRef.current : [key];
        setSelection(nextSel);
        nodeEl.classList.add("pc-dragging");
        const kind = key.startsWith("shot:") ? "card" : "loose";
        dragRef.current = {
          kind, sx: e.clientX, sy: e.clientY, moved: false,
          moves: nextSel
            .map((k) => {
              if (k.startsWith("shot:")) {
                const id = k.slice(5);
                const p = pos.cards[id];
                return p ? { key: id, x: p.x, y: p.y } : null;
              }
              const id = k.slice(6);
              const p = pos.loose[id];
              return p ? { key: id, x: p.x, y: p.y } : null;
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
        if (frameKey === "info") {
          dragRef.current = {
            kind: "infoframe", sx: e.clientX, sy: e.clientY,
            fox: infoPos.frame.x, foy: infoPos.frame.y, moved: false,
          };
          e.preventDefault();
          return;
        }
        if (frameKey && frameKey !== "loose") {
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
    [layout, pos, setSelection, view, infoPos, scenePos, portsOf, outputBox, notes, segPos, placeholders, sizeOfNode, infoNodePos, nodeSizes],
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
      } else if (drag.kind === "placeholder") {
        if (!drag.moved) return;
        setPlaceholders((prev) =>
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
        const minW = key.startsWith("segment:") ? 180 : 150;
        const minH = 90;
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
          const px = Math.round((drag.px ?? 0) + (shiftX ? (drag.ox ?? 0) - w : 0));
          const py = Math.round((drag.py ?? 0) + (shiftY ? (drag.oy ?? 0) - h : 0));
          // 回写进 drag 对象：mouseup 闭包可能拿不到最新 state，用它兜底。
          drag.px = px;
          drag.py = py;
          if (key.startsWith("segment:")) {
            const segId = key.slice(8);
            setSegPos((prev) => ({ ...prev, [segId]: { x: px, y: py } }));
          } else if (key.startsWith("asset:")) {
            const assetId = key.slice(6);
            setPos((prev) => ({ ...prev, loose: { ...prev.loose, [assetId]: { x: px, y: py } } }));
          } else if (key.startsWith("placeholder:")) {
            const phId = key.slice(12);
            setPlaceholders((prev) => prev.map((item) => (item.id === phId ? { ...item, x: px, y: py } : item)));
          }
        }
      } else if (drag.kind === "infonode") {
        if (!drag.moved) return;
        const key = drag.frameKey ?? "";
        setInfoOffsets((prev) => ({
          ...prev,
          [key]: { x: (drag.ox ?? 0) + dx / view.scale, y: (drag.oy ?? 0) + dy / view.scale },
        }));
      } else if (drag.kind === "wire") {
        const el = vpRef.current;
        if (!el || !drag.fromKey) return;
        const rect = el.getBoundingClientRect();
        const wx = (e.clientX - rect.left - view.x) / view.scale;
        const wy = (e.clientY - rect.top - view.y) / view.scale;
        const startPoint =
          drag.fromDir === "in"
            ? inPointOf(drag.fromKey, drag.fromPortId)
            : outPointOf(drag.fromKey);
        if (!startPoint) return;
        const cursor = { x: wx, y: wy };
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const tEl = hit instanceof Element ? hit.closest(".pc-node") : null;
        const tKey = tEl?.getAttribute("data-key") ?? null;
        // 可写连接模型：兼容性判断与松手后的落库动作一一对应，杜绝
        // "看起来能连、松手却写不进"的死线。镜头卡的产出可进片段口与
        // 成片（此前被误禁）；素材参考线仅散件之间（镜头/散件混连无
        // 渲染语义，不假兼容）；片段→成片是按拼接序的隐式聚合。
        const outKeyOf = drag.fromDir === "in" ? tKey : drag.fromKey;
        const inKeyOf = drag.fromDir === "in" ? drag.fromKey : tKey;
        const writable =
          !!outKeyOf && !!inKeyOf &&
          ((outKeyOf.startsWith("asset:") && inKeyOf.startsWith("asset:")) ||
            (inKeyOf === "output" &&
              (outKeyOf.startsWith("asset:") || outKeyOf.startsWith("shot:") || outKeyOf.startsWith("segment:"))) ||
            (inKeyOf.startsWith("segment:") &&
              (outKeyOf === "script" ||
                ["asset:", "shot:", "char:", "loc:", "prop:", "grp:", "segment:"].some((p) => outKeyOf.startsWith(p)))));
        let compatible = false;
        let targetPort: string | null = null;
        if (tKey && tKey !== drag.fromKey && writable) {
          const ports = portsOf(tKey);
          if (drag.fromDir === "in") {
            compatible = !!ports.out && !!drag.fromAccepts?.includes(ports.out.type);
          } else if (drag.fromType) {
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
          d: drag.fromDir === "in" ? wirePathD(cursor, startPoint) : wirePathD(startPoint, endPoint),
          invalid: drag.invalid,
          color: drag.fromType ? WIRE_TYPE_COLORS[drag.fromType] : undefined,
        });
      } else if (drag.kind === "card") {
        setPos((prev) => {
          const cards = { ...prev.cards };
          drag.moves?.forEach((mv) => {
            cards[mv.key] = { x: mv.x + dx / view.scale, y: mv.y + dy / view.scale };
          });
          return { ...prev, cards };
        });
      } else if (drag.kind === "loose") {
        setPos((prev) => {
          const loose = { ...prev.loose };
          drag.moves?.forEach((mv) => {
            loose[mv.key] = { x: mv.x + dx / view.scale, y: mv.y + dy / view.scale };
          });
          return { ...prev, loose };
        });
      }
    };
    const onUp = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.kind === "pan") {
        if (drag.moved) saveView(view);
      } else if (drag.kind === "wire") {
        wireHoverRef.current?.classList.remove("pc-wire-target");
        wireHoverRef.current = null;
        setWireDraft(null);
        if (drag.targetKey && drag.fromKey) {
          // 反拖（从输入口出发）时落点才是数据的来源方；落到成片节点
          // （key "output"）即设置本集总输出；落到片段的某个输入口则写
          // 一条 node_link（角色/场景/道具/剧本/素材/镜头/片段 → 片段）。
          const [outKey, inKey] = drag.fromDir === "in" ? [drag.targetKey, drag.fromKey] : [drag.fromKey, drag.targetKey];
          if (inKey === "output") {
            // 片段按拼接序隐式汇入成片（无库表可写）；镜头/散件才落总输出。
            if (!outKey.startsWith("segment:")) {
              void setEpisodeOutput(
                episodeId,
                outKey.startsWith("shot:") ? outKey : outKey.replace(/^asset:/, ""),
              );
            }
          } else if (inKey.startsWith("segment:")) {
            const segId = inKey.slice(8);
            if (outKey.startsWith("grp:")) {
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
          } else {
            // 可写模型已保证此处只会是散件↔散件。
            void linkAssets(
              outKey.replace(/^(shot|asset):/, ""),
              inKey.replace(/^(shot|asset):/, ""),
              "",
            );
          }
        } else if (!drag.targetKey && drag.moved && drag.fromKey) {
          // ComfyUI 惯例：拖到空白松手 → 弹节点选择框，创建的节点自动
          // 接上这条线；落在任何节点/浮层上松手视为取消，不弹。
          const hitEl = document.elementFromPoint(e.clientX, e.clientY);
          const landed = hitEl instanceof Element
            ? hitEl.closest(".pc-node, .pc-note, .pc-glass, .pc-checkbar")
            : null;
          if (!landed) {
            const el = vpRef.current;
            if (el) {
              const rect = el.getBoundingClientRect();
              setAddMenu({
                sx: e.clientX - rect.left,
                sy: e.clientY - rect.top,
                wx: (e.clientX - rect.left - view.x) / view.scale,
                wy: (e.clientY - rect.top - view.y) / view.scale,
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
        }
      } else if (drag.kind === "outnode") {
        if (drag.moved) {
          saveOutputPos({
            x: (drag.ox ?? 0) + (e.clientX - drag.sx) / view.scale,
            y: (drag.oy ?? 0) + (e.clientY - drag.sy) / view.scale,
          });
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
          const corner = drag.corner ?? "se";
          if (corner !== "se") {
            // mouseup 闭包里的 pos/segPos/placeholders 可能落后于拖拽中的
            // 实时更新，用 drag 对象上的最终坐标覆盖后再落盘。
            const finalX = drag.px;
            const finalY = drag.py;
            if (key.startsWith("segment:")) {
              const segId = key.slice(8);
              const p = segPos[segId];
              persistSegments({ ...segPos, [segId]: finalX != null && finalY != null ? { x: finalX, y: finalY } : p });
            } else if (key.startsWith("asset:")) {
              const assetId = key.slice(6);
              const p = pos.loose[assetId];
              persistLoose({
                ...pos.loose,
                [assetId]: finalX != null && finalY != null ? { x: finalX, y: finalY } : (p ?? { x: 0, y: 0 }),
              });
            } else if (key.startsWith("placeholder:")) {
              const phId = key.slice(12);
              persistPlaceholders(
                placeholders.map((item) =>
                  item.id === phId && finalX != null && finalY != null ? { ...item, x: finalX, y: finalY } : item,
                ),
              );
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
        }
      } else if (drag.kind === "placeholder") {
        if (drag.moved) {
          setPlaceholders((prev) => {
            const next = prev.map((item) =>
              item.id === drag.frameKey
                ? {
                    ...item,
                    x: (drag.ox ?? 0) + (e.clientX - drag.sx) / view.scale,
                    y: (drag.oy ?? 0) + (e.clientY - drag.sy) / view.scale,
                  }
                : item,
            );
            persistPlaceholders(next);
            return next;
          });
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
        if (drag.frameKey === "note") {
          addNote(dropPos.x, dropPos.y);
        } else if (drag.frameKey === "segment") {
          void addSegment(episodeId).then((segment) => {
            if (segment) {
              void saveCanvasLayout({
                assets: [], shots: [], scenes: [],
                segments: [{ id: segment.id, x: dropPos.x, y: dropPos.y }],
              });
              autoConnectNewNode(`segment:${segment.id}`, drag.wire);
            }
          });
        } else if (
          drag.frameKey === "character" ||
          drag.frameKey === "location" ||
          drag.frameKey === "prop"
        ) {
          // 「角色/场景/道具」：创建空白资料占位节点（不入库、不弹挑选
          // 面板），双击占位节点从详情窗加载实体；加载后原位变成实体节点。
          addEntityPh(drag.frameKey, dropPos.x, dropPos.y);
        } else {
          // 「素材」：创建空占位节点（不入库），双击占位节点才从库挑
          // 文件填充；填充后落位在占位节点处。
          addPlaceholder(dropPos.x, dropPos.y);
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
              const size = shotCardSize(card.shot);
              if (inBox(pos.cards[card.shot.id], size.w, size.h)) list.push(card.key);
            });
            layout.looses.forEach((loose) => {
              if (inBox(pos.loose[loose.asset.id], loose.w, loose.h)) list.push(loose.key);
            });
            // 资料节点（含组/剧本）、空白资料占位、片段、素材占位、成片：
            // 框选与点选同一套选中态（边缘点亮），删除也走同一套 Delete。
            infoNodes.forEach((node) => {
              if (inBox(infoNodePos(node.key), node.w, node.h)) list.push(node.key);
            });
            entityPhs.forEach((ph) => {
              if (inBox(infoNodePos(`eph:${ph.id}`), INFO_W, INFO_H)) list.push(`eph:${ph.id}`);
            });
            segments.forEach((segment) => {
              const size = sizeOfNode(`segment:${segment.id}`);
              if (inBox(segPos[segment.id], size?.w ?? SEG_W, size?.h ?? SEG_H)) list.push(`segment:${segment.id}`);
            });
            placeholders.forEach((ph) => {
              const size = sizeOfNode(`placeholder:${ph.id}`);
              if (inBox({ x: ph.x, y: ph.y }, size?.w ?? LOOSE_W, size?.h ?? MISSING_H)) list.push(`placeholder:${ph.id}`);
            });
            if (outputBox && inBox({ x: outputBox.x, y: outputBox.y }, outputBox.w, outputBox.h)) list.push("output");
          }
        }
        setSelection(list);
        drag.mq?.remove();
      } else if (drag.kind === "card" && drag.moved) {
        persistCards(pos.cards);
      } else if (drag.kind === "loose" && drag.moved) {
        persistLoose(pos.loose);
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
      vpRef.current?.classList.remove("pc-panning");
      vpRef.current?.classList.remove("pc-wiring");
      document
        .querySelectorAll<HTMLElement>(".pc-port-active")
        .forEach((el) => el.classList.remove("pc-port-active"));
      vpRef.current?.querySelectorAll<HTMLElement>(".pc-dragging").forEach((el) => el.classList.remove("pc-dragging"));
      if (drag.moved) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      dragRef.current = null;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [layout, pos, view, scenePos, infoPos, boxOf, portsOf, outPointOf, inPointOf, linkAssets, persistCards, persistLoose, saveCanvasLayout, saveInfoFramePos, saveView, setSelection, saveOutputPos, setEpisodeOutput, episodeId, notes, persistNotes, addNote, addPlaceholder, addEntityPh, persistPlaceholders, persistSegments, linkNode, nodeKeyParts, addSegment, autoConnectNewNode, persistSizes, persistInfoOffsets, infoGroups, infoNodes, infoNodePos, entityPhs, segments, segPos, placeholders, sizeOfNode, outputBox]);

  // ── 节点操作 ──
  // 节点接口圆点（ComfyUI 式）：输入口列在左缘（片段五口按列分布）、
  // 输出口在右缘实心类型色，hover 浮现接口名称；按下即拖出连线，从
  // 输入口反向拖也允许。
  const portEls = (key: string) => {
    const { ins, out } = portsOf(key);
    return (
      <>
        {ins.map((port, index) => (
          <span
            key={port.id}
            className="pc-port pc-port-in"
            data-port="in"
            data-port-id={port.id}
            data-label={port.label}
            style={{ top: `${portRatio(index, ins.length) * 100}%` }}
          />
        ))}
        {out && (
          <span
            className="pc-port pc-port-out"
            data-port="out"
            data-label={out.label}
            style={{ background: WIRE_TYPE_COLORS[out.type] ?? "#94a3b8" }}
          />
        )}
      </>
    );
  };

  // 工作流节点（片段/成片）的端口行：口点嵌在行首/行尾，接口名称常显
  // （ComfyUI 槽位文字的对应物），端口坐标由实测驱动连线锚点。
  const portRows = (key: string, dir: "in" | "out") => {
    const { ins, out } = portsOf(key);
  if (dir === "in") {
    return (
      <>
        {ins.map((port) => (
          <div key={port.id} className="pc-port-row">
            <span
              className="pc-port pc-port-in"
              data-port="in"
              data-port-id={port.id}
              style={{ borderColor: WIRE_TYPE_COLORS[port.accepts[0] ?? ""] ?? undefined }}
            />
            <span className="pc-port-name">{port.label}</span>
          </div>
        ))}
      </>
    );
  }
    return out ? (
      <div className="pc-port-row pc-port-row-out">
        <span className="pc-port-name">{out.label}</span>
        <span
          className="pc-port pc-port-out"
          data-port="out"
          style={{ background: WIRE_TYPE_COLORS[out.type] ?? "#94a3b8" }}
        />
      </div>
    ) : null;
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
          onDoubleClick={(event) => event.stopPropagation()}
        />
      ))}
    </>
  );
  // 资料节点 → 详情窗口（该类资源列表，当前/全部切换；剧本是单文件窗口）。
  // 双击节点与悬停工具条的「查看」按钮共用。
  const openInfoDetail = (node: { kind: string; key: string }) => {
    if (node.kind === "character") {
      setDetailFor({ kind: "info", group: "character", sourceKey: node.key, scope: "current" });
    } else if (node.kind === "location") {
      setDetailFor({ kind: "info", group: "location", sourceKey: node.key, scope: "current" });
    } else if (node.kind === "prop") {
      setDetailFor({ kind: "info", group: "prop", sourceKey: node.key, scope: "current" });
    } else {
      setDetailFor({ kind: "script" });
    }
  };

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
      await associateEntities(group.kind, [entityId]);
      const wired = groupWiredPorts(group);
      for (const w of wired) await linkNode(episodeId, group.kind, entityId, w.to_segment, w.to_port as ProjectNodeLink["to_port"]);
      persistInfoGroups(infoGroups.map((g) => (g.id === groupId ? { ...g, members: [...g.members, entityId] } : g)));
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
  // 剧本节点：解除挂接（剧本文件留在库内），提示词连线一并清理。
  const detachScript = useCallback(async () => {
    const episode = overview?.episode;
    if (!episodeId || !episode?.script_path) return;
    const rows = (overview?.node_links ?? []).filter((l) => l.from_kind === "script");
    for (const row of rows) await unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port);
    await updateEpisode(episodeId, { title: episode.title, status: episode.status, script_path: "" });
  }, [episodeId, overview, unlinkNode, updateEpisode]);
  // 空白资料占位：删除占位并清掉它拖动过的位置记忆。
  const removeEntityPh = useCallback(
    (phId: string) => {
      const next = { ...infoOffsets };
      delete next[`eph:${phId}`];
      persistInfoOffsets(next);
      persistEntityPhs(entityPhs.filter((item) => item.id !== phId));
    },
    [entityPhs, infoOffsets, persistEntityPhs, persistInfoOffsets],
  );
  // 素材占位节点：从画布移除占位记录。
  const removePlaceholder = useCallback(
    (phId: string) => {
      persistPlaceholders(placeholders.filter((item) => item.id !== phId));
    },
    [placeholders, persistPlaceholders],
  );
  // ── 键盘删除：Delete/Backspace 删除选中节点，与各节点工具条同一套
  // 语义（镜头卡有确认对话框，走同一确认流程；其余即时删除）。输入框
  // 聚焦或任一弹层打开时不响应，避免误删。 ──
  useEffect(() => {
    if (selKeys.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (
        detailFor || pickerFor || memberPick || addMenu || wireDraft ||
        scriptPickOpen || locationPickOpen || sceneForm || shotForm ||
        deleteSceneTarget || deleteShotTarget
      ) {
        return;
      }
      e.preventDefault();
      const shotKeys = selKeys.filter((k) => k.startsWith("shot:"));
      for (const key of selKeys) {
        if (key.startsWith("shot:")) continue;
        if (key === "output") {
          if (episodeId) void setEpisodeOutput(episodeId, null);
        } else if (key.startsWith("segment:")) {
          void removeSegment(key.slice(8));
        } else if (key.startsWith("placeholder:")) {
          removePlaceholder(key.slice(12));
        } else if (key.startsWith("eph:")) {
          removeEntityPh(key.slice(4));
        } else if (key.startsWith("grp:")) {
          removeGroup(key.slice(4));
        } else if (key === "script") {
          void detachScript();
        } else if (key.startsWith("asset:")) {
          void unlinkAsset(key.slice(6));
        } else if (key.startsWith("char:") || key.startsWith("loc:") || key.startsWith("prop:")) {
          const kind: EntityPhKind = key.startsWith("char:") ? "character" : key.startsWith("loc:") ? "location" : "prop";
          void removeInfoEntity(kind, key.slice(key.indexOf(":") + 1));
        }
      }
      if (shotKeys.length > 0) {
        const shot = scenes.flatMap((s) => s.shots).find((item) => item.id === shotKeys[0].slice(5));
        if (shot) setDeleteShotTarget(shot);
      }
      setSelection([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    selKeys, detailFor, pickerFor, memberPick, addMenu, wireDraft, scriptPickOpen, locationPickOpen,
    sceneForm, shotForm, deleteSceneTarget, deleteShotTarget, episodeId, scenes,
    setEpisodeOutput, removeSegment, removePlaceholder, removeEntityPh, removeGroup, detachScript,
    unlinkAsset, removeInfoEntity, setDeleteShotTarget, setSelection,
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
    if (pick.mode === "eph") {
      const ph = entityPhs.find((p) => p.id === pick.ephId);
      if (!ph || pending.length === 0) return;
      await associateEntities(pick.kind, pending);
      const groupId = groupIdOf();
      const pos = infoNodePos(`eph:${ph.id}`);
      const nextOffsets = { ...infoOffsets, [`grp:${groupId}`]: pos };
      delete nextOffsets[`eph:${ph.id}`];
      persistInfoOffsets(nextOffsets);
      persistEntityPhs(entityPhs.filter((p) => p.id !== ph.id));
      persistInfoGroups([...infoGroups, { id: groupId, kind: pick.kind, members: [...pending] }]);
      setPulseKeys([`grp:${groupId}`]);
      setDetailFor({ kind: "info", group: pick.kind, sourceKey: `grp:${groupId}`, scope: "current" });
      return;
    }
    if (pick.mode === "grp") {
      const group = infoGroups.find((g) => g.id === pick.groupId);
      if (!group) return;
      const additions = pending.filter((id) => !group.members.includes(id));
      const removals = group.members.filter((id) => !pending.includes(id));
      await associateEntities(pick.kind, additions);
      const wired = groupWiredPorts(group);
      for (const id of additions) {
        for (const w of wired) await linkNode(episodeId, pick.kind, id, w.to_segment, w.to_port as ProjectNodeLink["to_port"]);
      }
      for (const id of removals) await unlinkEntityLinks(pick.kind, id);
      persistInfoGroups(infoGroups.map((g) => (g.id === group.id ? { ...g, members: [...pending] } : g)));
      return;
    }
    // convert：默认单实体节点继续装入 → 升级为组节点（原位；primary 已有
    // 连线随归属解析自动归到组名下，新成员自动接入同样片段口）。
    const srcId = pick.sourceKey.slice((pick.kind === "character" ? "char:" : pick.kind === "location" ? "loc:" : "prop:").length);
    if (pending.length <= 1 || !pending.includes(srcId)) return;
    await associateEntities(pick.kind, pending);
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
    setDetailFor({ kind: "info", group: pick.kind, sourceKey: `grp:${groupId}`, scope: "current" });
  }, [
    memberPick, episodeId, entityPhs, infoNodePos, infoOffsets, persistInfoOffsets, persistEntityPhs,
    infoGroups, persistInfoGroups, associateEntities, groupWiredPorts, linkNode, overview,
    unlinkEntityLinks,
  ]);

  const detailDialog = (() => {
    if (!detailFor || !overview) return null;
    const fileHint = (relative: string) => joinLibraryPath(libraryRoot, relative);
    const assetPreview = (asset: ProjectAsset): React.ReactNode => {
      if (asset.missing) {
        return <div className="pc-detail-preview-empty">{Icons.image}{t("project.asset.fileMissing")}</div>;
      }
      const path = fileHint(asset.file_path);
      if (asset.kind === "image") {
        return <ResourceFileImage path={path} alt={asset.name} version={asset.updated_at} className="pc-detail-img" />;
      }
      if (asset.kind === "video") {
        return (
          <div className="pc-detail-video">
            <ResourceVideoPoster path={path} version={asset.updated_at} fallbackLabel={asset.name || asset.file_path} />
            <span className="pc-detail-video-hint">{Icons.play}{t("project.canvas.view")}</span>
          </div>
        );
      }
      if (asset.kind === "text") {
        return <TextPaperBody path={path} name={asset.name || asset.file_path} lines={12} />;
      }
      return <div className="pc-detail-preview-empty">{Icons.file}<span>{asset.name || asset.file_path}</span></div>;
    };
    // 某类资源（character/location/prop/asset）已连到哪些片段（#序号）。
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

    if (detailFor.kind === "placeholder") {
      const ph = placeholders.find((item) => item.id === detailFor.id);
      if (!ph) return null;
      const startFill = (file: { filePath: string; kind: string; name: string }) => fillPlaceholderFromLibrary(ph.id, file);
      return (
        <ProjectNodeDetailDialog
          title={t("project.canvas.placeholderTitle")}
          accent="#94a3b8"
          error={detailError}
          entries={[{
            key: `placeholder:${ph.id}`,
            title: t("project.canvas.placeholderTitle"),
            badge: t("project.canvas.typeAsset"),
            preview: (
              <button type="button" className="pc-detail-drop" onClick={() => void uploadViaImport(startFill)}>
                {Icons.image}
                {t("project.canvas.detailEmptyDrop")}
              </button>
            ),
            info: [{ label: t("project.canvas.detailStatus"), value: t("project.canvas.placeholderEmpty") }],
            actions: (
              <>
                <button type="button" className="pc-detail-btn primary" onClick={() => void uploadViaImport(startFill)}>
                  {Icons.add}{t("project.canvas.detailUpload")}
                </button>
                <button type="button" className="pc-detail-btn" onClick={() => setPickerFor(`placeholder:${ph.id}`)}>
                  {Icons.resources}{t("project.canvas.detailPickLibrary")}
                </button>
              </>
            ),
          }]}
          onClose={closeDetail}
        />
      );
    }
    if (detailFor.kind === "asset") {
      const asset = looseAssets.find((item) => item.id === detailFor.id)
        ?? allAssetsOf(scenes, looseAssets).find((item) => item.id === detailFor.id);
      if (!asset) return null;
      return (
        <ProjectNodeDetailDialog
          title={asset.name || asset.file_path}
          accent={NODE_ACCENTS[asset.kind] ?? "#94a3b8"}
          error={detailError}
          entries={[{
            key: `asset:${asset.id}`,
            title: asset.name || asset.file_path,
            badge: t(assetKindBadgeKey(asset.kind)),
            preview: assetPreview(asset),
            info: [
              { label: t("project.canvas.detailPath"), value: asset.file_path },
              { label: t("project.canvas.detailKind"), value: t(assetKindBadgeKey(asset.kind)) },
              { label: t("project.canvas.detailLinks"), value: linkedSegmentLabel("asset", asset.id) },
            ],
            actions: (
              <button type="button" className="pc-detail-btn" onClick={() => handleLocate(asset)}>
                {Icons.externalLink}{t("project.canvas.openFile")}
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
    // script：单文件窗口（文本预览 + 路径 + 打开）。
    const scriptPath = overview.episode.script_path;
    if (!scriptPath) return null;
    const scriptName = scriptFileLabelOf(scriptPath);
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
              {/* 重新挂接：换库内其他文件做本集剧本（窗口保持打开，
                  重选后条目就地刷新；节点留在原位）。 */}
              <button
                type="button"
                className="pc-detail-btn"
                onClick={() => setScriptPickOpen(true)}
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
        onMouseDown={onViewportMouseDown}
        onClickCapture={(e) => {
          if (!suppressClickRef.current) return;
          e.stopPropagation();
          e.preventDefault();
          suppressClickRef.current = false;
        }}
        onDoubleClick={(e) => {
          const thumb = e.target instanceof Element ? e.target.closest(".pc-shot-asset-thumb") : null;
          if (thumb) {
            const assetId = thumb.getAttribute("data-asset") ?? "";
            const node = layout.cards
              .flatMap((c) => c.assets)
              .find((a) => a.asset.id === assetId);
            if (node) onOpenAsset(node.asset);
            return;
          }
          // 双击空白（非节点/标签牌/浮层）：弹出节点选择框（ComfyUI 式）。
          const target = e.target instanceof Element ? e.target : null;
          if (target?.closest(".pc-node, .pc-frame-label, .pc-glass, .pc-checkbar, .pc-note, textarea, input, button")) return;
          const rect = vpRef.current?.getBoundingClientRect();
          if (!rect) return;
          setAddMenu({
            sx: e.clientX - rect.left,
            sy: e.clientY - rect.top,
            wx: (e.clientX - rect.left - view.x) / view.scale,
            wy: (e.clientY - rect.top - view.y) / view.scale,
          });
          setAddMenuQuery("");
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
              const midX = (a.x + b.x) / 2;
              const midY = (a.y + b.y) / 2;
              const color = WIRE_TYPE_COLORS[wire.type] ?? "#94a3b8";
              return (
                <g key={`${wire.fromKey}->${wire.toKey}`} className="pc-wire">
                  <path className="pc-wire-hit" d={d} />
                  <path className="pc-wire-line" d={d} style={{ stroke: color }} />
                  {wire.kind === "manual" && (
                    <g
                      className="pc-wire-del"
                      data-tooltip={t("project.canvas.wireRemove")}
                      onClick={() => void unlinkAssets(wire.fromKey, wire.toKey)}
                    >
                      <circle cx={midX} cy={midY} r="9" />
                      <path d={`M${midX - 4} ${midY - 4} l8 8 M${midX + 4} ${midY - 4} l-8 8`} />
                    </g>
                  )}
                </g>
              );
            })}
            {/* 片段输入口连线（角色/场景/道具/剧本/素材/片段 → 片段口）。
                组节点的多条成员连线按承载节点去重成一条，删线全断。 */}
            {segWires.map((wire) => {
              const link = wire.links[0];
              const a = outPointOf(wire.fromKey);
              const b = inPointOf(`segment:${link.to_segment}`, link.to_port);
              if (!a || !b) return null;
              const d = wirePathD(a, b);
              const midX = (a.x + b.x) / 2;
              const midY = (a.y + b.y) / 2;
              // 线色随来源数据类型（角色/场景/道具图绿、剧本橙、片段紫）。
              const fromType = portsOf(wire.fromKey).out?.type;
              return (
                <g key={wire.key} className="pc-wire">
                  <path className="pc-wire-hit" d={d} />
                  <path
                    className="pc-wire-line"
                    d={d}
                    style={{ stroke: WIRE_TYPE_COLORS[fromType ?? ""] ?? WIRE_TYPE_COLORS.video, strokeOpacity: 0.55 }}
                  />
                  <g
                    className="pc-wire-del"
                    data-tooltip={t("project.canvas.wireRemove")}
                    onClick={() => {
                      wire.links.forEach((l) => {
                        void unlinkNode(l.from_kind, l.from_id, l.to_segment, l.to_port);
                      });
                    }}
                  >
                    <circle cx={midX} cy={midY} r="9" />
                    <path d={`M${midX - 4} ${midY - 4} l8 8 M${midX + 4} ${midY - 4} l-8 8`} />
                  </g>
                </g>
              );
            })}
            {/* 片段 → 成片：按拼接序隐式聚合（无需连线数据，恒显示） */}
            {outputBox &&
              segments.map((segment) => {
                const a = outPointOf(`segment:${segment.id}`);
                if (!a) return null;
                const b = { x: outputBox.x, y: outputBox.y + outputBox.h / 2 };
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
              if (!a) return null;
              const b = { x: outputBox.x, y: outputBox.y + outputBox.h / 2 };
              const d = wirePathD(a, b);
              const midX = (a.x + b.x) / 2;
              const midY = (a.y + b.y) / 2;
              return (
                <g className="pc-wire">
                  <path className="pc-wire-hit" d={d} />
                  <path
                    className="pc-wire-line"
                    d={d}
                    style={{ stroke: WIRE_TYPE_COLORS.video }}
                  />
                  <g
                    className="pc-wire-del"
                    data-tooltip={t("project.canvas.wireRemove")}
                    onClick={() => void setEpisodeOutput(episodeId, null)}
                  >
                    <circle cx={midX} cy={midY} r="9" />
                    <path d={`M${midX - 4} ${midY - 4} l8 8 M${midX + 4} ${midY - 4} l-8 8`} />
                  </g>
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
            return (
              <div
                key={card.key}
                data-key={card.key}
                data-frame={card.sceneId}
                className={`pc-node pc-shotcard${selected ? " pc-selected" : ""}`}
                style={{ left: p.x, top: p.y, width: card.w, ["--node-accent" as string]: NODE_ACCENTS.shot } as React.CSSProperties}
                onDoubleClick={(event) => {
                  // 双击镜头卡 → 挂靠素材挑选面板（镜头没有详情窗，挑选面板
                  // 就是它的挂靠窗口）。选择框只认双击：单击与拖卡松手都不弹；
                  // 缩略图/工具条/缩放角标上的双击不抢（缩略图双击由视口层
                  // 打开素材查看器）。
                  const target = event.target instanceof Element ? event.target : null;
                  if (target?.closest(".pc-shot-asset-thumb, .pc-node-tools, .pc-resize")) return;
                  event.stopPropagation();
                  onPickForShot(shot.id);
                }}
              >
                <div className="pc-shot-head">
                  <span className="pc-shot-no">{shotNoOf(card.sceneId, card.shot.id)}</span>
                  <b className="pc-shot-desc">{shot.description || t("project.shot.untitled")}</b>
                  {shot.dialogue && <i className="pc-shot-dialogue">{shot.dialogue}</i>}
                </div>
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
                            style={{ width: w, height: h }}
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
                    onClick={() => setDeleteShotTarget(shot)}
                  >
                    {Icons.delete}
                  </button>
                </span>
                {portEls(card.key)}
              </div>
            );
          })}

          {/* 集级散件节点 */}
          {layout.looses.map((loose) => {
            const p = pos.loose[loose.asset.id] ?? { x: 0, y: 0 };
            const selected = selKeys.includes(loose.key);
            const asset = loose.asset;
            const size = sizeOfNode(loose.key);
            const nodeW = size?.w ?? loose.w;
            const nodeH = size?.h ?? loose.h;
            const mediaPath = joinLibraryPath(libraryRoot, asset.file_path);
            return (
              <div
                key={loose.key}
                data-key={loose.key}
                className={`pc-node${selected ? " pc-selected" : ""}`}
                style={{ left: p.x, top: p.y, width: nodeW, ["--node-accent" as string]: NODE_ACCENTS[asset.kind] ?? "#94a3b8" } as React.CSSProperties}
                onDoubleClick={(event) => {
                  // 双击散件节点 → 详情预览窗口（丢失文件走「重新挂靠」工具）。
                  if (asset.missing) return;
                  event.stopPropagation();
                  setDetailFor({ kind: "asset", id: asset.id });
                }}
              >
                <div className="pc-node-head">
                  <span className="pc-node-kind">{t(assetKindBadgeKey(asset.kind))}</span>
                  <b className="pc-node-title">{asset.name || asset.file_path}</b>
                </div>
                {asset.missing ? (
                    <div className="pc-miss-card" style={{ height: nodeH }}>
                      {Icons.image}
                      {t("project.asset.fileMissing")}
                    </div>
                  ) : asset.kind === "image" ? (
                    <div className="pc-media" style={{ height: nodeH }}>
                      <ResourceFileImage
                        path={mediaPath}
                        alt={asset.name}
                        version={asset.updated_at}
                        className="pc-media-img"
                      />
                    </div>
                  ) : asset.kind === "video" ? (
                    <div className="pc-media" style={{ height: nodeH }}>
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
                    <div className="pc-media pc-media-file" style={{ height: nodeH }}>
                      {Icons.file}
                      <span>{asset.name || asset.file_path}</span>
                    </div>
                  )}
                <span className="pc-node-tools">
                  <button type="button" data-tooltip={t("project.canvas.view")} onClick={() => onOpenAsset(asset)}>
                    {Icons.expand}
                  </button>
                  <button type="button" data-tooltip={t("project.canvas.openFile")} onClick={() => handleLocate(asset)}>
                    {Icons.externalLink}
                  </button>
                  {asset.missing && (
                    <button type="button" data-tooltip={t("project.sheet.relink")} onClick={() => onRelinkAsset(asset)}>
                      {Icons.swap}
                    </button>
                  )}
                  <button
                    type="button"
                    data-tooltip={t("project.canvas.remove")}
                    className="danger"
                    onClick={() => void unlinkAsset(asset.id)}
                  >
                    {Icons.delete}
                  </button>
                </span>
                {resizeHandle}
                {portEls(loose.key)}
              </div>
            );
          })}

          {/* 资料框（出场角色/出镜道具/剧本）：只在本集有资料节点时出现——
              空集时的空框没有信息量，只是画布上的占位噪音；创建资料走
              双击空白的添加菜单。 */}
          {infoNodes.length > 0 && (
            <div
              data-frame="info"
              className="pc-frame"
              style={{
                left: infoPos.frame.x,
                top: infoPos.frame.y,
                width: Math.max(FRAME_MIN_W, FRAME_PAD_X * 2 + 3 * (INFO_W + CARD_GAP) - CARD_GAP),
                height: Math.max(FRAME_MIN_H, FRAME_PAD_TOP + Math.ceil(infoNodes.length / 3) * (INFO_H + CARD_GAP) + 12),
              }}
            >
              <div className="pc-frame-label">
                <span className="pc-frame-name">{t("project.canvas.infoFrame")}</span>
                <small>{infoNodes.length}</small>
                <span className="pc-frame-ops">
                  <button
                    type="button"
                    data-tooltip={t("project.canvas.linkScene")}
                    onClick={(event) => {
                      // 关联的新场景节点出生在点击位置附近。
                      armSpawnFromEvent(event.clientX, event.clientY);
                      setLocationPickOpen(true);
                    }}
                  >
                    {Icons.add}
                  </button>
                </span>
              </div>
            </div>
          )}
          {infoNodes.map((node) => {
            const p = infoNodePos(node.key);
            return (
              <div
                key={node.key}
                data-key={node.key}
                className={`pc-node pc-info${pulseKeys.includes(node.key) ? " pc-spawn" : ""}${selKeys.includes(node.key) ? " pc-selected" : ""}`}
                style={{ left: p.x, top: p.y, width: node.w, ["--node-accent" as string]: NODE_ACCENTS[node.kind] ?? "#94a3b8" } as React.CSSProperties}
                onDoubleClick={(event) => {
                  // 双击资料节点 → 详情窗口（与工具条「查看」同语义）。
                  event.stopPropagation();
                  openInfoDetail(node);
                }}
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
                    <div className="pc-info-script">
                      <TextPaperBody path={joinLibraryPath(libraryRoot, node.textPath)} name={node.name} lines={5} />
                    </div>
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
                      else if (node.kind === "script") void detachScript();
                      else void removeInfoEntity(node.kind as EntityPhKind, node.key.slice(node.key.indexOf(":") + 1));
                    }}
                  >
                    {Icons.delete}
                  </button>
                </span>
                {portEls(node.key)}
              </div>
            );
          })}

          {/* 空白资料占位节点：菜单创建（角色/场景/道具），双击从详情窗
              加载实体，加载后原位变成实体节点 */}
          {entityPhs.map((ph) => {
            const key = `eph:${ph.id}`;
            const p = infoNodePos(key);
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
                className={`pc-node pc-info pc-eph${selKeys.includes(key) ? " pc-selected" : ""}`}
                style={{ left: p.x, top: p.y, width: INFO_W, ["--node-accent" as string]: NODE_ACCENTS[ph.kind] ?? "#94a3b8" } as React.CSSProperties}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  setDetailFor({ kind: "entityPh", id: ph.id });
                }}
              >
                <div className="pc-node-head">
                  <span className="pc-node-kind">{label}</span>
                  <b className="pc-node-title">{t("project.canvas.ephTitle")}</b>
                </div>
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
              </div>
            );
          })}

          {/* 片段节点：AI 分段生成的视频分段，按拼接序汇入本集成片 */}
          {segments.map((segment, index) => {
            const p = segPos[segment.id];
            if (!p) return null;
            const key = `segment:${segment.id}`;
            const segSize = sizeOfNode(key);
            return (
              <div
                key={segment.id}
                data-key={key}
                className={`pc-node pc-segment${selKeys.includes(key) ? " pc-selected" : ""}`}
                style={{
                  left: p.x, top: p.y, width: segSize?.w ?? SEG_W,
                  // 存量高度语义是节点总高：用 minHeight 兜底，缩小不裁切内容。
                  minHeight: segSize && segSize.h !== SEG_H ? segSize.h : undefined,
                  ["--node-accent" as string]: NODE_ACCENTS.segment,
                } as React.CSSProperties}
                onDoubleClick={(event) => {
                  // 双击片段节点 → 详情窗口：角色区（当前角色/全部角色切换）
                  // + 底部视频挂接区（上传 / 从库选择）。
                  event.stopPropagation();
                  setDetailFor({ kind: "segment", id: segment.id, scopes: { chars: "current", locs: "current", props: "current" } });
                }}
              >
                <div className="pc-node-head">
                  <span className="pc-node-kind">{t("project.canvas.segName")}</span>
                  <b className="pc-node-title">{segment.note || `#${index + 1}`}</b>
                </div>
                <div className="pc-seg-ports">{portRows(key, "in")}</div>
                {segment.asset ? (
                    <button
                      type="button"
                      className={`pc-seg-thumb${segment.asset.missing ? " is-missing" : ""}`}
                      title={segment.asset.missing ? t("project.asset.fileMissing") : segment.asset.name}
                      onClick={() => onOpenAsset(segment.asset as ProjectAsset)}
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
                <div className="pc-seg-out">{portRows(key, "out")}</div>
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
              className={`pc-node pc-outnode${selKeys.includes("output") ? " pc-selected" : ""}`}
              style={{ left: outputBox.x, top: outputBox.y, width: outputBox.w, ["--node-accent" as string]: NODE_ACCENTS.output } as React.CSSProperties}
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
              <div className="pc-seg-ports">{portRows("output", "in")}</div>
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
            </div>
          )}

          {/* 便签节点：双击编辑、拖动挪位、按集记 localStorage */}
          {notes.map((note) => (
            <div key={note.id} data-note={note.id} className="pc-note" style={{ left: note.x, top: note.y }}>
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
                  onMouseDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                />
              ) : (
                <div
                  className="pc-note-body"
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    setEditingNoteId(note.id);
                    setNoteDraft(note.text);
                  }}
                >
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
            </div>
          ))}

          {/* 占位素材节点：「素材」菜单创建的空节点，双击打开详情填充窗口 */}
          {placeholders.map((ph) => {
            const phKey = `placeholder:${ph.id}`;
            const phSize = sizeOfNode(phKey);
            return (
              <div
                key={ph.id}
                data-key={phKey}
                className="pc-node pc-placeholder"
                style={{ left: ph.x, top: ph.y, width: phSize?.w ?? LOOSE_W, ["--node-accent" as string]: "#94a3b8" } as React.CSSProperties}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  setDetailFor({ kind: "placeholder", id: ph.id });
                }}
              >
                <div className="pc-node-head">
                  <span className="pc-node-kind">{t("project.canvas.typeAsset")}</span>
                  <b className="pc-node-title">{t("project.canvas.placeholderTitle")}</b>
                </div>
                <div className="pc-ph-empty" style={{ height: phSize?.h }}>
                  {Icons.image}
                  {t("project.canvas.placeholderEmpty")}
                </div>
                <span className="pc-node-tools">
                  <button
                    type="button"
                    data-tooltip={t("common.delete")}
                    className="danger"
                    onClick={() => removePlaceholder(ph.id)}
                  >
                    {Icons.delete}
                  </button>
                </span>
                {resizeHandle}
              </div>
            );
          })}
        </div>

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
                    // 挂接后剧本节点出生在点击位置附近。
                    armSpawnFromEvent(event.clientX, event.clientY);
                    setScriptPickOpen(true);
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
            onMouseDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <input
              className="pc-addmenu-search"
              placeholder={t("project.canvas.addNodeSearch")}
              value={addMenuQuery}
              onChange={(event) => setAddMenuQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setAddMenu(null);
              }}
              autoFocus
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
                hint: overview?.episode.script_path
                  ? t("project.canvas.typeEpisodeLocatedHint")
                  : t("project.canvas.typeEpisodeHint"),
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
                key: "script",
                label: t("project.canvas.typePrompt"),
                hint: t("project.canvas.typePromptHint"),
                icon: Icons.file,
                panel: "",
              },
              {
                key: "asset",
                label: t("project.canvas.typeAsset"),
                hint: t("project.canvas.typeAssetHint"),
                icon: Icons.image,
                panel: "",
              },
            ]
              .filter((item) => item.label.toLowerCase().includes(addMenuQuery.trim().toLowerCase()))
              .map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="pc-addmenu-item"
                  // 剧本项：已挂接则定位到剧本纸片，未挂接则从库选文件挂
                  // 到本集；其余项（片段/角色/场景/道具/便签/提示词/素材）
                  // 支持点击与按住拖到画布松手两种落位（ComfyUI 搜索框惯
                  // 例），资料类先落空白节点、绝不先弹挑选面板；从「拖线
                  // 到空白」进入时创建的节点自动接上那条线（资料占位无
                  // 端口，待加载实体后再连线）。
                  {...(item.panel === "script"
                    ? {
                        onClick: () => {
                          setAddMenu(null);
                          setAddMenuQuery("");
                          if (overview?.episode.script_path) {
                            locateScript();
                          } else {
                            // 挂接后剧本节点出生在双击位置（视线附近）。
                            armSpawnAt(addMenu.wx, addMenu.wy);
                            setScriptPickOpen(true);
                          }
                        },
                      }
                    : {
                          onMouseDown: (event: React.MouseEvent) => {
                            if (event.button !== 0) return;
                            event.stopPropagation();
                            event.preventDefault();
                            dragRef.current = {
                              kind: "addnode", sx: event.clientX, sy: event.clientY, moved: false,
                              fox: addMenu.wx, foy: addMenu.wy, frameKey: item.key,
                              wire: addMenu.wire,
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
            onMouseDown={(e) => {
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
      {/* 节点详情预览窗口：双击节点的独立窗口（预览 + 信息 + 上传/库选） */}
      {detailDialog}
      {/* 详情窗口内的「从资源库选择」二级选择器（占位填充 / 片段挂产出） */}
      {pickerFor?.startsWith("placeholder:") && (
        <ProjectFilePickerDialog
          title={t("project.canvas.fillAsset")}
          takenPaths={new Set()}
          takenLabel=""
          onClose={() => setPickerFor(null)}
          onPick={(file) => fillPlaceholderFromLibrary(pickerFor.slice(12), file)}
        />
      )}
      {pickerFor?.startsWith("segment:") && (
        <ProjectFilePickerDialog
          title={t("project.canvas.segAttach")}
          takenPaths={new Set()}
          takenLabel=""
          onClose={() => setPickerFor(null)}
          onPick={(file) => attachSegmentFromLibrary(pickerFor.slice(8), file)}
        />
      )}
      {/* 挂剧本：从资源库选文件设为本集剧本，挂接即自动连全部片段提示词口 */}
      {scriptPickOpen && (
        <ProjectFilePickerDialog
          title={t("project.canvas.linkScript")}
          takenPaths={new Set()}
          takenLabel=""
          onClose={() => setScriptPickOpen(false)}
          onPick={(file) => handleScriptPick(file.filePath)}
        />
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

function scriptFileLabelOf(path: string): string {
  const trimmed = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return trimmed;
}
