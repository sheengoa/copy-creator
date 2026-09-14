import { createPortal } from "react-dom";
import { DragOverlay } from "@dnd-kit/core";

/**
 * 分组 chip 拖拽虚影：portal 到 body——主窗口内容容器带
 * transform/backdrop-filter 时 fixed 会以其为包含块，虚影不 portal
 * 无法跟随指针（快捷输入 / 资源分组条共用）。
 */
export function ChipDragOverlay({ label, className }: { label: string; className: string }) {
  return createPortal(
    <DragOverlay dropAnimation={null}>
      <div className={`${className} active drag-overlay-chip`}>{label}</div>
    </DragOverlay>,
    document.body,
  );
}
