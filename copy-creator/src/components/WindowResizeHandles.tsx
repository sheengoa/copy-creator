import { useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const WINDOW_RESIZE_HANDLES = [
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
