import { getResourceExtension, TEXT_EXTENSIONS } from "../pages/ResourcePage/resourceUtils";

export const INLINE_PREVIEW_MAX_LINES = 6;
export const INLINE_PREVIEW_TEXT_LENGTH = 160;

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

export function isQuickInputFilePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  return normalized.startsWith("quick-input-files/");
}

// 与资源区共用同一份文本扩展名清单（md/json/代码等常见格式均可预览）。
export function hasInlineTextPreviewExtension(path: string): boolean {
  return TEXT_EXTENSIONS.has(getResourceExtension(path));
}

export function isInlineTextPreviewFilePath(path: string): boolean {
  return isQuickInputFilePath(path) && hasInlineTextPreviewExtension(path);
}
