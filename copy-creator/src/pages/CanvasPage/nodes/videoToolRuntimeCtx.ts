import { createContext, useContext } from "react";
import type { CanvasNode } from "../../../stores/canvasStore";

// 视频工具运行时的 Context 与钩子（无组件模块；状态与控制器在
// videoToolRuntime.tsx 的 useVideoToolRuntimeController，Provider 只做
// 下发——controller 由 FreeCanvas 持有，因为取媒写回（applyFrameVideo）
// 也要清工具会话态）。

export interface TimelineData {
  duration: number;
  w?: number;
  h?: number;
  thumbnails: { t: number; path: string }[];
}

export type VideoToolDraft = Record<string, { t?: number; start?: number; dur?: number }>;

export interface VideoToolRuntime {
  /** 时间轴缓存（按视频路径）。 */
  videoTimelines: Record<string, TimelineData>;
  /** 拖动会话态（key=节点 id）：t=播放头，start/dur=选区。 */
  videoToolDraft: VideoToolDraft;
  setVideoToolDraft: (updater: (prev: VideoToolDraft) => VideoToolDraft) => void;
  /** 视频预览元素注册（MediaPlayback mediaRefCallback 转交；事件回调期
   *  调用，不经渲染期 ref 读写）。 */
  registerVideoEl(nodeId: string, el: HTMLVideoElement | HTMLAudioElement | null): void;
  /** 取预览元素（拖播放头/选区时程序 seek；仅事件回调期调用）。 */
  getVideoEl(nodeId: string): HTMLVideoElement | HTMLAudioElement | null;
  /** 执行中标记（抽帧/工具共用）。 */
  frameBusy: Record<string, boolean>;
  seekToolTo(nodeId: string, t: number): void;
  rangeToolTo(nodeId: string, start: number, dur: number, seekPreview: boolean): void;
  commitVideoTool(nodeId: string): void;
  runVideoTool(node: CanvasNode): Promise<void>;
  runFrameExtract(node: CanvasNode): Promise<void>;
  clearFrameVideo(node: CanvasNode): void;
  /** 换片重置：清拖动会话 + 该视频的轨道失败记账（允许重试）。 */
  resetToolSession(nodeId: string, videoPath: string): void;
}

export const VideoToolRuntimeCtx = createContext<VideoToolRuntime | null>(null);

export function useVideoToolRuntime(): VideoToolRuntime {
  const ctx = useContext(VideoToolRuntimeCtx);
  if (!ctx) throw new Error("useVideoToolRuntime 必须在 <VideoToolRuntimeProvider> 内使用");
  return ctx;
}
