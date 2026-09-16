import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useClipboardStore } from "../stores/clipboardStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useMultiSelect } from "../hooks/useMultiSelect";
import { Icons } from "../components/Icons";
import IosSelect from "../components/IosSelect";
import SearchInput from "../components/SearchInput";
import BatchSelectionBar from "../components/BatchSelectionBar";
import type { ClipboardRecord, ResourceFolder } from "../types";
import { BackToTopButton } from "../components/BackToTop";
import { useBackToTop } from "../hooks/useBackToTop";
import { useRefreshOnShow } from "../hooks/useRefreshOnShow";
import ResourceDetailPage from "./ResourcePage/ResourceDetailPage";
import ResourceGroupChips from "./ResourcePage/ResourceGroupChips";
import type { ResourceMediaKind as ResourceMediaKindLabel } from "../domain/mediaKind";
import { ResourceCard } from "./ResourcePage/ResourceCard";
import { buildRecordView, type RecordView } from "../domain/recordView";
import { type ResourceTypeFilter } from "../domain/mediaKind";
import { computeResourceColumnCount, splitResourceColumns } from "./ResourcePage/resourceUtils";
import { buildResourceFolderParentMap, findResourceFolder, flattenResourceFolderPaths, flattenResourceFoldersVisible, formatResourceFolderPath, getResourceFolderRoot, getResourceFolderSiblings, isResourceFolderPath, reorderResourceFolderSiblings } from "../domain/groups";
import { inferResourceMediaKind, matchesResourceType } from "../domain/mediaKind";
import { getResourceTitle } from "../domain/records";
import ResourceMoveDialog from "./ResourcePage/ResourceMoveDialog";
import ResourceGroupNameDialog from "./ResourcePage/ResourceGroupNameDialog";
import ResourceGroupMoveDialog from "./ResourcePage/ResourceGroupMoveDialog";
import ResourceGroupManageDialog from "./ResourcePage/ResourceGroupManageDialog";
import ResourceLibrarySettings from "./ResourcePage/ResourceLibrarySettings";
import { isResourceRecord } from "../domain/records";
import { mayReloadSharedRecordsView } from "../domain/viewOwnership";

import type {
  ResourceGroupDialogState,
  ResourceGroupMoveState,
  ResourceMoveDialogState,
} from "./ResourcePage/dialogTypes";

const RESOURCE_TYPE_FILTERS: ResourceTypeFilter[] = [
  "all",
  "text",
  "image",
  "video",
  "audio",
  "file",
];

export default function ResourcePage({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const {
    records,
    search,
    loading,
    loadError,
    hasMore,
    init,
    setSearch,
    loadRecords,
    loadAllRecords,
    setResourceGroup: setStoreResourceGroup,
    deleteRecord,
    deleteRecords,
    pasteRecord,
  } = useClipboardStore();
  const contentSort = useSettingsStore((s) => s.contentSort);

  const [typeFilter, setTypeFilter] = useState<ResourceTypeFilter>("all");
  const [detailRecordId, setDetailRecordId] = useState<string | null>(null);
  const [detailRecord, setDetailRecord] = useState<ClipboardRecord | null>(null);
  const detailHistoryRef = useRef(false);
  const pendingScrollTopRef = useRef<number | null>(null);
  const resourceListRef = useRef<HTMLDivElement>(null);
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  const [columnCount, setColumnCount] = useState(2);
  const [feedback, setFeedback] = useState<"copied" | "copyFailed" | "deleteFailed" | "openFailed" | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  const [deletingSelected, setDeletingSelected] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [moveDialog, setMoveDialog] = useState<ResourceMoveDialogState>(null);
  const [movingResource, setMovingResource] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moveFeedback, setMoveFeedback] = useState<string | null>(null);
  const [resourceLibraryPath, setResourceLibraryPath] = useState("");
  const [resourceLibraryPathLoading, setResourceLibraryPathLoading] = useState(true);
  const [resourceLibraryPathChanging, setResourceLibraryPathChanging] = useState(false);
  const [resourceLibraryPathError, setResourceLibraryPathError] = useState<string | null>(null);
  const [resourceSettingsOpen, setResourceSettingsOpen] = useState(false);
  const [resourceGroups, setResourceGroups] = useState<ResourceFolder[]>([]);
  const [resourceGroup, setResourceGroup] = useState<string | null>(null);
  const [resourceGroupsLoading, setResourceGroupsLoading] = useState(true);
  const [resourceGroupsError, setResourceGroupsError] = useState<string | null>(null);
  const [resourceGroupManageOpen, setResourceGroupManageOpen] = useState(false);
  const [resourceGroupDialog, setResourceGroupDialog] = useState<ResourceGroupDialogState>(null);
  const [resourceGroupName, setResourceGroupName] = useState("");
  const [resourceGroupSaving, setResourceGroupSaving] = useState(false);
  const [collapsedGroupPaths, setCollapsedGroupPaths] = useState<string[]>([]);
  const [resourceGroupMove, setResourceGroupMove] = useState<ResourceGroupMoveState>(null);
  const [movingGroup, setMovingGroup] = useState(false);
  const [movingGroupError, setMovingGroupError] = useState<string | null>(null);
  const resourceSettingsButtonRef = useRef<HTMLButtonElement>(null);
  const resourceSettingsPopoverRef = useRef<HTMLElement>(null);
  const [confirmState, setConfirmState] = useState<{
    message: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const searchEffectInitializedRef = useRef(false);
  const selectAllRequestRef = useRef(0);

  const typeLabels = useMemo<Record<ResourceMediaKindLabel, string>>(
    () => ({
      text: t("resources.typeText"),
      image: t("resources.typeImage"),
      video: t("resources.typeVideo"),
      audio: t("resources.typeAudio"),
      file: t("resources.typeFile"),
    }),
    [t],
  );
  const typeFilterLabel = useCallback(
    (kind: ResourceTypeFilter) => kind === "all" ? t("resources.typeAll") : typeLabels[kind],
    [t, typeLabels],
  );
  // 分组浏览的本地排序（最新/最旧）。「全部」视图按内容排序偏好展示，控件隐藏。
  const [sortOrderLocal, setSortOrderLocal] = useState<"newest" | "oldest">("newest");
  const sortOptions = useMemo(() => ([
    { value: "newest", label: t("resources.sortNewest") },
    { value: "oldest", label: t("resources.sortOldest") },
  ]), [t]);

  const showFeedback = useCallback((next: "copied" | "copyFailed" | "deleteFailed" | "openFailed") => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    setFeedback(next);
    feedbackTimerRef.current = window.setTimeout(() => {
      setFeedback(null);
      feedbackTimerRef.current = null;
    }, 2200);
  }, []);

  useEffect(() => () => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
  }, []);

  const loadResourceGroups = useCallback(async () => {
    setResourceGroupsLoading(true);
    try {
      const groups = await invoke<ResourceFolder[]>("get_resource_groups");
      setResourceGroups(groups);
      setResourceGroupsError(null);
      return groups;
    } catch (error) {
      console.error("Failed to load resource groups:", error);
      setResourceGroupsError(t("resources.groupLoadError"));
      return null;
    } finally {
      setResourceGroupsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    setSearch("");
    setStoreResourceGroup(null);
    init("resources");
  }, [init, setSearch, setStoreResourceGroup]);

  useEffect(() => {
    void loadResourceGroups();
  }, [loadResourceGroups]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    listen("resource-groups-changed", () => {
      void loadResourceGroups();
      // 归属判定（domain/viewOwnership）：外部资源库变更事件不分面板广播，
      // 本页不可见时不得强制加载资源视图——否则用户在剪切板页的每次外部
      // 文件操作都会把共享视图抢成资源，列表随即「有内容却显示为空」。
      if (
        !mayReloadSharedRecordsView({
          pageVisible: active,
          pageView: "resources",
          storeCategory: useClipboardStore.getState().category,
        })
      ) {
        return;
      }
      void loadRecords(false, "resources", resourceGroup);
    }).then((nextUnlisten) => {
      if (cancelled) {
        nextUnlisten();
      } else {
        unlisten = nextUnlisten;
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [active, loadRecords, loadResourceGroups, resourceGroup]);

  // 主窗口从隐藏恢复显示时重载分组与记录：兜底隐藏期间丢失/被节流的刷新。
  // 归属判定：本页不可见时（恢复显示的是剪切板等其他面板）不得写共享视图，
  // 否则每次窗口显示都会覆盖剪切板回调先落地的加载，列表恒空（空列表根因）。
  useRefreshOnShow(useCallback(() => {
    void loadResourceGroups();
    if (
      !mayReloadSharedRecordsView({
        pageVisible: active,
        pageView: "resources",
        storeCategory: useClipboardStore.getState().category,
      })
    ) {
      return;
    }
    void loadRecords(false, "resources", resourceGroup);
  }, [active, loadRecords, loadResourceGroups, resourceGroup]));

  // 对称兜底：本页激活即重载。归属判定使 resource-groups-changed /
  // 恢复显示兜底不再刷新不可见页，停留在其他面板期间的外部变更由激活
  // 重载补偿（不可见时不触发，无抢占风险）；视图仍被剪切板分类占用时
  // 借此写回资源视图，与剪切板页的重申对称。
  const resourcesActiveRef = useRef(active);
  useEffect(() => {
    if (resourcesActiveRef.current === active) return;
    resourcesActiveRef.current = active;
    if (!active) return;
    void loadRecords(false, "resources", resourceGroup);
  }, [active, loadRecords, resourceGroup]);

  useEffect(() => {
    let cancelled = false;
    setResourceLibraryPathLoading(true);
    invoke<string>("get_resource_library_path")
      .then((path) => {
        if (cancelled) return;
        setResourceLibraryPath(path);
        setResourceLibraryPathError(null);
      })
      .catch(() => {
        if (!cancelled) setResourceLibraryPathError(t("resources.libraryPathError"));
      })
      .finally(() => {
        if (!cancelled) setResourceLibraryPathLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    if (!resourceSettingsOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (resourceSettingsPopoverRef.current?.contains(target)) return;
      if (resourceSettingsButtonRef.current?.contains(target)) return;
      setResourceSettingsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setResourceSettingsOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [resourceSettingsOpen]);

  useEffect(() => {
    if (!searchEffectInitializedRef.current) {
      searchEffectInitializedRef.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      // search 是两页共享的 store 字段：剪切板页输入也会走到这里，
      // 本页不可见时不得借防抖重载抢占共享视图（空列表根因之一）。
      if (
        !mayReloadSharedRecordsView({
          pageVisible: active,
          pageView: "resources",
          storeCategory: useClipboardStore.getState().category,
        })
      ) {
        return;
      }
      void loadRecords(false, "resources", resourceGroup);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [active, loadRecords, resourceGroup, search]);

  const filteredRecords = useMemo(() => {
    const next = records.filter((record) => (
      isResourceRecord(record)
      && matchesResourceType(record, typeFilter)
    ));
    // 分组浏览保留「最新/最旧」本地排序；「全部」视图按内容排序偏好由后端排序。
    if (resourceGroup !== null && sortOrderLocal === "oldest") {
      return [...next].sort((left, right) => (
        new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
      ));
    }
    return next;
  }, [records, typeFilter, resourceGroup, sortOrderLocal]);

  const visibleIds = useMemo(
    () => filteredRecords.map((record) => record.id),
    [filteredRecords],
  );
  const {
    isSelecting,
    selectedIds,
    selectedCount,
    allVisibleSelected,
    startSelection,
    exitSelection,
    toggleSelected,
    isSelected,
    toggleAllVisible,
    selectIds,
  } = useMultiSelect(visibleIds);

  const startResourceSelection = useCallback(() => {
    selectAllRequestRef.current += 1;
    startSelection();
  }, [startSelection]);

  const cancelResourceSelection = useCallback(() => {
    selectAllRequestRef.current += 1;
    setSelectingAll(false);
    exitSelection();
  }, [exitSelection]);

  useEffect(() => {
    if (isSelecting || !selectingAll) return;
    selectAllRequestRef.current += 1;
    setSelectingAll(false);
  }, [isSelecting, selectingAll]);

  const columns = splitResourceColumns(filteredRecords, columnCount);

  // 列数随列表宽度动态变化，窗口缩放时实时跟随（最少两列）。
  useEffect(() => {
    if (!listElement) return;
    const update = () => setColumnCount(computeResourceColumnCount(listElement.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(listElement);
    return () => observer.disconnect();
  }, [listElement]);

  // 统一的「回到顶部」：批量选择模式下隐藏。
  const backToTop = useBackToTop({ enabled: !isSelecting });

  const manageRowSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const handleSearchChange = useCallback((value: string) => {
    cancelResourceSelection();
    setSearch(value);
  }, [cancelResourceSelection, setSearch]);

  const handleSelectType = useCallback((next: ResourceTypeFilter) => {
    cancelResourceSelection();
    setTypeFilter(next);
  }, [cancelResourceSelection]);

  const resourceFolderGroups = useMemo(
    () => resourceGroups.filter((group) => group.name !== ""),
    [resourceGroups],
  );
  const selectedResourceFolder = useMemo(
    () => resourceGroup && resourceGroup !== ""
      ? findResourceFolder(resourceFolderGroups, resourceGroup)
      : null,
    [resourceFolderGroups, resourceGroup],
  );
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
  const [activeGroupRowId, setActiveGroupRowId] = useState<string | null>(null);
  // 拖动虚影与被拖行等宽：fixed 定位的 DragOverlay 默认按内容收缩，
  // 文字短时会缩成一小条（与剪贴板区 activeOverlayWidth 同一做法）。
  const [activeGroupRowWidth, setActiveGroupRowWidth] = useState<number | null>(null);
  const handleManageRowDragStart = useCallback((event: DragStartEvent) => {
    setActiveGroupRowId(String(event.active.id));
    setActiveGroupRowWidth(event.active.rect.current.initial?.width ?? null);
  }, []);
  const getResourceGroupLabel = useCallback((name: string) => (
    name === "" ? t("resources.ungrouped") : name
  ), [t]);

  useEffect(() => {
    if (
      resourceGroup === null
      || resourceGroup === ""
      || resourceGroupsLoading
      || findResourceFolder(resourceFolderGroups, resourceGroup)
    ) {
      return;
    }
    setResourceGroup(null);
    setStoreResourceGroup(null);
    void loadRecords(false, "resources", null);
  }, [
    loadRecords,
    resourceFolderGroups,
    resourceGroup,
    resourceGroupsLoading,
    setStoreResourceGroup,
  ]);

  const handleSelectResourceGroup = useCallback((name: string | null) => {
    cancelResourceSelection();
    setResourceGroup(name);
    setStoreResourceGroup(name);
  }, [cancelResourceSelection, setStoreResourceGroup]);

  const openNewResourceGroup = useCallback((parentPath?: string) => {
    setResourceGroupName("");
    setResourceGroupsError(null);
    setResourceGroupDialog({ mode: "create", parentPath });
  }, []);

  const openRenameResourceGroup = useCallback((name: string) => {
    const segments = name.split("/");
    setResourceGroupName(segments[segments.length - 1] ?? name);
    setResourceGroupsError(null);
    setResourceGroupDialog({ mode: "rename", oldName: name });
  }, []);

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
      setResourceGroup(nextGroup);
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
        setResourceGroup(newPath);
        setStoreResourceGroup(newPath);
      } else {
        const parentPath = resourceGroupDialog?.parentPath;
        const fullPath = parentPath ? `${parentPath}/${name}` : name;
        await invoke("create_resource_group", { name: fullPath });
        await loadResourceGroups();
        setResourceGroup(fullPath);
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
  }, []);

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
  }, [loadResourceGroups]);

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
      onConfirm: async () => {
        try {
          await invoke("delete_resource_group", { name });
          await loadResourceGroups();
          const nextGroup = resourceGroup !== null && isResourceFolderPath(resourceGroup, name)
            ? null
            : resourceGroup;
          setResourceGroup(nextGroup);
          setStoreResourceGroup(nextGroup);
          await loadRecords(false, "resources", nextGroup);
          setResourceGroupManageOpen(false);
        } catch (error) {
          console.error("Failed to delete resource group:", error);
          setResourceGroupsError(String(error));
        }
      },
    });
  }, [loadRecords, loadResourceGroups, resourceGroup, setStoreResourceGroup, t]);

  const handleCopy = useCallback(async (record: ClipboardRecord) => {
    const copied = await pasteRecord(record);
    showFeedback(copied ? "copied" : "copyFailed");
  }, [pasteRecord, showFeedback]);

  const closeDetail = useCallback(() => {
    if (!detailRecordId) return;
    if (detailHistoryRef.current) {
      window.history.back();
      return;
    }
    setDetailRecord(null);
    setDetailRecordId(null);
  }, [detailRecordId]);

  const handleDeleteRecord = useCallback((id: string) => {
    setConfirmState({
      message: t("resources.confirmDelete"),
      onConfirm: async () => {
        try {
          await deleteRecord(id);
          if (detailRecordId === id) closeDetail();
        } catch {
          showFeedback("deleteFailed");
        }
      },
    });
  }, [closeDetail, deleteRecord, detailRecordId, showFeedback, t]);

  // 卡片叶子回合适配：view → 按 id 查原始记录
  const handleCopyCard = useCallback((view: RecordView) => {
    const record = records.find((r) => r.id === view.id);
    if (record) void handleCopy(record);
  }, [handleCopy, records]);

  const openDetail = useCallback((view: RecordView) => {
    const record = records.find((r) => r.id === view.id);
    if (!record) return;
    pendingScrollTopRef.current = resourceListRef.current?.scrollTop ?? 0;
    setDetailRecord(record);
    detailHistoryRef.current = true;
    setDetailRecordId(record.id);
    window.history.pushState({ resourceDetailId: record.id }, "", `#resource/${record.id}`);
  }, [records]);

  const openResourceMove = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const selected = filteredRecords.filter((record) => ids.includes(record.id));
    // 详情页记录可能尚未出现在已加载的列表里（如刚改名/移动完），用详情记录兜底。
    if (selected.length === 0 && detailRecord && ids.includes(detailRecord.id)) {
      selected.push(detailRecord);
    }
    if (selected.length === 0) return;
    const folders = [...new Set(selected.map((record) => record.resource_folder ?? ""))];
    const label = selected.length === 1
      ? getResourceTitle(selected[0], inferResourceMediaKind(selected[0]))
      : t("resources.moveSelectedCount", { count: selected.length });
    const meta = folders.length === 1
      ? t("resources.moveCurrentLocation", {
        name: folders[0] === "" ? t("resources.ungrouped") : formatResourceFolderPath(folders[0]),
      })
      : t("resources.moveMultipleLocations");
    setMoveError(null);
    setMoveDialog({ ids, label, meta, folders });
  }, [detailRecord, filteredRecords, t]);

  const handleMoveConfirm = useCallback(async (targetFolder: string) => {
    if (!moveDialog || movingResource) return;
    setMovingResource(true);
    setMoveError(null);
    try {
      const results = await invoke<
        Array<{
          id: string;
          resource_path?: string;
          resource_relative_path?: string | null;
          resource_folder?: string | null;
          content?: string;
        }>
      >("move_resource_records", {
        ids: moveDialog.ids,
        targetFolder,
      });
      const targetLabel = targetFolder === ""
        ? t("resources.ungrouped")
        : formatResourceFolderPath(targetFolder);
      setMoveFeedback(t("resources.moveSuccess", { count: moveDialog.ids.length, name: targetLabel }));
      if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = window.setTimeout(() => {
        setMoveFeedback(null);
        feedbackTimerRef.current = null;
      }, 2600);
      setDetailRecord((current) => {
        if (!current) return null;
        // 自动发现记录的 id 随路径变化，结果按请求下标对齐后整条修补。
        const index = moveDialog.ids.indexOf(current.id);
        if (index < 0 || index >= results.length) return current;
        const updated = results[index];
        return {
          ...current,
          ...(updated.id ? { id: updated.id } : null),
          ...(updated.resource_path ? { resource_path: updated.resource_path } : null),
          ...(updated.resource_relative_path
            ? { resource_relative_path: updated.resource_relative_path }
            : null),
          ...(updated.resource_folder !== undefined ? { resource_folder: updated.resource_folder } : null),
          ...(updated.content ? { content: updated.content } : null),
        };
      });
      setMoveDialog(null);
      cancelResourceSelection();
    } catch (error) {
      console.error("Failed to move resource records:", error);
      setMoveError(String(error));
    } finally {
      setMovingResource(false);
    }
  }, [cancelResourceSelection, moveDialog, movingResource, t]);

  useEffect(() => {
    const handlePopState = () => {
      if (!detailRecordId) return;
      detailHistoryRef.current = false;
      setDetailRecord(null);
      setDetailRecordId(null);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [detailRecordId]);

  useEffect(() => {
    if (detailRecordId || pendingScrollTopRef.current === null) return;
    const top = pendingScrollTopRef.current;
    pendingScrollTopRef.current = null;
    const frame = requestAnimationFrame(() => {
      resourceListRef.current?.scrollTo({ top, behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [detailRecordId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !detailRecordId) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
      event.preventDefault();
      closeDetail();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeDetail, detailRecordId]);

  const handleToggleAll = useCallback(async () => {
    if (selectingAll) return;
    if (allVisibleSelected && !hasMore) {
      toggleAllVisible();
      return;
    }
    const request = ++selectAllRequestRef.current;
    setSelectingAll(true);
    try {
      const allRecords = await loadAllRecords("resources", resourceGroup);
      if (!allRecords || request !== selectAllRequestRef.current) return;
      selectIds(
        allRecords
          .filter((record) => (
            isResourceRecord(record)
            && matchesResourceType(record, typeFilter)
          ))
          .map((record) => record.id),
      );
    } finally {
      if (request === selectAllRequestRef.current) setSelectingAll(false);
    }
  }, [
    allVisibleSelected,
    hasMore,
    loadAllRecords,
    resourceGroup,
    selectIds,
    selectingAll,
    toggleAllVisible,
    typeFilter,
  ]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedCount === 0 || selectingAll || deletingSelected) return;
    const ids = [...selectedIds];
    setConfirmState({
      message: t("resources.confirmDeleteSelected", { count: ids.length }),
      onConfirm: async () => {
        setDeletingSelected(true);
        try {
          await deleteRecords(ids);
          cancelResourceSelection();
        } catch {
          showFeedback("deleteFailed");
        } finally {
          setDeletingSelected(false);
        }
      },
    });
  }, [
    cancelResourceSelection,
    deleteRecords,
    deletingSelected,
    selectingAll,
    selectedCount,
    selectedIds,
    showFeedback,
    t,
  ]);

  const handleChangeResourceLibraryPath = useCallback(async () => {
    if (resourceLibraryPathChanging) return;
    setResourceLibraryPathChanging(true);
    setResourceLibraryPathError(null);
    try {
      const selectedPath = await invoke<string>("select_resource_library_folder");
      if (!selectedPath) return;
      const savedPath = await invoke<string>("set_resource_library_path", {
        path: selectedPath,
      });
      setResourceLibraryPath(savedPath);
      setResourceGroup(null);
      setStoreResourceGroup(null);
      await loadResourceGroups();
      await loadRecords(false, "resources", null);
    } catch (error) {
      const message = String(error).toLowerCase();
      if (!message.includes("cancelled") && !message.includes("canceled")) {
        console.error("Failed to change resource library path:", error);
        setResourceLibraryPathError(t("resources.libraryPathChangeError"));
      }
    } finally {
      setResourceLibraryPathChanging(false);
    }
  }, [loadRecords, loadResourceGroups, resourceLibraryPathChanging, setStoreResourceGroup, t]);

  const openResourceCreate = useCallback(async () => {
    try {
      await invoke("open_clipboard_create", {
        storageMode: "resource",
        groupName: resourceGroup ? getResourceFolderRoot(resourceGroup) : "",
      });
    } catch {
      showFeedback("openFailed");
    }
  }, [resourceGroup, showFeedback]);

  const confirmDialog = confirmState ? (
    <ConfirmDialog
      message={confirmState.message}
      onConfirm={confirmState.onConfirm}
      onCancel={() => setConfirmState(null)}
    />
  ) : null;

  const moveDialogElement = (
    <ResourceMoveDialog
      open={moveDialog !== null}
      itemsLabel={moveDialog?.label ?? ""}
      itemsMeta={moveDialog?.meta ?? ""}
      currentFolders={moveDialog?.folders ?? []}
      groups={resourceGroups}
      moving={movingResource}
      error={moveError}
      onClose={() => {
        setMoveDialog(null);
        setMoveError(null);
      }}
      onConfirm={(target) => void handleMoveConfirm(target)}
    />
  );

  const moveFeedbackElement = moveFeedback ? (
    <div className="resource-feedback success" role="status" aria-live="polite">
      {moveFeedback}
    </div>
  ) : null;

  if (detailRecord) {
    return (
      <>
        <ResourceDetailPage
          record={detailRecord}
          typeLabel={(kind) => typeLabels[kind]}
          onBack={closeDetail}
          onCopy={handleCopy}
          onDelete={handleDeleteRecord}
          onRecordUpdated={setDetailRecord}
          onMoveRecord={(record) => openResourceMove([record.id])}
        />
        {confirmDialog}
        {moveDialogElement}
        {moveFeedbackElement}
      </>
    );
  }

  return (
    <div className="resource-library-page">
      <div className="resource-library-toolbar">
        <div className="page-search">
          <SearchInput
            placeholder={t("resources.search")}
            value={search}
            onChange={handleSearchChange}
          />
        </div>
        <button
          type="button"
          ref={resourceSettingsButtonRef}
          className="resource-secondary-button resource-settings-button"
          onClick={() => setResourceSettingsOpen((open) => !open)}
          aria-expanded={resourceSettingsOpen}
          aria-haspopup="dialog"
        >
          {Icons.settings}
          <span>{t("resources.librarySettings")}</span>
        </button>
        <button type="button" className="resource-new-button" onClick={() => void openResourceCreate()}>
          {Icons.add}
          <span>{t("resources.new")}</span>
        </button>
      </div>

      {resourceSettingsOpen && (
        <ResourceLibrarySettings
          path={resourceLibraryPath}
          loading={resourceLibraryPathLoading}
          changing={resourceLibraryPathChanging}
          error={resourceLibraryPathError}
          popoverRef={resourceSettingsPopoverRef}
          onClose={() => setResourceSettingsOpen(false)}
          onChangePath={() => void handleChangeResourceLibraryPath()}
        />
      )}

      <ResourceGroupChips
        groups={resourceFolderGroups}
        selectedGroup={resourceGroup}
        onSelectGroup={handleSelectResourceGroup}
        onReorderGroups={handleReorderTopGroups}
        onManageGroups={() => {
          setResourceGroupsError(null);
          setResourceGroupManageOpen(true);
        }}
      />

      <div className="resource-filter-row">
        <span className="resource-filter-label">{t("resources.filterByType")}</span>
        <div className="resource-filter-options">
          {RESOURCE_TYPE_FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              className={`resource-filter-chip${typeFilter === filter ? " active" : ""}`}
              onClick={() => handleSelectType(filter)}
            >
              {typeFilterLabel(filter)}
            </button>
          ))}
        </div>
        {/* 「全部」视图按内容排序偏好展示，最新/最旧仅分组浏览有意义。 */}
        {resourceGroup !== null && (
          <div className="resource-sort-control">
            <span>{t("resources.sort")}</span>
            <IosSelect
              value={sortOrderLocal}
              options={sortOptions}
              onChange={(value) => setSortOrderLocal(value as "newest" | "oldest")}
            />
          </div>
        )}
      </div>

      {isSelecting && (
        <BatchSelectionBar
          selectedCount={selectedCount}
          totalCount={visibleIds.length}
          allSelected={allVisibleSelected}
          onToggleAll={() => void handleToggleAll()}
          onDelete={handleDeleteSelected}
          onCancel={cancelResourceSelection}
          busy={selectingAll || deletingSelected}
          busyLabel={deletingSelected ? t("common.deleting") : t("common.loading")}
          onMove={() => openResourceMove([...selectedIds])}
        />
      )}

      {resourceGroupManageOpen && (
        <ResourceGroupManageDialog
          rows={manageRows}
          sensors={manageRowSensors}
          collapsedPaths={collapsedGroupPaths}
          activeRowId={activeGroupRowId}
          activeRowWidth={activeGroupRowWidth}
          error={resourceGroupsError}
          onClose={() => setResourceGroupManageOpen(false)}
          onNewSubgroup={openNewResourceGroup}
          onRename={openRenameResourceGroup}
          onMove={openGroupMove}
          onDelete={handleDeleteResourceGroup}
          onOpen={(path) => void handleOpenResourceGroup(path)}
          onToggleCollapsed={toggleGroupCollapsed}
          getGroupLabel={getResourceGroupLabel}
          onDragStart={handleManageRowDragStart}
          onDragEnd={handleReorderManageRows}
          onDragCancel={() => {
            setActiveGroupRowId(null);
            setActiveGroupRowWidth(null);
          }}
        />
      )}

      {resourceGroupDialog && (
        <ResourceGroupNameDialog
          dialog={resourceGroupDialog}
          name={resourceGroupName}
          saving={resourceGroupSaving}
          error={resourceGroupsError}
          onNameChange={setResourceGroupName}
          onClose={() => setResourceGroupDialog(null)}
          onSave={() => void handleSaveResourceGroup()}
        />
      )}

      {resourceGroupMove && (
        <ResourceGroupMoveDialog
          moveState={resourceGroupMove}
          rows={groupMoveRows}
          collapsedPaths={collapsedGroupPaths}
          moving={movingGroup}
          error={movingGroupError}
          onSelectTarget={(target) => setResourceGroupMove({ ...resourceGroupMove, target })}
          onClose={() => setResourceGroupMove(null)}
          onConfirm={() => void handleMoveGroupConfirm()}
          onToggleCollapsed={toggleGroupCollapsed}
        />
      )}

      {confirmDialog}

      <section className="resource-list-area">
        <div className="resource-list-heading">
          <div className="resource-list-heading-main">
            <h2>
              {resourceGroup === ""
                ? t("resources.ungrouped")
                : selectedResourceFolder?.name ?? t("resources.modeResource")}
            </h2>
            <span>{t("resources.itemCount", { count: filteredRecords.length })}</span>
          </div>
          <div className="resource-list-heading-actions">
            {!isSelecting && filteredRecords.length > 0 && (
              <button
                type="button"
                className="phrase-add-btn selection-mode-btn resource-selection-button"
                onClick={startResourceSelection}
              >
                {Icons.check}
                <span>{t("common.select")}</span>
              </button>
            )}
          </div>
        </div>

        {loadError && (
          <div className="resource-load-error" role="alert">
            <span>{t("resources.loadError")}</span>
            <button type="button" onClick={() => void loadRecords(false, "resources", resourceGroup)}>
              {t("common.retry")}
            </button>
          </div>
        )}

        {loading && records.length === 0 ? (
          <div className="resource-list resource-list-skeleton" aria-busy="true">
            {[1, 2, 3, 4].map((item) => (
              <div className="resource-card-skeleton" key={item}>
                <div className="resource-skeleton-preview" />
                <div className="resource-skeleton-line long" />
                <div className="resource-skeleton-line short" />
              </div>
            ))}
          </div>
        ) : filteredRecords.length === 0 ? (
          <div className="resource-empty-state">
            <div className="empty-icon-compact">{Icons.resources}</div>
            <strong>
              {search.trim() || typeFilter !== "all"
                ? t("resources.noMatches")
                : resourceGroup !== null
                  ? t("resources.groupEmpty")
                  : t("resources.empty")}
            </strong>
            <span>{t("resources.modeResourceHint")}</span>
            {hasMore && (
              <button type="button" className="resource-secondary-button" onClick={() => void loadRecords(true, "resources", resourceGroup)}>
                {t("resources.loadMore")}
              </button>
            )}
          </div>
        ) : (
          <div
            className="resource-list"
            ref={(element) => {
              resourceListRef.current = element;
              setListElement(element);
              backToTop.containerRef(element);
            }}
            data-resource-scroll
          >
            {/* 手动拖拽排序已移除：「全部分组」按排序偏好，分组浏览按时间序。 */}
            <div
              className="resource-columns"
              style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
            >
              {columns.map((column, columnIndex) => (
                <div className="resource-column" key={`column-${columnIndex}`}>
                  {column.map((record) => {
                    const view = buildRecordView(record);
                    return (
                    <div className="resource-item" key={record.id}>
                      <ResourceCard
                        view={view}
                        search={search}
                        typeLabel={(kind) => typeLabels[kind]}
                        selectionMode={isSelecting}
                        selected={isSelected(view.id)}
                        showGroupTag={resourceGroup === null}
                        showUsageBadge={contentSort === "count" && resourceGroup === null}
                        onOpenDetail={openDetail}
                        onCopy={handleCopyCard}
                        onDelete={handleDeleteRecord}
                        onToggleSelected={toggleSelected}
                        onMove={(moveView) => openResourceMove([moveView.id])}
                      />
                    </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {hasMore && (
              <button type="button" className="clipboard-load-more" onClick={() => void loadRecords(true, "resources", resourceGroup)}>
                {t("resources.loadMore")}
              </button>
            )}
          </div>
        )}

        <BackToTopButton
          visible={backToTop.visible}
          onTop={backToTop.scrollToTop}
          label={t("common.backToTop")}
        />
      </section>

      {feedback && (
        <div className={`resource-feedback ${feedback === "copied" ? "success" : "error"}`} role="status" aria-live="polite">
          {feedback === "copied"
            ? t("resources.copied")
            : feedback === "copyFailed"
              ? t("resources.copyFailed")
              : feedback === "deleteFailed"
                ? t("resources.deleteFailed")
                : t("resources.openFailed")}
        </div>
      )}
      {moveDialogElement}
      {moveFeedbackElement}
    </div>
  );
}
