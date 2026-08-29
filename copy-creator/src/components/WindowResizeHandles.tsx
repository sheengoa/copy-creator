import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, type UnlistenFn } from "@tauri-apps/api/window";

export const WINDOW_RESIZE_HANDLES = [
  { className: "north", direction: "North" },
  { className: "south", direction: "South" },
  { className: "west", direction: "West" },
  { className: "east", direction: "East" },
  { className: "north-west", direction: "NorthWest" },
  { className: "north-east", direction: "NorthEast" },
  { className: "south-west", direction: "SouthWest" },
  { className: "south-east", direction: "SouthEast" },
] as const;

type WindowResizeDirection = (typeof WINDOW_RESIZE_HANDLES)[number]["direction"];

/** 无边框窗口的八方向缩放手柄，挂在窗口根容器（position: relative）内使用。 */
export function WindowResizeHandles() {
  const handleResizeMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const direction = event.currentTarget.dataset.resizeDirection as WindowResizeDirection | undefined;
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    void getCurrentWindow().startResizeDragging(direction).catch((resizeError) => {
      console.error("启动窗口缩放失败:", resizeError);
    });
  }, []);

  return (
    <>
      {WINDOW_RESIZE_HANDLES.map(({ className, direction }) => (
        <div
          key={direction}
          className={`window-resize-handle ${className}`}
          data-resize-direction={direction}
          onMouseDown={handleResizeMouseDown}
          aria-hidden="true"
        />
      ))}
    </>
  );
}

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
