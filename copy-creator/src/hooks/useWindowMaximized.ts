import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * 跟踪当前窗口是否处于最大化。无边框窗口的阴影边距/圆角由窗口内的
 * --window-* 变量绘制，最大化时需要收起，因此监听尺寸变化后查询状态。
 * 以序号丢弃乱序的查询结果，避免恢复/最大化过程中的旧应答覆盖新状态。
 */
export function useWindowMaximized() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let cancelled = false;
    let seq = 0;
    let unlistenResized: UnlistenFn | undefined;
    const sync = () => {
      const current = ++seq;
      appWindow
        .isMaximized()
        .then((value) => {
          if (!cancelled && current === seq) setMaximized(value);
        })
        .catch(() => {});
    };
    sync();
    appWindow
      .onResized(sync)
      .then((fn) => {
        if (cancelled) fn();
        else unlistenResized = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlistenResized?.();
    };
  }, []);

  return maximized;
}
