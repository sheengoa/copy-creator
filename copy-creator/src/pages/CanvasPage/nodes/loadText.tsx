import { Icons } from "../../../components/Icons";
import { MEDIA_COLOR } from "./colors";
import type { NodeDefinition } from "./types";

// 加载文本节点：正文是常驻编辑框——视觉标准 B+ 的固定高特例
// （壳 height 恒渲染，不随内容自适应）。
export const loadTextDef: NodeDefinition = {
  type: "load_text",
  chrome: "standard",
  menu: { group: "load", icon: Icons.file },
  accent: MEDIA_COLOR.text,
  size: { w: 260, h: null },
  minSize: { w: 180, h: 120 },
  fallbackSize: { w: 260, h: 150 },
  ports: { ins: [], out: { mediaKind: "text" } },
  fixedHeight: true,
};
