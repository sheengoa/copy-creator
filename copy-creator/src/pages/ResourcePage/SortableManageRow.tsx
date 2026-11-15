// 分组管理对话框的可拖拽树行（dnd-kit sortable + 折叠箭头 + 行内动作组）。
// 自 ResourcePage.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）——
// 纯展示组件，回调与数据全部经 props 注入。

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";
import { GroupTwistButton } from "../../components/GroupTwistButton";
import type { ResourceFolder } from "../../types";

export function SortableManageRow({
  folder,
  depth,
  label,
  collapsed,
  hasChildren,
  onToggleCollapsed,
  onOpen,
  onNewSubgroup,
  onRename,
  onMove,
  onDelete,
  hideRootControls,
}: {
  folder: ResourceFolder;
  depth: number;
  label: string;
  collapsed: boolean;
  hasChildren: boolean;
  onToggleCollapsed: () => void;
  onOpen: () => void;
  onNewSubgroup: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
  hideRootControls: boolean;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: folder.path, disabled: hideRootControls });

  return (
    <div
      ref={setNodeRef}
      className={`resource-group-manage-row${isDragging ? " is-dragging" : ""}`}
      style={{
        paddingLeft: `${depth * 16}px`,
        transform: CSS.Transform.toString(transform),
        transition: transition || "transform 180ms ease",
      } as React.CSSProperties}
    >
      {!hideRootControls && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          className="resource-group-drag-handle"
          {...attributes}
          {...listeners}
          aria-label={t("resources.reorder")}
          title={t("resources.reorder")}
          onClick={(event) => event.stopPropagation()}
        >
          {Icons.drag}
        </button>
      )}
      <GroupTwistButton
        hasChildren={hasChildren}
        collapsed={collapsed}
        onToggle={onToggleCollapsed}
      />
      <div className="resource-group-manage-name" title={folder.path}>
        <span>{label}</span>
      </div>
      <span className="resource-group-manage-count">
        {t("resources.itemCount", { count: folder.count })}
      </span>
      <div className="resource-group-manage-actions">
        <button
          type="button"
          className="resource-icon-button"
          onClick={onOpen}
          aria-label={t("resources.openGroup")}
          title={t("resources.openGroup")}
        >
          {Icons.resources}
        </button>
        {!hideRootControls && (
          <>
            <button
              type="button"
              className="resource-icon-button"
              onClick={onNewSubgroup}
              aria-label={t("resources.newSubgroup")}
              title={t("resources.newSubgroup")}
            >
              {Icons.add}
            </button>
            <button
              type="button"
              className="resource-icon-button"
              onClick={onRename}
              aria-label={t("resources.renameGroup")}
              title={t("resources.renameGroup")}
            >
              {Icons.edit}
            </button>
            <button
              type="button"
              className="resource-icon-button"
              onClick={onMove}
              aria-label={t("resources.moveGroup")}
              title={t("resources.moveGroup")}
            >
              {Icons.arrowRight}
            </button>
            <button
              type="button"
              className="resource-delete-button"
              onClick={onDelete}
              aria-label={t("common.delete")}
              title={t("common.delete")}
            >
              {Icons.delete}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
