// 工程画布实体类型与引用稳定常量（自 ProjectCanvas.tsx 零改动搬运，
// 2026-11-03 引擎拆分阶段 11a；fork 对齐点按原注释保持）。

import type { ProjectAsset, ProjectScene, ProjectShot } from "../../../stores/projectStore";

export type Pos = { x: number; y: number };
export type PosMap = { cards: Record<string, Pos>; info?: Pos };

export interface CardAsset {
  asset: ProjectAsset;
  w: number;
  h: number;
}

/** 镜头卡（含素材网格）/ 散件 / 资料节点的统一渲染模型。 */
export interface CanvasCard {
  key: string; // `shot:<id>`
  shot: ProjectShot;
  sceneId: string;
  w: number;
  h: number;
  assets: CardAsset[];
}
export interface CanvasInfo {
  key: string; // `char:<id>` | `loc:<id>` | `prop:<id>` | `script`
  kind: "character" | "location" | "prop" | "script";
  name: string;
  avatarPath: string; // 角色/场景参考图（相对库根）
  textPath: string; // 剧本正文（相对库根）
  w: number;
  h: number;
}

/** 画布便签节点（ComfyUI Note 的对应物），按集存 localStorage。 */
export interface CanvasNote {
  id: string;
  text: string;
  x: number;
  y: number;
}

export type EntityPhKind = "character" | "location" | "prop";
/** 空白资料占位节点（角色/场景/道具未加载实体前的画布占位）。 */
export interface EntityPh { id: string; kind: EntityPhKind; x: number; y: number }

/** 剧本纸片（多实例）：空纸片双击挂文件；本集无剧本时首个挂接转正为主剧本。 */
export interface ScriptPh { id: string; path: string }

/** 提示词纸片（多实例）：空纸片双击从提示词库选一条，promptId 为空即未填充；
 *  出生点存 x/y（与空白资料占位一致），拖动后的位置走 infoOffsets。 */
export interface PromptPh { id: string; promptId: string; x: number; y: number }

/** 资料组节点：一个节点装多个同类实体，一条线接入片段。 */
export interface InfoGroup {
  id: string;
  kind: EntityPhKind;
  members: string[];
}

/** 占位节点/剧本纸片连到片段口的暂存线（画布层，localStorage 按集）。 */
export interface PendingLink { fromKey: string; toSegmentId: string; toPort: string }

/** 节点分组（Ctrl+G，ComfyUI Group 的对应物）。 */
export interface NodeGroup { id: string; label: string; members: string[] }

// usePerEpisodeStorage 的 fallback/parse 会进 effect 依赖，必须是模块级
// 常量/纯函数（引用稳定），故统一定义在此。
export const EMPTY_NOTES: CanvasNote[] = [];
export const EMPTY_SCRIPT_PHS: ScriptPh[] = [];
export const EMPTY_PROMPT_PHS: PromptPh[] = [];
export const EMPTY_ENTITY_PHS: EntityPh[] = [];
export const EMPTY_INFO_GROUPS: InfoGroup[] = [];
export const EMPTY_SIZES: Record<string, { w: number; h: number }> = {};
export const EMPTY_INFO_OFFSETS: Record<string, Pos> = {};
export const EMPTY_PENDING_LINKS: PendingLink[] = [];
export const EMPTY_NODE_GROUPS: NodeGroup[] = [];
// 剧本纸片做形状防御：历史脏数据（非数组/缺字段）不进画布，直接回退空。
export const parseScriptPhs = (raw: string): ScriptPh[] => {
  const list = JSON.parse(raw) as ScriptPh[];
  return Array.isArray(list) ? list.filter((item) => item && typeof item.id === "string") : [];
};
// 提示词纸片同款形状防御。
export const parsePromptPhs = (raw: string): PromptPh[] => {
  const list = JSON.parse(raw) as PromptPh[];
  return Array.isArray(list) ? list.filter((item) => item && typeof item.id === "string") : [];
};
// 素材占位节点已整体移除：加载暂存线时顺手过滤历史遗留的占位来源，
// 画布层不再出现该类线（存储直清见组件内的存量清理 effect）。
export const parsePendingLinks = (raw: string): PendingLink[] => {
  const parsed = JSON.parse(raw) as PendingLink[];
  return Array.isArray(parsed)
    ? parsed.filter((l) => l && typeof l.fromKey === "string" && !l.fromKey.startsWith("placeholder:"))
    : [];
};

export interface CanvasFrame {
  id: string; // sceneId | "info"
  scene: ProjectScene | null;
  label: string;
  w: number;
  h: number;
}

export interface CanvasLayout {
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

export interface WireBox extends Pos {
  w: number;
  h: number;
}

export interface WireItem {
  fromKey: string; // 容器 key：shot:<id>
  toKey: string;
  kind: "gen" | "manual";
  type: string; // 线上流动的数据类型 = 来源素材的 kind
}
