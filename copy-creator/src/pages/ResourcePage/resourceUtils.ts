import type { ClipboardRecord } from "../../types";




/** 文件路径按扩展名推断的媒体视觉类型；普通文件/文本返回 null，维持文件名展示。 */
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

// 交错分配保证双列布局按行阅读时与时间顺序一致，配合拖拽预览的扁平排序。
export function splitResourceColumns(records: ClipboardRecord[], columnCount: number): ClipboardRecord[][] {
  const count = Math.max(1, Math.floor(columnCount));
  const columns = Array.from({ length: count }, () => [] as ClipboardRecord[]);
  records.forEach((record, index) => {
    columns[index % count].push(record);
  });
  return columns;
}
