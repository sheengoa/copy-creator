// 「移动分组」目标树对话框：受控组件，选中目标与执行状态由容器持有。
// 拖拽排序在管理对话框内；本对话框只做目标选择（禁选自身子树与当前父级）。
import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";
import type { ResourceGroupMoveState } from "./dialogTypes";

interface ResourceGroupMoveDialogProps {
  moveState: NonNullable<ResourceGroupMoveState>;
  rows: Array<{ folder: import("../../types").ResourceFolder; depth: number }>;
  collapsedPaths: string[];
  moving: boolean;
  error: string | null;
  onSelectTarget: (target: string | null) => void;
  onClose: () => void;
  onConfirm: () => void;
  onToggleCollapsed: (path: string) => void;
}

export default function ResourceGroupMoveDialog({
  moveState,
  rows,
  collapsedPaths,
  moving,
  error,
  onSelectTarget,
  onClose,
  onConfirm,
  onToggleCollapsed,
}: ResourceGroupMoveDialogProps) {
  const { t } = useTranslation();
  return (
    <div className="dialog-overlay" onClick={() => !moving && onClose()}>
      <div
        className="dialog-content resource-move-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="dialog-title">
          {t("resources.moveGroupTitle", {
            name: moveState.path.split("/").pop() ?? moveState.path,
          })}
        </h3>
        <div className="resource-move-tree" role="listbox" aria-label={t("resources.moveGroup")}>
          <div className="resource-move-entry">
            <button
              type="button"
              className="resource-group-twist"
              disabled
              tabIndex={-1}
            />
            <button
              type="button"
              className={`resource-move-row${moveState.target === "" ? " selected" : ""}`}
              role="option"
              aria-selected={moveState.target === ""}
              onClick={() => onSelectTarget("")}
            >
              <span className="resource-move-icon">{Icons.resources}</span>
              <span>{t("resources.topLevel")}</span>
            </button>
          </div>
          {rows.map(({ folder, depth }) => {
            const currentParent = moveState.path
              .split("/")
              .slice(0, -1)
              .join("/");
            const inSubtree = folder.path === moveState.path
              || folder.path.startsWith(`${moveState.path}/`);
            const disabled = inSubtree || folder.path === currentParent;
            const hasChildren = (folder.children ?? []).length > 0;
            const collapsed = collapsedPaths.includes(folder.path);
            return (
              <div
                key={folder.path}
                className="resource-move-entry"
                style={{ paddingLeft: `${depth * 16}px` }}
              >
                <button
                  type="button"
                  className={`resource-group-twist${collapsed ? " collapsed" : ""}`}
                  disabled={!hasChildren}
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
                  className={`resource-move-row${moveState.target === folder.path ? " selected" : ""}${disabled ? " current" : ""}`}
                  role="option"
                  aria-selected={moveState.target === folder.path}
                  disabled={disabled}
                  title={folder.path}
                  onClick={() => !disabled && onSelectTarget(folder.path)}
                >
                  <span className="resource-move-icon">{Icons.resources}</span>
                  <span>{folder.name}</span>
                  {folder.path === currentParent && (
                    <span className="resource-move-current-tag">{t("resources.currentParentTag")}</span>
                  )}
                  {inSubtree && (
                    <span className="resource-move-current-tag">{t("resources.selfTag")}</span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
        <p className="resource-move-hint">{t("resources.moveGroupHint")}</p>
        {error && (
          <span className="dialog-error-text" role="alert">{error}</span>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="dialog-btn secondary"
            onClick={onClose}
            disabled={moving}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="dialog-btn save"
            disabled={moveState.target === null || moving}
            onClick={onConfirm}
          >
            {moving ? t("common.saving") : t("resources.move")}
          </button>
        </div>
      </div>
    </div>
  );
}
