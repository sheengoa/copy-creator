import { createContext, useContext } from "react";
import type {
  EpisodeOverview,
  ProjectCharacter,
  ProjectLocation,
  ProjectPrompt,
  ProjectProp,
  ProjectScene,
  ProjectSegment,
} from "../../../../stores/projectStore";
import type {
  CanvasLayout,
  CanvasNote,
  EntityPh,
  EntityPhKind,
  InfoGroup,
  PromptPh,
  ScriptPh,
} from "../../../ResourcePage/ProjectCanvas/types";
import type { DetailTarget } from "../../../ResourcePage/ProjectShell/DetailWindow";

// 工程节点内容层的数据源（工程视图节点化 2026-11-05 阶段 B）：工程节点
// defs 的 Component 经此读取工程库概览/按集画布状态与操作——旧 ProjectCanvas
// 渲染层的 props 全部换源为 ctx，节点基座（NodeShell/手势/引擎）不感知
// 工程语义。无组件模块，Provider 由 ProjectShell 直接挂。

export interface ProjectCanvasContextValue {
  libraryRoot: string;
  episodeId: string;
  overview: EpisodeOverview | null;
  scenes: ProjectScene[];
  segments: ProjectSegment[];
  /** 集关联三库（出场角色/出镜场景/出镜道具，overview 带出）。 */
  castCharacters: ProjectCharacter[];
  episodeLocations: ProjectLocation[];
  episodeProps: ProjectProp[];
  /** 全局三库（组员解析兜底）。 */
  characters: ProjectCharacter[];
  locations: ProjectLocation[];
  props: ProjectProp[];
  prompts: ProjectPrompt[];
  /** 按集画布状态（useCanvasData 引擎钩子产出）。 */
  layout: Omit<CanvasLayout, "infoFramePos">;
  infoGroups: InfoGroup[];
  entityPhs: EntityPh[];
  scriptPhs: ScriptPh[];
  promptPhs: PromptPh[];
  notes: CanvasNote[];
  editingNoteId: string | null;
  noteDraft: string;
  setNoteDraft(text: string): void;
  setEditingNoteId(id: string | null): void;
  persistNotes(notes: CanvasNote[]): void;
  /** 镜头序号（场景内序）。 */
  shotNoOf(sceneId: string, shotId: string): number;
  onPickForShot(shotId: string): void;
  setShotForm(form: { id: string; sceneId: string; description: string; dialogue: string } | null): void;
  deleteShot(shotId: string): void;
  /** 详情窗/选择器（阶段 D 重做详情窗，B 阶段先接旧状态位）。 */
  detailFor: DetailTarget | null;
  setDetailFor: (value: DetailTarget | null) => void;
  removeGroup(groupId: string): void;
  detachScript(): unknown;
  removeScriptPh(phId: string): void;
  removeInfoEntity(kind: EntityPhKind, entityId: string): unknown;
  removeEntityPh(id: string): void;
  setPromptPickTarget(key: string): void;
  setPromptPickOpen(open: boolean): void;
  moveSegment(id: string, dir: number): unknown;
  removeSegment(id: string): unknown;
  outputSourceLabel: string | null;
  setEpisodeOutput(episodeId: string, key: string | null): unknown;
}

export const ProjectCanvasContext = createContext<ProjectCanvasContextValue | null>(null);

/** 工程节点内容层取数据源；未挂 Provider = 装配错误。 */
export function useProjectCanvas(): ProjectCanvasContextValue {
  const value = useContext(ProjectCanvasContext);
  if (!value) throw new Error("ProjectCanvasContext 缺失：工程节点必须在 ProjectShell 内渲染");
  return value;
}
