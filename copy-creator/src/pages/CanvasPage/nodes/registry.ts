import type { ReactNode } from "react";
import type { CanvasNodeType } from "../../../stores/canvasStore";
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
import type { MenuGroup, NodeDefinition } from "./types";
import { videoExtractAudioDef, videoSeekFrameDef, videoToGifDef } from "./videoTool";

// 节点注册表（画布节点基座化）：全部 22 种节点类型的 def 单点登记。
// NODE_DEFS 的 Record<CanvasNodeType, …> 形状即注册完整性守卫——新增
// 节点类型漏登记直接 typecheck 失败。下方的派生表（端口/颜色/尺寸/菜单/
// 扩展名）保持 FreeCanvas 原表形状导出，引擎调用点零改动。

export const NODE_DEFS: Record<CanvasNodeType, NodeDefinition> = {
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

/** 建节点菜单的展示顺序（各组内顺序与基座化前 menuGroups 逐项一致）。 */
export const MENU_TYPE_ORDER: CanvasNodeType[] = [
  "gen_image",
  "gen_video",
  "gen_audio",
  "load_text",
  "load_image",
  "load_video",
  "load_audio",
  "video_first_frame",
  "video_last_frame",
  "video_seek_frame",
  "video_to_gif",
  "video_extract_audio",
  "collection_text",
  "collection_image",
  "collection_video",
  "save_image",
  "preview_image",
  "save_video",
  "preview_video",
  "save_audio",
  "preview_audio",
  "note",
];

const MENU_GROUP_ORDER: MenuGroup[] = ["gen", "load", "collection", "output", "misc"];

const recordOf = <T,>(pick: (def: NodeDefinition) => T): Record<CanvasNodeType, T> =>
  Object.fromEntries(MENU_TYPE_ORDER.map((t) => [t, pick(NODE_DEFS[t])])) as Record<CanvasNodeType, T>;

/** 类型化端口矩阵（原 FreeCanvas.PORT_DEFS，数据已内聚进各 def）。 */
export const PORT_DEFS = recordOf((d) => d.ports);

/** 建节点默认尺寸（h=null = 高度内容自适应；原 NODE_DEFAULT_SIZE）。 */
export const NODE_DEFAULT_SIZE = recordOf((d) => d.size);

/** 缩放下限（原 NODE_MIN_SIZE）。 */
export const NODE_MIN_SIZE = recordOf((d) => d.minSize);

/** 连线锚点实测前的兜底尺寸（原 NODE_FALLBACK_SIZE）。 */
export const NODE_FALLBACK_SIZE = recordOf((d) => d.fallbackSize);

/** 节点主题色通道（原 NODE_ACCENT，B+ 视觉标准：按媒体链路取色）。 */
export const NODE_ACCENT = recordOf((d) => d.accent);

/** 「从资源库选择」浮层的类型白名单（原 LIBRARY_PICKER_KINDS）。 */
export const LIBRARY_PICKER_KINDS: Partial<Record<CanvasNodeType, string[]>> = Object.fromEntries(
  MENU_TYPE_ORDER.filter((t) => NODE_DEFS[t].pickerKinds).map((t) => [t, NODE_DEFS[t].pickerKinds]),
);

/** 加载/视频工具节点允许的文件扩展名（原 loadAllowedExts，读 def）。 */
export const loadAllowedExts = (type: CanvasNodeType): string[] => [...(NODE_DEFS[type].dropExtensions ?? [])];

/** 视频进节点的五类型（首/尾帧 + 任意抽帧/转 GIF/抽音轨）：OS 拖入与
 *  资源库/本地选片都写 metadata.video_path 并清旧产物，语义与抽帧一致。 */
export const VIDEO_TOOL_TYPES: readonly CanvasNodeType[] = MENU_TYPE_ORDER.filter(
  (t) => NODE_DEFS[t].applyMode === "video-tool",
);

export const isVideoToolType = (type: CanvasNodeType | undefined): boolean =>
  !!type && VIDEO_TOOL_TYPES.includes(type);

/** 输出口/连线取色：按产物媒体类型（图像蓝/视频紫/音频绿），不跟节点
 *  主题色——视频工具节点主题是视频紫，但图像/音频产物口不该被带紫
 *  （用户 2026-11-02 定案）；其余节点的主题色本就等于产物类型色，外观
 *  不变。无产物口的节点（note）回退主题色。 */
export function outMediaColor(type: CanvasNodeType): string {
  const out = NODE_DEFS[type].ports.out;
  return out ? MEDIA_COLOR[out.mediaKind] : NODE_DEFS[type].accent;
}

/** 建节点菜单条目（按三类链路分组 + 便签），组内顺序见 MENU_TYPE_ORDER。 */
export const menuGroups: { key: string; types: CanvasNodeType[] }[] = MENU_GROUP_ORDER.map((key) => ({
  key,
  types: MENU_TYPE_ORDER.filter((t) => NODE_DEFS[t].menu.group === key),
}));

/** 菜单条目图标（原 menuIconOf switch，现读 def）。 */
export const menuIconOf = (type: CanvasNodeType): ReactNode => NODE_DEFS[type].menu.icon;
