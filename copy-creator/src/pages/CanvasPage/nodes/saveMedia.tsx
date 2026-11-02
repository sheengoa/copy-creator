import { Icons } from "../../../components/Icons";
import { MEDIA_COLOR } from "./colors";
import type { NodeDefinition } from "./types";

// 保存三族：入口接受对应生成/加载节点，产物去向由自动保存管线决定
// （资源库 / 指定路径，决策 19）。渲染三族 100% 共享（阶段 4b 迁入）。
export const saveImageDef: NodeDefinition = {
  type: "save_image",
  chrome: "standard",
  menu: { group: "output", icon: Icons.resources },
  accent: MEDIA_COLOR.image,
  size: { w: 250, h: null },
  minSize: { w: 180, h: 130 },
  fallbackSize: { w: 250, h: 170 },
  ports: {
    ins: [{ id: "in", accepts: ["gen_image", "video_first_frame", "video_last_frame", "video_seek_frame", "video_to_gif"], mediaKind: "image" }],
    out: null,
  },
};

export const saveVideoDef: NodeDefinition = {
  type: "save_video",
  chrome: "standard",
  menu: { group: "output", icon: Icons.resources },
  accent: MEDIA_COLOR.video,
  size: { w: 280, h: null },
  minSize: { w: 180, h: 120 },
  fallbackSize: { w: 280, h: 150 },
  ports: {
    ins: [{ id: "in", accepts: ["gen_video"], mediaKind: "video" }],
    out: null,
  },
};

export const saveAudioDef: NodeDefinition = {
  type: "save_audio",
  chrome: "standard",
  menu: { group: "output", icon: Icons.audio },
  accent: MEDIA_COLOR.audio,
  size: { w: 260, h: null },
  minSize: { w: 180, h: 110 },
  fallbackSize: { w: 260, h: 130 },
  ports: {
    ins: [{ id: "in", accepts: ["gen_audio", "video_extract_audio"], mediaKind: "audio" }],
    out: null,
  },
};
