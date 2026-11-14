import type { CardActionMenuAnchor } from "../components/CardActionMenu";

/** CardActionMenu 的触发钮锚点：按钮视口矩形直接换算（三卡同款）。 */
export function cardActionMenuAnchor(
  buttonRef: { current: { getBoundingClientRect(): DOMRect } | null },
): CardActionMenuAnchor | null {
  const rect = buttonRef.current?.getBoundingClientRect();
  return rect
    ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    : null;
}
