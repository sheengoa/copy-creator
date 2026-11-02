import { Icons } from "../../../components/Icons";
import { MEDIA_COLOR } from "./colors";
import type { NodeDefinition } from "./types";

// 合集三族：画布上唯一的多线入口（multi，落线追加不顶掉）；成员为对应
// 加载节点与对应生成产物。渲染三族合一（阶段 4c 迁入）。
export const collectionTextDef: NodeDefinition = {
  type: "collection_text",
  chrome: "standard",
  menu: { group: "collection", icon: Icons.copy },
  accent: MEDIA_COLOR.text,
  size: { w: 240, h: null },
  minSize: { w: 180, h: 110 },
  fallbackSize: { w: 240, h: 160 },
  ports: {
    ins: [{ id: "text", accepts: ["load_text"], mediaKind: "text", multi: true }],
    out: { mediaKind: "text" },
  },
  // 生成前提：文本合集有任意成员连线即就绪（空内容成员由后端聚合跳过）。
  ready: (node, connections) => connections.some((m) => m.to_node === node.id),
};

export const collectionImageDef: NodeDefinition = {
  type: "collection_image",
  chrome: "standard",
  menu: { group: "collection", icon: Icons.copy },
  accent: MEDIA_COLOR.image,
  size: { w: 240, h: null },
  minSize: { w: 180, h: 110 },
  fallbackSize: { w: 240, h: 160 },
  ports: {
    ins: [
      {
        id: "image",
        accepts: ["load_image", "gen_image", "video_first_frame", "video_last_frame", "video_seek_frame", "video_to_gif"],
        mediaKind: "image",
        multi: true,
      },
    ],
    out: { mediaKind: "image" },
  },
};

export const collectionVideoDef: NodeDefinition = {
  type: "collection_video",
  chrome: "standard",
  menu: { group: "collection", icon: Icons.video },
  accent: MEDIA_COLOR.video,
  size: { w: 260, h: null },
  minSize: { w: 180, h: 110 },
  fallbackSize: { w: 260, h: 160 },
  ports: {
    ins: [{ id: "video", accepts: ["load_video", "gen_video"], mediaKind: "video", multi: true }],
    out: { mediaKind: "video" },
  },
};
