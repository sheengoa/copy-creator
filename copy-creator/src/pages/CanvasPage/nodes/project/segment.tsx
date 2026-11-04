import { Icons } from "../../../../components/Icons";
import { NODE_ACCENTS, PORT_COLORS, WIRE_TYPE_COLORS } from "../../../ResourcePage/ProjectCanvas/colors";
import { SEG_H, SEG_W } from "../../../ResourcePage/ProjectCanvas/layout";
import { SegmentBody, SegmentTools } from "./bodies";
import type { NodeDefinition } from "../types";

// 工程片段节点 def：AI 分段生成的视频分段，按拼接序汇入本集成片。渲染
// 体自旧 SegmentNodes 移植（2026-11-05 阶段 B）。六输入口沿用历史口 id
// （script/prompt 为存量口名）；兼容分三档：角色/场景/道具同为图片类
// 可互相穿插；剧本与提示词同为文本类可互相穿插；「其他」口不限类型。

const SEG_PORTS = [
  { id: "character", labelKey: "project.canvas.typeCharacter", color: PORT_COLORS.character, accepts: ["image"], mediaKind: "image" },
  { id: "location", labelKey: "project.canvas.typeLocation", color: PORT_COLORS.location, accepts: ["image"], mediaKind: "image" },
  { id: "prop", labelKey: "project.canvas.typeProp", color: PORT_COLORS.prop, accepts: ["image"], mediaKind: "image" },
  { id: "prompt", labelKey: "project.canvas.typePrompt", color: PORT_COLORS.prompt, accepts: ["prompt", "text"], mediaKind: "text" },
  { id: "script", labelKey: "project.canvas.typeScript", color: PORT_COLORS.script, accepts: ["text", "prompt"], mediaKind: "text" },
  { id: "other", labelKey: "project.canvas.typeOther", color: PORT_COLORS.other, accepts: ["image", "video", "audio", "file", "text", "prompt"], mediaKind: "image" },
] as const;

export const segmentDef: NodeDefinition = {
  type: "segment",
  scope: "project",
  chrome: "standard",
  menu: { group: "project", icon: Icons.clapperboard },
  accent: NODE_ACCENTS.segment,
  size: { w: SEG_W, h: SEG_H },
  minSize: { w: 220, h: 160 },
  fallbackSize: { w: SEG_W, h: SEG_H },
  ports: {
    ins: SEG_PORTS.map((p) => ({
      id: p.id,
      labelKey: p.labelKey,
      color: p.color,
      accepts: [...p.accepts],
      mediaKind: p.mediaKind,
      match: "data" as const,
    })),
    out: { mediaKind: "video", dataType: "video", color: WIRE_TYPE_COLORS.video },
  },
  Component: SegmentBody,
  ToolsExtra: SegmentTools,
};
