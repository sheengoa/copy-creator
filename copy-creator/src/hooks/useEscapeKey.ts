import { useEffect, useRef } from "react";

/**
 * 统一的 Esc 关闭处理：enabled 时监听 document keydown，按下 Escape 调用 handler。
 * 供弹层 / 对话框 / 右键菜单共用，替代各自手写的监听（handler 始终取最新闭包，
 * 不会因 handler 引用变化反复摘挂监听）。
 */
export function useEscapeKey(
  handler: (event: KeyboardEvent) => void,
  enabled = true,
) {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      handlerRef.current(event);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled]);
}
