// 列表置顶/重排序的统一排序实现：剪贴板记录与快捷短语的「移到顶部」、
// 拖拽重排序共用。ids 的顺序即目标顺序，未提及的项保持原相对顺序。

/**
 * 按 ids 给出的目标顺序重排 items：出现在 ids 中的项按 ids 顺序排在最前，
 * 未提及的项按原相对顺序排在后面。返回新数组，不修改入参。
 */
export function sortByIdOrder<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const idOrder = new Map(ids.map((id, index) => [id, index] as const));
  return [...items].sort(
    (a, b) => (idOrder.get(a.id) ?? Infinity) - (idOrder.get(b.id) ?? Infinity),
  );
}
