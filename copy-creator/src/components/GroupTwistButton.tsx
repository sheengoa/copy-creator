import { useTranslation } from "react-i18next";
import { Icons } from "./Icons";

/**
 * 分组树折叠箭头钮的统一实现：资源管理对话框、移动目标树、建档目标
 * 分组、径向菜单分组下钻、分组下拉菜单六处共用同一份折叠交互——
 * 无子级禁用不渲染箭头，collapsed 切样式类，aria 随态标注展开/折叠。
 * 径向类弹层（方向键导航、不需要 Tab 序）传 tabIndex={-1}。
 */
export function GroupTwistButton({
  hasChildren,
  collapsed,
  onToggle,
  tabIndex,
}: {
  hasChildren: boolean;
  collapsed: boolean;
  onToggle: () => void;
  tabIndex?: 0 | -1;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={`resource-group-twist${collapsed ? " collapsed" : ""}`}
      disabled={!hasChildren}
      tabIndex={tabIndex}
      aria-label={
        hasChildren
          ? (collapsed ? t("resources.expandGroup") : t("resources.collapseGroup"))
          : undefined
      }
      onClick={() => hasChildren && onToggle()}
    >
      {hasChildren ? Icons.chevronDown : null}
    </button>
  );
}
