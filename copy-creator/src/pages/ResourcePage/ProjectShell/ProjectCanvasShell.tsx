import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { useProjectStore, type ProjectAsset } from "../../../stores/projectStore";
import { CanvasDataContext } from "../../CanvasPage/dataContext";
import FreeCanvas from "../../CanvasPage/FreeCanvas";
import { ProjectCanvasContext, type ProjectCanvasContextValue } from "../../CanvasPage/nodes/project/projectContext";
import {
  EMPTY_PENDING_LINKS,
  EMPTY_NODE_GROUPS,
  parsePendingLinks,
  type CanvasLayout,
  type PendingLink,
} from "./types";
import type { LiftedWire } from "./types";
import { ProjectDetailWindow, type DetailTarget, type DetailWindowOps } from "./DetailWindow";
import { usePerEpisodeStorage } from "../usePerEpisodeStorage";
import { useCanvasData } from "./engine/useCanvasData";
import { useNodeMetrics } from "./engine/useNodeMetrics";
import { usePorts } from "./engine/usePorts";
import { WIRES_VIEWPORT_PAD } from "./layout";
import { WiresLayer } from "./layers/WiresLayer";
import { buildProjectCanvasApi, buildProjectNodes } from "./projectProvider";
import { SceneFrames } from "./layers/SceneFrames";
import { EpisodeCard, AddBtnBar, IssueBar } from "./layers/CanvasBars";
import {
  DeleteSceneConfirm,
  LocationPickPanel,
  PromptPickDialog,
  SceneFormDialog,
  ScriptPickDialog,
  ShotFormDialog,
} from "./layers/Dialogs";
import { useGroupOps } from "./engine/useGroupOps";
import { useCanvasView } from "./engine/useCanvasView";
import { useWorkflowSeed } from "./engine/useWorkflowSeed";
import type { ProjectScene } from "../../../stores/projectStore";
import type { Pos } from "./types";
import { WORLD_MARGIN } from "./layout";
import type { EntityPhKind } from "./types";

/** updateEpisode 补丁的状态字段（store 的 ProjectEpisodeStatus）。 */
type ProjectEpisodeStatusLike = Parameters<ReturnType<typeof useProjectStore.getState>["updateEpisode"]>[1]["status"];

// 工程画布壳（工程视图节点化 2026-11-05 阶段 B，方案 §B3）：自由画布
// 节点基座上的「工程作用域实例」——挂工程数据源 provider（overview 派生
// 节点 + 工程表/按集记忆落盘分流），复用基座的节点 chrome、手势引擎与
// 建节点菜单。场景框/缺项条/集信息卡/默认工作流种子等工程外围件在阶段
// E1 收编进本壳；连线渲染与落库在阶段 C 接入；详情窗在阶段 D 重做。
// 旧 ProjectCanvas 停止挂载、文件保留（回退用，阶段 E 删除）。

export default function ProjectCanvasShell({
  libraryRoot,
  overlay,
  onOpenAsset,
  onPickForShot,
}: {
  libraryRoot: string;
  /** 集信息玻璃卡（阶段 E1 接回 EpisodeCard 时启用）。 */
  overlay?: React.ReactNode;
  onOpenAsset: (asset: ProjectAsset) => void;
  onPickForShot: (shotId: string) => void;
}) {
  void overlay;
  void onOpenAsset;
  const { t } = useTranslation();
  const {
    overview,
    characters,
    locations,
    props,
    prompts,
    loadPrompts,
    loadCharacters,
    loadLocations,
    loadProps,
    saveCanvasLayout,
    deleteShot,
    setEpisodeOutput,
    setEpisodeCharacters,
    setEpisodeLocations,
    setEpisodeProps,
    updateEpisode: storeUpdateEpisode,
    addSegment,
    removeSegment,
    moveSegment,
    linkNode,
    unlinkNode,
    unlinkAssets,
    saveCharacter,
    setCharacterVoice,
    saveScene,
    deleteScene,
    saveShot,
    linkAsset,
    setSegmentAsset,
    selectEpisode,
    loadLocations: storeLoadLocations,
  } = useProjectStore(
    useShallow((state) => ({
      overview: state.overview,
      characters: state.characters,
      locations: state.locations,
      props: state.props,
      prompts: state.prompts,
      loadPrompts: state.loadPrompts,
      loadCharacters: state.loadCharacters,
      loadLocations: state.loadLocations,
      loadProps: state.loadProps,
      saveCanvasLayout: state.saveCanvasLayout,
      deleteShot: state.deleteShot,
      setEpisodeOutput: state.setEpisodeOutput,
      setEpisodeCharacters: state.setEpisodeCharacters,
      setEpisodeLocations: state.setEpisodeLocations,
      setEpisodeProps: state.setEpisodeProps,
      updateEpisode: state.updateEpisode,
      addSegment: state.addSegment,
      removeSegment: state.removeSegment,
      moveSegment: state.moveSegment,
      linkNode: state.linkNode,
      unlinkNode: state.unlinkNode,
      unlinkAssets: state.unlinkAssets,
      saveCharacter: state.saveCharacter,
      setCharacterVoice: state.setCharacterVoice,
      saveScene: state.saveScene,
      deleteScene: state.deleteScene,
      saveShot: state.saveShot,
      linkAsset: state.linkAsset,
      setSegmentAsset: state.setSegmentAsset,
      selectEpisode: state.selectEpisode,
    })),
  );

  const episodeId = overview?.episode.id ?? "";
  // provider/ctx 共用的单参形态（updateEpisode 需要集 id，这里烤入）。
  const updateEpisode = (patch: { title: string; status: ProjectEpisodeStatusLike; script_path: string }) =>
    void storeUpdateEpisode(episodeId, patch);
  const scenes = useMemo(() => overview?.scenes ?? [], [overview]);
  const segments = useMemo(() => overview?.segments ?? [], [overview]);
  const castCharacters = useMemo(() => overview?.characters ?? [], [overview]);
  const episodeLocations = useMemo(() => overview?.locations ?? [], [overview]);
  const episodeProps = useMemo(() => overview?.props ?? [], [overview]);

  // ── 数据层（旧引擎钩子原样复用：按集状态 + 布局派生 + 自愈/兜底加载）──
  const data = useCanvasData({
    episodeId, overview, scenes, segments, castCharacters, episodeLocations,
    episodeProps, characters, locations, props, loadPrompts, loadCharacters,
    loadLocations, loadProps, saveCanvasLayout,
  });

  // 节点分组（Ctrl+G，按集 localStorage——与旧画布同键）。
  const [nodeGroups, , persistNodeGroups] = usePerEpisodeStorage(episodeId, "nodegroups", EMPTY_NODE_GROUPS);
  // 占位/纸片 → 片段口的暂存线（按集 localStorage——与旧画布同键）。
  const [pendingLinks, , persistPendingLinks] = usePerEpisodeStorage<PendingLink[]>(
    episodeId, "pendinglinks", EMPTY_PENDING_LINKS, parsePendingLinks,
  );

  // 详情窗状态（阶段 D 重做详情窗前，工具按钮先接状态位）。
  const [detailFor, setDetailFor] = useState<DetailTarget | null>(null);

  const promptUntitled = t("project.canvas.promptUntitled");
  const ephTitle = t("project.canvas.ephTitle");
  const scriptUntitled = t("project.canvas.scriptUntitled");

  // ── 工程外围件引擎链（阶段 E1 收编）：组操作（暂存线转正/出生锚点）
  // → 视图（缺项检查/定位/剧本挑挂）→ 空集工作流种子。选择态由基座
  // 自管，这里给组操作挂空实现（其复制粘贴/组拖路径不被外围件使用）。 ──
  const overlaySelRef = useRef<string[]>([]);
  const groupOps = useGroupOps({
    selRef: overlaySelRef,
    pos: data.pos,
    segPos: data.segPos,
    infoOffsets: data.infoOffsets,
    notes: data.notes,
    outputBox: data.outputBox,
    infoNodePos: data.infoNodePos,
    setPos: data.setPos,
    setSegPos: data.setSegPos,
    setNotes: data.setNotes,
    setInfoOffsets: data.setInfoOffsets,
    setOutputPos: data.setOutputPos,
    persistCards: data.persistCards,
    persistSegments: data.persistSegments,
    persistNotes: data.persistNotes,
    persistInfoOffsets: data.persistInfoOffsets,
    saveOutputPos: data.saveOutputPos,
    episodeId,
    overview,
    infoNodes: data.infoNodes,
    entityPhs: data.entityPhs,
    persistEntityPhs: data.persistEntityPhs,
    scriptPhs: data.scriptPhs,
    persistScriptPhs: data.persistScriptPhs,
    promptPhs: data.promptPhs,
    persistPromptPhs: data.persistPromptPhs,
    saveCanvasLayout,
    setSelection: () => {},
    sizeOfNode: data.sizeOfNode,
    setNodeSizes: data.setNodeSizes,
    persistSizes: data.persistSizes,
    removeSegment,
    addNote: data.addNote,
    addEntityPh: data.addEntityPh,
    addSegment,
  });
  // 剧本/提示词纸片的库选弹窗状态（双击纸片 → 选文件/选提示词）。
  const [scriptPickOpen, setScriptPickOpen] = useState(false);
  const [scriptPickTarget, setScriptPickTarget] = useState<string | null>(null);
  const [promptPickOpen, setPromptPickOpen] = useState(false);
  const [promptPickTarget, setPromptPickTarget] = useState<string | null>(null);
  const [promptPickQuery, setPromptPickQuery] = useState("");
  const canvasView = useCanvasView({
    episodeId,
    overview,
    scenes,
    segments,
    looseAssets: overview?.loose_assets ?? [],
    segPos: data.segPos,
    entityPhs: data.entityPhs,
    infoPos: data.infoPos,
    infoNodes: data.infoNodes,
    outputBox: data.outputBox,
    layout: data.layout,
    sizeOfNode: data.sizeOfNode,
    infoNodePos: data.infoNodePos,
    updateEpisode: storeUpdateEpisode,
    linkNode,
    linkAsset,
    setSegmentAsset,
    selectEpisode,
    scriptPhs: data.scriptPhs,
    persistScriptPhs: data.persistScriptPhs,
    infoOffsets: data.infoOffsets,
    persistInfoOffsets: data.persistInfoOffsets,
    nodeSizes: data.nodeSizes,
    persistSizes: data.persistSizes,
    dropPendingLinksOf: groupOps.dropPendingLinksOf,
    scriptPickTarget,
    setScriptPickOpen,
    setScriptPickTarget,
    setPulseKeys: groupOps.setPulseKeys,
    spawnAnchorRef: groupOps.spawnAnchorRef,
    armSpawnAt: groupOps.armSpawnAt,
  });
  // 空集默认工作流种子（首次进入自动铺片段+占位骨架）。
  useWorkflowSeed({
    episodeId,
    overview,
    addSegment,
    layout: data.layout,
    persistEntityPhs: data.persistEntityPhs,
    persistPromptPhs: data.persistPromptPhs,
    persistScriptPhs: data.persistScriptPhs,
    persistInfoOffsets: data.persistInfoOffsets,
    persistPendingLinks,
  });

  // ── 场景框：位置（scenes.canvas 之外叠本地实时层）+ 标签牌整组拖动 ──
  const [scenePos, setScenePos] = useState<Record<string, Pos>>({});
  useEffect(() => {
    setScenePos((prev) => {
      const next: Record<string, Pos> = {};
      scenes.forEach((scene) => {
        next[scene.id] = prev[scene.id] ?? (scene.canvas_x != null && scene.canvas_y != null
          ? { x: scene.canvas_x, y: scene.canvas_y }
          : data.layout.framePos[scene.id] ?? { x: WORLD_MARGIN, y: 110 });
      });
      return next;
    });
  }, [scenes, data.layout.framePos]);
  // 标签牌拖动 = 整组移动（框 + 场景内全部镜头卡），松手落工程表。
  const sceneDragRef = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; members: string[] } | null>(null);
  const handleSceneLabelPointerDown = (e: React.PointerEvent) => {
    const label = (e.target as Element).closest(".pc-frame-label");
    if (!label || e.button !== 0) return;
    const frame = label.closest(".pc-frame");
    const sceneId = frame?.getAttribute("data-scene") ?? "";
    const base = scenePos[sceneId];
    if (!base) return;
    e.preventDefault();
    const members = data.layout.cards.filter((c) => c.sceneId === sceneId).map((c) => c.shot.id);
    sceneDragRef.current = { id: sceneId, sx: e.clientX, sy: e.clientY, ox: base.x, oy: base.y, members };
    const onMove = (ev: PointerEvent) => {
      const drag = sceneDragRef.current;
      if (!drag) return;
      const dx = (ev.clientX - drag.sx) / (canvasView.view.scale || 1);
      const dy = (ev.clientY - drag.sy) / (canvasView.view.scale || 1);
      setScenePos((prev) => ({ ...prev, [drag.id]: { x: drag.ox + dx, y: drag.oy + dy } }));
      data.setPos((prev) => {
        const cards = { ...prev.cards };
        drag.members.forEach((shotId) => {
          const origin = data.layout.cardPos[shotId];
          if (origin) cards[shotId] = { x: origin.x + dx, y: origin.y + dy };
        });
        return { ...prev, cards };
      });
    };
    const onUp = () => {
      const drag = sceneDragRef.current;
      sceneDragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!drag) return;
      const dx = (dragLastX - drag.sx) / (canvasView.view.scale || 1);
      const dy = (dragLastY - drag.sy) / (canvasView.view.scale || 1);
      void saveCanvasLayout({
        assets: [],
        shots: drag.members.map((shotId) => {
          const origin = data.layout.cardPos[shotId];
          return { id: shotId, x: (origin?.x ?? 0) + dx, y: (origin?.y ?? 0) + dy };
        }),
        scenes: [{ id: drag.id, x: drag.ox + dx, y: drag.oy + dy }],
      });
    };
    let dragLastX = e.clientX;
    let dragLastY = e.clientY;
    const trackMove = (ev: PointerEvent) => {
      dragLastX = ev.clientX;
      dragLastY = ev.clientY;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointermove", trackMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  // ── 场景/镜头快速表单 ──
  const [sceneForm, setSceneForm] = useState<{ id?: string; heading: string; locationId: string } | null>(null);
  const [shotForm, setShotForm] = useState<{ id: string; sceneId: string; description: string; dialogue: string } | null>(null);
  const [deleteSceneTarget, setDeleteSceneTarget] = useState<ProjectScene | null>(null);
  const [locationPickOpen, setLocationPickOpen] = useState(false);
  useEffect(() => {
    if ((sceneForm || shotForm) && locations.length === 0) void storeLoadLocations();
  }, [sceneForm, shotForm, locations.length, storeLoadLocations]);
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
  // 提示词库选确认（纸片记 promptId，画布层状态）；详情窗保持打开，
  // 纸片内容经 promptPhs 状态刷新。
  const handlePromptPick = (promptId: string) => {
    setPromptPickOpen(false);
    setPromptPickQuery("");
    const target = promptPickTarget;
    setPromptPickTarget(null);
    if (!target || !target.startsWith("prompt:")) return;
    const phId = target.slice(7);
    if (!data.promptPhs.some((item) => item.id === phId)) return;
    data.persistPromptPhs(data.promptPhs.map((item) => (item.id === phId ? { ...item, promptId } : item)));
  };
  const closePromptPick = () => {
    setPromptPickOpen(false);
    setPromptPickTarget(null);
    setPromptPickQuery("");
  };

  // ── 连线层（阶段 C）：旧引擎钩子复用——wires（gen 链+手动素材线聚合）、
  // segWires（node_links 按承载节点去重）、口色与顶掉/换源语义。实测锚点
  // 由基座（FreeCanvas 的 useNodeMetrics）经 renderWires 插槽下发，这里的
  // useNodeMetrics 只取纯数据派生（vpRef 给空 ref，DOM 实测跳过）。
  const dummyVpRef = useRef<HTMLDivElement | null>(null);
  const metrics = useNodeMetrics({
    vpRef: dummyVpRef,
    view: { x: 0, y: 0, scale: 1 },
    layout: data.layout,
    scenes,
    links: overview?.links ?? [],
    nodeSizes: data.nodeSizes,
    infoNodes: data.infoNodes,
    segments,
    promptPhs: data.promptPhs,
    entityPhs: data.entityPhs,
    pos: data.pos,
    cardSizeOf: () => ({ w: 240, h: 200 }),
    outputBox: data.outputBox,
    segPos: data.segPos,
    sizeOfNode: data.sizeOfNode,
    infoNodePos: data.infoNodePos,
    infoGroups: data.infoGroups,
  });
  const nodeLinks = overview?.node_links ?? [];
  const ports = usePorts({
    overview,
    unlinkNode,
    pendingLinks,
    persistPendingLinks,
    nodeLinks,
    ownerKeyOfLink: metrics.ownerKeyOfLink,
    scenes,
    infoGroups: data.infoGroups,
    entityPhs: data.entityPhs,
    episodeId,
    linkNode,
    setEpisodeOutput,
  });

  // provider 公共依赖（两个装配共用；data 对象随渲染换身份，正好让
  // api/nodes 每次渲染重建——与旧 ProjectCanvas 的订阅渲染频率一致）。
  const providerDeps = {
    episodeId, overview, segments, layout: data.layout as CanvasLayout, infoNodes: data.infoNodes,
    pos: data.pos, segPos: data.segPos, infoOffsets: data.infoOffsets,
    outputBox: data.outputBox, nodeSizes: data.nodeSizes,
    infoNodePos: data.infoNodePos, sizeOfNode: data.sizeOfNode,
    entityPhs: data.entityPhs, scriptPhs: data.scriptPhs, promptPhs: data.promptPhs,
    notes: data.notes, infoGroups: data.infoGroups, prompts,
    nodeGroups,
    // 连线落库（阶段 C）
    nodeLinks, segWires: ports.segWires, pendingLinks, persistPendingLinks,
    displacePortLinks: ports.displacePortLinks, nodeKeyParts: ports.nodeKeyParts,
    ownerKeyOfLink: metrics.ownerKeyOfLink,
    linkNode, unlinkNode, unlinkAssets,
    setPos: data.setPos, setSegPos: data.setSegPos, setInfoOffsets: data.setInfoOffsets,
    setNodeSizes: data.setNodeSizes, setNotes: data.setNotes,
    persistCards: data.persistCards, persistSegments: data.persistSegments,
    persistInfoOffsets: data.persistInfoOffsets, persistSizes: data.persistSizes,
    persistNotes: data.persistNotes, persistEntityPhs: data.persistEntityPhs,
    persistScriptPhs: data.persistScriptPhs, persistPromptPhs: data.persistPromptPhs,
    persistInfoGroups: data.persistInfoGroups, persistNodeGroups,
    saveOutputPos: data.saveOutputPos,
    addNote: data.addNote, addEntityPh: data.addEntityPh,
    addScriptPh: data.addScriptPh, addPromptPh: data.addPromptPh,
    addSegment, deleteShot, removeSegment, setEpisodeOutput,
    setEpisodeCharacters, setEpisodeLocations, setEpisodeProps, updateEpisode,
    ephTitle, promptUntitled, scriptUntitled,
  };

  const nodes = buildProjectNodes({ ...providerDeps, nodes: [] });
  const api = buildProjectCanvasApi({ ...providerDeps, nodes });

  // ── 工程节点内容层的数据源 ──
  const projectCtx: ProjectCanvasContextValue = {
    libraryRoot, episodeId, overview, scenes, segments,
    castCharacters, episodeLocations, episodeProps,
    characters, locations, props, prompts,
    layout: data.layout,
    infoGroups: data.infoGroups,
    entityPhs: data.entityPhs,
    scriptPhs: data.scriptPhs,
    promptPhs: data.promptPhs,
    notes: data.notes,
    editingNoteId: data.editingNoteId,
    noteDraft: data.noteDraft,
    setNoteDraft: data.setNoteDraft,
    setEditingNoteId: data.setEditingNoteId,
    persistNotes: data.persistNotes,
    shotNoOf: (sceneId, shotId) => {
      const scene = scenes.find((item) => item.id === sceneId);
      const index = scene ? scene.shots.findIndex((shot) => shot.id === shotId) : -1;
      return index + 1;
    },
    onPickForShot,
    // 场景/镜头表单与提示词库选面板阶段 E1/D 已接回：镜头卡编辑钮与
    // 纸片库选经 ctx 到真实状态（此前空实现=镜头编辑/纸片双击无响应）。
    setShotForm: setShotForm,
    deleteShot,
    detailFor,
    setDetailFor,
    removeGroup: (groupId) => data.persistInfoGroups(data.infoGroups.filter((g) => g.id !== groupId)),
    detachScript: () => {
      if (overview?.episode) {
        void updateEpisode({ title: overview.episode.title, status: overview.episode.status, script_path: "" });
      }
    },
    removeScriptPh: (phId) => data.persistScriptPhs(data.scriptPhs.filter((p) => p.id !== phId)),
    removeInfoEntity: (kind, entityId) => {
      if (!overview) return;
      if (kind === "character") void setEpisodeCharacters(episodeId, (overview.episode.character_ids ?? []).filter((v) => v !== entityId));
      else if (kind === "location") void setEpisodeLocations(episodeId, (overview.episode.location_ids ?? []).filter((v) => v !== entityId));
      else void setEpisodeProps(episodeId, (overview.episode.prop_ids ?? []).filter((v) => v !== entityId));
    },
    removeEntityPh: (id) => data.persistEntityPhs(data.entityPhs.filter((p) => p.id !== id)),
    // 纸片双击/工具钮的库选入口：接真实状态（此前是空实现——纸片双击
    // 与工具钮全部无响应，用户报告「双击弹窗都有问题」的根源之一）。
    setPromptPickTarget: setPromptPickTarget,
    setPromptPickOpen: setPromptPickOpen,
    moveSegment: (id, dir) => void moveSegment(id, dir < 0 ? -1 : 1),
    removeSegment: (id) => void removeSegment(id),
    outputSourceLabel: null,
    setEpisodeOutput,
  };

  // ── 连线渲染插槽（阶段 C）：基座下发实测锚点与手势状态，这里组装旧
  // WiresLayer（gen 链/端口线/暂存线/成片线 + 拖线草稿）。摘线中的线隐藏
  // 按 fc 的单线 lifted（connId 前缀）适配旧 LiftedWire 形状。
  const renderWires = (slot: {
    view: { x: number; y: number; scale: number };
    vpSize: { w: number; h: number } | null;
    liftedWire: { connId: string; fromKey: string } | null;
    wireDraft: { d: string; invalid: boolean; color?: string } | null;
    outPointOf(key: string): { x: number; y: number } | null;
    inPointOf(key: string, portId?: string): { x: number; y: number } | null;
  }) => {
    let lifted: LiftedWire | null = null;
    if (slot.liftedWire) {
      const { connId, fromKey } = slot.liftedWire;
      if (connId.startsWith("p:")) {
        const [fk, seg, port] = connId.slice(2).split("|");
        lifted = {
          fromKey,
          pendings: pendingLinks.filter((l) => l.fromKey === fk && l.toSegmentId === seg && l.toPort === port),
          rows: [],
        };
      } else if (connId.startsWith("s:")) {
        lifted = { fromKey, pendings: [], rows: nodeLinks.filter((l) => l.id === connId.slice(2)) };
      }
    }
    return (
      <>
      <div onPointerDown={handleSceneLabelPointerDown}>
      <SceneFrames
        scenes={scenes}
        scenePos={scenePos}
        layout={data.layout}
        pos={data.pos}
        setSceneForm={setSceneForm}
        setShotForm={setShotForm}
        setDeleteSceneTarget={setDeleteSceneTarget}
      />
      </div>
      <WiresLayer
        wires={metrics.wires}
        segWires={ports.segWires}
        pendingLinks={pendingLinks}
        liftedWire={lifted}
        wireDraft={slot.wireDraft}
        outputBox={data.outputBox}
        segments={segments}
        overview={overview}
        wiresVis={{
          x: -slot.view.x / slot.view.scale - WIRES_VIEWPORT_PAD,
          y: -slot.view.y / slot.view.scale - WIRES_VIEWPORT_PAD,
          w: ((slot.vpSize?.w ?? 0) || 1600) / slot.view.scale + WIRES_VIEWPORT_PAD * 2,
          h: ((slot.vpSize?.h ?? 0) || 900) / slot.view.scale + WIRES_VIEWPORT_PAD * 2,
        }}
        outPointOf={slot.outPointOf}
        inPointOf={slot.inPointOf}
        portsOf={ports.portsOf}
        nodeWireColorOf={ports.nodeWireColorOf}
      />
      </>
    );
  };

  // ── 详情窗装配（阶段 D）：按 detailFor 分派骨架与操作集 ──
  // closeDetail 统一出口（×/遮罩/Esc）：二级选择浮层（提示词库选/剧本
  // 文件选）开着时只关浮层不关详情窗——先关最上层，再按一次才关窗。
  const closeDetail = () => {
    if (promptPickOpen) {
      closePromptPick();
      return;
    }
    if (scriptPickOpen) {
      setScriptPickOpen(false);
      setScriptPickTarget(null);
      return;
    }
    setDetailFor(null);
  };
  const detailOps: DetailWindowOps = {
    libraryRoot,
    overview,
    segments,
    nodeLinks,
    pendingLinks,
    characters,
    locations,
    props,
    prompts,
    promptPhs: data.promptPhs,
    scriptPhs: data.scriptPhs,
    setVoice: (id, voicePath) => void setCharacterVoice(id, voicePath),
    setAvatar: (character, refPath) => {
      void saveCharacter({
        id: character.id,
        name: character.name,
        role_tag: character.role_tag,
        bio: character.bio,
        prompt: character.prompt,
        avatar_path: refPath,
        reference_paths: character.reference_paths,
        voice_path: character.voice_path ?? "",
      });
    },
    loadEntity: (ephId, kind, entityId) => {
      // 装入：先关联到集（概览带出实体节点），再把该占位的暂存线转正为
      // node_link（语义对齐旧占位转正），最后移除占位、跳到实体详情。
      void (async () => {
        if (kind === "character") await setEpisodeCharacters(episodeId, [...new Set([...(overview?.episode.character_ids ?? []), entityId])]);
        else if (kind === "location") await setEpisodeLocations(episodeId, [...new Set([...(overview?.episode.location_ids ?? []), entityId])]);
        else await setEpisodeProps(episodeId, [...new Set([...(overview?.episode.prop_ids ?? []), entityId])]);
        const phKey = `eph:${ephId}`;
        for (const p of pendingLinks.filter((l) => l.fromKey === phKey)) {
          linkNode(episodeId, kind, entityId, p.toSegmentId, p.toPort as Parameters<typeof linkNode>[4], "");
        }
        persistPendingLinks(pendingLinks.filter((l) => l.fromKey !== phKey));
        data.persistEntityPhs(data.entityPhs.filter((ph) => ph.id !== ephId));
        setDetailFor({ kind: "info", group: kind, sourceKey: `${kind === "character" ? "char" : kind === "location" ? "loc" : "prop"}:${entityId}` });
      })();
    },
    removeLink: (row) => {
      if (row.pending) {
        persistPendingLinks(pendingLinks.filter((l) => !(l.fromKey === row.fromKey && l.toSegmentId === row.toSegment && l.toPort === row.toPort)));
        return;
      }
      // 正式行：组认领线整组断（与切线同语义）。
      const group = ports.segWires.find((w) => w.links[0]?.id === row.rowId);
      const rows = group && group.links[0]?.id === row.rowId ? group.links : nodeLinks.filter((l) => l.id === row.rowId);
      rows.forEach((l) => {
        void unlinkNode(l.from_kind, l.from_id, l.to_segment, l.to_port, l.owner_key);
      });
    },
    attachEntities: (segmentId, port, entities) => {
      entities.forEach((e) => {
        linkNode(episodeId, e.kind, e.id, segmentId, port as Parameters<typeof linkNode>[4], "");
      });
    },
    openPromptPick: (phKey) => {
      setPromptPickTarget(phKey);
      setPromptPickOpen(true);
    },
    openScriptPick: (key) => {
      setScriptPickTarget(key);
      setScriptPickOpen(true);
    },
    onClose: closeDetail,
  };

  return (
    <CanvasDataContext.Provider value={api}>
      <ProjectCanvasContext.Provider value={projectCtx}>
        <FreeCanvas
          canvasId={episodeId}
          renderWires={renderWires}
          overlays={(
            <>
              <IssueBar
                issues={canvasView.issues}
                scriptPhs={data.scriptPhs}
                segments={segments}
                locateOutput={() => canvasView.locateOutput()}
                locateScript={(key) => canvasView.locateScript(key)}
                armSpawnFromEvent={(x, y) => canvasView.armSpawnFromEvent(x, y)}
                addScriptPh={data.addScriptPh}
                locateEmptySegment={() => canvasView.locateEmptySegment()}
                setDetailFor={(v) => {
                  const target = typeof v === "function" ? null : v;
                  if (target && target.kind === "segment") setDetailFor({ kind: "segment", id: target.id });
                }}
              />
              <AddBtnBar onPickForShot={onPickForShot} setSceneForm={setSceneForm} />
              <EpisodeCard overlay={overlay} scenes={scenes} looseAssets={overview?.loose_assets ?? []} wires={metrics.wires} />
              <SceneFormDialog sceneForm={sceneForm} setSceneForm={setSceneForm} locations={locations} submitSceneForm={submitSceneForm} />
              <ShotFormDialog shotForm={shotForm} setShotForm={setShotForm} submitShotForm={submitShotForm} />
              <DeleteSceneConfirm deleteSceneTarget={deleteSceneTarget} setDeleteSceneTarget={setDeleteSceneTarget} deleteScene={(id) => void deleteScene(id)} />
              <ScriptPickDialog
                scriptPickOpen={scriptPickOpen}
                setScriptPickTarget={setScriptPickTarget}
                setScriptPickOpen={setScriptPickOpen}
                handleScriptPick={canvasView.handleScriptPick}
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
            </>
          )}
          onOpenNodeDetail={(node) => {
            // 双击必出详情窗（用户定案）：剧本/提示词纸片的挂靠动作收进
            // 窗内钉底钮，点开二级选择浮层；不再直弹选择框。
            const key = node.id;
            if (key.startsWith("segment:")) setDetailFor({ kind: "segment", id: key.slice(8) });
            else if (key.startsWith("eph:")) setDetailFor({ kind: "entityPh", id: key.slice(4), group: node.type as EntityPhKind });
            else if (/^(char|loc|prop|grp):/.test(key)) setDetailFor({ kind: "info", group: node.type as EntityPhKind, sourceKey: key });
            else if (key === "script" || key.startsWith("script:")) setDetailFor({ kind: "scriptPh", key });
            else if (key.startsWith("prompt:")) setDetailFor({ kind: "promptPh", id: key.slice(7) });
            else if (key === "output") setDetailFor({ kind: "output" });
          }}
        />
        {detailFor && (
          <ProjectDetailWindow target={detailFor} ops={detailOps} />
        )}
      </ProjectCanvasContext.Provider>
    </CanvasDataContext.Provider>
  );
}
