import { useEffect, useRef } from "react";

/**
 * 展开卡片时把展开内容完整滚入最近的可视滚动区：
 * - 展开瞬间 block: "nearest" 做最小滚动——已完整可见时不动作，收起不回滚；
 * - 展开期间监听内容高度变化（图片/视频异步加载完成会改变高度），变化后再次校正。
 * 供剪切板/短语等所有「卡内展开」列表复用，避免有的界面滚、有的界面不滚。
 */
export function useExpandReveal<T extends HTMLElement>(expanded: boolean) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!expanded) return;
    const element = ref.current;
    if (!element) return;

    let frame: number | null = null;
    const reveal = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      // rAF 内滚动：在 ResizeObserver 回调里直接改滚动位置会触发循环警告。
      frame = window.requestAnimationFrame(() => {
        frame = null;
        element.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    };

    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [expanded]);

  return ref;
}
