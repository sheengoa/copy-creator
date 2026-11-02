import { Icons } from "../../../components/Icons";
import { MEDIA_COLOR } from "./colors";
import type { NodeDefinition } from "./types";

// 图像生成节点（渲染自 FreeCanvas 条件链 L3278 迁入，阶段 4f）。
export const genImageDef: NodeDefinition = {
  type: "gen_image",
  chrome: "standard",
  menu: { group: "gen", icon: Icons.image },
  accent: MEDIA_COLOR.image,
  size: { w: 280, h: null },
  minSize: { w: 200, h: 180 },
  fallbackSize: { w: 280, h: 300 },
  ports: {
    ins: [
      { id: "text", accepts: ["load_text", "collection_text"], mediaKind: "text" },
      {
        id: "image",
        accepts: ["load_image", "collection_image", "video_first_frame", "video_last_frame", "video_seek_frame", "video_to_gif"],
        mediaKind: "image",
      },
    ],
    out: { mediaKind: "image" },
  },
};
