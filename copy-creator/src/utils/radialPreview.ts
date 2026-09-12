export const RADIAL_MENU_WIDTH = 420;
export const RADIAL_MENU_HEIGHT = 650;
// 窗口四周的透明阴影边距（逻辑像素）：透明窗口的 CSS 阴影会被窗口边界裁剪，
// 因此窗口实际尺寸比可见面板大一圈，阴影落在边距内。与 src-tauri 侧
// WINDOW_SHADOW_MARGIN 保持一致，改动时必须同步。
export const RADIAL_SHADOW_MARGIN = 20;
export const STASH_IMAGE_PLACEHOLDER = "\uFFFC";

export type RadialPreviewSegment =
  | { type: "text"; content: string }
  | { type: "image"; path: string }
  | { type: "video"; path: string }
  | { type: "audio"; path: string };

interface ContentPreviewCandidate {
  type: string;
  contentTruncated?: boolean;
  hasImages?: boolean;
}

export function isContentPreviewAvailable(
  candidate: ContentPreviewCandidate,
  isClipped: boolean,
) {
  if (
    candidate.hasImages
    || candidate.type === "text"
    || candidate.type === "image"
    || candidate.type === "link"
    || candidate.type === "file"
    || candidate.type === "phrase"
  ) return true;
  return Boolean(candidate.contentTruncated || isClipped);
}

function pushText(segments: RadialPreviewSegment[], content: string) {
  if (content) segments.push({ type: "text", content });
}

export function buildRadialPreviewSegments(
  content: string,
  imagePaths: string[],
): RadialPreviewSegment[] {
  if (imagePaths.length === 0) return [{ type: "text", content }];

  const segments: RadialPreviewSegment[] = [];
  if (content.includes(STASH_IMAGE_PLACEHOLDER)) {
    const parts = content.split(STASH_IMAGE_PLACEHOLDER);
    parts.forEach((part, index) => {
      pushText(segments, part);
      if (index < imagePaths.length) {
        segments.push({ type: "image", path: imagePaths[index] });
      }
    });
    return segments;
  }

  const markerPattern = /\[Image #(\d+)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(content)) !== null) {
    const imageIndex = Number(match[1]) - 1;
    const path = imagePaths[imageIndex];
    if (!path) continue;
    pushText(segments, content.slice(lastIndex, match.index));
    segments.push({ type: "image", path });
    lastIndex = match.index + match[0].length;
  }
  pushText(segments, content.slice(lastIndex));

  if (!segments.some((segment) => segment.type === "image")) {
    return [
      { type: "text", content },
      ...imagePaths.map((path) => ({ type: "image" as const, path })),
    ];
  }
  return segments;
}
