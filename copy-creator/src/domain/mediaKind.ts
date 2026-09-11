// 领域层：记录/文件的媒体类型判定（全项目唯一事实源）。
// 扩展名清单不在本文件手写——由 config/media-types.json 生成（见方案 §5.3）；
// DECODABLE_IMAGE_EXTENSIONS 是语言特有清单（与后端 image crate 解码能力
// 绑定，浏览器展示集是 image 全集），不属于共享配置，豁免于架构守卫规则 1。
import type { ClipboardRecord } from "../types";
import { getResourceFileName } from "./fileName";
import {
  IMAGE_EXTENSIONS as IMAGE_EXTENSIONS_LIST,
  VIDEO_EXTENSIONS as VIDEO_EXTENSIONS_LIST,
  AUDIO_EXTENSIONS as AUDIO_EXTENSIONS_LIST,
  TEXT_EXTENSIONS as TEXT_EXTENSIONS_LIST,
} from "./mediaTypes.generated";

export type ResourceMediaKind = "text" | "image" | "video" | "audio" | "file";
export type ResourceTypeFilter = "all" | ResourceMediaKind;
export type FileMediaKind = "video" | "audio" | "image";

export const IMAGE_EXTENSIONS = new Set(IMAGE_EXTENSIONS_LIST);
export const VIDEO_EXTENSIONS = new Set(VIDEO_EXTENSIONS_LIST);
export const AUDIO_EXTENSIONS = new Set(AUDIO_EXTENSIONS_LIST);
export const TEXT_EXTENSIONS = new Set(TEXT_EXTENSIONS_LIST);

// 能被后端 image crate 解码为位图的图片扩展（对应 Cargo.toml 的 image
// features：png/jpeg/webp/gif/bmp）。资源区展示用 IMAGE_EXTENSIONS 全集
// （浏览器可显示 svg/avif/heic），位图粘贴必须限定在本集合内，否则
// paste_image_file 解码失败。语言特有清单（architectureGuard 豁免）。
export const DECODABLE_IMAGE_EXTENSIONS = new Set(["bmp", "gif", "jpeg", "jpg", "png", "webp"]);

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

/** 文件路径按扩展名推断的媒体视觉类型；普通文件/文本返回 null，维持文件名展示。 */
export function fileMediaKindFromPath(path: string): FileMediaKind | null {
  const kind = inferResourceMediaKind({ type: "file", content: path });
  return kind === "video" || kind === "audio" || kind === "image" ? kind : null;
}

// 与资源区共用同一份文本扩展名清单（md/json/代码等常见格式均可预览）。
export function isTextPreviewableFile(path: string): boolean {
  return TEXT_EXTENSIONS.has(getResourceExtension(path));
}

export function matchesResourceType(
  record: Pick<ClipboardRecord, "type" | "content" | "resource_kind">,
  filter: ResourceTypeFilter,
): boolean {
  return filter === "all" || inferResourceMediaKind(record) === filter;
}
