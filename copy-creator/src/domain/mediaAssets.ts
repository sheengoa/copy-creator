// 领域层：媒体资产访问（缩略图/系统播放器/文本预览）的唯一出口。
// UI 层禁止直接 invoke 这些命令（eslint 规则见 eslint.config.js §5.1）。
import { invoke } from "@tauri-apps/api/core";

export { getStoragePath } from "./mediaUrl";

/** 资源库文本文件的预览内容（按扩展名与文件头判定）。 */
export function readResourceTextPreview(path: string): Promise<string> {
  return invoke<string>("read_resource_text_preview", { path });
}

/** 快捷输入文件（quick-input-files/）的文本预览内容。 */
export function readQuickInputTextPreview(path: string): Promise<string> {
  return invoke<string>("read_quick_input_text_preview", { path });
}

/** 剪贴板文本文件记录的预览内容（按记录 id 读取）。 */
export function readClipboardTextPreviewById(id: string): Promise<string> {
  return invoke<string>("read_clipboard_text_preview", { id });
}

/** 文件承载的文本资源完整内容（粘贴与整组拼接用）。 */
export function readTextFileContent(path: string): Promise<string> {
  return invoke<string>("read_text_file_content", { path });
}

// 缩略图命令全局并发上限：解码已下放线程池，仍需限流——大库首次滚动时
// 同时发起几十个解码会挤占 CPU，肉眼可见地拖慢滚动与切换。
const MAX_THUMBNAIL_CONCURRENCY = 3;
let runningThumbnailTasks = 0;
const thumbnailWaiters: (() => void)[] = [];

async function runThumbnailLimited<T>(task: () => Promise<T>): Promise<T> {
  if (runningThumbnailTasks >= MAX_THUMBNAIL_CONCURRENCY) {
    await new Promise<void>((resolve) => thumbnailWaiters.push(resolve));
  }
  runningThumbnailTasks += 1;
  try {
    return await task();
  } finally {
    runningThumbnailTasks -= 1;
    thumbnailWaiters.shift()?.();
  }
}

/** 图片记录/图像文件短语的缩略图（base64 PNG）。 */
export function getImageThumbnail(path: string, maxSize: number): Promise<string> {
  return runThumbnailLimited(() =>
    invoke<string>("get_image_thumbnail", { path, maxSize }),
  );
}

/** 资源库文件（含视频抽帧前的位图）缩略图（base64 PNG）。 */
export function getResourceFileThumbnail(path: string, maxSize: number): Promise<string> {
  return runThumbnailLimited(() =>
    invoke<string>("get_resource_file_thumbnail", { path, maxSize }),
  );
}

/** 用系统默认播放器打开媒体文件（应用内播放失败时的兜底）。 */
export function openResourceFile(path: string): Promise<void> {
  return invoke("open_resource_file", { path });
}
