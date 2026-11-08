import { Icons } from "../../../../components/Icons";
import { NODE_ACCENTS } from "../../../ResourcePage/ProjectShell/colors";
import { OUTPUT_H, OUTPUT_W } from "../../../ResourcePage/ProjectShell/layout";
import { OutputBody } from "./bodies";
import type { NodeDefinition } from "../types";

// 工程成片输出节点 def：本集工作流的总输出口（片段按序聚合，无需连线）。
// 渲染体自旧 OutputNode 移植（2026-11-05 阶段 B）；成片连线渲染在阶段 C
// 的 WiresLayer 移植里接入。画布不新建（menuHidden）。双击开输出详情窗
// ——壳层分派与 DetailWindow 的 output 视图早已就绪，唯节点入口漏接
// （实测 P2-4：双击无反应，整套输出详情成死代码）。

export const outputDef: NodeDefinition = {
  type: "output",
  scope: "project",
  chrome: "standard",
  menuHidden: true,
  menu: { group: "project", icon: Icons.clapperboard },
  accent: NODE_ACCENTS.output,
  size: { w: OUTPUT_W, h: OUTPUT_H },
  minSize: { w: 220, h: 140 },
  fallbackSize: { w: OUTPUT_W, h: OUTPUT_H },
  minHeightOf: () => OUTPUT_H,
  ports: {
    ins: [{ id: "in", labelKey: "project.canvas.portFinal", accepts: ["video"], mediaKind: "video", match: "data" }],
    out: null,
  },
  onDoubleClick: (node, services) => {
    services.openNodeDetail?.(node);
  },
  Component: OutputBody,
};
