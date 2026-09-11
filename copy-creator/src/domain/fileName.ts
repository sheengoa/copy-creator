// 领域层：文件名/扩展名切分与重命名资格规则（全项目唯一事实源）。
// fileNameFromPath 原四处各有一份相同写法，此处为唯一实现。
import type { ClipboardRecord } from "../types";

/** 取路径最后一段作为文件名，兼容 Windows 反斜杠；空段回落原值。 */
export function fileNameFromPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

export function getResourceFileName(value: string): string {
  // 资源标题语义：截断 #/查询串、剥 file:// 前缀后取末段并做 URL 解码；
  // 纯路径取末段复用统一的 fileNameFromPath。
  const normalized = value.replace(/[?#].*$/, "");
  const withoutScheme = normalized.replace(/^file:\/\/(?:localhost)?/i, "");
  const fileName = fileNameFromPath(withoutScheme);
  try {
    return decodeURIComponent(fileName);
  } catch {
    return fileName;
  }
}

// 把文件名拆成主干与扩展名（含点号）。无扩展名或以点开头的隐藏文件名整体视为主干。
export function splitResourceFileName(fileName: string): {
  stem: string;
  extension: string;
} {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return { stem: fileName, extension: "" };
  return {
    stem: fileName.slice(0, dotIndex),
    extension: fileName.slice(dotIndex),
  };
}

// 标题即文件名的记录（图片、文件、资源库文本）才支持重命名；无文件的文本/链接
// 的标题取自正文首行，无文件名可改。
export function isResourceTitleRenameable(
  record: Pick<ClipboardRecord, "type" | "resource_path">,
): boolean {
  return record.type === "image" || record.type === "file" || Boolean(record.resource_path);
}

// 新建窗口保存的文本资源由后端按「copy-creator-{记录id}-{事务id}-{首行}」自动命名，
// 此时标题显示正文首行；用户重命名后文件名不再是自动格式，标题以文件名为准。
export function hasCustomResourceFileName(
  record: Pick<ClipboardRecord, "type" | "resource_path"> & { id?: string },
): boolean {
  if (record.type === "image" || record.type === "file" || !record.resource_path || !record.id) {
    return false;
  }
  return !getResourceFileName(record.resource_path).startsWith(`copy-creator-${record.id}-`);
}
