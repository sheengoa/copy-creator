import { Icons } from "../../../../components/Icons";
import { NODE_ACCENTS, PORT_COLORS } from "../../../ResourcePage/ProjectCanvas/colors";
import { INFO_H, SCRIPT_W } from "../../../ResourcePage/ProjectCanvas/layout";
import { ScriptPaperBody } from "./bodies";
import type { NodeDefinition } from "../types";

// 工程剧本纸片 def（多实例）：空纸片双击挂文件；本集无剧本时首个挂接
// 转正为主剧本。主剧本（key = "script"）与画布纸片（script:<phid>）共用
// 本 def——渲染体自旧 InfoNodesLayer 剧本分支移植（2026-11-05 阶段 B）。
// 剧本连线在后端以集为锚，纸片连线走画布暂存线（阶段 C 接入）。

export const scriptPaperDef: NodeDefinition = {
  type: "scriptPaper",
  scope: "project",
  chrome: "standard",
  menu: { group: "project", icon: Icons.file },
  accent: NODE_ACCENTS.script,
  size: { w: SCRIPT_W, h: INFO_H + 40 },
  minSize: { w: 180, h: 120 },
  fallbackSize: { w: SCRIPT_W, h: INFO_H + 40 },
  ports: {
    ins: [],
    out: { mediaKind: "text", dataType: "text", color: PORT_COLORS.script },
  },
  Component: ScriptPaperBody,
};
