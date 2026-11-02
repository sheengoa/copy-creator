import type { ReactNode } from "react";
import { VideoToolRuntimeCtx, type VideoToolRuntime } from "./videoToolRuntimeCtx";

// 视频工具运行时 Provider（组件独立成文件，满足 react-refresh 纯组件
// 导出约定；状态与控制器见 videoToolRuntime.tsx）。
export function VideoToolRuntimeProvider({
  runtime,
  children,
}: {
  runtime: VideoToolRuntime;
  children: ReactNode;
}) {
  return <VideoToolRuntimeCtx.Provider value={runtime}>{children}</VideoToolRuntimeCtx.Provider>;
}
