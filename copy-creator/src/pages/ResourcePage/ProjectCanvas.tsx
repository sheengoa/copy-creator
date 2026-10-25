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
const SCENE_PITCH = 380;
const MINI_W = 150;
const MINI_H = 96;

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
  key: string; // `char:<id>` | `prop:<id>` | `script`
  kind: "character" | "prop" | "script";
  name: string;
  avatarPath: string; // 角色头像（相对库根）
  textPath: string; // 剧本正文（相对库根）
  w: number;
  h: number;
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
  infoFramePos: Pos;
  worldW: number;
  worldH: number;
}

interface WireBox extends Pos {
  w: number;
  h: number;
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
  looseAssets: ProjectAsset[],
): Omit<CanvasLayout, "infoFramePos"> {
  const cardPos: Record<string, Pos> = {};
  const loosePos: Record<string, Pos> = {};
  const cards: CanvasCard[] = [];
  const looses: CanvasLoose[] = [];
  const frames: CanvasFrame[] = [];
  let worldW = 1200;
  let worldH = 900;

  scenes.forEach((scene, index) => {
    const fx = scene.canvas_x ?? WORLD_MARGIN + index * SCENE_PITCH;
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

  return { cards, looses, infos: [], frames, cardPos, loosePos, worldW, worldH };
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

function wirePath(a: WireBox, b: WireBox): string {
  return wirePathD(a, b);
}

interface WireItem {
  fromKey: string; // 容器 key：shot:<id> | asset:<id>
  toKey: string;
  label: string;
  kind: "gen" | "manual";
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
    props,
    loadLocations,
    loadProps,
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
      props: state.props,
      loadLocations: state.loadLocations,
      loadProps: state.loadProps,
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

  // 出镜道具名（全集并集）与出场角色：资料框数据源。
  const castCharacters = useMemo(() => overview?.characters ?? [], [overview]);
  const propIds = useMemo(() => {
    const ids: string[] = [];
    scenes.forEach((scene) =>
      scene.shots.forEach((shot) => shot.prop_ids.forEach((pid) => {
        if (!ids.includes(pid)) ids.push(pid);
      })),
    );
    return ids;
  }, [scenes]);

  useEffect(() => {
    if (propIds.length > 0 && props.length === 0) void loadProps();
  }, [propIds.length, props.length, loadProps]);

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

  // ── 布局与位置（state 驱动渲染） ──
  const layout = useMemo(() => {
    const base = buildLayout(scenes, looseAssets);
    return base;
  }, [scenes, looseAssets]);

  // 资料节点（出场角色/出镜道具/剧本）：资料框内网格自动排。
  const infoNodes = useMemo(() => {
    const list: CanvasInfo[] = [];
    castCharacters.forEach((character) => {
      list.push({
        key: `char:${character.id}`, kind: "character", name: character.name,
        avatarPath: character.avatar_path, textPath: "", w: INFO_W, h: INFO_H,
      });
    });
    propIds.forEach((pid) => {
      const prop = props.find((item) => item.id === pid);
      if (prop) {
        list.push({ key: `prop:${pid}`, kind: "prop", name: prop.name, avatarPath: "", textPath: "", w: INFO_W, h: INFO_H });
      }
    });
    if (overview?.episode.script_path) {
      list.push({
        key: "script", kind: "script", name: scriptFileLabelOf(overview.episode.script_path),
        avatarPath: "", textPath: overview.episode.script_path, w: SCRIPT_W, h: INFO_H + 40,
      });
    }
    return list;
  }, [castCharacters, propIds, props, overview]);

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
    const worldW = Math.max(layout.worldW, infoPos.frame.x + FRAME_MIN_W + 60);
    const worldH = Math.max(layout.worldH, infoBottom + 60);
    const scale = Math.min(el.clientWidth / worldW, el.clientHeight / worldH, 1);
    const next = {
      x: Math.max(12, (el.clientWidth - worldW * scale) / 2),
      y: Math.max(8, (el.clientHeight - worldH * scale) / 2),
      scale,
    };
    setView(next);
    saveView(next);
  }, [layout, infoPos, infoNodes, saveView]);

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
    const pushWire = (fromAsset: string, toAsset: string, label: string, kind: "gen" | "manual") => {
      const from = containerOf(fromAsset);
      const to = containerOf(toAsset);
      if (!from || !to || from === to) return;
      if (list.some((w) => w.fromKey === from && w.toKey === to && w.kind === kind)) return;
      list.push({ fromKey: from, toKey: to, label, kind });
    };
    const allAssets: ProjectAsset[] = [];
    scenes.forEach((scene) => scene.shots.forEach((shot) => allAssets.push(...shot.assets)));
    allAssets.push(...looseAssets);
    allAssets.forEach((asset) => {
      if (asset.gen_from_asset && allAssets.some((a) => a.id === asset.gen_from_asset)) {
        pushWire(asset.gen_from_asset, asset.id, t("project.canvas.wireGen"), "gen");
      }
    });
    links.forEach((link: ProjectAssetLink) => {
      pushWire(link.from_asset, link.to_asset, link.label || t("project.canvas.wireRef"), "manual");
    });
    return list;
  }, [scenes, looseAssets, links, containerOf, t]);

  const boxOf = useCallback(
    (key: string): WireBox | null => {
      if (key.startsWith("shot:")) {
        const shotId = key.slice(5);
        const size = cardSizeOf(shotId);
        const p = pos.cards[shotId];
        return p ? { x: p.x, y: p.y, w: size.w, h: size.h } : null;
      }
      if (key.startsWith("asset:")) {
        const assetId = key.slice(6);
        const loose = layout.looses.find((l) => l.asset.id === assetId);
        const p = pos.loose[assetId];
        return loose && p ? { x: p.x, y: p.y, w: loose.w, h: loose.h } : null;
      }
      return null;
    },
    [layout, pos, cardSizeOf],
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
      scenes.forEach((scene, index) => {
        next[scene.id] = prev[scene.id] ?? {
          x: scene.canvas_x ?? WORLD_MARGIN + index * SCENE_PITCH,
          y: scene.canvas_y ?? 110,
        };
      });
      return next;
    });
  }, [scenes]);

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
    kind: "pan" | "marquee" | "card" | "loose" | "group" | "infoframe" | "wire";
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
        target?.closest(".pc-frame-ops") ||
        target?.closest(".pc-shot-head") ||
        target?.closest(".pc-shot-grid") ||
        target?.closest(".pc-shot-empty")
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
      const anchor = target?.closest(".pc-anchor");
      if (anchor) {
        const nodeEl = anchor.closest(".pc-node");
        const key = nodeEl?.getAttribute("data-key") ?? "";
        if (key) {
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
    [layout, pos, setSelection, view, infoPos, scenePos],
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
      } else if (drag.kind === "wire") {
        const el = vpRef.current;
        if (!el || !drag.fromKey) return;
        const rect = el.getBoundingClientRect();
        const wx = (e.clientX - rect.left - view.x) / view.scale;
        const wy = (e.clientY - rect.top - view.y) / view.scale;
        const fromBox = boxOf(drag.fromKey);
        if (!fromBox) return;
        setWireDraft(wirePath(fromBox, { x: wx - 1, y: wy - 1, w: 2, h: 2 }));
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const tEl = hit instanceof Element ? hit.closest(".pc-node") : null;
        const tKey = tEl?.getAttribute("data-key") ?? null;
        drag.targetKey = tKey && tKey !== drag.fromKey ? tKey : null;
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
        setWireDraft(null);
        if (drag.targetKey && drag.fromKey) {
          void linkAssets(
            drag.fromKey.replace(/^(shot|asset):/, ""),
            drag.targetKey.replace(/^(shot|asset):/, ""),
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
      dragRef.current = null;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [layout, pos, view, scenePos, infoPos, boxOf, linkAssets, persistCards, persistLoose, saveCanvasLayout, saveInfoFramePos, saveView, setSelection]);

  // ── 节点操作 ──
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
          const thumb = e.target instanceof Element ? e.target.closest(".pc-shot-asset-thumb") : null;
          if (!thumb) return;
          const assetId = thumb.getAttribute("data-asset") ?? "";
          const node = layout.cards
            .flatMap((c) => c.assets)
            .find((a) => a.asset.id === assetId);
          if (node) onOpenAsset(node.asset);
        }}
      >
        <div
          className="pc-world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {/* 场景分组框 + 集级框 + 资料框 */}
          {scenes.map((scene, sceneIndex) => {
            const spos = scenePos[scene.id] ?? { x: scene.canvas_x ?? WORLD_MARGIN + sceneIndex * SCENE_PITCH, y: scene.canvas_y ?? 110 };
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

          {/* 连线层（卡片之下） */}
          <svg className="pc-wires" aria-hidden="true">
            <defs>
              <marker id="pc-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" fill="#4a4a54" />
              </marker>
            </defs>
            {wires.map((wire) => {
              const fromBox = boxOf(wire.fromKey);
              const toBox = boxOf(wire.toKey);
              if (!fromBox || !toBox) return null;
              const d = wirePathD(fromBox, toBox);
              const midX = (fromBox.x + fromBox.w / 2 + toBox.x + toBox.w / 2) / 2;
              const midY = (fromBox.y + fromBox.h / 2 + toBox.y + toBox.h / 2) / 2 - 7;
              return (
                <g key={`${wire.fromKey}->${wire.toKey}`} className="pc-wire">
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
                      onClick={() => void unlinkAssets(wire.fromKey, wire.toKey)}
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
                style={{ left: p.x, top: p.y, width: card.w }}
              >
                <div className="pc-media-wrap pc-shot-card">
                  <div className="pc-shot-head">
                    <span className="pc-shot-no">{shotNoOf(card.sceneId, card.shot.id)}</span>
                    <b className="pc-shot-desc">{shot.description || t("project.shot.untitled")}</b>
                    {shot.dialogue && <i className="pc-shot-dialogue">{shot.dialogue}</i>}
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
                </div>
                <span className="pc-anchor" data-tooltip={t("project.canvas.wireHint")} />
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
                style={{ left: p.x, top: p.y, width: loose.w }}
              >
                <div className="pc-media-wrap">
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
                </div>
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
                <span className="pc-anchor" data-tooltip={t("project.canvas.wireHint")} />
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
              <div key={node.key} className={`pc-node pc-info${""}`} style={{ left: p.x, top: p.y, width: node.w }}>
                <div className="pc-media-wrap pc-info-card">
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
              </div>
            );
          })}
        </div>

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
    </div>
  );
}

function scriptFileLabelOf(path: string): string {
  const trimmed = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return trimmed;
}
