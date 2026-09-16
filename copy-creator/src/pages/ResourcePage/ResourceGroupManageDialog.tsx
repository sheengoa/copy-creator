// 「管理分组」对话框：分组树拖拽排序 + 行内操作入口。受控组件，
// 树数据、折叠状态与全部操作回调由容器持有；拖拽虚影 portal 到 body
// （对话框的 backdrop-filter/transform 会把 fixed 包含块劫持到自身，
// 虚影会飘出对话框边界）。
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  DragOverlay,
  closestCenter,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { Icons } from "../../components/Icons";
import type { ResourceFolder } from "../../types";
import SortableManageRow from "./SortableManageRow";

interface ResourceGroupManageDialogProps {
  rows: Array<{ folder: ResourceFolder; depth: number }>;
  sensors: ReturnType<typeof import("@dnd-kit/core").useSensors>;
  collapsedPaths: string[];
  activeRowId: string | null;
  activeRowWidth: number | null;
  error: string | null;
  onClose: () => void;
  onNewSubgroup: (parentPath?: string) => void;
  onRename: (path: string) => void;
  onMove: (path: string) => void;
  onDelete: (path: string) => void;
  onOpen: (path: string) => void;
  onToggleCollapsed: (path: string) => void;
  getGroupLabel: (name: string) => string;
  onDragStart: (event: DragStartEvent) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragCancel: () => void;
}

export default function ResourceGroupManageDialog({
  rows,
  sensors,
  collapsedPaths,
  activeRowId,
  activeRowWidth,
  error,
  onClose,
  onNewSubgroup,
  onRename,
  onMove,
  onDelete,
  onOpen,
  onToggleCollapsed,
  getGroupLabel,
  onDragStart,
  onDragEnd,
  onDragCancel,
}: ResourceGroupManageDialogProps) {
  const { t } = useTranslation();
  const activeRow = activeRowId
    ? rows.find(({ folder }) => folder.path === activeRowId)?.folder ?? null
    : null;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog-content large resource-group-manage-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-title-row">
          <h3 className="dialog-title">{t("resources.manageGroups")}</h3>
          <button
            type="button"
            className="group-add-btn group-manage-add-btn"
            onClick={() => onNewSubgroup()}
            aria-label={t("resources.newGroup")}
            title={t("resources.newGroup")}
          >
            {Icons.add}
          </button>
        </div>
        {error && (
          <span className="dialog-error-text" role="alert">{error}</span>
        )}
        <div className="resource-group-manage-list">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
          >
            <SortableContext
              items={rows.map(({ folder }) => folder.path)}
              strategy={verticalListSortingStrategy}
            >
              {rows.map(({ folder, depth }) => {
                const isRoot = folder.name === "";
                const hasChildren = (folder.children ?? []).length > 0;
                const collapsed = collapsedPaths.includes(folder.path);
                return (
                  <SortableManageRow
                    key={folder.path || "ungrouped"}
                    folder={folder}
                    depth={depth}
                    label={getGroupLabel(folder.name)}
                    collapsed={collapsed}
                    hasChildren={hasChildren}
                    onToggleCollapsed={() => hasChildren && onToggleCollapsed(folder.path)}
                    onOpen={() => onOpen(folder.path)}
                    onNewSubgroup={() => onNewSubgroup(folder.path)}
                    onRename={() => onRename(folder.path)}
                    onMove={() => onMove(folder.path)}
                    onDelete={() => onDelete(folder.path)}
                    hideRootControls={isRoot}
                  />
                );
              })}
            </SortableContext>
            {/* 对话框带 backdrop-filter/transform 会让 fixed 以它为包含块，
                虚影飘出对话框；portal 到 body 才能跟随指针。 */}
            {activeRow && createPortal(
              <DragOverlay
                dropAnimation={null}
                style={activeRowWidth ? { width: activeRowWidth } : undefined}
              >
                <div className="resource-group-manage-row is-drag-overlay">
                  <span className="resource-group-drag-handle is-static">{Icons.drag}</span>
                  <span className="resource-group-manage-name">
                    {getGroupLabel(activeRow.name)}
                  </span>
                </div>
              </DragOverlay>,
              document.body,
            )}
          </DndContext>
        </div>
      </div>
    </div>
  );
}
