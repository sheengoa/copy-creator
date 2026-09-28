import { useCallback, type KeyboardEvent, type RefObject } from "react";

// 列表方向键导航：卡片自身已支持 Tab 聚焦 + Enter/Space 触发，本补齐
// 上下键在条目间移动（roving focus）。垂直列表按 DOM 顺序移动；瀑布流
// （columnar）按列分组——上下键列内移动，左右键跨列同位移动，符合
// 视觉直觉。不越界环绕（列表框惯例）。

interface ArrowKeyNavOptions {
  /** 列表容器：keydown 挂在它上面，条目查找也以它为界。 */
  containerRef: RefObject<HTMLElement | null>;
  /** 条目（卡片根节点）选择器。 */
  itemSelector: string;
  /** 瀑布流布局时开启。 */
  columnar?: boolean;
  /** 列容器选择器，columnar 时必填。 */
  columnSelector?: string;
}

const focusItem = (item: HTMLElement) => {
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: "nearest" });
};

export function useArrowKeyNav({
  containerRef,
  itemSelector,
  columnar = false,
  columnSelector,
}: ArrowKeyNavOptions) {
  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const key = event.key;
      if (
        (key !== "ArrowDown" && key !== "ArrowUp" && !(columnar && (key === "ArrowLeft" || key === "ArrowRight"))) ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      ) {
        return;
      }
      const container = containerRef.current;
      if (!container) return;

      // 列分组：columnar 用列容器各自内部顺序；否则全部条目为一组。
      const columns = columnar && columnSelector
        ? Array.from(container.querySelectorAll<HTMLElement>(columnSelector))
        : [container];
      const groups = columns.map((column) =>
        Array.from(column.querySelectorAll<HTMLElement>(itemSelector)),
      );
      const flat = groups.flat();
      if (flat.length === 0) return;

      // 当前焦点条目：允许焦点落在卡片内部元素（动作按钮等）时回溯到卡片。
      const active = document.activeElement;
      const current =
        active instanceof HTMLElement && container.contains(active)
          ? (active.matches(itemSelector)
            ? active
            : active.closest<HTMLElement>(itemSelector))
          : null;

      let target: HTMLElement | undefined;
      if (!current) {
        // 焦点还在输入框等处：下键从头进入，上键从尾进入。
        target = key === "ArrowUp" ? flat[flat.length - 1] : flat[0];
      } else if (key === "ArrowLeft" || key === "ArrowRight") {
        const groupIndex = groups.findIndex((group) => group.includes(current));
        const indexInGroup = groups[groupIndex].indexOf(current);
        const nextGroup = groups[groupIndex + (key === "ArrowRight" ? 1 : -1)];
        if (nextGroup) {
          target = nextGroup[Math.min(indexInGroup, nextGroup.length - 1)];
        }
      } else {
        for (const group of groups) {
          const index = group.indexOf(current);
          if (index === -1) continue;
          target = key === "ArrowDown" ? group[index + 1] : group[index - 1];
          break;
        }
      }

      if (target) {
        event.preventDefault();
        focusItem(target);
      }
    },
    [containerRef, itemSelector, columnar, columnSelector],
  );
}
