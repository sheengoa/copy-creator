import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ClipboardRecord, ResourceFolder } from "../../types";

export type ResourceMediaKind = "text" | "image" | "video" | "audio" | "file";
export type ResourceTypeFilter = "all" | ResourceMediaKind;

export interface FlattenedResourceFolder {
  folder: ResourceFolder;
  depth: number;
}

const VIDEO_EXTENSIONS = new Set(["avi", "m4v", "mkv", "mov", "mp4", "ogv", "webm"]);
const AUDIO_EXTENSIONS = new Set([
  "aac",
  "flac",
  "m4a",
  "mid",
  "midi",
  "mp3",
  "oga",
  "ogg",
  "opus",
  "wav",
  "weba",
]);
const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "tif",
  "tiff",
  "webp",
]);
const TEXT_EXTENSIONS = new Set([
  "bat",
  "bash",
  "c",
  "cc",
  "cfg",
  "clj",
  "conf",
  "cpp",
  "cs",
  "css",
  "cxx",
  "env",
  "fish",
  "go",
  "graphql",
  "h",
  "hh",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsonl",
  "jsx",
  "kt",
  "kts",
  "less",
  "log",
  "markdown",
  "md",
  "mjs",
  "php",
  "pl",
  "properties",
  "ps1",
  "py",
  "rb",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "tex",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
]);

export function getResourceFileName(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/[?#].*$/, "");
  const withoutScheme = normalized.replace(/^file:\/\/(?:localhost)?/i, "");
  const fileName = withoutScheme.split("/").pop() || value;
  try {
    return decodeURIComponent(fileName);
  } catch {
    return fileName;
  }
}

export function getResourceExtension(value: string): string {
  const fileName = getResourceFileName(value).toLowerCase();
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex + 1) : "";
}

export function inferResourceMediaKind(
  record: Pick<ClipboardRecord, "type" | "content" | "resource_kind">,
): ResourceMediaKind {
  if (record.type === "image") return "image";
  if (record.resource_kind) return record.resource_kind;
  if (record.type !== "file") return "text";

  const extension = getResourceExtension(record.content);
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  return "file";
}

export function matchesResourceType(
  record: Pick<ClipboardRecord, "type" | "content" | "resource_kind">,
  filter: ResourceTypeFilter,
): boolean {
  return filter === "all" || inferResourceMediaKind(record) === filter;
}

export function getResourceTitle(
  record: Pick<ClipboardRecord, "type" | "content" | "resource_kind" | "resource_path">,
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

  const firstLine = record.content
    .replaceAll("\uFFFC", "")
    .replace(/\[Image #\d+\]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (firstLine) return firstLine.slice(0, 80);
  return record.type === "link" ? "链接内容" : "文本内容";
}

export function getResourcePath(
  record: Pick<ClipboardRecord, "type" | "content" | "resource_path">,
): string {
  return record.type === "file" ? record.resource_path || record.content : record.content;
}

export function getResourceSummary(record: Pick<ClipboardRecord, "type" | "content">): string {
  const summary = record.content
    .replaceAll("\uFFFC", "[图片]")
    .replace(/\s+/g, " ")
    .trim();
  return summary.length > 180 ? `${summary.slice(0, 180)}…` : summary;
}

export function formatResourceTime(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  return `${date.getMonth() + 1}/${date.getDate()} ${date
    .getHours()
    .toString()
    .padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

export function formatResourceFileSize(size?: number): string {
  if (size === undefined || !Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

// 列宽低于该值时保持最少两列（用户要求最低两排），随窗口变宽逐步增加列数。
const RESOURCE_COLUMN_MIN_WIDTH = 460;
const RESOURCE_COLUMN_GAP = 10;
const RESOURCE_COLUMN_MAX = 5;

export function computeResourceColumnCount(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 2;
  const usable = width + RESOURCE_COLUMN_GAP;
  const columnSlot = RESOURCE_COLUMN_MIN_WIDTH + RESOURCE_COLUMN_GAP;
  const count = Math.floor(usable / columnSlot);
  return Math.min(RESOURCE_COLUMN_MAX, Math.max(2, count));
}

export function formatResourceDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const two = (value: number) => value.toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${two(minutes)}:${two(secs)}`
    : `${minutes}:${two(secs)}`;
}

export function formatResourceBitrate(bytes?: number, seconds?: number): string {
  if (
    bytes === undefined
    || !Number.isFinite(bytes)
    || bytes <= 0
    || seconds === undefined
    || !Number.isFinite(seconds)
    || seconds <= 0
  ) {
    return "";
  }
  const bitsPerSecond = (bytes * 8) / seconds;
  if (bitsPerSecond >= 1_000_000) {
    return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  }
  return `${Math.max(1, Math.round(bitsPerSecond / 1000))} kbps`;
}

export function flattenResourceFolders(
  folders: ResourceFolder[],
  depth = 0,
): FlattenedResourceFolder[] {
  return folders.flatMap((folder) => [
    { folder, depth },
    ...flattenResourceFolders(folder.children ?? [], depth + 1),
  ]);
}

export function findResourceFolder(
  folders: ResourceFolder[],
  path: string,
): ResourceFolder | null {
  for (const folder of folders) {
    if (folder.path === path) return folder;
    const found = findResourceFolder(folder.children ?? [], path);
    if (found) return found;
  }
  return null;
}

export function isResourceFolderPath(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

export function getResourceFolderRoot(path: string): string {
  return path.split("/")[0] || "";
}

// 交错分配保证双列布局按行阅读时与时间顺序一致，配合拖拽预览的扁平排序。
export function splitResourceColumns(records: ClipboardRecord[], columnCount: number): ClipboardRecord[][] {
  const count = Math.max(1, Math.floor(columnCount));
  const columns = Array.from({ length: count }, () => [] as ClipboardRecord[]);
  records.forEach((record, index) => {
    columns[index % count].push(record);
  });
  return columns;
}

function normalizeLocalPath(value: string): string {
  const trimmed = value.trim();
  if (!/^file:\/\//i.test(trimmed)) return trimmed;
  let path = trimmed.replace(/^file:\/\/(?:localhost)?/i, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the original path when a malformed escape sequence is present.
  }
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

let storagePathPromise: Promise<string> | null = null;
let mediaServerPromise: Promise<{ origin: string; token: string }> | null = null;

function getStoragePath(): Promise<string> {
  if (!storagePathPromise) {
    storagePathPromise = invoke<string>("get_storage_path").catch((error) => {
      storagePathPromise = null;
      throw error;
    });
  }
  return storagePathPromise;
}

function getMediaServer(): Promise<{ origin: string; token: string }> {
  if (!mediaServerPromise) {
    mediaServerPromise = invoke<{ origin: string; token: string }>(
      "get_media_server_origin",
    ).catch((error) => {
      mediaServerPromise = null;
      throw error;
    });
  }
  return mediaServerPromise;
}

async function resolveAbsoluteResourcePath(path: string): Promise<string> {
  const normalized = normalizeLocalPath(path);
  if (!normalized) throw new Error("资源路径为空");
  if (/^(?:https?:|data:|blob:|asset:)/i.test(normalized)) return normalized;
  if (isAbsoluteLocalPath(normalized)) return normalized;

  const storagePath = (await getStoragePath()).replace(/[\\/]+$/, "");
  return `${storagePath}/${normalized.replace(/^[\\/]+/, "")}`;
}

export async function resolveResourceAssetUrl(path: string): Promise<string> {
  const absolute = await resolveAbsoluteResourcePath(path);
  return convertFileSrc(absolute);
}

// WebKitGTK 的 <video>/<audio> 无法播放 asset:// 协议地址（媒体协议白名单
// 与 GStreamer 均不支持自定义协议），媒体预览需改走后端回环 HTTP 服务。
export async function resolveResourceMediaUrl(path: string): Promise<string> {
  const absolute = await resolveAbsoluteResourcePath(path);
  if (!isAbsoluteLocalPath(absolute)) return absolute;
  const { origin, token } = await getMediaServer();
  return `${origin}/media?token=${encodeURIComponent(token)}&path=${encodeURIComponent(absolute)}`;
}
