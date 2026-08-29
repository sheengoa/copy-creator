import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * 监听窗口缩放并在停止后把逻辑像素尺寸写入设置。返回取消函数，
 * 供窗口 show 回调丢弃尚未落盘的保存（避免把恢复值重复写回）。
 */
export function usePersistWindowSize(widthKey: string, heightKey: string) {
  const saveTimerRef = useRef<number | null>(null);

  const cancelPendingSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let cancelled = false;
    let unlistenResize: UnlistenFn | undefined;
    appWindow.onResized(({ payload }) => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(async () => {
        saveTimerRef.current = null;
        try {
          const scaleFactor = await appWindow.scaleFactor();
          await invoke("set_settings_batch", {
            settings: {
              [widthKey]: String(Math.round(payload.width / scaleFactor)),
              [heightKey]: String(Math.round(payload.height / scaleFactor)),
            },
          });
        } catch (e) {
          console.error("保存窗口尺寸失败:", e);
        }
      }, 300);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlistenResize = unlisten;
      }
    });

    return () => {
      cancelled = true;
      if (unlistenResize) unlistenResize();
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [cancelPendingSave, heightKey, widthKey]);

  return cancelPendingSave;
}
