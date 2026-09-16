// 分组管理对话框内的可排序树形行：受控组件，行内操作经回调交还容器。
import { useTranslation } from "react-i18next";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Icons } from "../../components/Icons";
import type { ResourceFolder } from "../../types";

export default function SortableManageRow({
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
      <button
        type="button"
        className={`resource-group-twist${collapsed ? " collapsed" : ""}`}
        disabled={!hasChildren}
        aria-label={
          hasChildren
            ? (collapsed ? t("resources.expandGroup") : t("resources.collapseGroup"))
            : undefined
        }
        onClick={() => hasChildren && onToggleCollapsed()}
      >
        {hasChildren && Icons.chevronDown}
      </button>
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
