// 资源分组三对话框：管理对话框（dnd-kit 树行排序 + 拖拽虚影 portal）、
// 新建/重命名对话框、移动分组目标树对话框。自 ResourcePage.tsx 拆出
// （2026-11-14，架构守卫规则 27 行数上限）；状态机与动作收口在
// useResourceGroupAdmin，本组件经 admin bundle 消费（JSX 为原文机械重命名）。

import { DndContext, DragOverlay, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";
import { formatResourceFolderPath } from "../../domain/groups";
import { GroupTwistButton } from "../../components/GroupTwistButton";
import { SortableManageRow } from "./SortableManageRow";
import type { useResourceGroupAdmin } from "./useResourceGroupAdmin";

type AdminBundle = ReturnType<typeof useResourceGroupAdmin>;

export function ResourceGroupDialogs({
  admin,
  resourceGroupsError,
}: {
  admin: AdminBundle;
  resourceGroupsError: string | null;
}) {
  const { t } = useTranslation();
  // TS 属性访问收窄不跨成员表达式：move 对话框三状态解构为局部常量。
  const { resourceGroupMove, movingGroup, movingGroupError } = admin;
  const getResourceGroupLabel = (name: string) => (
    name === "" ? t("resources.ungrouped") : name
  );
  const manageRowSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  return (
    <>
      {admin.resourceGroupManageOpen && (
        <div className="dialog-overlay" onClick={() => admin.setResourceGroupManageOpen(false)}>
          <div
            className="dialog-content large resource-group-manage-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-title-row">
              <h3 className="dialog-title">{t("resources.manageGroups")}</h3>
              <button
                type="button"
                className="group-add-btn group-manage-add-btn"
                onClick={() => admin.openNewResourceGroup()}
                aria-label={t("resources.newGroup")}
                title={t("resources.newGroup")}
              >
                {Icons.add}
              </button>
            </div>
            {resourceGroupsError && (
              <span className="dialog-error-text" role="alert">{resourceGroupsError}</span>
            )}
            <div className="resource-group-manage-list">
              <DndContext
                sensors={manageRowSensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis]}
                onDragStart={admin.handleManageRowDragStart}
                onDragEnd={admin.handleReorderManageRows}
                onDragCancel={() => {
                  admin.setActiveGroupRowId(null);
                  admin.setActiveGroupRowWidth(null);
                }}
              >
                <SortableContext
                  items={admin.manageRows.map(({ folder }) => folder.path)}
                  strategy={verticalListSortingStrategy}
                >
                  {admin.manageRows.map(({ folder, depth }) => {
                    const isRoot = folder.name === "";
                    const hasChildren = (folder.children ?? []).length > 0;
                    const collapsed = admin.collapsedGroupPaths.includes(folder.path);
                    return (
                      <SortableManageRow
                        key={folder.path || "ungrouped"}
                        folder={folder}
                        depth={depth}
                        label={getResourceGroupLabel(folder.name)}
                        collapsed={collapsed}
                        hasChildren={hasChildren}
                        onToggleCollapsed={() => hasChildren && admin.toggleGroupCollapsed(folder.path)}
                        onOpen={() => void admin.handleOpenResourceGroup(folder.path)}
                        onNewSubgroup={() => admin.openNewResourceGroup(folder.path)}
                        onRename={() => admin.openRenameResourceGroup(folder.path)}
                        onMove={() => admin.openGroupMove(folder.path)}
                        onDelete={() => admin.handleDeleteResourceGroup(folder.path)}
                        hideRootControls={isRoot}
                      />
                    );
                  })}
                </SortableContext>
                {/* 对话框带 backdrop-filter/transform 会让 fixed 以它为包含块，
                    虚影飘出对话框；portal 到 body 才能跟随指针。 */}
                {admin.activeGroupRow && createPortal(
                  <DragOverlay
                    dropAnimation={null}
                    style={admin.activeGroupRowWidth ? { width: admin.activeGroupRowWidth } : undefined}
                  >
                    <div className="resource-group-manage-row is-drag-overlay">
                      <span className="resource-group-drag-handle is-static">{Icons.drag}</span>
                      <span className="resource-group-manage-name">
                        {getResourceGroupLabel(admin.activeGroupRow.name)}
                      </span>
                    </div>
                  </DragOverlay>,
                  document.body,
                )}
              </DndContext>
            </div>
          </div>
        </div>
      )}

      {admin.resourceGroupDialog && (
        <div className="dialog-overlay" onClick={() => admin.setResourceGroupDialog(null)}>
          <div className="dialog-content" onClick={(event) => event.stopPropagation()}>
            <h3 className="dialog-title">
              {admin.resourceGroupDialog.mode === "rename"
                ? t("resources.renameGroup")
                : t("resources.newGroup")}
            </h3>
            {admin.resourceGroupDialog.mode === "create" && admin.resourceGroupDialog.parentPath && (
              <p className="resource-group-path-hint">
                {t("resources.groupCreateAt", {
                  path: formatResourceFolderPath(admin.resourceGroupDialog.parentPath),
                })}
              </p>
            )}
            {admin.resourceGroupDialog.mode === "rename" && admin.resourceGroupDialog.oldName && (
              <p className="resource-group-path-hint">
                {t("resources.groupLocationAt", {
                  path: formatResourceFolderPath(
                    admin.resourceGroupDialog.oldName.split("/").slice(0, -1).join("/"),
                  ),
                })}
              </p>
            )}
            <input
              className="dialog-input"
              autoFocus
              value={admin.resourceGroupName}
              placeholder={t("resources.groupName")}
              onChange={(event) => admin.setResourceGroupName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void admin.handleSaveResourceGroup();
              }}
            />
            {resourceGroupsError && (
              <span className="dialog-error-text" role="alert">{resourceGroupsError}</span>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="dialog-btn secondary"
                onClick={() => admin.setResourceGroupDialog(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="dialog-btn save"
                onClick={() => void admin.handleSaveResourceGroup()}
                disabled={!admin.resourceGroupName.trim() || admin.resourceGroupSaving}
              >
                {admin.resourceGroupSaving ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {resourceGroupMove && (
        <div className="dialog-overlay" onClick={() => !movingGroup && admin.setResourceGroupMove(null)}>
          <div
            className="dialog-content resource-move-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="dialog-title">
              {t("resources.moveGroupTitle", {
                name: resourceGroupMove.path.split("/").pop() ?? resourceGroupMove.path,
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
                  className={`resource-move-row${resourceGroupMove.target === "" ? " selected" : ""}`}
                  role="option"
                  aria-selected={resourceGroupMove.target === ""}
                  onClick={() => admin.setResourceGroupMove({ ...resourceGroupMove, target: "" })}
                >
                  <span className="resource-move-icon">{Icons.resources}</span>
                  <span>{t("resources.topLevel")}</span>
                </button>
              </div>
              {admin.groupMoveRows.map(({ folder, depth }) => {
                const currentParent = resourceGroupMove.path
                  .split("/")
                  .slice(0, -1)
                  .join("/");
                const inSubtree = folder.path === resourceGroupMove.path
                  || folder.path.startsWith(`${resourceGroupMove.path}/`);
                const disabled = inSubtree || folder.path === currentParent;
                const hasChildren = (folder.children ?? []).length > 0;
                const collapsed = admin.collapsedGroupPaths.includes(folder.path);
                return (
                  <div
                    key={folder.path}
                    className="resource-move-entry"
                    style={{ paddingLeft: `${depth * 16}px` }}
                  >
                    <GroupTwistButton
                      hasChildren={hasChildren}
                      collapsed={collapsed}
                      onToggle={() => admin.toggleGroupCollapsed(folder.path)}
                    />
                    <button
                      type="button"
                      className={`resource-move-row${resourceGroupMove.target === folder.path ? " selected" : ""}${disabled ? " current" : ""}`}
                      role="option"
                      aria-selected={resourceGroupMove.target === folder.path}
                      disabled={disabled}
                      title={folder.path}
                      onClick={() => !disabled && admin.setResourceGroupMove({ ...resourceGroupMove, target: folder.path })}
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
            {movingGroupError && (
              <span className="dialog-error-text" role="alert">{movingGroupError}</span>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="dialog-btn secondary"
                onClick={() => admin.setResourceGroupMove(null)}
                disabled={movingGroup}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="dialog-btn save"
                disabled={resourceGroupMove.target === null || movingGroup}
                onClick={() => void admin.handleMoveGroupConfirm()}
              >
                {movingGroup ? t("common.saving") : t("resources.move")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
