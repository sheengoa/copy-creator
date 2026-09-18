// 查找替换共享数学：非重叠匹配定位。textarea（资源详情页）与富文本
// 编辑器（新建内容窗口）分别负责把命中位置落到各自的选区/内容模型上。
export function findMatchPositions(
  text: string,
  query: string,
  caseSensitive: boolean,
): number[] {
  if (query === "") return [];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const positions: number[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, from);
    if (found === -1) break;
    positions.push(found);
    from = found + needle.length;
  }
  return positions;
}
