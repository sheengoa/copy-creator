import { useEffect, type RefObject } from "react";

/**
 * 横向 chip 条 / 分类条的滚轮横滚：悬浮容器上滚动滑轮时把纵向滚轮
 * 转为横向滚动。剪切板分类条、快捷输入与资源分组条、径向菜单分类条
 * 共用。resetKey 变化时重挂监听（容器节点随条件渲染重建的场景，
 * 如径向菜单按 tab 切换重挂分类条）。
 */
export function useHorizontalWheelScroll(
  ref: RefObject<HTMLElement | null>,
  resetKey: unknown = null,
) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault();
        element.scrollLeft += event.deltaY;
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [ref, resetKey]);
}
