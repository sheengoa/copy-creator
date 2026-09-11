// 卡片时间展示的统一实现：剪贴板、快捷输入、资源区共用（原三处各有一份）。
import i18n from "../i18n";

/** 把 ISO 时间串格式化为「M/D HH:MM」；无法解析时原样返回。 */
export function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${month}/${day} ${hours}:${minutes}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** 超过该跨度回退为「M/D HH:MM」绝对时间，避免「N 天前」失去参照。 */
const RELATIVE_MAX_MS = 7 * DAY_MS;

/** 把 ISO 时间串格式化为相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，
 *  超过 7 天或无法解析时回退 formatTime 的绝对时间。 */
export function formatRelativeTime(dateStr: string, now = Date.now()): string {
  const date = new Date(dateStr);
  const elapsed = now - date.getTime();
  if (Number.isNaN(date.getTime()) || elapsed < 0) return formatTime(dateStr);
  if (elapsed < RELATIVE_MAX_MS) {
    if (elapsed < MINUTE_MS) return i18n.t("common.justNow");
    if (elapsed < HOUR_MS) {
      return i18n.t("common.minutesAgo", { count: Math.floor(elapsed / MINUTE_MS) });
    }
    if (elapsed < DAY_MS) {
      return i18n.t("common.hoursAgo", { count: Math.floor(elapsed / HOUR_MS) });
    }
    return i18n.t("common.daysAgo", { count: Math.floor(elapsed / DAY_MS) });
  }
  return formatTime(dateStr);
}
