import { Icons } from "../../../components/Icons";
import { MEDIA_COLOR } from "./colors";
import { LoadTextBody } from "./LoadTextBody";
import type { NodeDefinition } from "./types";

// 加载文本节点：正文是常驻编辑框——视觉标准 B+ 的固定高特例
// （壳 height 恒渲染，不随内容自适应）。
export const loadTextDef: NodeDefinition = {
  type: "load_text",
  chrome: "standard",
  menu: { group: "load", icon: Icons.typeT },
  accent: MEDIA_COLOR.text,
  size: { w: 260, h: null },
  minSize: { w: 180, h: 120 },
  fallbackSize: { w: 260, h: 150 },
  ports: { ins: [], out: { mediaKind: "text" } },
  fixedHeight: true,
  // 聚合：文本节点向下游提供提示词文本。
  aggregate: (from) => (from.metadata.kind === "load_text" ? { paths: [], text: from.metadata.content } : { paths: [], text: "" }),
  // 生成前提：作为文本口来源时内容须非空。
  ready: (node) => node.metadata.kind === "load_text" && node.metadata.content.trim().length > 0,
  Component: LoadTextBody,
};
