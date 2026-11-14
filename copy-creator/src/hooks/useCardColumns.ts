import { useEffect, useState } from "react";
import { computeResourceColumnCount } from "../utils/cardGrid";

// 多列卡片网格的列数：随列表容器宽度动态变化，窗口缩放时实时跟随
// （宽度不足以排两列时降单列——主窗口 minWidth 480 的窄窗可用性）。
// 最小列宽槽位由调用方传入——资源页接卡片大小设置
// （紧凑档同宽容纳更多列），剪切板/快捷输入页用标准档。
// 三页同构（资源库 / 剪切板 / 快捷输入），禁止单页复制私有实现。

export function useCardColumns(
  listElement: HTMLElement | null,
  minColumnWidth: number,
): number {
  const [columnCount, setColumnCount] = useState(2);

  useEffect(() => {
    if (!listElement) return;
    const update = () =>
      setColumnCount(computeResourceColumnCount(listElement.clientWidth, minColumnWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(listElement);
    return () => observer.disconnect();
  }, [listElement, minColumnWidth]);

  return columnCount;
}
