import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

// 卡片操作菜单的统一实现：挂载到文档根节点、fixed 定位、视口内自动收拢、
// 外点/ESC 关闭、视口尺寸变化时跟随重算。此前剪贴板卡片与资源卡片各有一份
// 手写定位实现，剪贴板版本因菜单挂在带 transform 的卡片内部，fixed 退化为
// 相对卡片定位且被后续卡片盖住（搜索后右键菜单错位即此原因）。

/** 视口坐标下的锚点矩形；右键菜单传 0×0 的点矩形。 */
export interface CardActionMenuAnchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface CardActionMenuProps {
  open: boolean;
  /** 打开时与视口变化时取锚点；关闭期间不会调用。 */
  getAnchor: () => CardActionMenuAnchor | null;
  /** 外点豁免的触发元素（如 ⋯ 按钮）；右键场景不传。 */
  anchorEl?: { current: HTMLElement | null };
  /** start：菜单左缘对齐锚点（右键菜单）；end：菜单右缘对齐锚点右缘（按钮菜单）。 */
  align?: "start" | "end";
  className?: string;
  ariaLabel?: string;
  onClose: () => void;
  children: ReactNode;
}

const MENU_PADDING = 8;
const MENU_DEFAULT_WIDTH = 158;
const MENU_DEFAULT_HEIGHT = 148;

const closeContext = createContext<{ close: () => void } | null>(null);

export function CardActionMenu({
  open,
  getAnchor,
  anchorEl,
  align = "start",
  className = "clipboard-ctx-menu",
  ariaLabel,
  onClose,
  children,
}: CardActionMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  // getAnchor 每次渲染都会重建，放进 ref 供定位回调取最新值，避免监听反复重挂。
  const getAnchorRef = useRef(getAnchor);
  useEffect(() => {
    getAnchorRef.current = getAnchor;
  }, [getAnchor]);

  const updatePosition = useCallback(() => {
    const anchor = getAnchorRef.current();
    if (!anchor) return;
    const menuRect = menuRef.current?.getBoundingClientRect();
    const menuWidth = menuRect?.width ?? MENU_DEFAULT_WIDTH;
    const menuHeight = menuRect?.height ?? MENU_DEFAULT_HEIGHT;
    const maxLeft = window.innerWidth - menuWidth - MENU_PADDING;
    const left = Math.max(
      MENU_PADDING,
      Math.min(align === "end" ? anchor.right - menuWidth : anchor.left, maxLeft),
    );
    const fitsBelow = anchor.bottom + menuHeight + 6 <= window.innerHeight - MENU_PADDING;
    const top = fitsBelow
      ? anchor.bottom + 4
      : Math.max(MENU_PADDING, anchor.top - menuHeight - 4);
    setPosition({ left, top });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const frame = requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorEl?.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, anchorEl, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      className={className}
      role="menu"
      aria-label={ariaLabel}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <closeContext.Provider value={{ close: onClose }}>{children}</closeContext.Provider>
    </div>,
    document.body,
  );
}

interface CardActionMenuItemProps {
  icon?: ReactNode;
  label: ReactNode;
  /** 菜单项样式类，跟随所在页面菜单的样式族（如 ctx-menu-item、is-danger）。 */
  className?: string;
  onClick: () => void;
}

export function CardActionMenuItem({ icon, label, className, onClick }: CardActionMenuItemProps) {
  const ctx = useContext(closeContext);
  return (
    <button
      type="button"
      role="menuitem"
      className={className}
      onClick={(event) => {
        // portal 菜单的点击仍沿 React 树冒泡到卡片，需阻断卡片自身的点击行为。
        event.stopPropagation();
        ctx?.close();
        onClick();
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function CardActionMenuSeparator({ className = "ctx-menu-sep" }: { className?: string }) {
  return <div className={className} />;
}
