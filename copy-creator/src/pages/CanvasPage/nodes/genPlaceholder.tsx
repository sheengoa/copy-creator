import { Icons } from "../../../components/Icons";
import { MEDIA_COLOR } from "./colors";
import { GenPlaceholderBody } from "./GenPlaceholderBody";
import type { NodeDefinition } from "./types";

// 视频/音频生成节点：协议未接入（决策 10：按钮置灰留置），当前仅模型
// 参数 + 禁用生成按钮的占位渲染（阶段 4e 迁入）。
export const genVideoDef: NodeDefinition = {
  type: "gen_video",
  chrome: "standard",
  menu: { group: "gen", icon: Icons.video },
  accent: MEDIA_COLOR.video,
  size: { w: 280, h: null },
  minSize: { w: 200, h: 160 },
  fallbackSize: { w: 280, h: 240 },
  ports: {
    ins: [
      { id: "text", accepts: ["load_text", "collection_text"], mediaKind: "text" },
      { id: "video", accepts: ["load_video", "collection_video"], mediaKind: "video" },
      {
        id: "image",
        accepts: ["load_image", "collection_image", "video_first_frame", "video_last_frame", "video_seek_frame", "video_to_gif"],
        mediaKind: "image",
      },
    ],
    out: { mediaKind: "video" },
  },
  Component: GenPlaceholderBody,
};

export const genAudioDef: NodeDefinition = {
  type: "gen_audio",
  chrome: "standard",
  menu: { group: "gen", icon: Icons.audio },
  accent: MEDIA_COLOR.audio,
  size: { w: 260, h: null },
  minSize: { w: 180, h: 130 },
  fallbackSize: { w: 260, h: 180 },
  ports: {
    ins: [{ id: "text", accepts: ["load_text", "collection_text"], mediaKind: "text" }],
    out: { mediaKind: "audio" },
  },
  Component: GenPlaceholderBody,
};
