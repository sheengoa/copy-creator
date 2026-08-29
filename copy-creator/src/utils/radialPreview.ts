export const RADIAL_MENU_WIDTH = 300;
export const RADIAL_MENU_HEIGHT = 420;
export const RADIAL_PREVIEW_WIDTH = 400;
export const RADIAL_PREVIEW_MIN_WIDTH = 260;
export const STASH_IMAGE_PLACEHOLDER = "\uFFFC";

export type RadialPreviewDirection = "left" | "right";

export type RadialPreviewSegment =
  | { type: "text"; content: string }
  | { type: "image"; path: string };

interface ExpansionInput {
  windowX: number;
  workAreaX: number;
  workAreaWidth: number;
  scaleFactor: number;
}

export interface RadialExpansion {
  direction: RadialPreviewDirection;
  previewWidth: number;
  windowX: number;
}

export function calculateRadialExpansion({
  windowX,
  workAreaX,
  workAreaWidth,
  scaleFactor,
}: ExpansionInput): RadialExpansion {
  const scale = Math.max(scaleFactor, 0.1);
  const menuWidth = RADIAL_MENU_WIDTH * scale;
  const rightSpace = workAreaX + workAreaWidth - (windowX + menuWidth);
  const leftSpace = windowX - workAreaX;
  const preferredWidth = RADIAL_PREVIEW_WIDTH * scale;
  const minimumWidth = RADIAL_PREVIEW_MIN_WIDTH * scale;
  const direction: RadialPreviewDirection =
    rightSpace >= minimumWidth || rightSpace >= leftSpace ? "right" : "left";
  const availableSpace = Math.max(0, direction === "right" ? rightSpace : leftSpace);
  const previewPhysicalWidth = Math.min(preferredWidth, availableSpace);
  const previewWidth = Math.floor(previewPhysicalWidth / scale);

  return {
    direction,
    previewWidth,
    windowX: direction === "left" ? Math.round(windowX - previewPhysicalWidth) : windowX,
  };
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
