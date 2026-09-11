import { useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Icons } from "./Icons";

interface BackToTopButtonProps {
  visible: boolean;
  onTop: () => void;
  label: string;
  /** 追加类名，如 back-to-top-fixed。 */
  className?: string;
  /** 祖先带 transform / backdrop-filter 时 fixed 定位会失效，需挂到 body。 */
  portal?: boolean;
}

// 统一的「回到顶部」按钮外观：右下角圆形箭头，滚动后淡入。
// 逻辑（滚动监视/可见性）见 hooks/useBackToTop.ts。
export function BackToTopButton({
  visible,
  onTop,
  label,
  className,
  portal = false,
}: BackToTopButtonProps) {
  // 悬停期间保持可见：闲置淡出若把按钮从指针下方抽走，用户正要点它时
  // 会扑空；移开指针后才真正淡出。
  const [hovered, setHovered] = useState(false);
  const button = (
    <button
      type="button"
      className={`back-to-top${visible || hovered ? " visible" : ""}${className ? ` ${className}` : ""}`}
      aria-label={label}
      title={label}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(event: MouseEvent) => {
        // 不冒泡：径向菜单等容器把点击视为空白区操作。
        event.stopPropagation();
        onTop();
      }}
    >
      {Icons.arrowUp}
    </button>
  );
  return portal ? createPortal(button, document.body) : button;
}
