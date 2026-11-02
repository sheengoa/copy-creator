import { Icons } from "../../../components/Icons";
import { MEDIA_COLOR } from "./colors";
import { GenImageBody } from "./GenImageBody";
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
  // 产物聚合：备选按主图置顶排序（下游引用取主图，点备选可切换）。
  aggregate: (from) => {
    if (from.metadata.kind !== "gen_image") return { paths: [], text: "" };
    const sorted = [...from.metadata.images].sort((a, b) => (a.primary === b.primary ? 0 : a.primary ? -1 : 1));
    return { paths: sorted.map((img) => img.resource_path), text: "" };
  },
  // 撤销恢复归一：删除时取消的后台生成，恢复时不再转圈（引擎 undo 调用）。
  normalizeRestored: (meta) =>
    meta.kind === "gen_image" && meta.status === "generating"
      ? { ...meta, status: "error", error: "生成已中断" }
      : meta,
  // 批量生成队列白名单（多选 ≥2 出浮动条，GenRuntime 顺序执行）。
  batchGenerate: true,
  Component: GenImageBody,
};
