import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 元素首次进入视口后置 true（一次性）。返回回调 ref——元素实例被 React
 * 替换（条件分支切换）时会自动重新观察。列表卡片用它把缩略图等重资源
 * 请求推迟到可见时：display:none 的隐藏标签页、视口外的大库卡片都不会
 * 再发起请求（content-visibility 只省绘制，拦不住 effect 与请求）。
 */
export function useInViewOnce<T extends HTMLElement>(rootMargin = "300px") {
  const [inView, setInView] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const ref = useCallback(
    (node: T | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node || inView) return;
      if (typeof IntersectionObserver === "undefined") {
        setInView(true);
        return;
      }
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setInView(true);
            observer.disconnect();
          }
        },
        { rootMargin },
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [inView, rootMargin],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return [ref, inView] as const;
}
