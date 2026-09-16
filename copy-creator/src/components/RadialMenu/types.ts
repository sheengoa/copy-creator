// 径向菜单的共享类型、常量与无状态工具：只做声明与纯函数，
// 不包含组件状态与副作用，供 index.tsx 与同目录模块复用。
import { invoke } from "@tauri-apps/api/core";
import { Icons } from "../Icons";
import { useSettingsStore } from "../../stores/settingsStore";
import type { RadialPreviewDirection, RadialPreviewSegment } from "../../domain/preview";
import type { RadialDragKind, RadialDragSource } from "../../utils/radialDrag";
import type { ResourceMediaKind } from "../../domain/mediaKind";

export type TabKey = "clipboard" | "phrases" | "resources";

export const NAV_TAB_ICONS: Record<TabKey, typeof Icons.clipboard> = {
  clipboard: Icons.clipboard,
  phrases: Icons.phrases,
  resources: Icons.resources,
};

export const RADIAL_LAST_TAB_SETTING = "radial_last_tab";
export const RADIAL_TAB_KEYS: TabKey[] = ["clipboard", "phrases", "resources"];

export const MAX_ITEMS = 2000;
// 快捷输入「全部」视图展示条数：覆盖高频短语，按最近使用倒序，
// 更多内容通过搜索或切到具体分组查看。
export const PHRASES_ALL_LIMIT = 15;
export const RADIAL_DRAG_THRESHOLD_PX = 6;
export const IS_LINUX = typeof navigator !== "undefined"
  && /Linux/i.test(navigator.userAgent)
  && !/Android/i.test(navigator.userAgent);

// 诊断日志：转发到后端日志文件，排查仅真实交互可复现的拖动时序问题。
export const flog = (message: string) => {
  void invoke("debug_log", { message }).catch(() => {});
};

// 拖动虚影上限：与后端 make_drag_image 的 MAX_DIM 保持一致。
export const RADIAL_DRAG_GHOST_PX = 128;

// 抓取条目已渲染的缩略图交给后端当拖动虚影，避免后端解码原图
// （大图会拖慢拖动启动 ~1s）。无图或未加载完成返回 null，由后端
// 回退磁盘解码。
export const captureDragThumbnail = (itemId: string): string | null => {
  try {
    const img = document
      .querySelector(`[data-radial-item-id="${CSS.escape(itemId)}"]`)
      ?.querySelector("img");
    if (!img || !img.complete || !img.naturalWidth) return null;
    const scale = Math.min(
      1,
      RADIAL_DRAG_GHOST_PX / Math.max(img.naturalWidth, img.naturalHeight),
    );
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
};

export interface RadialItem {
  id: string;
  content: string;
  type: string;
  /** file 短语指向图像文件时为相对存储路径：条目显示缩略图，悬浮展开大图预览。 */
  imagePath?: string;
  /** 剪切板 file 记录的完整本地路径：条目据此渲染视频封面帧等媒体视觉。 */
  filePath?: string;
  /** filePath 的媒体视觉判定（映射时经 domain 计算，渲染层只读不判）。 */
  fileMediaKind?: "video" | "audio" | "image" | null;
  createdAt?: string;
  title?: string;
  contentTruncated?: boolean;
  previewAvailable: boolean;
  dragPath?: string;
  dragKind: RadialDragKind;
  dragSource: RadialDragSource;
  isResource?: boolean;
  resourceKind?: ResourceMediaKind;
  resourcePath?: string;
  resourceTitle?: string;
  resourceSummary?: string;
  /** 「最近使用」条目的来源标签（剪切板 / 快捷输入·分组 / 资源·分组）。 */
  sourceLabel?: string;
  /** 「全部」视图的使用时间标签（相对时间或「未使用过」）；有值时替代 createdAt 展示。 */
  usedAtLabel?: string;
  /** 使用次数：「最多使用」模式下条目尾部展示「N 次」。 */
  useCount?: number;
}

export interface PreviewLayout {
  direction: RadialPreviewDirection;
  width: number;
}

export interface PreviewState {
  itemId: string;
  segments: RadialPreviewSegment[] | null;
  layout: PreviewLayout;
}

export interface PendingNativeDrag {
  itemId: string;
  dragSource: RadialDragSource;
  dragPath?: string;
  sessionId: number;
  pointerId: number;
  startX: number;
  startY: number;
  startScreenX: number;
  startScreenY: number;
  devicePixelRatio: number;
  thresholdCrossed: boolean;
  armRequested: boolean;
  armCompleted: boolean;
  startRequested: boolean;
  nativeStarted: boolean;
}

export interface RadialDragEvent {
  session_id: number;
}

export async function loadPasteLeftClickSetting() {
  try {
    const mode = await invoke<string>("get_setting", { key: "paste_left_click" });
    useSettingsStore.setState({
      pasteLeftClick: mode === "terminal" ? "terminal" : "normal",
    });
  } catch {
    // Keep the default normal paste mode if the setting is unavailable.
  }
}
