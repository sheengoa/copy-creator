import { useEffect, useRef } from "react";

/** 向上找第一个真正可滚动的祖先（overflow 为 auto/scroll 且内容已溢出）。 */
function findScrollParent(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element.parentElement;
  while (current) {
    const overflowY = getComputedStyle(current).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll")
      && current.scrollHeight > current.clientHeight
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * 展开卡片时把展开内容完整滚入列表可视区：
 * - 展开瞬间与内容高度变化（媒体异步加载）后各校正一次；
 * - 只在内容超出可视区时滚动，已完整可见与收起时不动作；
 * - 直接写 scrollTop 的 rAF 缓动，不走 scrollIntoView/scrollBy 的 smooth——
 *   WebKitGTK 上 options 形式的 smooth/nearest 存在不滚动的兼容问题。
 * 供剪切板/短语等所有「卡内展开」列表复用，避免有的界面滚、有的界面不滚。
 */
export function useExpandReveal<T extends HTMLElement>(expanded: boolean) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!expanded) return;
    const element = ref.current;
    if (!element) return;

    let frame: number | null = null;
    let animating = false;

    const cancelPending = () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
      animating = false;
    };

    const reveal = () => {
      cancelPending();
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const scroller = findScrollParent(element);
        if (!scroller) return;
        const rect = element.getBoundingClientRect();
        const bounds = scroller.getBoundingClientRect();
        // 上方只需贴回可视区；下方除呼吸间隙外还要容纳卡片尾栏（时间戳约 30px），
        // 否则尾栏会紧贴甚至超出可视区底边。
        const marginAbove = 8;
        const marginBelow = 40;
        const below = rect.bottom - bounds.bottom + marginBelow; // >0：下方被裁的量
        const above = bounds.top - rect.top + marginAbove; // >0：上方被裁的量
        let target = scroller.scrollTop;
        if (below > 0) target += below;
        else if (above > 0) target -= above;
        else return;
        const maxScroll = scroller.scrollHeight - scroller.clientHeight;
        target = Math.max(0, Math.min(target, maxScroll));
        if (target === scroller.scrollTop) return;
        const from = scroller.scrollTop;
        const distance = target - from;
        const start = performance.now();
        animating = true;
        const step = (now: number) => {
          if (!animating) return;
          const progress = Math.min(1, (now - start) / 240);
          scroller.scrollTop = from + distance * (1 - (1 - progress) * (1 - progress));
          frame = progress < 1 ? window.requestAnimationFrame(step) : null;
        };
        frame = window.requestAnimationFrame(step);
      });
    };

    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelPending();
    };
  }, [expanded]);

  return ref;
}
