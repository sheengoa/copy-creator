import { Icons } from "../../../../components/Icons";
import { NODE_ACCENTS, PORT_COLORS } from "../../../ResourcePage/ProjectShell/colors";
import { INFO_H, SCRIPT_W } from "../../../ResourcePage/ProjectShell/layout";
import { PromptPaperBody, PromptPaperTools } from "./bodies";
import type { NodeDefinition } from "../types";

// 工程提示词纸片 def（多实例）：空纸片双击从提示词库选一条，内容直接
// 显示在纸片上。渲染体自旧 PromptPhNodes 移植（2026-11-05 阶段 B）；
// 连线走画布暂存线（提示词是画布层记忆，不入库，阶段 C 接入）。

export const promptPaperDef: NodeDefinition = {
  type: "promptPaper",
  scope: "project",
  chrome: "standard",
  menu: { group: "project", icon: Icons.file },
  accent: NODE_ACCENTS.prompt,
  size: { w: SCRIPT_W, h: null },
  minSize: { w: 180, h: 110 },
  fallbackSize: { w: SCRIPT_W, h: INFO_H + 40 },
  ports: {
    ins: [],
    out: { mediaKind: "text", dataType: "prompt", color: PORT_COLORS.prompt },
  },
  Component: PromptPaperBody,
  ToolsExtra: PromptPaperTools,
};
