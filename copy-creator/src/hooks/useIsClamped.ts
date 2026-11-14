import { useCallback, useRef, useState } from "react";

/**
 * 行数截断检测（-webkit-line-clamp 场景）：截断发生时 scrollHeight 超出
 * clientHeight，据此点亮卡片正文截断渐隐提示（.is-clamped）。
 * ResizeObserver 跟随盒子尺寸变化重测——文案增减、窗口回流、
 * content-visibility 进出视口补排版都会触发，无需依赖具体文案。
 * jsdom 无 ResizeObserver：守卫跳过（真实行为由浏览器 mock 实测承担）。
 */
export function useIsClamped(): [(node: HTMLElement | null) => void, boolean] {
  const [clamped, setClamped] = useState(false);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    // 1px 容差：scrollHeight/clientHeight 均为整数取整，恰好占满时相等。
    const measure = () => setClamped(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  return [ref, clamped];
}
