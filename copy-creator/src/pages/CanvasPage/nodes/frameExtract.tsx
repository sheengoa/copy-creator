import { Icons } from "../../../components/Icons";
import { MEDIA_COLOR } from "./colors";
import { FrameExtractBody } from "./FrameExtractBody";
import { VIDEO_EXTS } from "./exts";
import type { NodeDefinition } from "./types";

// 视频抽帧（2026-11-01）：视频自己加载进节点（无输入口），产物是一张
// 图片——输出口按图像类型走，下游一切图像消费口都能接。首/尾帧二族
// 合一渲染（阶段 4g 迁入）。取媒写回走 video-tool 模式（写 video_path
// 并清旧产物，语义与工具三节点一致）。
const framePorts = { ins: [], out: { mediaKind: "image" as const } };

export const videoFirstFrameDef: NodeDefinition = {
  type: "video_first_frame",
  chrome: "standard",
  menu: { group: "load", icon: Icons.arrowLeftToLine },
  accent: MEDIA_COLOR.video,
  size: { w: 280, h: null },
  minSize: { w: 240, h: 200 },
  fallbackSize: { w: 280, h: 240 },
  ports: framePorts,
  pickerKinds: ["video"],
  applyMode: "video-tool",
  dropAccept: true,
  dropExtensions: VIDEO_EXTS,
  Component: FrameExtractBody,
};

export const videoLastFrameDef: NodeDefinition = {
  type: "video_last_frame",
  chrome: "standard",
  menu: { group: "load", icon: Icons.arrowRightToLine },
  accent: MEDIA_COLOR.video,
  size: { w: 280, h: null },
  minSize: { w: 240, h: 200 },
  fallbackSize: { w: 280, h: 240 },
  ports: framePorts,
  pickerKinds: ["video"],
  applyMode: "video-tool",
  dropAccept: true,
  dropExtensions: VIDEO_EXTS,
  Component: FrameExtractBody,
};
