/** 侧栏分组 pill 的面包屑段：`more` 为 true 的段是收起中段的「…」占位。 */
export interface ResourceGroupCrumb {
  text: string;
  more?: boolean;
}

/**
 * 嵌套分组路径的展示段拆分。侧栏 pill 很窄，深层路径放不下全部层级：
 * ≤4 层全部展示（超宽时由 CSS 逐段压缩）；5-6 层收起中段为首段 + … + 末两段；
 * 更深只保留首段 + … + 末段（最深一层是分组身份，必须完整）。
 * 完整路径始终通过 pill 的 title 悬停查看。
 */
export function buildResourceGroupCrumbs(path: string): ResourceGroupCrumb[] {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 4) return segments.map((text) => ({ text }));
  if (segments.length <= 6) {
    return [
      { text: segments[0] },
      { text: "…", more: true },
      ...segments.slice(-2).map((text) => ({ text })),
    ];
  }
  return [
    { text: segments[0] },
    { text: "…", more: true },
    { text: segments[segments.length - 1] },
  ];
}




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

/** 强确认护栏阈值：缺失 ≥10 条且占资源记录总数一半以上——与启动对账
 *  清退安全阀同一口径，视为疑似存储离线的异常规模。 */
export function isMassMissing(
  stillMissingCount: number,
  totalResources: number,
): boolean {
  return (
    stillMissingCount >= 10
    && totalResources > 0
    && stillMissingCount * 2 >= totalResources
  );
}
