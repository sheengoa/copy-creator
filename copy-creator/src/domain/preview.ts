// 领域层：记录/短语预览 segments 的构建与可用性判定（全项目唯一事实源）。
// 径向菜单预览面板、资源详情页与主窗口展开预览共用 loadRecordPreviewSegments。
import { invoke } from "@tauri-apps/api/core";
import type { ClipboardRecord } from "../types";
import { fileMediaKindFromPath, getResourceExtension, TEXT_EXTENSIONS } from "./mediaKind";

// 预览条带的设计像素宽度：后端开窗时按 440 × scale × dpi 一次性预留条带
// （见 src-tauri show_radial_menu 的 preferred_strip），前端展开面板以此为
// 名义宽度，两处必须同步修改。
export const RADIAL_PREVIEW_WIDTH = 440;

export type RadialPreviewDirection = "left" | "right";

export type RadialPreviewSegment =
  | { type: "text"; content: string }
  | { type: "image"; path: string; version?: string }
  | { type: "video"; path: string; version?: string }
  | { type: "audio"; path: string; version?: string };

export const STASH_IMAGE_PLACEHOLDER = "\uFFFC";

// 详情页大文本的分块渲染粒度：正文切成固定字符数的块，块级挂 CSS
// content-visibility: auto，浏览器只排版视口内的块——全文完整展示而
// 不拖垮排版的唯一途径（数据全在内存，DOM 只画可视区）。
export const TEXT_DETAIL_CHUNK_CHARS = 100_000;

/**
 * 把全文按固定字符数切块（详情页分块虚拟渲染用）。边界向后避开
 * UTF-16 代理对，任何字符都不会被切进两个块；块顺序拼接与原文严格
 * 相等。短文本原样返回单块。
 */
export function splitTextChunks(content: string): string[] {
  if (content.length <= TEXT_DETAIL_CHUNK_CHARS) return [content];
  const chunks: string[] = [];
  for (let start = 0; start < content.length;) {
    let end = start + TEXT_DETAIL_CHUNK_CHARS;
    if (end < content.length) {
      const code = content.charCodeAt(end);
      // 边界落在低代理位：上一字符的代理对被切开，回退一位。
      if (code >= 0xdc00 && code <= 0xdfff) end -= 1;
    } else {
      end = content.length;
    }
    chunks.push(content.slice(start, end));
    start = end;
  }
  return chunks;
}

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
async function getRecordFullContent(record: RecordPreviewInput): Promise<string> {
  if (!record.contentTruncated) return record.content;
  return invoke<string>("get_clipboard_record_content", { id: record.id });
}

/** 预览输入：RecordView 与原始记录均可直接满足（判定字段来自 domain）。 */
export interface RecordPreviewInput {
  id: string;
  recordType: ClipboardRecord["type"];
  content: string;
  contentTruncated: boolean;
  hasImages: boolean;
}

export async function loadRecordPreviewSegments(
  record: RecordPreviewInput,
): Promise<RadialPreviewSegment[]> {
  if (record.recordType === "image") {
    return [{ type: "image", path: record.content }];
  }

  // 文件记录：图片/视频/音频按媒体预览（径向菜单预览面板、资源详情页与
  // 主窗口展开预览共用此判定）；常见文本格式读取内容预览；其余格式回退
  // 为路径展示。
  if (record.recordType === "file") {
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
    record.hasImages ? getStashImages(record.id) : Promise.resolve([]),
  ]);
  return buildRadialPreviewSegments(content, imagePaths);
}
