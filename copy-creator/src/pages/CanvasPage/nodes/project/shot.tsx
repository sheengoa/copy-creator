import { Icons } from "../../../../components/Icons";
import { NODE_ACCENTS, REF_ACCEPTS, WIRE_TYPE_COLORS } from "../../../ResourcePage/ProjectCanvas/colors";
import { ShotBody, ShotTools } from "./bodies";
import type { NodeDefinition, NodeIO } from "../types";

// 工程镜头卡 def：场景框内的素材网格卡。渲染体自旧 ShotCards 移植
// （2026-11-05 阶段 B）；头栏沿用旧 pc-shot-head（序号+描述+对白），壳
// 头栏由 hideHead 关闭。输出口随素材有无视频切换 image/video（portsOf
// 逐节点覆写），参考输入口按数据类型匹配。画布不新建镜头（menuHidden）。

const shotPorts = (hasVideo: boolean): NodeIO => ({
  ins: [{ id: "in", labelKey: "project.canvas.portRef", accepts: [...REF_ACCEPTS], mediaKind: "image", match: "data" }],
  out: {
    mediaKind: hasVideo ? "video" : "image",
    dataType: hasVideo ? "video" : "image",
    color: WIRE_TYPE_COLORS[hasVideo ? "video" : "image"],
  },
});

export const shotDef: NodeDefinition = {
  type: "shot",
  scope: "project",
  chrome: "standard",
  hideHead: true,
  menuHidden: true,
  menu: { group: "project", icon: Icons.clapperboard },
  accent: NODE_ACCENTS.shot,
  size: { w: 240, h: 200 },
  minSize: { w: 160, h: 140 },
  fallbackSize: { w: 240, h: 200 },
  ports: shotPorts(false),
  portsOf: (node) => shotPorts((node.metadata as { hasVideo?: boolean } | undefined)?.hasVideo === true),
  Component: ShotBody,
  ToolsExtra: ShotTools,
};
