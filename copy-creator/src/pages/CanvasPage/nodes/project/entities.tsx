import { Icons } from "../../../../components/Icons";
import { NODE_ACCENTS, PORT_COLORS, } from "../../../ResourcePage/ProjectCanvas/colors";
import { INFO_H, INFO_W } from "../../../ResourcePage/ProjectCanvas/layout";
import type { EntityPhKind } from "../../../ResourcePage/ProjectCanvas/types";
import { EntityBody, EntityViewTool } from "./bodies";
import type { NodeDefinition } from "../types";

// 工程资料节点 defs（角色/场景/道具）：三种形态（空白占位 eph:/单实体
// char:/loc:/prop:/组 grp:）共用一套渲染体（bodies.EntityBody），渲染体
// 自旧 InfoNodesLayer/EntityPhNodes 移植（2026-11-05 阶段 B）。输出口与
// 连线色跟片段对应输入口同色（角色粉/场景绿/道具橙），兼容性按 image
// 数据类型匹配。

const kindMenuIcon = (kind: EntityPhKind) =>
  kind === "character" ? Icons.clipboard : kind === "location" ? Icons.resources : Icons.star;

const defOfKind = (kind: EntityPhKind): NodeDefinition => ({
  type: kind,
  scope: "project",
  chrome: "standard",
  menu: { group: "project", icon: kindMenuIcon(kind) },
  accent: NODE_ACCENTS[kind],
  size: { w: INFO_W, h: INFO_H },
  minSize: { w: 140, h: 120 },
  fallbackSize: { w: INFO_W, h: INFO_H },
  ports: {
    ins: [],
    // 参考图输出口（占位节点同款）：上画布即可接入工作流。
    out: { mediaKind: "image", dataType: "image", color: PORT_COLORS[kind] },
  },
  Component: EntityBody,
  ToolsExtra: EntityViewTool,
});

export const characterDef: NodeDefinition = defOfKind("character");
export const locationDef: NodeDefinition = defOfKind("location");
export const propDef: NodeDefinition = defOfKind("prop");
