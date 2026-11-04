import type { ReactNode } from "react";
import type { CanvasNode } from "../../../stores/canvasStore";
import { MEDIA_COLOR } from "./colors";
import {
  collectionImageDef,
  collectionTextDef,
  collectionVideoDef,
} from "./collection";
import { videoFirstFrameDef, videoLastFrameDef } from "./frameExtract";
import { genImageDef } from "./genImage";
import { genAudioDef, genVideoDef } from "./genPlaceholder";
import { loadAudioDef, loadImageDef, loadVideoDef } from "./loadMedia";
import { loadTextDef } from "./loadText";
import { noteDef } from "./note";
import { previewAudioDef, previewImageDef, previewVideoDef } from "./previewMedia";
import { saveAudioDef, saveImageDef, saveVideoDef } from "./saveMedia";
import type { MenuGroup, NodeDefinition, NodeIO, PortDef } from "./types";
import { videoExtractAudioDef, videoSeekFrameDef, videoToGifDef } from "./videoTool";
import { PROJECT_NODE_DEFS } from "./project";

// 节点注册表（画布节点基座化）：自由画布 22 种 + 工程作用域 8 种节点
// 类型的 def 单点登记（工程视图节点化 2026-11-05 阶段 B，键放宽为
// string——工程作用域自注册类型 id）。下方的派生表（端口/颜色/尺寸/
// 菜单/扩展名）保持原表形状导出，引擎调用点零改动。

const FREE_NODE_DEFS: Record<string, NodeDefinition> = {
  gen_image: genImageDef,
  gen_video: genVideoDef,
  gen_audio: genAudioDef,
  load_text: loadTextDef,
  load_image: loadImageDef,
  load_video: loadVideoDef,
  load_audio: loadAudioDef,
  video_first_frame: videoFirstFrameDef,
  video_last_frame: videoLastFrameDef,
  video_seek_frame: videoSeekFrameDef,
  video_to_gif: videoToGifDef,
  video_extract_audio: videoExtractAudioDef,
  save_image: saveImageDef,
  save_video: saveVideoDef,
  save_audio: saveAudioDef,
  preview_image: previewImageDef,
  preview_video: previewVideoDef,
  preview_audio: previewAudioDef,
  collection_text: collectionTextDef,
  collection_image: collectionImageDef,
  collection_video: collectionVideoDef,
  note: noteDef,
};

export const NODE_DEFS: Record<string, NodeDefinition> = Object.fromEntries([
  ...Object.entries(FREE_NODE_DEFS),
  ...PROJECT_NODE_DEFS.map((def) => [def.type, def] as const),
]);

/** 建节点菜单的展示顺序（各组内顺序与基座化前 menuGroups 逐项一致；
 *  工程节点排在自由画布节点之后）。 */
export const MENU_TYPE_ORDER: string[] = [
  ...Object.keys(FREE_NODE_DEFS),
  ...PROJECT_NODE_DEFS.map((def) => def.type),
];

const MENU_GROUP_ORDER: MenuGroup[] = ["gen", "load", "collection", "output", "misc", "project"];

const recordOf = <T,>(pick: (def: NodeDefinition) => T): Record<string, T> =>
  Object.fromEntries(MENU_TYPE_ORDER.map((t) => [t, pick(NODE_DEFS[t])]));

/** 类型化端口矩阵（原 FreeCanvas.PORT_DEFS，数据已内聚进各 def）。 */
export const PORT_DEFS = recordOf((d) => d.ports);

/** 建节点默认尺寸（h=null = 高度内容自适应；原 NODE_DEFAULT_SIZE）。 */
export const NODE_DEFAULT_SIZE = recordOf((d) => d.size);

/** 缩放下限（原 NODE_MIN_SIZE）。 */
export const NODE_MIN_SIZE = recordOf((d) => d.minSize);

/** 连线锚点实测前的兜底尺寸（原 NODE_FALLBACK_SIZE）。 */
export const NODE_FALLBACK_SIZE = recordOf((d) => d.fallbackSize);

/** 节点主题色通道（原 NODE_ACCENT，B+ 视觉标准：按所属媒体链路取色）。 */
export const NODE_ACCENT = recordOf((d) => d.accent);

/** 「从资源库选择」浮层的类型白名单（原 LIBRARY_PICKER_KINDS）。 */
export const LIBRARY_PICKER_KINDS: Partial<Record<string, string[]>> = Object.fromEntries(
  MENU_TYPE_ORDER.filter((t) => NODE_DEFS[t].pickerKinds).map((t) => [t, NODE_DEFS[t].pickerKinds]),
);

/** 加载/视频工具节点允许的文件扩展名（原 loadAllowedExts，读 def）。 */
export const loadAllowedExts = (type: string): string[] => [...(NODE_DEFS[type]?.dropExtensions ?? [])];

/** 视频进节点的五类型（首/尾帧 + 任意抽帧/转 GIF/抽音轨）：OS 拖入与
 *  资源库/本地选片都写 metadata.video_path 并清旧产物，语义与抽帧一致。 */
export const VIDEO_TOOL_TYPES: readonly string[] = MENU_TYPE_ORDER.filter(
  (t) => NODE_DEFS[t].applyMode === "video-tool",
);

export const isVideoToolType = (type: string | undefined): boolean =>
  !!type && VIDEO_TOOL_TYPES.includes(type);

/** 端口匹配/取色的最小节点形（手势/菜单过滤只有 type+metadata 在手，
 *  CanvasNode 天然可赋值；metadata 逐节点内容由各 def 自行解释）。 */
export type NodeLike = { type: string; metadata: unknown };

/** 节点端口矩阵取值（portsOf 逐节点覆写优先，静态 ports 兜底）。 */
export function ioOf(node: NodeLike): NodeIO {
  const def = NODE_DEFS[node.type];
  return def.portsOf ? def.portsOf(node as CanvasNode) : def.ports;
}

/** 来源节点的输出口数据类型（工程 data 匹配用；自由画布节点返回
 *  mediaKind，语义等价——accepts 的 node 匹配不走这里）。 */
export function outDataTypeOf(node: NodeLike): string {
  const out = ioOf(node).out;
  return out ? (out.dataType ?? out.mediaKind) : "";
}

/** 输出口/连线取色（逐节点覆写优先）：def 级 color > 数据类型色 >
 *  节点主题色。工程实体口的粉/绿/橙与镜头卡的图/视频切换都靠它。 */
export function outWireColorOf(node: NodeLike): string {
  const def = NODE_DEFS[node.type];
  const out = ioOf(node).out;
  if (!out) return def.accent;
  return out.color ?? MEDIA_COLOR[out.mediaKind];
}

/** 原按类型取色的旧入口（草稿线等只需类型级颜色的调用点；含动态端口
 *  的类型走中位缺省——工程节点的草稿线色请用 outWireColorOf）。 */
export function outMediaColor(type: string): string {
  const def = NODE_DEFS[type];
  const out = def?.ports.out;
  return out ? out.color ?? MEDIA_COLOR[out.mediaKind] : def?.accent ?? "#94a3b8";
}

/** 输入口与来源节点是否兼容（两套语义并存）：自由画布口 accepts 存
 *  节点类型（node 匹配）；工程口 accepts 存数据类型（data 匹配，按
 *  来源节点输出口的 dataType 判定——镜头卡图/视频动态切换由此生效）。 */
export function portFits(port: PortDef, sourceNode: NodeLike): boolean {
  if (port.match === "data") return port.accepts.includes(outDataTypeOf(sourceNode));
  return port.accepts.includes(sourceNode.type);
}

/** 节点 def 是否归属当前作用域（互斥规则：工程视图只收 project+both，
 *  自由画布只收 free+both；缺省 free）。 */
export function scopeFits(defScope: NodeDefinition["scope"], scope: "free" | "project"): boolean {
  const own = defScope ?? "free";
  return own === "both" || own === scope;
}

/** 建节点菜单条目（按三类链路分组 + 便签 + 工程组），组内顺序见
 *  MENU_TYPE_ORDER；menuHidden 的类型（镜头/成片）不列出。 */
export const menuGroups: { key: string; types: string[] }[] = MENU_GROUP_ORDER.map((key) => ({
  key,
  types: MENU_TYPE_ORDER.filter((t) => NODE_DEFS[t].menu.group === key && !NODE_DEFS[t].menuHidden),
}));

/** 菜单条目图标（原 menuIconOf switch，现读 def）。 */
export const menuIconOf = (type: string): ReactNode => NODE_DEFS[type].menu.icon;
