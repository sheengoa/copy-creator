// 查找替换历史共享逻辑：条目模型、去重置顶、升级与序列化。资源详情页
// 与新建内容窗口经 settingsStore 共享同一份历史（设置 KV 持久化 +
// 跨窗口事件同步），纯规则只在本文件维护。

export interface FindHistoryEntry {
  /** 查找词（条目主键）。 */
  query: string;
  /** 最近一次配对的替换值；未替换过的条目为空串。 */
  replacement: string;
  /** 是否执行过替换（决定「替换过/查找过」徽标与回填行为）。 */
  replaced: boolean;
}

/** 历史上限：超出淘汰最旧。 */
export const FIND_HISTORY_LIMIT = 10;

/** 设置 KV 键名。 */
export const FIND_HISTORY_SETTING_KEY = "find_replace_history";

/** 规整任意来源的条目数组：丢弃畸形项、钳正字段类型（存储读取与跨窗口事件共用）。 */
export function normalizeFindHistory(raw: unknown): FindHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: FindHistoryEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Partial<FindHistoryEntry>;
    if (typeof candidate.query !== "string" || candidate.query === "") continue;
    entries.push({
      query: candidate.query,
      replacement: typeof candidate.replacement === "string" ? candidate.replacement : "",
      replaced: candidate.replaced === true,
    });
  }
  return entries.slice(0, FIND_HISTORY_LIMIT);
}

export function parseFindHistory(raw: string | undefined): FindHistoryEntry[] {
  if (!raw) return [];
  try {
    return normalizeFindHistory(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function serializeFindHistory(entries: FindHistoryEntry[]): string {
  return JSON.stringify(entries.slice(0, FIND_HISTORY_LIMIT));
}

/** 按查找词置顶插入，同词旧条目移除，容量超限淘汰末尾。 */
function upsert(entries: FindHistoryEntry[], entry: FindHistoryEntry): FindHistoryEntry[] {
  const rest = entries.filter((item) => item.query !== entry.query);
  return [entry, ...rest].slice(0, FIND_HISTORY_LIMIT);
}

/** 查找导航：记录查找词；既有条目原样置顶（仅查找不降级「替换过」标记）。 */
export function recordFindQuery(
  entries: FindHistoryEntry[],
  query: string,
): FindHistoryEntry[] {
  if (query === "") return entries;
  const existing = entries.find((item) => item.query === query);
  return upsert(entries, existing ?? { query, replacement: "", replaced: false });
}

/** 执行替换（单个/全部）：记录查找词 + 替换值对，并升级为「替换过」。 */
export function recordReplacement(
  entries: FindHistoryEntry[],
  query: string,
  replacement: string,
): FindHistoryEntry[] {
  if (query === "") return entries;
  return upsert(entries, { query, replacement, replaced: true });
}

export function removeFindHistoryEntry(
  entries: FindHistoryEntry[],
  query: string,
): FindHistoryEntry[] {
  return entries.filter((item) => item.query !== query);
}
