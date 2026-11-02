import { Icons } from "../../../components/Icons";
import { MEDIA_COLOR } from "./colors";
import { VIDEO_EXTS } from "./exts";
import type { NodeDefinition } from "./types";

// 视频工具三节点（2026-11-02 定稿）：剪辑器式横向长方形——监视器 + 侧栏
// + 缩略图时间轴，460 宽才有可拖的轨道。抽帧/GIF 产物归图像族；音轨
// 产物按音频类型走，下游 save_audio/preview_audio 通用分支消费。
// 轨道+监视器再窄就摆不下（监视器 224 + 侧栏最低可读），min 宽 380。
const toolSize = { w: 460, h: null as number | null };
const toolMin = { w: 380, h: 220 };
const toolFallback = { w: 460, h: 250 };
const toolMedia = {
  pickerKinds: ["video"],
  applyMode: "video-tool" as const,
  dropAccept: true,
  dropExtensions: VIDEO_EXTS,
};

export const videoSeekFrameDef: NodeDefinition = {
  type: "video_seek_frame",
  chrome: "standard",
  menu: { group: "load", icon: Icons.clapperboard },
  accent: MEDIA_COLOR.video,
  size: toolSize,
  minSize: toolMin,
  fallbackSize: toolFallback,
  ports: { ins: [], out: { mediaKind: "image" } },
  ...toolMedia,
};

export const videoToGifDef: NodeDefinition = {
  type: "video_to_gif",
  chrome: "standard",
  // GIF 产物归图像族，菜单图标跟产物。
  menu: { group: "load", icon: Icons.image },
  accent: MEDIA_COLOR.video,
  size: toolSize,
  minSize: toolMin,
  fallbackSize: toolFallback,
  ports: { ins: [], out: { mediaKind: "image" } },
  ...toolMedia,
};

export const videoExtractAudioDef: NodeDefinition = {
  type: "video_extract_audio",
  chrome: "standard",
  menu: { group: "load", icon: Icons.audio },
  accent: MEDIA_COLOR.video,
  size: toolSize,
  minSize: toolMin,
  fallbackSize: toolFallback,
  ports: { ins: [], out: { mediaKind: "audio" } },
  ...toolMedia,
};
