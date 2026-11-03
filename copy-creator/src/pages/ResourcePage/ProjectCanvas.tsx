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
} from "../../stores/projectStore";
import {
  characterAvatarInitial,
  joinLibraryPath,
  scriptFileLabel,
} from "../../domain/projectView";

import {
  allAssetsOf,
  buildLayout,
  CARD_GAP,
  CARD_W,
  FRAME_MIN_W,
  FRAME_PAD_TOP,
  FRAME_PAD_X,
  WORLD_MARGIN,
  INFO_H,
  INFO_W,
  OUTPUT_H,
  OUTPUT_W,
  portRatio,
  SCRIPT_W,
  SEG_H,
  SEG_W,
  WIRES_VIEWPORT_PAD,
} from "./ProjectCanvas/layout";
import {
  EMPTY_ENTITY_PHS,
  EMPTY_INFO_GROUPS,
  EMPTY_INFO_OFFSETS,
  EMPTY_NODE_GROUPS,
  EMPTY_NOTES,
  EMPTY_PENDING_LINKS,
  EMPTY_PROMPT_PHS,
  EMPTY_SIZES,
  EMPTY_SCRIPT_PHS,
  parsePendingLinks,
  parsePromptPhs,
  parseScriptPhs,
  type CanvasInfo,
  type CanvasNote,
  type EntityPh,
  type EntityPhKind,
  type InfoGroup,
  type NodeGroup,
  type PendingLink,
  type Pos,
  type PosMap,
  type PromptPh,
  type ScriptPh,
  type WireBox,
  type WireItem,
} from "./ProjectCanvas/types";
import { ResourceImage } from "./ResourceMedia";
import { PORT_COLORS, WIRE_TYPE_COLORS } from "./ProjectCanvas/colors";
import { useCanvasGestures } from "./ProjectCanvas/engine/useGestures";
import { useWorkflowSeed } from "./ProjectCanvas/engine/useWorkflowSeed";
import { useDetailActions } from "./ProjectCanvas/engine/useDetailActions";
import { usePorts } from "./ProjectCanvas/engine/usePorts";
import { DetailDialog } from "./ProjectCanvas/layers/DetailDialog";
import type { DetailForArg } from "./ProjectCanvas/layers/NodeExtras";
import { MiniMap, ZoomBar } from "./ProjectCanvas/layers/chrome";
import { SceneFrames } from "./ProjectCanvas/layers/SceneFrames";
import { WiresLayer } from "./ProjectCanvas/layers/WiresLayer";
import { ShotCards } from "./ProjectCanvas/layers/ShotCards";
import { InfoNodesLayer, NodeGroupsLayer } from "./ProjectCanvas/layers/InfoLayer";
import {
  EntityPhNodes,
  NoteNodes,
  OutputNode,
  PromptPhNodes,
  SegmentNodes,
} from "./ProjectCanvas/layers/NodeExtras";
import {
  AddBtnBar,
  AddMenuBlock,
  CutTrailLayer,
  EpisodeCard,
  IssueBar,
} from "./ProjectCanvas/layers/CanvasBars";
import {
  DeleteSceneConfirm,
  LocationPickPanel,
  MemberPickPanel,
  PromptPickDialog,
  SceneFormDialog,
  ScriptPickDialog,
  SegmentAttachPicker,
  ShotFormDialog,
} from "./ProjectCanvas/layers/Dialogs";

// ── 模块层已拆出 ProjectCanvas/（types/layout/colors/TextPaperBody，
//    2026-11-03 引擎拆分阶段 11a；下方为组件体）──


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
    loadCharacters,
    loadProps,
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
      loadCharacters: state.loadCharacters,
      loadProps: state.loadProps,
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
    // 删旧行；取消（点空白/Esc）则整组断开（discardDetachedWire）；
    // 建出的节点接不回线（无口）才放回原口。
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

  // 全局三库兜底加载：组节点成员解析与组自愈按全局库判定存在性，
  // 未拉取时（画布直达、没开过库面板）判定退化成空。列表轻量，
  // 每次画布挂载拉一次（ref 守卫，概览整刷重挂不重复触发）。
  const libsLoadedRef = useRef(false);
  useEffect(() => {
    if (libsLoadedRef.current) return;
    libsLoadedRef.current = true;
    void loadCharacters();
    void loadLocations();
    void loadProps();
  }, [loadCharacters, loadLocations, loadProps]);

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
      // 只统计仍存在的成员：按集关联 ∪ 全局库判定（entitiesOfKind 同
      // 规则，此处提前内联）。只按集关联判定时，装入的关联落库失败/
      // 未整刷回来会把整组判成 0 成员而整节点消失（幽灵组），全局库
      // 兜底保住可见性。
      const episodeList =
        group.kind === "character" ? castCharacters : group.kind === "location" ? episodeLocations : episodeProps;
      const globalList = group.kind === "character" ? characters : group.kind === "location" ? locations : props;
      const members = group.members.filter(
        (id) => episodeList.some((e) => e.id === id) || globalList.some((e) => e.id === id),
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
  }, [castCharacters, episodeLocations, episodeProps, characters, locations, props, infoGroups, overview, scriptPhs, t]);

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
          // 纵向间距 520 与模板两排阵型同基准：片段左侧一组占位高约两排，
          // 260 的旧间距会让相邻两组的占位相交。
          y: segment.canvas_y ?? WORLD_MARGIN + INFO_H + index * 520,
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
      // 提示词纸片：独立渲染块（不在 infoNodes），默认尺寸与剧本纸片一致。
      if (key.startsWith("prompt:")) {
        return { w: over?.w ?? SCRIPT_W, h: over?.h ?? INFO_H + 40 };
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
  const [detailFor, setDetailFor] = useState<DetailForArg | null>(null);
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

  // ── 默认工作流模板（engine/useWorkflowSeed，2026-11-03 阶段 11d）：
  //    首次进入空集自动铺片段+占位骨架，代码零改动搬移 ──
  useWorkflowSeed({
    episodeId, overview, addSegment, layout, persistEntityPhs,
    persistPromptPhs, persistScriptPhs, persistInfoOffsets, persistPendingLinks,
  });

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
      // 提示词纸片：独立渲染块（不在 infoNodes），位置同空白占位解析。
      if (key.startsWith("prompt:")) {
        const p = infoNodePos(key);
        const size = sizeOfNode(key);
        return p ? finish(p.x, p.y, size?.w ?? SCRIPT_W, size?.h ?? INFO_H + 40) : null;
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
  // 共享语义下同一实体可被多个组认领，此函数只用于「渲染位置」类回退
  // （取第一个组）；线的归属一律看线自己的 owner_key（ownerKeyOfLink）。
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
  // 连线 → 发出节点 key：优先线自身记录的 owner（资料组线身份，精确）；
  // 旧数据无 owner 时按当前组账回退定位（历史互斥语义下唯一组，等价）。
  const ownerKeyOfLink = useCallback(
    (link: Pick<ProjectNodeLink, "from_kind" | "from_id" | "owner_key">): string =>
      link.owner_key ? link.owner_key : ownerKeyOf(link.from_kind, link.from_id),
    [ownerKeyOf],
  );
  // ── 端口语义与色通道（engine/usePorts，2026-11-03 阶段 11d）：
  //    顶掉/去重/接口表/实体色/key 解析/自动接回，代码零改动搬移 ──
  const {
    displacePortLinks,
    segWires,
    portsOf,
    nodeWireColorOf,
    nodeKeyParts,
    autoConnectNewNode,
    entityPorts: ENTITY_PORTS,
  } = usePorts({
    overview, unlinkNode, pendingLinks, persistPendingLinks, nodeLinks,
    ownerKeyOfLink, scenes, infoGroups, entityPhs, episodeId, linkNode,
    setEpisodeOutput,
  });

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

  // ── 手势引擎（engine/useGestures，2026-11-03 阶段 11b）：DragState 按下
  //    分派 + 窗口级 move/up/cancel + 切线/摘线/双击判定，代码零改动搬移 ──
  const {
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
  } = useCanvasGestures({
    vpRef, view, setView, saveView, layout, pos, setPos, segPos, setSegPos, outputBox,
    notes, setNotes, nodeSizes, setNodeSizes, infoGroups, infoNodes, infoNodePos,
    entityPhs, promptPhs, segments, segWires, nodeLinks, pendingLinks,
    persistPendingLinks, nodeGroups, memberFrame, groupSnapshot, selRef,
    setSelection, moveGroupTo, persistPositions, pushUndo, persistCards,
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
  });

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
                  style={{ background: nodeWireColorOf(key) ?? WIRE_TYPE_COLORS[out.type] ?? "#94a3b8" }}
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
    (kind: EntityPhKind) => {
      const episodeList =
        kind === "character" ? castCharacters : kind === "location" ? episodeLocations : episodeProps;
      const globalList = kind === "character" ? characters : kind === "location" ? locations : props;
      // 集关联为主、全局库兜底：组成员在集关联写入空档/缺失时（装入的
      // 关联落库失败或尚未整刷回来）仍可解析出成员实体，组节点不消失。
      const seen = new Set(episodeList.map((e) => e.id));
      return [...episodeList, ...globalList.filter((e) => !seen.has(e.id))];
    },
    [castCharacters, episodeLocations, episodeProps, characters, locations, props],
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
        // 只认本组名下的线：共享成员（同时在其他组）的他组线不算本组
        // 的口。旧数据线无 owner，按成员匹配回退（历史互斥下等价）。
        if (l.owner_key && l.owner_key !== `grp:${group.id}`) return;
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
    // ownerKey 传入（组移除成员）时只删该组名下的线——共享成员在其他
    // 组的连线保留；旧数据线无 owner（历史互斥语义下该实体只可能在这
    // 一个组里）视为本组一并清。不传（实体移出本集）全删。
    async (kind: EntityPhKind, entityId: string, ownerKey?: string) => {
      const rows = (overview?.node_links ?? []).filter((l) =>
        l.from_kind === kind && l.from_id === entityId &&
        (ownerKey ? !l.owner_key || l.owner_key === ownerKey : true),
      );
      for (const row of rows) await unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port, row.owner_key);
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
  // ── 详情窗动作集（engine/useDetailActions，2026-11-03 阶段 11d）：
  //    本机上传/打开定位/组员增删，代码零改动搬移 ──
  const { uploadViaImport, handleLocate, removeGroupMember, addGroupMember } = useDetailActions({
    libraryRoot, setDetailError, episodeId, infoGroups, persistInfoGroups,
    infoOffsets, persistInfoOffsets, infoNodePos, unlinkEntityLinks,
    groupWiredPorts, linkNode, associateEntities,
  });
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
      // 面板保挂载：资源页被 display:none 隐藏（用户在剪切板等其他顶级区）
      // 时不响应，否则别处按 Delete/Backspace 会隔着隐藏面板删掉工程选中。
      if (!vpRef.current || vpRef.current.offsetParent === null) return;
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
    // 成员可在多个组复用（同一角色可同时挂上多个片段，如同主角出场于
    // 上下两个片段），不做组间互斥过滤。
    const pending = pick.pending;
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
      // 占位节点的暂存线随加载转正：组内每个成员各落一条 node_link
      // （owner 记组身份，组删线/找组口按此精确匹配）。转正落到资料口
      // 时先顶掉口上既有来源——占位在口上挂着，实体加载后正式接上，
      // 原来占着这个口的其他来源被替换（后连顶先连）。顶掉的既有线
      // （他人正式行 + 他人暂存线）在这里一次性合并删除：同块逐口调用
      // displace 的话，多次 persistPendingLinks 基于同一闭包旧值会互相
      // 覆盖。
      const ephKey = `eph:${ph.id}`;
      const myPending = pendingLinks.filter((l) => l.fromKey === ephKey);
      myPending.forEach((l) => {
        if (!ENTITY_PORTS.has(l.toPort)) return;
        (overview?.node_links ?? [])
          .filter((row) => row.to_segment === l.toSegmentId && row.to_port === l.toPort)
          .forEach((row) => {
            void unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port, row.owner_key);
          });
      });
      const displacedStale = pendingLinks.filter(
        (l) =>
          l.fromKey !== ephKey &&
          ENTITY_PORTS.has(l.toPort) &&
          myPending.some((m) => m.toSegmentId === l.toSegmentId && m.toPort === l.toPort),
      );
      if (displacedStale.length) {
        persistPendingLinks(pendingLinks.filter((l) => !displacedStale.includes(l)));
      }
      for (const l of myPending) {
        for (const memberId of pending) {
          await linkNode(episodeId, pick.kind, memberId, l.toSegmentId, l.toPort as ProjectNodeLink["to_port"], `grp:${groupId}`);
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
        for (const w of wired) await linkNode(episodeId, pick.kind, id, w.to_segment, w.to_port as ProjectNodeLink["to_port"], `grp:${group.id}`);
      }
      // 面板勾掉的成员 = 从本组移除：只删本组名下的线，成员在其他组
      // 的连线保留（共享复用）。
      for (const id of removals) await unlinkEntityLinks(pick.kind, id, `grp:${group.id}`);
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
        if (id !== srcId) await linkNode(episodeId, pick.kind, id, row.to_segment, row.to_port, `grp:${groupId}`);
      }
    }
    await associateEntities(pick.kind, pending);
    setDetailFor({ kind: "info", group: pick.kind, sourceKey: `grp:${groupId}`, scope: "current" });
  }, [
    memberPick, episodeId, entityPhs, infoNodePos, infoOffsets, persistInfoOffsets, persistEntityPhs,
    infoGroups, persistInfoGroups, associateEntities, groupWiredPorts, linkNode, overview,
    unlinkEntityLinks, pendingLinks, persistPendingLinks, ENTITY_PORTS, unlinkNode,
  ]);

  // ── 节点详情窗口（layers/DetailDialog，2026-11-03 阶段 11d）：按
  //    detailFor 组装预览/信息/动作，IIFE 组装体零改动搬移 ──
  const detailDialog = (
    <DetailDialog
      detailFor={detailFor}
      detailError={detailError}
      overview={overview}
      libraryRoot={libraryRoot}
      segments={segments}
      scriptPhs={scriptPhs}
      infoGroups={infoGroups}
      promptPhs={promptPhs}
      entityPhs={entityPhs}
      prompts={prompts}
      kindTextOf={kindTextOf}
      uploadViaImport={uploadViaImport}
      handleLocate={handleLocate}
      removeGroupMember={removeGroupMember}
      addGroupMember={addGroupMember}
      castCharacters={castCharacters}
      episodeLocations={episodeLocations}
      episodeProps={episodeProps}
      entitiesOfKind={entitiesOfKind}
      setPromptPickTarget={setPromptPickTarget}
      setMemberPick={setMemberPick}
      closeDetail={closeDetail}
      attachSegmentFromLibrary={attachSegmentFromLibrary}
      setScriptPickTarget={setScriptPickTarget}
      setScriptPickOpen={setScriptPickOpen}
      setPickerFor={setPickerFor}
      setPromptPickOpen={setPromptPickOpen}
      setDetailFor={setDetailFor}
    />
  );

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
          <SceneFrames
            scenes={scenes}
            scenePos={scenePos}
            layout={layout}
            pos={pos}
            setSceneForm={setSceneForm}
            setShotForm={setShotForm}
            setDeleteSceneTarget={setDeleteSceneTarget}
          />

          <WiresLayer
            wires={wires}
            segWires={segWires}
            pendingLinks={pendingLinks}
            liftedWire={liftedWire}
            wireDraft={wireDraft}
            outputBox={outputBox}
            segments={segments}
            overview={overview}
            wiresVis={wiresVis}
            outPointOf={outPointOf}
            inPointOf={inPointOf}
            portsOf={portsOf}
            nodeWireColorOf={nodeWireColorOf}
          />
          <ShotCards
            cards={layout.cards}
            pos={pos}
            selKeys={selKeys}
            nodeSizes={nodeSizes}
            sizeOfNode={sizeOfNode}
            shotNoOf={shotNoOf}
            portBar={portBar}
            resizeHandle={resizeHandle}
            libraryRoot={libraryRoot}
            onPickForShot={onPickForShot}
            setShotForm={setShotForm}
            deleteShot={deleteShot}
          />

          <NodeGroupsLayer nodeGroups={nodeGroups} memberFrame={memberFrame} />
          <InfoNodesLayer
            infoNodes={infoNodes}
            infoGroups={infoGroups}
            infoNodePos={infoNodePos}
            sizeOfNode={sizeOfNode}
            nodeSizes={nodeSizes}
            pulseKeys={pulseKeys}
            selKeys={selKeys}
            portBar={portBar}
            resizeHandle={resizeHandle}
            libraryRoot={libraryRoot}
            entitiesOfKind={entitiesOfKind}
            entityRefOf={entityRefOf}
            photoMainOf={photoMainOf}
            openInfoDetail={openInfoDetail}
            removeGroup={removeGroup}
            detachScript={detachScript}
            removeScriptPh={removeScriptPh}
            removeInfoEntity={removeInfoEntity}
          />

          <EntityPhNodes
            entityPhs={entityPhs}
            infoNodePos={infoNodePos}
            sizeOfNode={sizeOfNode}
            nodeSizes={nodeSizes}
            selKeys={selKeys}
            portBar={portBar}
            resizeHandle={resizeHandle}
            setDetailFor={setDetailFor}
            removeEntityPh={removeEntityPh}
          />
          <PromptPhNodes
            promptPhs={promptPhs}
            prompts={prompts}
            infoNodePos={infoNodePos}
            sizeOfNode={sizeOfNode}
            nodeSizes={nodeSizes}
            selKeys={selKeys}
            portBar={portBar}
            resizeHandle={resizeHandle}
            setPromptPickTarget={setPromptPickTarget}
            setPromptPickOpen={setPromptPickOpen}
            setDetailFor={setDetailFor}
            removePromptPh={removePromptPh}
          />
          <SegmentNodes
            segments={segments}
            segPos={segPos}
            sizeOfNode={sizeOfNode}
            nodeSizes={nodeSizes}
            selKeys={selKeys}
            portBar={portBar}
            resizeHandle={resizeHandle}
            libraryRoot={libraryRoot}
            moveSegment={moveSegment}
            setDetailFor={setDetailFor}
            removeSegment={removeSegment}
          />
          <OutputNode
            outputBox={outputBox}
            segments={segments}
            outputSourceLabel={outputSourceLabel}
            episodeId={episodeId}
            sizeOfNode={sizeOfNode}
            nodeSizes={nodeSizes}
            selKeys={selKeys}
            portBar={portBar}
            resizeHandle={resizeHandle}
            setEpisodeOutput={setEpisodeOutput}
          />
          <NoteNodes
            notes={notes}
            selKeys={selKeys}
            sizeOfNode={sizeOfNode}
            resizeHandle={resizeHandle}
            editingNoteId={editingNoteId}
            noteDraft={noteDraft}
            setNoteDraft={setNoteDraft}
            setEditingNoteId={setEditingNoteId}
            persistNotes={persistNotes}
          />
        </div>

        <CutTrailLayer cutTrailUnderRef={cutTrailUnderRef} cutTrailRef={cutTrailRef} />

        <IssueBar
          issues={issues}
          scriptPhs={scriptPhs}
          segments={segments}
          locateOutput={locateOutput}
          locateScript={locateScript}
          armSpawnFromEvent={armSpawnFromEvent}
          addScriptPh={addScriptPh}
          locateEmptySegment={locateEmptySegment}
          setDetailFor={setDetailFor}
        />
        <AddMenuBlock
          addMenu={addMenu}
          addMenuQuery={addMenuQuery}
          setAddMenuQuery={setAddMenuQuery}
          setAddMenu={setAddMenu}
          discardDetachedWire={discardDetachedWire}
          setLiftedWire={setLiftedWire}
          armSpawnAt={armSpawnAt}
          addScriptPh={addScriptPh}
          setLocationPickOpen={setLocationPickOpen}
          dragRef={dragRef}
        />

        <EpisodeCard overlay={overlay} scenes={scenes} looseAssets={looseAssets} wires={wires} />

        <div className="pc-tip">{t("project.canvas.tip")}</div>

        <ZoomBar view={view} zoomAt={zoomAt} fitAll={fitAll} vpRef={vpRef} />
        <MiniMap
          scenes={scenes}
          scenePos={scenePos}
          layout={layout}
          pos={pos}
          view={view}
          vpSize={vpSize}
          vpRef={vpRef}
          setView={setView}
          saveView={saveView}
        />
        <AddBtnBar onPickForShot={onPickForShot} setSceneForm={setSceneForm} />
      </div>

      <SceneFormDialog
        sceneForm={sceneForm}
        setSceneForm={setSceneForm}
        locations={locations}
        submitSceneForm={submitSceneForm}
      />

      <ShotFormDialog
        shotForm={shotForm}
        setShotForm={setShotForm}
        submitShotForm={submitShotForm}
      />

      <DeleteSceneConfirm
        deleteSceneTarget={deleteSceneTarget}
        setDeleteSceneTarget={setDeleteSceneTarget}
        deleteScene={deleteScene}
      />
      {/* 节点详情预览窗口：双击节点的独立窗口（预览 + 信息 + 上传/库选） */}
      {detailDialog}
      <SegmentAttachPicker
        pickerFor={pickerFor}
        setPickerFor={setPickerFor}
        attachSegmentFromLibrary={attachSegmentFromLibrary}
      />
      <ScriptPickDialog
        scriptPickOpen={scriptPickOpen}
        setScriptPickTarget={setScriptPickTarget}
        setScriptPickOpen={setScriptPickOpen}
        handleScriptPick={handleScriptPick}
      />
      <PromptPickDialog
        promptPickOpen={promptPickOpen}
        closePromptPick={closePromptPick}
        promptPickQuery={promptPickQuery}
        setPromptPickQuery={setPromptPickQuery}
        prompts={prompts}
        handlePromptPick={handlePromptPick}
      />
      <LocationPickPanel
        locationPickOpen={locationPickOpen}
        setLocationPickOpen={setLocationPickOpen}
        episodeId={episodeId}
        locationIds={overview?.episode.location_ids ?? []}
        setEpisodeLocations={setEpisodeLocations}
      />
      <MemberPickPanel
        memberPick={memberPick}
        setMemberPick={setMemberPick}
        kindTextOf={kindTextOf}
        applyMemberPick={applyMemberPick}
      />
    </div>
  );
}
