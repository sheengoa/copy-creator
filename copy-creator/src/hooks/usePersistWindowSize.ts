import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * 监听窗口缩放并在停止后把逻辑像素尺寸写入设置。返回取消函数，
 * 供窗口 show 回调丢弃尚未落盘的保存（避免把恢复值重复写回）。
 *
 * minSize：落库下限（与窗口的 min_inner_size 同口径）。异常小的瞬时
 * 尺寸（DPI 切换、驱动重置等瞬间）不落库，否则之后每次启动都会恢复成
 * 挤成一团的小窗。
 */
export function usePersistWindowSize(
  widthKey: string,
  heightKey: string,
  minSize?: { width: number; height: number },
) {
  // 拆成原始值进依赖数组：调用方内联对象每次渲染都是新引用，
  // 直接依赖它会让监听反复解绑重绑。
  const minWidth = minSize?.width ?? 0;
  const minHeight = minSize?.height ?? 0;
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
          // 最大化尺寸是临时态：跳过持久化，避免下次启动恢复成最大化大小。
          if (await appWindow.isMaximized()) return;
          const scaleFactor = await appWindow.scaleFactor();
          const width = Math.round(payload.width / scaleFactor);
          const height = Math.round(payload.height / scaleFactor);
          if (width < minWidth || height < minHeight) return;
          await invoke("set_settings_batch", {
            settings: {
              [widthKey]: String(width),
              [heightKey]: String(height),
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
  }, [cancelPendingSave, heightKey, widthKey, minWidth, minHeight]);

  return cancelPendingSave;
}
