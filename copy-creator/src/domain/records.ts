// 领域层：记录语义与能力判定（全项目唯一事实源）。
// 「这条记录是什么资源 / 能否展开预览 / 怎么粘贴 / 显示什么标题」的规则
// 全部定义在此，均为纯函数（可独立单测）；UI 与 recordView 只调用不判定。
import type { ClipboardRecord } from "../types";
import { fileNameFromPath, getResourceFileName, hasCustomResourceFileName } from "./fileName";
import {
  fileMediaKindFromPath,
  inferResourceMediaKind,
  isTextPreviewableFile,
} from "./mediaKind";

export type ExpandPreviewKind = "video" | "audio" | "image" | "text" | null;
export type PasteStrategy = "text" | "file" | "stash";

export function isResourceRecord(
  record: Pick<ClipboardRecord, "group_name" | "storage_mode">,
): boolean {
  return record.storage_mode === "resource";
}

// 文件承载的文本资源：以文件形态存储、媒体类型为文本的资源记录（新建窗口
// 保存的 .txt/.md 与资源库中自动发现的文本文件）。content 存的是文件路径
// 或截断预览，再次使用时必须读取文件内容按文本粘贴，而不是把文件粘出去。
export function isFileBackedTextResource(
  record: Pick<
    ClipboardRecord,
    "type" | "content" | "resource_kind" | "storage_mode" | "group_name"
  >,
): boolean {
  return record.type === "file" && isResourceRecord(record) && inferResourceMediaKind(record) === "text";
}

export function getResourcePath(
  record: Pick<ClipboardRecord, "type" | "content" | "resource_path">,
): string {
  return record.type === "file" ? record.resource_path || record.content : record.content;
}

export function getResourceTitle(
  record: (Pick<ClipboardRecord, "type" | "content" | "resource_kind" | "resource_path"> & { id?: string }),
  kind = inferResourceMediaKind(record),
): string {
  const resourcePath = record.type === "file" ? record.resource_path || record.content : record.content;
  if (record.type === "file" && (record.resource_kind || kind === "text")) {
    return getResourceFileName(resourcePath);
  }
  if (kind === "image" && record.type === "image") return getResourceFileName(record.content);
  if (kind === "video" || kind === "audio" || kind === "file") {
    return getResourceFileName(resourcePath);
  }

  // 文件承载的文本资源被用户重命名过后，标题以文件名为准（原首行不再是用户命名）。
  if (hasCustomResourceFileName(record)) {
    return getResourceFileName(record.resource_path ?? "");
  }

  const firstLine = record.content
    .replaceAll("\uFFFC", "")
    .replace(/\[Image #\d+\]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (firstLine) return firstLine.slice(0, 80);
  return record.type === "link" ? "链接内容" : "文本内容";
}

export function getResourceSummary(record: Pick<ClipboardRecord, "type" | "content">): string {
  const summary = record.content
    .replaceAll("\uFFFC", "[图片]")
    .replace(/\s+/g, " ")
    .trim();
  return summary.length > 180 ? `${summary.slice(0, 180)}…` : summary;
}

// 文本记录展开预览的判定：后端截断标记、超长正文、超过行数阈值任一命中。
const INLINE_PREVIEW_MAX_LINES = 6;
const INLINE_PREVIEW_TEXT_LENGTH = 160;

export function countTextLines(content: string): number {
  return content.split(/\r\n|\r|\n/).length;
}

export function shouldShowInlineTextToggle(
  content: string,
  contentTruncated = false,
): boolean {
  return (
    contentTruncated
    || content.length > INLINE_PREVIEW_TEXT_LENGTH
    || countTextLines(content) > INLINE_PREVIEW_MAX_LINES
  );
}

// 与资源区共用同一份文本扩展名清单（md/json/代码等常见格式均可预览）。
export function hasInlineTextPreviewExtension(path: string): boolean {
  return isTextPreviewableFile(path);
}

// 快捷输入的文件路径形态（quick-input-files/ 前缀的相对路径）。
export function isQuickInputFilePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  return normalized.startsWith("quick-input-files/");
}

export function isInlineTextPreviewFilePath(path: string): boolean {
  return isQuickInputFilePath(path) && hasInlineTextPreviewExtension(path);
}

/** 条目显示文本：三窗口统一规则（收口原主窗口/径向菜单两套实现）。
 *  imagePlaceholder 由调用方传入（如 t("clipboard.image")），domain 不依赖 i18n。 */
export function recordDisplayName(
  record: Pick<ClipboardRecord, "type" | "content" | "is_api_key" | "key_preview">,
  imagePlaceholder: string,
): string {
  if (record.type === "image") return `[${imagePlaceholder}]`;
  if (record.type === "file") return fileNameFromPath(record.content);
  if (record.is_api_key) return record.key_preview || record.content;
  return record.content;
}

/** 展开预览类型：决定展开区渲染哪个共享组件（ResourceMediaPlayer /
 *  InlineImagePreview / 文本预览）。null 表示不可展开。 */
export function recordExpandPreview(
  record: Pick<
    ClipboardRecord,
    "type" | "content" | "content_truncated" | "has_images" | "resource_kind"
  >,
): ExpandPreviewKind {
  if (record.type === "image") return "image";
  if (record.type === "file") {
    const mediaKind = fileMediaKindFromPath(record.content);
    if (mediaKind) return mediaKind;
    return isTextPreviewableFile(record.content) ? "text" : null;
  }
  return record.has_images || shouldShowInlineTextToggle(record.content, record.content_truncated)
    ? "text"
    : null;
}

/** 粘贴路由描述（与 clipboardStore.pasteRecord 的分支一一对应，执行仍在 store）。 */
export function recordPasteStrategy(
  record: Pick<
    ClipboardRecord,
    "type" | "content" | "has_images" | "resource_kind" | "storage_mode" | "group_name"
  >,
): PasteStrategy {
  if (record.has_images) return "stash";
  if (record.type === "image") return "stash";
  if (record.type === "file") {
    return isFileBackedTextResource(record) ? "text" : "file";
  }
  return "text";
}
