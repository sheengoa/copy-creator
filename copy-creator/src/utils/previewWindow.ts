import { invoke } from "@tauri-apps/api/core";
import type { RadialPreviewSegment } from "./radialPreview";

export interface ContentPreviewPayload {
  title: string;
  segments: RadialPreviewSegment[];
}

/**
 * 打开独立内容预览窗口（以鼠标指针为中心弹出，可拖拽调整大小）。
 * 主窗口媒体展开与径向菜单展开按钮共用。
 */
export async function openContentPreviewWindow(
  title: string,
  segments: RadialPreviewSegment[],
): Promise<void> {
  try {
    await invoke("open_preview_window", { title, segments });
  } catch (error) {
    // 弹窗失败必须留痕：静默吞掉会表现为「点了没反应」。
    console.error("[preview-window] open failed:", error);
  }
}
