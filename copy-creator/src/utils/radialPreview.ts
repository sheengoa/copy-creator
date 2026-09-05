export const RADIAL_MENU_WIDTH = 420;
export const RADIAL_MENU_HEIGHT = 650;
export const RADIAL_PREVIEW_WIDTH = 440;
export const RADIAL_PREVIEW_MIN_WIDTH = 260;
export const STASH_IMAGE_PLACEHOLDER = "\uFFFC";

export type RadialPreviewDirection = "left" | "right";

export type RadialPreviewSegment =
  | { type: "text"; content: string }
  | { type: "image"; path: string }
  | { type: "video"; path: string }
  | { type: "audio"; path: string };

interface ExpansionInput {
  windowX: number;
  windowWidth: number;
  workAreaX: number;
  workAreaWidth: number;
  scaleFactor: number;
}

export interface PreviewExpansion {
  direction: RadialPreviewDirection;
  previewWidth: number;
  previewPhysicalWidth: number;
  windowX: number;
}

export type RadialExpansion = Omit<PreviewExpansion, "previewPhysicalWidth">;

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

export function calculatePreviewExpansion({
  windowX,
  windowWidth,
  workAreaX,
  workAreaWidth,
  scaleFactor,
}: ExpansionInput): PreviewExpansion {
  const scale = Math.max(scaleFactor, 0.1);
  const rightSpace = workAreaX + workAreaWidth - (windowX + windowWidth);
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
    previewPhysicalWidth,
    windowX: direction === "left" ? Math.round(windowX - previewPhysicalWidth) : windowX,
  };
}

export function calculateRadialExpansion({
  windowX,
  workAreaX,
  workAreaWidth,
  scaleFactor,
}: Omit<ExpansionInput, "windowWidth">): RadialExpansion {
  const expansion = calculatePreviewExpansion({
    windowX,
    windowWidth: RADIAL_MENU_WIDTH * Math.max(scaleFactor, 0.1),
    workAreaX,
    workAreaWidth,
    scaleFactor,
  });
  return {
    direction: expansion.direction,
    previewWidth: expansion.previewWidth,
    windowX: expansion.windowX,
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
