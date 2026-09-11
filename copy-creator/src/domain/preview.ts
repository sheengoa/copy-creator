// 领域层：记录/短语预览 segments 的构建与可用性判定（全项目唯一事实源）。
// 径向菜单预览面板、资源详情页与主窗口展开预览共用 loadRecordPreviewSegments。
import { invoke } from "@tauri-apps/api/core";
import type { ClipboardRecord } from "../types";
import { fileMediaKindFromPath, getResourceExtension, TEXT_EXTENSIONS } from "./mediaKind";

export type RadialPreviewSegment =
  | { type: "text"; content: string }
  | { type: "image"; path: string }
  | { type: "video"; path: string }
  | { type: "audio"; path: string };

export const STASH_IMAGE_PLACEHOLDER = "\uFFFC";

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

// 暂存图文记录的图片附件列表（仅截断的 stash 记录需要读取）。
function getStashImages(id: string): Promise<string[]> {
  return invoke<string[]>("get_stash_record_images", { id });
}

// 截断记录的完整内容（非截断记录直接用 content，无缓存语义）。
async function getRecordFullContent(record: Pick<ClipboardRecord, "id" | "content" | "content_truncated">): Promise<string> {
  if (!record.content_truncated) return record.content;
  return invoke<string>("get_clipboard_record_content", { id: record.id });
}

export async function loadRecordPreviewSegments(
  record: Pick<
    ClipboardRecord,
    "id" | "type" | "content" | "content_truncated" | "has_images"
  >,
): Promise<RadialPreviewSegment[]> {
  if (record.type === "image") {
    return [{ type: "image", path: record.content }];
  }

  // 文件记录：图片/视频/音频按媒体预览（径向菜单预览面板、资源详情页与
  // 主窗口展开预览共用此判定）；常见文本格式读取内容预览；其余格式回退
  // 为路径展示。
  if (record.type === "file") {
    const mediaKind = fileMediaKindFromPath(record.content);
    if (mediaKind) {
      return [{ type: mediaKind, path: record.content }];
    }
    if (TEXT_EXTENSIONS.has(getResourceExtension(record.content))) {
      try {
        const text = await invoke<string>("read_clipboard_text_preview", {
          id: record.id,
        });
        return [{ type: "text", content: text }];
      } catch {
        // 读取失败（文件已移动/删除等）时回退为路径展示。
      }
    }
    return [{ type: "text", content: record.content }];
  }

  const [content, imagePaths] = await Promise.all([
    getRecordFullContent(record),
    record.has_images ? getStashImages(record.id) : Promise.resolve([]),
  ]);
  return buildRadialPreviewSegments(content, imagePaths);
}
