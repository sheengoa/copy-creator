// 卡片网格几何：资源库 / 剪切板 / 快捷输入三页共用的多列卡片布局纯函数。
// 列数是 JS 计算（非 CSS auto-fit）：最少两列、随容器宽度增长、上限钳制，
// 搭配 hooks/useCardColumns 的 ResizeObserver 实时跟随。
// 命名沿用历史 Resource 前缀（同 quick_input / phrases 惯例）。

// 「标准」档位的最小列宽（历史默认），卡片大小滑块的缩放基准值。
export const RESOURCE_COLUMN_MIN_WIDTH = 460;

// 主窗口紧凑档（剪切板/快捷输入卡片）：内容相对不多，默认档比资源库
// 小一档，1440px 主窗口排 3-4 列。
export const COMPACT_CARD_MIN_WIDTH = 300;
const RESOURCE_COLUMN_GAP = 10;
const RESOURCE_COLUMN_MAX = 5;

// 卡片内部尺寸的缩放系数钳制：极端滑块值下保持文字可读、版面不失真。
const CARD_SCALE_MIN = 0.8;
const CARD_SCALE_MAX = 1.35;

/** 卡片内部尺寸（字号/内边距等）相对基准的等比缩放系数。 */
export function resourceCardScale(cardSize: number): number {
  if (!Number.isFinite(cardSize) || cardSize <= 0) return 1;
  return Math.min(CARD_SCALE_MAX, Math.max(CARD_SCALE_MIN, cardSize / RESOURCE_COLUMN_MIN_WIDTH));
}

export function computeResourceColumnCount(
  width: number,
  minColumnWidth: number = RESOURCE_COLUMN_MIN_WIDTH,
): number {
  if (!Number.isFinite(width) || width <= 0) return 2;
  const usable = width + RESOURCE_COLUMN_GAP;
  const columnSlot = minColumnWidth + RESOURCE_COLUMN_GAP;
  const count = Math.floor(usable / columnSlot);
  // 下限 1 列：主窗口 minWidth 480 下内容区 ~390px 排两列只有 ~190px/列，
  // 卡片文字换行破碎——窄窗宁团单列（与 <560px 单列的响应式意图一致）。
  // 宽度非法/未量得时仍回退 2（初始渲染的安全默认）。
  return Math.min(RESOURCE_COLUMN_MAX, Math.max(1, count));
}

// 交错分配保证双列布局按行阅读时与时间顺序一致。
export function splitResourceColumns<T>(items: T[], columnCount: number): T[][] {
  const count = Math.max(1, Math.floor(columnCount));
  const columns = Array.from({ length: count }, () => [] as T[]);
  items.forEach((item, index) => {
    columns[index % count].push(item);
  });
  return columns;
}

/** 交错分配的逆变换：把分列瀑布流的 DOM 序（列主序）数组还原为逻辑序。
 *  dnd-kit 的 items/DOM 顺序必须与渲染序一致（分列后是列主序），拖拽
 *  提交 reorder 时需要还原回列表的逻辑序。 */
export function restoreInterleavedOrder(
  logicalBefore: string[],
  domAfter: string[],
  columnCount: number,
): string[] {
  const domBefore = splitResourceColumns(logicalBefore, columnCount).flat();
  const pos = new Map(domBefore.map((id, index) => [id, index]));
  return logicalBefore.map((id) => {
    const p = pos.get(id);
    return p !== undefined && p < domAfter.length ? domAfter[p] : id;
  });
}
