import { Icons } from "../../../components/Icons";
import { MEDIA_COLOR } from "./colors";
import { PreviewMediaBody } from "./PreviewMediaBody";
import type { NodeDefinition } from "./types";

// 预览三族 def：入口接受对应生成/加载节点，仅试听/试看不落盘。渲染三族
// 合一（PreviewMediaBody，阶段 4a 迁入）。

export const previewImageDef: NodeDefinition = {
  type: "preview_image",
  chrome: "standard",
  menu: { group: "output", icon: Icons.eye },
  accent: MEDIA_COLOR.image,
  size: { w: 320, h: null },
  minSize: { w: 200, h: 160 },
  fallbackSize: { w: 320, h: 260 },
  ports: {
    ins: [{ id: "in", accepts: ["gen_image", "load_image", "video_first_frame", "video_last_frame", "video_seek_frame", "video_to_gif"], mediaKind: "image" }],
    out: null,
  },
  // 双击开大图（上游主产物）。
  onDoubleClick: (node, services) => {
    const primary = services.upstream(node.id)?.paths[0];
    if (primary) services.openLightbox(primary);
  },
  Component: PreviewMediaBody,
};

export const previewVideoDef: NodeDefinition = {
  type: "preview_video",
  chrome: "standard",
  menu: { group: "output", icon: Icons.eye },
  accent: MEDIA_COLOR.video,
  size: { w: 360, h: null },
  minSize: { w: 220, h: 160 },
  fallbackSize: { w: 360, h: 240 },
  ports: {
    ins: [{ id: "in", accepts: ["gen_video", "load_video"], mediaKind: "video" }],
    out: null,
  },
  Component: PreviewMediaBody,
};

export const previewAudioDef: NodeDefinition = {
  type: "preview_audio",
  chrome: "standard",
  menu: { group: "output", icon: Icons.eye },
  accent: MEDIA_COLOR.audio,
  size: { w: 280, h: null },
  minSize: { w: 180, h: 110 },
  fallbackSize: { w: 280, h: 130 },
  ports: {
    ins: [{ id: "in", accepts: ["gen_audio", "load_audio", "video_extract_audio"], mediaKind: "audio" }],
    out: null,
  },
  Component: PreviewMediaBody,
};
