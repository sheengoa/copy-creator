import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { useProjectStore, type ProjectAsset } from "../../../stores/projectStore";
import { CanvasDataContext } from "../../CanvasPage/dataContext";
import FreeCanvas from "../../CanvasPage/FreeCanvas";
import { ProjectCanvasContext, type ProjectCanvasContextValue } from "../../CanvasPage/nodes/project/projectContext";
import { EMPTY_NODE_GROUPS, type CanvasLayout } from "../ProjectCanvas/types";
import type { DetailForState } from "../ProjectCanvas/layers/NodeExtras";
import { usePerEpisodeStorage } from "../usePerEpisodeStorage";
import { useCanvasData } from "../ProjectCanvas/engine/useCanvasData";

/** updateEpisode 补丁的状态字段（store 的 ProjectEpisodeStatus）。 */
type ProjectEpisodeStatusLike = Parameters<ReturnType<typeof useProjectStore.getState>["updateEpisode"]>[1]["status"];
import { buildProjectCanvasApi, buildProjectNodes } from "./projectProvider";

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
    })),
  );

  const episodeId = overview?.episode.id ?? "";
  // provider/ctx 共用的单参形态（updateEpisode 需要集 id，这里烤入）。
  const updateEpisode = (patch: { title: string; status: ProjectEpisodeStatusLike; script_path: string }) =>
    void storeUpdateEpisode(episodeId, patch);
  const scenes = overview?.scenes ?? [];
  const segments = overview?.segments ?? [];
  const castCharacters = overview?.characters ?? [];
  const episodeLocations = overview?.locations ?? [];
  const episodeProps = overview?.props ?? [];

  // ── 数据层（旧引擎钩子原样复用：按集状态 + 布局派生 + 自愈/兜底加载）──
  const data = useCanvasData({
    episodeId, overview, scenes, segments, castCharacters, episodeLocations,
    episodeProps, characters, locations, props, loadPrompts, loadCharacters,
    loadLocations, loadProps, saveCanvasLayout,
  });

  // 节点分组（Ctrl+G，按集 localStorage——与旧画布同键）。
  const [nodeGroups, , persistNodeGroups] = usePerEpisodeStorage(episodeId, "nodegroups", EMPTY_NODE_GROUPS);

  // 详情窗状态（阶段 D 重做详情窗前，工具按钮先接状态位）。
  const [detailFor, setDetailFor] = useState<DetailForState | null>(null);

  const promptUntitled = t("project.canvas.promptUntitled");
  const ephTitle = t("project.canvas.ephTitle");

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
    ephTitle, promptUntitled,
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
    // 场景/镜头表单与提示词库选面板随阶段 E1/D 接回，先接空实现。
    setShotForm: () => {},
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
    setPromptPickTarget: () => {},
    setPromptPickOpen: () => {},
    moveSegment: (id, dir) => void moveSegment(id, dir < 0 ? -1 : 1),
    removeSegment: (id) => void removeSegment(id),
    outputSourceLabel: null,
    setEpisodeOutput,
  };

  return (
    <CanvasDataContext.Provider value={api}>
      <ProjectCanvasContext.Provider value={projectCtx}>
        <FreeCanvas canvasId={episodeId} />
      </ProjectCanvasContext.Provider>
    </CanvasDataContext.Provider>
  );
}
