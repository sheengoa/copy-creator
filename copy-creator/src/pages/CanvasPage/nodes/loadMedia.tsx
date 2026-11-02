import { Icons } from "../../../components/Icons";
import { MEDIA_COLOR } from "./colors";
import { AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS } from "./exts";
import type { NodeDefinition } from "./types";

// 媒体加载三族（image/video/audio）：库选/盘选/OS 拖入同一份扩展名契约，
// 拖到空白按扩展名直接建对应节点。渲染三族合一（阶段 4d 迁入）。
export const loadImageDef: NodeDefinition = {
  type: "load_image",
  chrome: "standard",
  menu: { group: "load", icon: Icons.image },
  accent: MEDIA_COLOR.image,
  size: { w: 260, h: null },
  minSize: { w: 160, h: 140 },
  fallbackSize: { w: 260, h: 220 },
  ports: { ins: [], out: { mediaKind: "image" } },
  pickerKinds: ["image"],
  dropAccept: true,
  dropExtensions: IMAGE_EXTS,
  blankDropExtensions: IMAGE_EXTS,
};

export const loadVideoDef: NodeDefinition = {
  type: "load_video",
  chrome: "standard",
  menu: { group: "load", icon: Icons.video },
  accent: MEDIA_COLOR.video,
  size: { w: 280, h: null },
  minSize: { w: 180, h: 140 },
  fallbackSize: { w: 280, h: 220 },
  ports: { ins: [], out: { mediaKind: "video" } },
  pickerKinds: ["video"],
  dropAccept: true,
  dropExtensions: VIDEO_EXTS,
  blankDropExtensions: VIDEO_EXTS,
};

export const loadAudioDef: NodeDefinition = {
  type: "load_audio",
  chrome: "standard",
  menu: { group: "load", icon: Icons.audio },
  accent: MEDIA_COLOR.audio,
  size: { w: 260, h: null },
  minSize: { w: 180, h: 110 },
  fallbackSize: { w: 260, h: 140 },
  ports: { ins: [], out: { mediaKind: "audio" } },
  pickerKinds: ["audio"],
  dropAccept: true,
  dropExtensions: AUDIO_EXTS,
  blankDropExtensions: AUDIO_EXTS,
};
