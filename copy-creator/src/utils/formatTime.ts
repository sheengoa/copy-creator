// 卡片时间展示的统一实现：剪贴板、快捷输入、资源区共用（原三处各有一份）。

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
