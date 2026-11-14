import { useEffect, useRef } from "react";

/**
 * 统一的 Esc 关闭处理：enabled 时监听 document keydown，按下 Escape 调用 handler。
 * 供弹层 / 对话框 / 右键菜单共用，替代各自手写的监听（handler 始终取最新闭包，
 * 不会因 handler 引用变化反复摘挂监听）。
 *
 * stopPropagation：弹层需要独占本次 Esc（不让 window 层监听再响应）时开启，
 * 如全屏灯箱压在确认框之上时 Esc 只关灯箱。document 层监听之间的同节点
 * 触发不受它影响（stopPropagation 拦不住同节点的其他监听），故本 hook 的
 * 多层弹层靠 enabled 门控分层，元素级 onKeyDown 的 stopPropagation 仍可
 * 阻断事件冒泡到 document——两层护栏并存。
 */
export function useEscapeKey(
  handler: (event: KeyboardEvent) => void,
  enabled = true,
  options?: { stopPropagation?: boolean },
) {
  const handlerRef = useRef(handler);
  const optionsRef = useRef(options);
  useEffect(() => {
    handlerRef.current = handler;
    optionsRef.current = options;
  });
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (optionsRef.current?.stopPropagation) event.stopPropagation();
      handlerRef.current(event);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled]);
}
