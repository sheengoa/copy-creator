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

export function hasInlineTextPreviewExtension(path: string): boolean {
  return /\.(json|txt|toml)$/i.test(path);
}

export function isInlineTextPreviewFilePath(path: string): boolean {
  return isQuickInputFilePath(path) && hasInlineTextPreviewExtension(path);
}
