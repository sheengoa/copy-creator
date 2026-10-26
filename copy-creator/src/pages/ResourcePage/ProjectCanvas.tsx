import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
      w: asset.missing ? MISSING_W : LOOSE_W,
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
  // 挂产出：正在为哪个片段选择视频文件；资料关联面板开关。
  const [segmentAssetPickFor, setSegmentAssetPickFor] = useState<string | null>(null);
  const [locationPickOpen, setLocationPickOpen] = useState(false);
  const [castPickOpen, setCastPickOpen] = useState(false);
  const [propPickOpen, setPropPickOpen] = useState(false);
  // 挂剧本：选择库内文件设为本集 script_path；已有剧本时「剧本」菜单项
  // 与缺项提醒改为定位。
  const [scriptPickOpen, setScriptPickOpen] = useState(false);

  // ── 占位素材节点（双击填充后才入库为集级散件）：按集存 localStorage ──
  const [placeholders, setPlaceholders] = useState<CanvasPlaceholder[]>([]);
  const [placeholderFillFor, setPlaceholderFillFor] = useState<string | null>(null);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`project_canvas_placeholders_${episodeId}`);
      setPlaceholders(raw ? (JSON.parse(raw) as CanvasPlaceholder[]) : []);
    } catch {
      setPlaceholders([]);
    }
    setPlaceholderFillFor(null);
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

  // ── 布局与位置（state 驱动渲染） ──
  const layout = useMemo(() => {
    const base = buildLayout(scenes, looseAssets);
    return base;
  }, [scenes, looseAssets]);

  // 资料节点（出场角色/出场场景/出镜道具/剧本）：资料框内网格自动排。
  const infoNodes = useMemo(() => {
    const list: CanvasInfo[] = [];
    castCharacters.forEach((character) => {
      list.push({
        key: `char:${character.id}`, kind: "character", name: character.name,
        avatarPath: character.avatar_path, textPath: "", w: INFO_W, h: INFO_H,
      });
    });
    episodeLocations.forEach((location) => {
      list.push({
        key: `loc:${location.id}`, kind: "location", name: location.name,
        avatarPath: location.ref_path, textPath: "", w: INFO_W, h: INFO_H,
      });
    });
    episodeProps.forEach((prop) => {
      list.push({ key: `prop:${prop.id}`, kind: "prop", name: prop.name, avatarPath: "", textPath: "", w: INFO_W, h: INFO_H });
    });
    if (overview?.episode.script_path) {
      list.push({
        key: "script", kind: "script", name: scriptFileLabelOf(overview.episode.script_path),
        avatarPath: "", textPath: overview.episode.script_path, w: SCRIPT_W, h: INFO_H + 40,
      });
    }
    return list;
  }, [castCharacters, episodeLocations, episodeProps, overview]);

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

  // 剧本节点定位（视口居中到资料框剧本纸片）。
  const locateScript = useCallback(() => {
    const el = vpRef.current;
    const p = infoPos.map.script;
    if (!el || !p) return;
    const next = {
      x: el.clientWidth / 2 - (p.x + SCRIPT_W / 2) * view.scale,
      y: el.clientHeight / 2 - (p.y + (INFO_H + 40) / 2) * view.scale,
      scale: view.scale,
    };
    setView(next);
    saveView(next);
  }, [infoPos, view.scale, setView, saveView]);

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
    const infoBottom = infoPos.frame.y + FRAME_PAD_TOP + Math.ceil(infoNodes.length / 3) * (INFO_H + CARD_GAP);
    // 片段列与成片节点挂在主世界右侧，也要进适配包围盒。
    const segBottom = 110 + segments.length * 260 + 60;
    const outputRight = outputBox ? outputBox.x + outputBox.w + 60 : 0;
    const worldW = Math.max(layout.worldW, infoPos.frame.x + FRAME_MIN_W + 60, outputRight);
    const worldH = Math.max(layout.worldH, infoBottom + 60, segBottom);
    const scale = Math.min(el.clientWidth / worldW, el.clientHeight / worldH, 1);
    const next = {
      x: Math.max(12, (el.clientWidth - worldW * scale) / 2),
      y: Math.max(8, (el.clientHeight - worldH * scale) / 2),
      scale,
    };
    setView(next);
    saveView(next);
  }, [layout, infoPos, infoNodes, saveView, outputBox, segments.length]);

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
        return loose && p ? finish(p.x, p.y, loose.w, loose.h) : null;
      }
      if (key.startsWith("segment:")) {
        const p = segPos[key.slice(8)];
        return p ? finish(p.x, p.y, SEG_W, SEG_H) : null;
      }
      if (key === "output") {
        return outputBox ? finish(outputBox.x, outputBox.y, OUTPUT_W, OUTPUT_H) : null;
      }
      // 资料节点（角色/场景/道具/剧本）按资料框网格位置。
      const infoNode = infoNodes.find((item) => item.key === key);
      const infoP = infoNode ? infoPos.map[key] : undefined;
      return infoNode && infoP ? finish(infoP.x, infoP.y, infoNode.w, infoNode.h) : null;
    },
    [layout, pos, cardSizeOf, outputBox, segPos, infoNodes, infoPos, nodeMetrics],
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
      if (key.startsWith("char:") || key.startsWith("loc:") || key.startsWith("prop:")) {
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
    kind: "pan" | "marquee" | "card" | "loose" | "group" | "infoframe" | "wire" | "outnode" | "note" | "addnode" | "segment" | "placeholder";
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
            nodeEl.classList.add("pc-dragging");
            dragRef.current = {
              kind: "placeholder", sx: e.clientX, sy: e.clientY, moved: false,
              ox: ph.x, oy: ph.y, frameKey: phId,
            };
            e.preventDefault();
            return;
          }
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
    [layout, pos, setSelection, view, infoPos, scenePos, portsOf, outputBox, notes, segPos, placeholders],
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
                ["asset:", "shot:", "char:", "loc:", "prop:", "segment:"].some((p) => outKeyOf.startsWith(p)))));
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
            const source = nodeKeyParts(outKey);
            const port = drag.fromDir === "in" ? drag.fromPortId : drag.targetPort;
            if (source && port) {
              void linkNode(
                episodeId,
                source.kind,
                source.id,
                inKey.slice(8),
                port as ProjectNodeLink["to_port"],
              );
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
  }, [layout, pos, view, scenePos, infoPos, boxOf, portsOf, outPointOf, inPointOf, linkAssets, persistCards, persistLoose, saveCanvasLayout, saveInfoFramePos, saveView, setSelection, saveOutputPos, setEpisodeOutput, episodeId, notes, persistNotes, addNote, addPlaceholder, persistPlaceholders, persistSegments, linkNode, nodeKeyParts, addSegment, autoConnectNewNode]);

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
                  <path
                    className={`pc-wire-line${wire.kind === "manual" ? " manual" : ""}`}
                    d={d}
                    style={{ stroke: color }}
                  />
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
            {/* 片段输入口连线（角色/场景/道具/剧本/素材/片段 → 片段口） */}
            {nodeLinks.map((link) => {
              const fromKey =
                link.from_kind === "script"
                  ? "script"
                  : link.from_kind === "character"
                    ? `char:${link.from_id}`
                    : link.from_kind === "location"
                      ? `loc:${link.from_id}`
                      : link.from_kind === "prop"
                        ? `prop:${link.from_id}`
                        : link.from_kind === "segment"
                          ? `segment:${link.from_id}`
                          : link.from_kind === "shot"
                            ? `shot:${link.from_id}`
                            : `asset:${link.from_id}`;
              const a = outPointOf(fromKey);
              const b = inPointOf(`segment:${link.to_segment}`, link.to_port);
              if (!a || !b) return null;
              const d = wirePathD(a, b);
              const midX = (a.x + b.x) / 2;
              const midY = (a.y + b.y) / 2;
              // 线色随来源数据类型（角色/场景/道具图绿、剧本橙、片段紫）。
              const fromType = portsOf(fromKey).out?.type;
              return (
                <g key={link.id} className="pc-wire">
                  <path className="pc-wire-hit" d={d} />
                  <path
                    className="pc-wire-line"
                    d={d}
                    style={{ stroke: WIRE_TYPE_COLORS[fromType ?? ""] ?? WIRE_TYPE_COLORS.video, strokeOpacity: 0.55 }}
                  />
                  <g
                    className="pc-wire-del"
                    data-tooltip={t("project.canvas.wireRemove")}
                    onClick={() =>
                      void unlinkNode(link.from_kind, link.from_id, link.to_segment, link.to_port)
                    }
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
                    <button
                      type="button"
                      className="pc-shot-empty"
                      onClick={() => onPickForShot(shot.id)}
                    >
                      {Icons.link}
                      {t("project.canvas.shotEmpty")}
                    </button>
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
            const mediaPath = joinLibraryPath(libraryRoot, asset.file_path);
            return (
              <div
                key={loose.key}
                data-key={loose.key}
                className={`pc-node${selected ? " pc-selected" : ""}`}
                style={{ left: p.x, top: p.y, width: loose.w, ["--node-accent" as string]: NODE_ACCENTS[asset.kind] ?? "#94a3b8" } as React.CSSProperties}
              >
                <div className="pc-node-head">
                  <span className="pc-node-kind">{t(assetKindBadgeKey(asset.kind))}</span>
                  <b className="pc-node-title">{asset.name || asset.file_path}</b>
                </div>
                {asset.missing ? (
                    <div className="pc-miss-card" style={{ height: loose.h }}>
                      {Icons.image}
                      {t("project.asset.fileMissing")}
                    </div>
                  ) : asset.kind === "image" ? (
                    <div className="pc-media" style={{ height: loose.h }}>
                      <ResourceFileImage
                        path={mediaPath}
                        alt={asset.name}
                        version={asset.updated_at}
                        className="pc-media-img"
                      />
                    </div>
                  ) : asset.kind === "video" ? (
                    <div className="pc-media" style={{ height: loose.h }}>
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
                    <div className="pc-media pc-media-file" style={{ height: loose.h }}>
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
                    {Icons.close}
                  </button>
                </span>
                {portEls(loose.key)}
              </div>
            );
          })}

          {/* 资料框（出场角色/出镜道具/剧本） */}
          {(
            <div
              data-frame="info"
              className="pc-frame"
              style={{
                left: infoPos.frame.x,
                top: infoPos.frame.y,
                width: Math.max(FRAME_MIN_W, FRAME_PAD_X * 2 + 3 * (INFO_W + CARD_GAP) - CARD_GAP),
                height: Math.max(FRAME_MIN_H, FRAME_PAD_TOP + Math.ceil(Math.max(infoNodes.length, 1) / 3) * (INFO_H + CARD_GAP) + 12),
              }}
            >
              <div className="pc-frame-label">
                <span className="pc-frame-name">{t("project.canvas.infoFrame")}</span>
                <small>{infoNodes.length}</small>
                <span className="pc-frame-ops">
                  <button
                    type="button"
                    data-tooltip={t("project.canvas.linkScene")}
                    onClick={() => setLocationPickOpen(true)}
                  >
                    {Icons.add}
                  </button>
                  {infoNodes.length === 0 && (
                    <small style={{ padding: "0 4px" }}>{t("project.canvas.infoEmpty")}</small>
                  )}
                </span>
              </div>
            </div>
          )}
          {infoNodes.map((node) => {
            const p = infoPos.map[node.key];
            return (
              <div
                key={node.key}
                data-key={node.key}
                className="pc-node pc-info"
                style={{ left: p.x, top: p.y, width: node.w, ["--node-accent" as string]: NODE_ACCENTS[node.kind] ?? "#94a3b8" } as React.CSSProperties}
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
                  {node.kind === "character" ? (
                    <>
                      <span className={`pc-info-ava pc-ava-p${characterAvatarPaletteIndex(node.name)}`}>
                        {node.avatarPath ? (
                          <ResourceImage
                            path={joinLibraryPath(libraryRoot, node.avatarPath)}
                            alt={node.name}
                            className="pc-info-ava-img"
                          />
                        ) : (
                          characterAvatarInitial(node.name)
                        )}
                      </span>
                      <b className="pc-info-name">{node.name}</b>
                      <small className="pc-info-role">{t("project.cast.title")}</small>
                    </>
                  ) : node.kind === "location" ? (
                    <>
                      <span className="pc-info-ava">
                        {node.avatarPath ? (
                          <ResourceImage
                            path={joinLibraryPath(libraryRoot, node.avatarPath)}
                            alt={node.name}
                            className="pc-info-ava-img"
                          />
                        ) : (
                          Icons.resources
                        )}
                      </span>
                      <b className="pc-info-name">{node.name}</b>
                      <small className="pc-info-role">{t("project.library.locations")}</small>
                    </>
                  ) : node.kind === "prop" ? (
                    <>
                      <span className="pc-info-ava">{Icons.star}</span>
                      <b className="pc-info-name">{node.name}</b>
                      <small className="pc-info-role">{t("project.library.props")}</small>
                    </>
                  ) : (
                    <div className="pc-info-script">
                      <TextPaperBody path={joinLibraryPath(libraryRoot, node.textPath)} name={node.name} lines={5} />
                    </div>
                  )}
                </div>
                {portEls(node.key)}
              </div>
            );
          })}

          {/* 片段节点：AI 分段生成的视频分段，按拼接序汇入本集成片 */}
          {segments.map((segment, index) => {
            const p = segPos[segment.id];
            if (!p) return null;
            const key = `segment:${segment.id}`;
            return (
              <div
                key={segment.id}
                data-key={key}
                className="pc-node pc-segment"
                style={{ left: p.x, top: p.y, width: SEG_W, ["--node-accent" as string]: NODE_ACCENTS.segment } as React.CSSProperties}
                onDoubleClick={(event) => {
                  // 空片段双击卡体即打开填充窗口（有产出时双击无操作，
                  // 单击缩略图开素材详情）。
                  if (segment.asset) return;
                  event.stopPropagation();
                  setSegmentAssetPickFor(segment.id);
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
                    <button
                      type="button"
                      className="pc-seg-empty"
                      onClick={() => setSegmentAssetPickFor(segment.id)}
                    >
                      {Icons.link}
                      {t("project.canvas.segEmpty")}
                    </button>
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
                    onClick={() => setSegmentAssetPickFor(segment.id)}
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
              </div>
            );
          })}

          {/* 成片输出节点：本集工作流的总输出口（拖卡体挪位，按集记忆） */}
          {outputBox && (
            <div
              data-key="output"
              className="pc-node pc-outnode"
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

          {/* 占位素材节点：「素材」菜单创建的空节点，双击打开填充窗口 */}
          {placeholders.map((ph) => (
            <div
              key={ph.id}
              data-key={`placeholder:${ph.id}`}
              className="pc-node pc-placeholder"
              style={{ left: ph.x, top: ph.y, width: LOOSE_W, ["--node-accent" as string]: "#94a3b8" } as React.CSSProperties}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setPlaceholderFillFor(ph.id);
              }}
            >
              <div className="pc-node-head">
                <span className="pc-node-kind">{t("project.canvas.typeAsset")}</span>
                <b className="pc-node-title">{t("project.canvas.placeholderTitle")}</b>
              </div>
              <div className="pc-ph-empty">
                {Icons.image}
                {t("project.canvas.placeholderEmpty")}
              </div>
              <span className="pc-node-tools">
                <button
                  type="button"
                  data-tooltip={t("common.delete")}
                  className="danger"
                  onClick={() => persistPlaceholders(placeholders.filter((item) => item.id !== ph.id))}
                >
                  {Icons.close}
                </button>
              </span>
            </div>
          ))}
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
                onClick={() => {
                  if (issue.key === "output") locateOutput();
                  if (issue.key === "script") setScriptPickOpen(true);
                  if (issue.key === "segAssets") {
                    locateEmptySegment();
                    // 定位之余直接打开填充窗口，形成"提醒→填充"闭环。
                    const firstEmpty = segments.find((item) => !item.asset);
                    if (firstEmpty) setSegmentAssetPickFor(firstEmpty.id);
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
                panel: "characters",
              },
              {
                key: "location",
                label: t("project.canvas.typeLocation"),
                hint: t("project.canvas.typeLocationHint"),
                icon: Icons.resources,
                panel: "locations",
              },
              {
                key: "prop",
                label: t("project.canvas.typeProp"),
                hint: t("project.canvas.typePropHint"),
                icon: Icons.star,
                panel: "props",
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
                  // 资料类节点点击打开库挑选面板（挑选即关联进资料框）；
                  // 剧本项：已挂接则定位到剧本纸片，未挂接则从库选文件挂
                  // 到本集；创建类节点支持点击与按住拖到画布松手两种落位
                  // （ComfyUI 搜索框惯例）；从「拖线到空白」进入时创建的
                  // 节点自动接上那条线。
                  {...(item.panel === "script"
                    ? {
                        onClick: () => {
                          setAddMenu(null);
                          setAddMenuQuery("");
                          if (overview?.episode.script_path) {
                            locateScript();
                          } else {
                            setScriptPickOpen(true);
                          }
                        },
                      }
                    : item.panel
                      ? {
                          onClick: () => {
                            setAddMenu(null);
                            setAddMenuQuery("");
                            if (item.panel === "characters") setCastPickOpen(true);
                            if (item.panel === "locations") setLocationPickOpen(true);
                            if (item.panel === "props") setPropPickOpen(true);
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
      {/* 片段挂产出：从资源库选视频文件，导入为集级素材并设为片段产出 */}
      {segmentAssetPickFor && (
        <ProjectFilePickerDialog
          title={t("project.canvas.segAttach")}
          takenPaths={new Set()}
          takenLabel=""
          onClose={() => setSegmentAssetPickFor(null)}
          onPick={(file) => {
            const segmentId = segmentAssetPickFor;
            setSegmentAssetPickFor(null);
            void linkAsset({
              filePath: file.filePath,
              kind: file.kind,
              name: file.name,
              episodeId,
              shotId: "",
            }).then((asset) => {
              if (asset) void setSegmentAsset(segmentId, asset.id);
            });
          }}
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
      {/* 占位素材填充窗口：从库挑文件，新散件落在占位节点位置并移除占位 */}
      {placeholderFillFor && (
        <ProjectFilePickerDialog
          title={t("project.canvas.fillAsset")}
          takenPaths={new Set()}
          takenLabel=""
          onClose={() => setPlaceholderFillFor(null)}
          onPick={(file) => {
            const ph = placeholders.find((item) => item.id === placeholderFillFor);
            setPlaceholderFillFor(null);
            if (!ph) return;
            void linkAsset({
              filePath: file.filePath,
              kind: file.kind,
              name: file.name,
              episodeId,
              shotId: "",
            }).then((asset) => {
              if (!asset) return;
              void saveCanvasLayout({
                assets: [{ id: asset.id, x: ph.x, y: ph.y, w: LOOSE_W }],
                shots: [],
                scenes: [],
              });
              persistPlaceholders(placeholders.filter((item) => item.id !== ph.id));
            });
          }}
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
      {/* 双击菜单「角色」：出场角色挑选面板 */}
      {castPickOpen && (
        <ProjectLibraryPanel
          kind="characters"
          mode="pick"
          multi
          selectedIds={overview?.episode.character_ids ?? []}
          onClose={() => setCastPickOpen(false)}
          pickTitle={t("project.canvas.linkCast")}
          onTogglePick={(id) => {
            if (!episodeId) return;
            const existing = overview?.episode.character_ids ?? [];
            const next = existing.includes(id)
              ? existing.filter((item) => item !== id)
              : [...existing, id];
            void setEpisodeCharacters(episodeId, next);
          }}
        />
      )}
      {/* 双击菜单「道具」：出场道具挑选面板（与镜头挂靠按并集并存） */}
      {propPickOpen && (
        <ProjectLibraryPanel
          kind="props"
          mode="pick"
          multi
          selectedIds={overview?.episode.prop_ids ?? []}
          onClose={() => setPropPickOpen(false)}
          pickTitle={t("project.canvas.linkProps")}
          onTogglePick={(id) => {
            if (!episodeId) return;
            const existing = overview?.episode.prop_ids ?? [];
            const next = existing.includes(id)
              ? existing.filter((item) => item !== id)
              : [...existing, id];
            void setEpisodeProps(episodeId, next);
          }}
        />
      )}
    </div>
  );
}

function scriptFileLabelOf(path: string): string {
  const trimmed = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return trimmed;
}
