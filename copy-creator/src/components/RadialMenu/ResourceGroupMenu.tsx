// 资源分组条的下拉子分组菜单（受控组件）：纯展示与点击回调，
// 定位/开关/折叠状态由容器（index.tsx）持有，渲染输出与抽取前一致。
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Icons } from "../Icons";
import type { ResourceFolder } from "../../types";

interface ResourceGroupMenuProps {
  /** 展平后的树形行（首行为锚分组自身，其后为可见后代）。 */
  items: Array<{ folder: ResourceFolder; depth: number }>;
  position: { left: number; top: number } | null;
  collapsedPaths: string[];
  selectedGroup: string | null;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onToggleCollapsed: (path: string) => void;
  onSwitch: (path: string) => void;
}

export function ResourceGroupMenu({
  items,
  position,
  collapsedPaths,
  selectedGroup,
  menuRef,
  onToggleCollapsed,
  onSwitch,
}: ResourceGroupMenuProps) {
  const { t } = useTranslation();
  return createPortal(
    <div
      ref={menuRef}
      className="radial-menu-resource-group-dropdown"
      role="menu"
      aria-label={t("resources.openSubfolders")}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
      onClick={(event) => event.stopPropagation()}
    >
      {items.map(({ folder, depth }, index) => {
        const hasChildren = index > 0 && (folder.children ?? []).length > 0;
        const collapsed = collapsedPaths.includes(folder.path);
        return (
          <div
            key={folder.path}
            className="resource-group-menu-entry"
            style={{ paddingLeft: `${8 + depth * 14}px` }}
          >
            <button
              type="button"
              className={`resource-group-twist${collapsed ? " collapsed" : ""}`}
              disabled={!hasChildren}
              tabIndex={hasChildren ? 0 : -1}
              aria-label={
                hasChildren
                  ? (collapsed ? t("resources.expandGroup") : t("resources.collapseGroup"))
                  : undefined
              }
              onClick={() => hasChildren && onToggleCollapsed(folder.path)}
            >
              {hasChildren ? Icons.chevronDown : null}
            </button>
            <button
              type="button"
              className={`radial-menu-resource-group-menu-item${selectedGroup === folder.path ? " selected" : ""}`}
              role="menuitem"
              aria-current={selectedGroup === folder.path ? "page" : undefined}
              title={folder.path}
              onClick={() => onSwitch(folder.path)}
            >
              {Icons.resources}
              <span>{depth === 0 ? t("resources.allFiles") : folder.name}</span>
            </button>
          </div>
        );
      })}
      </div>,
      document.body,
    );
}
