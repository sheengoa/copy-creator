// 资源分组管理子系统：管理对话框/移动分组对话框的状态机、树形派生
// （折叠展平/父映射/拖拽虚影）、分组 CRUD 与跨重启排序持久化。
// 自 ResourcePage.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）。
// 浏览态（resourceGroup 当前分组）与分组加载（loadResourceGroups）、
// 列表重载（loadRecords）、确认框（setConfirmState）、选择取消
// （cancelResourceSelection）与主列表共享，经 params 注入。

import { useCallback, useMemo, useState } from "react";
import type { ClipType } from "../../stores/clipboardStore";
import { invoke } from "@tauri-apps/api/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useTranslation } from "react-i18next";
import type { ResourceFolder } from "../../types";
import {
  buildResourceFolderParentMap,
  flattenResourceFolderPaths,
  flattenResourceFoldersVisible,
  getResourceFolderSiblings,
  isResourceFolderPath,
  reorderResourceFolderSiblings,
} from "../../domain/groups";

export type ResourceGroupDialogState = {
  mode: "create" | "rename";
  parentPath?: string;
  oldName?: string;
} | null;

export function useResourceGroupAdmin({
  resourceGroups,
  setResourceGroups,
  resourceGroup,
  setStoreResourceGroup,
  loadResourceGroups,
  loadRecords,
  setConfirmState,
  setResourceGroupsError,
}: {
  resourceGroups: ResourceFolder[];
  setResourceGroups: (groups: ResourceFolder[]) => void;
  /** 当前浏览分组（null=全部视图）；分组增删改后联动重定位。 */
  resourceGroup: string | null;
  setStoreResourceGroup: (group: string | null) => void;
  loadResourceGroups: () => Promise<unknown>;
  loadRecords: (append?: boolean, categoryOverride?: ClipType, resourceGroup?: string | null) => Promise<void>;
  setConfirmState: (state: {
    message: string;
    hint?: string;
    onConfirm: () => void | Promise<void>;
  } | null) => void;
  setResourceGroupsError: (error: string | null) => void;
}) {
  const { t } = useTranslation();
  const [resourceGroupManageOpen, setResourceGroupManageOpen] = useState(false);
  const [resourceGroupDialog, setResourceGroupDialog] = useState<ResourceGroupDialogState>(null);
  const [resourceGroupName, setResourceGroupName] = useState("");
  const [resourceGroupSaving, setResourceGroupSaving] = useState(false);
  const [collapsedGroupPaths, setCollapsedGroupPaths] = useState<string[]>([]);
  const [resourceGroupMove, setResourceGroupMove] = useState<{ path: string; target: string | null } | null>(null);
  const [movingGroup, setMovingGroup] = useState(false);
  const [movingGroupError, setMovingGroupError] = useState<string | null>(null);
  const [activeGroupRowId, setActiveGroupRowId] = useState<string | null>(null);
  // 拖动虚影与被拖行等宽：fixed 定位的 DragOverlay 默认按内容收缩，
  // 文字短时会缩成一小条（与剪贴板区 activeOverlayWidth 同一做法）。
  const [activeGroupRowWidth, setActiveGroupRowWidth] = useState<number | null>(null);

  // 管理对话框的树形行：折叠的分组不展示其后代；计数为含子级的总量（后端提供）。
  const manageRows = useMemo(
    () => flattenResourceFoldersVisible(resourceGroups, new Set(collapsedGroupPaths)),
    [collapsedGroupPaths, resourceGroups],
  );
  // 「移动分组」目标树与管理对话框共用同一折叠集合：同一棵树在两个
  // 对话框间来回打开时保持一致的浏览状态。
  const groupMoveRows = useMemo(
    () => flattenResourceFoldersVisible(
      resourceGroups.filter((group) => group.name !== ""),
      new Set(collapsedGroupPaths),
    ),
    [collapsedGroupPaths, resourceGroups],
  );
  // 管理对话框拖拽用：分组路径 → 父分组路径（顶层为 null）。
  const groupParentMap = useMemo(
    () => buildResourceFolderParentMap(resourceGroups),
    [resourceGroups],
  );
  const handleManageRowDragStart = useCallback((event: DragStartEvent) => {
    setActiveGroupRowId(String(event.active.id));
    setActiveGroupRowWidth(event.active.rect.current.initial?.width ?? null);
  }, []);
  const activeGroupRow = activeGroupRowId
    ? manageRows.find(({ folder }) => folder.path === activeGroupRowId)?.folder ?? null
    : null;

  const openNewResourceGroup = useCallback((parentPath?: string) => {
    setResourceGroupName("");
    setResourceGroupsError(null);
    setResourceGroupDialog({ mode: "create", parentPath });
  }, [setResourceGroupsError]);

  const openRenameResourceGroup = useCallback((name: string) => {
    const segments = name.split("/");
    setResourceGroupName(segments[segments.length - 1] ?? name);
    setResourceGroupsError(null);
    setResourceGroupDialog({ mode: "rename", oldName: name });
  }, [setResourceGroupsError]);

  const toggleGroupCollapsed = useCallback((path: string) => {
    setCollapsedGroupPaths((current) => (
      current.includes(path)
        ? current.filter((path2) => path2 !== path)
        : [...current, path]
    ));
  }, []);

  const openGroupMove = useCallback((path: string) => {
    setResourceGroupManageOpen(false);
    setMovingGroupError(null);
    setResourceGroupMove({ path, target: null });
  }, []);

  const handleMoveGroupConfirm = useCallback(async () => {
    if (!resourceGroupMove || resourceGroupMove.target === null || movingGroup) return;
    const movedPath = resourceGroupMove.path;
    const target = resourceGroupMove.target;
    setMovingGroup(true);
    setMovingGroupError(null);
    try {
      await invoke("move_resource_group", { path: movedPath, newParent: target });
      await loadResourceGroups();
      const baseName = movedPath.split("/").pop() ?? movedPath;
      const nextMovedPath = target === "" ? baseName : `${target}/${baseName}`;
      let nextGroup: string | null = resourceGroup;
      if (resourceGroup !== null) {
        if (resourceGroup === movedPath) {
          nextGroup = nextMovedPath;
        } else if (resourceGroup.startsWith(`${movedPath}/`)) {
          const rest = resourceGroup.slice(movedPath.length + 1);
          nextGroup = target === "" ? rest : `${target}/${rest}`;
        }
      }
      setStoreResourceGroup(nextGroup);
      setResourceGroupMove(null);
      await loadRecords(false, "resources", nextGroup);
    } catch (error) {
      console.error("Failed to move resource group:", error);
      setMovingGroupError(String(error));
    } finally {
      setMovingGroup(false);
    }
  }, [
    loadRecords,
    loadResourceGroups,
    movingGroup,
    resourceGroup,
    resourceGroupMove,
    setStoreResourceGroup,
  ]);

  const handleSaveResourceGroup = useCallback(async () => {
    const name = resourceGroupName.trim();
    if (!name || resourceGroupSaving) return;
    setResourceGroupSaving(true);
    setResourceGroupsError(null);
    try {
      if (resourceGroupDialog?.mode === "rename" && resourceGroupDialog.oldName) {
        const segments = resourceGroupDialog.oldName.split("/");
        segments[segments.length - 1] = name;
        const newPath = segments.join("/");
        await invoke("update_resource_group", {
          oldName: resourceGroupDialog.oldName,
          newName: newPath,
        });
        await loadResourceGroups();
        setStoreResourceGroup(newPath);
      } else {
        const parentPath = resourceGroupDialog?.parentPath;
        const fullPath = parentPath ? `${parentPath}/${name}` : name;
        await invoke("create_resource_group", { name: fullPath });
        await loadResourceGroups();
        setStoreResourceGroup(fullPath);
      }
      setResourceGroupDialog(null);
    } catch (error) {
      console.error("Failed to save resource group:", error);
      setResourceGroupsError(String(error));
    } finally {
      setResourceGroupSaving(false);
    }
  }, [
    loadResourceGroups,
    setResourceGroupsError,
    resourceGroupDialog,
    resourceGroupName,
    resourceGroupSaving,
    setStoreResourceGroup,
  ]);

  const handleOpenResourceGroup = useCallback(async (name: string) => {
    try {
      await invoke("open_resource_group", { name });
    } catch (error) {
      console.error("Failed to open resource group:", error);
      setResourceGroupsError(String(error));
    }
  }, [setResourceGroupsError]);

  // 按新兄弟顺序重排分组树并持久化（扁平全路径列表）；失败时回退为后端顺序。
  const commitGroupOrder = useCallback(async (nextGroups: ResourceFolder[]) => {
    const ungrouped = nextGroups.find((group) => group.name === "");
    setResourceGroups(nextGroups);
    const ordered = nextGroups.filter((group) => group.name !== "");
    try {
      await invoke("reorder_resource_groups", {
        ids: flattenResourceFolderPaths(ordered),
      });
    } catch (error) {
      console.error("Failed to reorder resource groups:", error);
      void loadResourceGroups();
    }
    return ungrouped ? [ungrouped, ...ordered] : ordered;
  }, [loadResourceGroups, setResourceGroups]);

  const handleReorderTopGroups = useCallback((orderedPaths: string[]) => {
    void commitGroupOrder(reorderResourceFolderSiblings(resourceGroups, null, orderedPaths));
  }, [commitGroupOrder, resourceGroups]);

  const handleReorderManageRows = useCallback((event: DragEndEvent) => {
    setActiveGroupRowId(null);
    setActiveGroupRowWidth(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeParent = groupParentMap.get(String(active.id)) ?? null;
    const overParent = groupParentMap.get(String(over.id)) ?? null;
    // 只允许在同一父分组内排序，跨层级移动仍走「移动分组」对话框。
    if (activeParent !== overParent) return;
    const siblings = getResourceFolderSiblings(resourceGroups, activeParent);
    const oldIndex = siblings.findIndex((group) => group.path === active.id);
    const newIndex = siblings.findIndex((group) => group.path === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const orderedPaths = arrayMove(siblings, oldIndex, newIndex).map((group) => group.path);
    void commitGroupOrder(reorderResourceFolderSiblings(resourceGroups, activeParent, orderedPaths));
  }, [commitGroupOrder, groupParentMap, resourceGroups]);

  const handleDeleteResourceGroup = useCallback((name: string) => {
    setConfirmState({
      message: t("resources.confirmDeleteGroup", { name }),
      hint: t("resources.confirmDeleteGroupHint"),
      onConfirm: async () => {
        try {
          await invoke("delete_resource_group", { name });
          await loadResourceGroups();
          const nextGroup = resourceGroup !== null && isResourceFolderPath(resourceGroup, name)
            ? null
            : resourceGroup;
          setStoreResourceGroup(nextGroup);
          await loadRecords(false, "resources", nextGroup);
          setResourceGroupManageOpen(false);
        } catch (error) {
          console.error("Failed to delete resource group:", error);
          setResourceGroupsError(String(error));
        }
      },
    });
  }, [loadRecords, loadResourceGroups, resourceGroup, setConfirmState, setResourceGroupsError, setStoreResourceGroup, t]);

  return {
    // 对话框开合与表单态（渲染消费）
    resourceGroupManageOpen,
    setResourceGroupManageOpen,
    resourceGroupDialog,
    setResourceGroupDialog,
    resourceGroupName,
    setResourceGroupName,
    resourceGroupSaving,
    resourceGroupMove,
    setResourceGroupMove,
    movingGroup,
    movingGroupError,
    setMovingGroupError,
    // 树形派生与拖拽虚影（渲染消费）
    manageRows,
    groupMoveRows,
    groupParentMap,
    activeGroupRow,
    activeGroupRowWidth,
    setActiveGroupRowId,
    setActiveGroupRowWidth,
    handleManageRowDragStart,
    // 折叠集合（渲染树行 collapsed 判定消费）
    collapsedGroupPaths,
    // 动作（渲染与其它逻辑消费）
    openNewResourceGroup,
    openRenameResourceGroup,
    toggleGroupCollapsed,
    openGroupMove,
    handleMoveGroupConfirm,
    handleSaveResourceGroup,
    handleOpenResourceGroup,
    handleReorderTopGroups,
    handleReorderManageRows,
    handleDeleteResourceGroup,
  };
}
