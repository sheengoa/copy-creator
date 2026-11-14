// 径向菜单列表滚动锚点：WebKitGTK 无 scroll anchoring，后台整窗替换
// records 时（粘贴使用重排/资源增删/打开菜单刷新）停留位置会被顶走。
// 随滚动持续记住「视口顶条目 + 偏移」，同视图内容更新后重新对位。
// 自 index.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）。

import { useEffect, useLayoutEffect, useRef } from "react";
import { applyListScrollAnchor, captureListScrollAnchor, type ListScrollAnchor } from "../../utils/scrollAnchor";

export function useRadialScrollAnchor(
  listRef: { current: HTMLDivElement | null },
  listViewKey: string,
  items: unknown[],
) {
  const scrollAnchorRef = useRef<ListScrollAnchor | null>(null);

  // items 每次变化（后台重载/重排）后重对位，再按新位置刷新锚点。
  // useLayoutEffect 在绘制前完成，用户看不到跳动帧。
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const previous = scrollAnchorRef.current;
    if (previous && previous.viewKey === listViewKey) {
      applyListScrollAnchor(list, previous, listViewKey);
    }
    const captured = captureListScrollAnchor(list, listViewKey);
    // 空态（无条目）不覆盖旧锚点：列表短暂清空又填充（如打开菜单的
    // 重载序列）时，旧锚点仍能把位置找回来。
    if (captured && (captured.itemId !== null || previous?.viewKey !== listViewKey)) {
      scrollAnchorRef.current = captured;
    }
  }, [items, listRef, listViewKey]);

  // 用户滚动期间持续刷新锚点，保证下一次内容替换用的是最新停留位置。
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => {
      const captured = captureListScrollAnchor(list, listViewKey);
      if (captured && captured.itemId !== null) {
        scrollAnchorRef.current = captured;
      }
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => list.removeEventListener("scroll", onScroll);
  }, [listRef, listViewKey]);

  return { scrollAnchorRef };
}
