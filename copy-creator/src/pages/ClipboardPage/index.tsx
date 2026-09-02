import { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";
import { useClipboardStore } from "../../stores/clipboardStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { Icons } from "../../components/Icons";
import SearchInput from "../../components/SearchInput";
import { ClipboardCard, ClipboardCardDragPreview } from "./ClipboardCard";
import { TYPE_META } from "./utils";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensors,
  useSensor,
  closestCenter,
  DragOverlay,
} from "@dnd-kit/core";
import type { DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { getChangedOrderIds, getDragPreviewOrder } from "../../utils/reorderPreview";
import BatchSelectionBar from "../../components/BatchSelectionBar";
import { useMultiSelect } from "../../hooks/useMultiSelect";
import { useResourceGroupStore } from "../../stores/resourceGroupStore";
import { ContentPreviewPanel } from "../../components/ContentPreviewPanel";
import { loadClipboardPreviewSegments } from "../../utils/contentPreview";
import {
  calculatePreviewExpansion,
  type RadialPreviewDirection,
  type RadialPreviewSegment,
} from "../../utils/radialPreview";
import { GroupChips } from "../PhrasePage/GroupChips";
import { GroupDialog } from "../PhrasePage/GroupDialog";
import { ManageGroupsDialog } from "../PhrasePage/ManageGroupsDialog";

type ClipType = "all" | "text" | "image" | "link" | "file" | "stash";

TYPE_META.text.icon = Icons.clipboard;
TYPE_META.image.icon = Icons.image;
TYPE_META.link.icon = Icons.link;
TYPE_META.file.icon = Icons.file;

interface ClipboardPageProps {
  resourcesOnly?: boolean;
}

interface ClipboardPreviewState {
  recordId: string;
  segments: RadialPreviewSegment[] | null;
  layout: PreviewLayout;
}

interface PreviewLayout {
  direction: RadialPreviewDirection;
  width: number;
}

interface OriginalWindowGeometry {
  position: PhysicalPosition;
  size: PhysicalSize;
}

function applyMainPreviewLayout(layout: PreviewLayout) {
  document.documentElement.dataset.mainContentPreview = layout.direction;
  delete document.documentElement.dataset.mainContentPreviewState;
  document.documentElement.style.setProperty("--main-content-preview-width", `${layout.width}px`);
}

function markMainPreviewRestoring() {
  document.documentElement.dataset.mainContentPreviewState = "restoring";
}

function clearMainPreviewLayout() {
  delete document.documentElement.dataset.mainContentPreview;
  delete document.documentElement.dataset.mainContentPreviewState;
  document.documentElement.style.removeProperty("--main-content-preview-width");
  document.documentElement.style.removeProperty("--main-content-preview-main-width");
}

export default function ClipboardPage({ resourcesOnly = false }: ClipboardPageProps) {
  const { t } = useTranslation();
  const {
    records,
    search,
    loading,
    hasMore,
    category,
    init,
    setSearch,
    setCategory,
    loadRecords,
    loadAllRecords,
    deleteRecords,
    deleteRecord,
    pasteRecord,
    pasteRecordTerminal,
  } = useClipboardStore();
  const resourceGroups = useResourceGroupStore((state) => state.groups);
  const selectedResourceGroupId = useResourceGroupStore((state) => state.selectedGroupId);
  const initResourceGroups = useResourceGroupStore((state) => state.init);
  const setSelectedResourceGroup = useResourceGroupStore((state) => state.setSelectedGroup);
  const createResourceGroup = useResourceGroupStore((state) => state.createGroup);
  const updateResourceGroup = useResourceGroupStore((state) => state.updateGroup);
  const deleteResourceGroup = useResourceGroupStore((state) => state.deleteGroup);
  const reorderResourceGroups = useResourceGroupStore((state) => state.reorderGroups);
  const resourceGroupError = useResourceGroupStore((state) => state.error);
  const clearResourceGroupError = useResourceGroupStore((state) => state.clearError);
  const pasteLeftClick = useSettingsStore((s) => s.pasteLeftClick);
  const createRecord = useClipboardStore((s) => s.createRecord);
  const [showCreate, setShowCreate] = useState(false);
  const [createContent, setCreateContent] = useState("");
  const [confirmState, setConfirmState] = useState<{
    message: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);
  const [resourceGroupDialogOpen, setResourceGroupDialogOpen] = useState(false);
  const [resourceGroupName, setResourceGroupName] = useState("");
  const [resourceManageGroupsOpen, setResourceManageGroupsOpen] = useState(false);
  const [resourceRenameId, setResourceRenameId] = useState<string | null>(null);
  const [resourceRenameName, setResourceRenameName] = useState("");
  const [deletingSelected, setDeletingSelected] = useState(false);

  const categoriesScrollRef = useRef<HTMLDivElement>(null);
  const clipboardListRef = useRef<HTMLDivElement>(null);
  const previewRequestRef = useRef(0);
  const previewRef = useRef<ClipboardPreviewState | null>(null);
  const previewRestoringRef = useRef(false);
  const restoreFinishedRef = useRef(false);
  const contentPreviewRef = useRef<ClipboardPreviewState | null>(null);
  const originalWindowGeometryRef = useRef<OriginalWindowGeometry | null>(null);
  const windowRestoreRef = useRef<Promise<void> | null>(null);
  const previewCacheRef = useRef(new Map<string, RadialPreviewSegment[]>());
  const [contentPreview, setContentPreview] = useState<ClipboardPreviewState | null>(null);

  useEffect(() => {
    const el = categoriesScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const categories: { key: ClipType; label: string }[] = resourcesOnly
    ? []
    : [
        { key: "all", label: t("clipboard.all") },
        { key: "text", label: t("clipboard.text") },
        { key: "image", label: t("clipboard.image") },
        { key: "link", label: t("clipboard.link") },
        { key: "file", label: t("clipboard.file") },
      ];

  const labels: Record<string, string> = useMemo(
    () => ({
      text: t("clipboard.text"),
      image: t("clipboard.image"),
      link: t("clipboard.link"),
      file: t("clipboard.file"),
    }),
    [t],
  );

  const getTypeLabel = useCallback(
    (type: string): string => labels[type] || labels.text,
    [labels],
  );

  const handlePaste = useCallback(
    (r: typeof records[number]) => pasteRecord(r),
    [pasteRecord],
  );

  const handlePasteTerminal = useCallback(
    (r: typeof records[number]) => pasteRecordTerminal(r),
    [pasteRecordTerminal],
  );

  const handleDelete = useCallback(
    (id: string) => {
      setConfirmState({
        message: t("clipboard.confirmDelete"),
        onConfirm: () => deleteRecord(id),
      });
    },
    [deleteRecord, t],
  );

  const handleSubmitCreate = useCallback(() => {
    const trimmed = createContent.trim();
    if (!trimmed) return;
    if (resourcesOnly) {
      void invoke("save_stash_record", { id: null, content: trimmed, images: [] });
    } else {
      void createRecord(trimmed);
    }
    setCreateContent("");
    setShowCreate(false);
  }, [createContent, createRecord, resourcesOnly]);

  const filtered = useMemo(() => {
    if (resourcesOnly) {
      const selectedGroup = resourceGroups.find((group) => group.id === selectedResourceGroupId);
      if (!selectedGroup) return [];
      return records.filter((r) => r.group_name === selectedGroup.name);
    }
    const clipboardRecords = records.filter((r) => !r.group_name);
    if (category === "all") return clipboardRecords;
    if (category === "stash") return [];
    return clipboardRecords.filter((r) => r.type === category);
  }, [records, category, resourceGroups, resourcesOnly, selectedResourceGroupId]);
  const visibleIds = useMemo(() => filtered.map((record) => record.id), [filtered]);
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
  const [selectingAll, setSelectingAll] = useState(false);
  const selectAllRequestRef = useRef(0);

  const startClipboardSelection = useCallback(() => {
    selectAllRequestRef.current += 1;
    startSelection();
  }, [startSelection]);

  const cancelClipboardSelection = useCallback(() => {
    selectAllRequestRef.current += 1;
    setSelectingAll(false);
    exitSelection();
  }, [exitSelection]);

  const handleSearchChange = useCallback(
    (value: string) => {
      cancelClipboardSelection();
      setSearch(value);
    },
    [cancelClipboardSelection, setSearch],
  );

  const handleCategoryChange = useCallback(
    (value: ClipType) => {
      cancelClipboardSelection();
      setCategory(value);
      void loadRecords(false, value);
    },
    [cancelClipboardSelection, setCategory, loadRecords],
  );

  const selectedResourceGroup = resourceGroups.find(
    (group) => group.id === selectedResourceGroupId,
  );
  const selectedResourceGroupName = selectedResourceGroup?.name;

  const handleToggleAll = useCallback(async () => {
    if (selectingAll) return;
    if (allVisibleSelected && !hasMore) {
      toggleAllVisible();
      return;
    }

    const request = ++selectAllRequestRef.current;
    setSelectingAll(true);
    try {
      const allRecords = await loadAllRecords(resourcesOnly ? "resources" : category);
      if (!allRecords || request !== selectAllRequestRef.current) return;
      const allVisibleRecordIds = resourcesOnly
        ? allRecords
            .filter((record) => record.group_name === selectedResourceGroupName)
            .map((record) => record.id)
        : allRecords
            .filter((record) => !record.group_name)
            .map((record) => record.id);
      selectIds(allVisibleRecordIds);
    } finally {
      if (request === selectAllRequestRef.current) setSelectingAll(false);
    }
  }, [allVisibleSelected, category, hasMore, loadAllRecords, resourcesOnly, selectIds, selectedResourceGroupName, selectingAll, toggleAllVisible]);

  const openNewResourceGroup = useCallback(() => {
    setResourceManageGroupsOpen(false);
    clearResourceGroupError();
    setResourceGroupName("");
    setResourceGroupDialogOpen(true);
  }, [clearResourceGroupError]);

  const handleSaveResourceGroup = useCallback(async () => {
    const name = resourceGroupName.trim();
    if (!name) return;
    const group = await createResourceGroup(name);
    if (!group) return;
    setResourceGroupDialogOpen(false);
    setResourceGroupName("");
  }, [createResourceGroup, resourceGroupName]);

  const openResourceManageGroups = useCallback(() => {
    clearResourceGroupError();
    setResourceRenameId(null);
    setResourceRenameName("");
    setResourceManageGroupsOpen(true);
  }, [clearResourceGroupError]);

  const startResourceRename = useCallback((id: string, name: string) => {
    clearResourceGroupError();
    setResourceRenameId(id);
    setResourceRenameName(name);
  }, [clearResourceGroupError]);

  const handleResourceRename = useCallback(async () => {
    if (resourceRenameId && resourceRenameName.trim()) {
      const updated = await updateResourceGroup(resourceRenameId, resourceRenameName.trim());
      if (!updated) return;
    }
    setResourceRenameId(null);
    setResourceRenameName("");
  }, [resourceRenameId, resourceRenameName, updateResourceGroup]);

  const handleDeleteResourceGroup = useCallback((id: string) => {
    setConfirmState({
      message: t("resources.confirmDeleteGroup"),
      onConfirm: async () => {
        const deleted = await deleteResourceGroup(id);
        if (!deleted) return;
        if (resourceGroups.length <= 2) setResourceManageGroupsOpen(false);
      },
    });
  }, [deleteResourceGroup, resourceGroups.length, t]);

  const handleSelectResourceGroup = useCallback((id: string) => {
    cancelClipboardSelection();
    setSelectedResourceGroup(id);
  }, [cancelClipboardSelection, setSelectedResourceGroup]);

  const openResourceCreate = useCallback(() => {
    void invoke("open_clipboard_create", {
      groupName: selectedResourceGroup?.name,
    });
  }, [selectedResourceGroup?.name]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedCount === 0 || selectingAll || deletingSelected) return;
    const ids = [...selectedIds];
    setConfirmState({
      message: t(
        resourcesOnly ? "resources.confirmDeleteSelected" : "clipboard.confirmDeleteSelected",
        { count: ids.length },
      ),
      onConfirm: async () => {
        setDeletingSelected(true);
        try {
          await deleteRecords(ids);
          cancelClipboardSelection();
        } catch {
          // 删除失败时保留选择状态，便于用户重试。
        } finally {
          setDeletingSelected(false);
        }
      },
    });
  }, [cancelClipboardSelection, deleteRecords, deletingSelected, resourcesOnly, selectingAll, selectedCount, selectedIds, t]);

  useEffect(() => {
    init(resourcesOnly ? "resources" : "all");
    setCategory(resourcesOnly ? "resources" : "all");
    void loadRecords(false, resourcesOnly ? "resources" : "all");
    if (resourcesOnly) initResourceGroups();
  }, [init, initResourceGroups, loadRecords, resourcesOnly, setCategory]);

  useEffect(() => {
    const timer = setTimeout(() => loadRecords(false, resourcesOnly ? "resources" : undefined), 300);
    return () => clearTimeout(timer);
  }, [loadRecords, resourcesOnly, search]);

  const finishMainPreviewRestore = useCallback(() => {
    if (!previewRestoringRef.current || !restoreFinishedRef.current) return;
    if (previewRef.current || contentPreviewRef.current) return;

    previewRestoringRef.current = false;
    restoreFinishedRef.current = false;
    clearMainPreviewLayout();
  }, []);

  useLayoutEffect(() => {
    contentPreviewRef.current = contentPreview;
    finishMainPreviewRestore();
  }, [contentPreview, finishMainPreviewRestore]);

  const restoreMainWindow = useCallback(async () => {
    const geometry = originalWindowGeometryRef.current;
    originalWindowGeometryRef.current = null;
    if (!geometry) return;

    const appWindow = getCurrentWindow();
    try {
      await appWindow.setSize(geometry.size);
      await appWindow.setPosition(geometry.position);
    } catch {
      // 主窗口下次显示时仍会按已保存尺寸恢复。
    }
  }, []);

  const collapsePreview = useCallback(() => {
    const request = ++previewRequestRef.current;
    previewRef.current = null;
    setContentPreview(null);

    const restoreTask = windowRestoreRef.current
      ?? (originalWindowGeometryRef.current ? restoreMainWindow() : null);
    if (!restoreTask) {
      previewRestoringRef.current = false;
      restoreFinishedRef.current = false;
      clearMainPreviewLayout();
      return;
    }
    previewRestoringRef.current = true;
    restoreFinishedRef.current = false;
    markMainPreviewRestoring();
    windowRestoreRef.current = restoreTask;
    void restoreTask.finally(() => {
      if (windowRestoreRef.current === restoreTask) windowRestoreRef.current = null;
      if (request !== previewRequestRef.current) return;
      restoreFinishedRef.current = true;
      finishMainPreviewRestore();
    });
  }, [finishMainPreviewRestore, restoreMainWindow]);

  const expandPreviewWindow = useCallback(async (
    request: number,
    recordId: string,
  ): Promise<PreviewLayout | null> => {
    if (windowRestoreRef.current) await windowRestoreRef.current;
    if (request !== previewRequestRef.current) return null;
    if (previewRestoringRef.current) {
      previewRestoringRef.current = false;
      restoreFinishedRef.current = false;
      clearMainPreviewLayout();
    }
    if (previewRef.current) return previewRef.current.layout;

    const appWindow = getCurrentWindow();
    try {
      const [position, outerSize, innerSize, monitor, scaleFactor] = await Promise.all([
        appWindow.outerPosition(),
        appWindow.outerSize(),
        appWindow.innerSize(),
        currentMonitor(),
        appWindow.scaleFactor(),
      ]);
      if (!monitor || request !== previewRequestRef.current) return null;

      const scale = Math.max(scaleFactor, 0.1);
      const mainWidth = innerSize.width / scale;
      const expansion = calculatePreviewExpansion({
        windowX: position.x,
        windowWidth: outerSize.width,
        workAreaX: monitor.workArea.position.x,
        workAreaWidth: monitor.workArea.size.width,
        scaleFactor,
      });
      if (expansion.previewWidth <= 0) return null;

      const geometry = { position, size: innerSize };
      originalWindowGeometryRef.current = geometry;
      const layout = { direction: expansion.direction, width: expansion.previewWidth };
      // 在调整原生窗口前锁定主页面宽度，避免收起时短暂按变化中的视口宽度重排。
      document.documentElement.style.setProperty("--main-content-preview-main-width", `${mainWidth}px`);
      applyMainPreviewLayout(layout);
      const loadingState = { recordId, segments: null, layout };
      previewRef.current = loadingState;
      setContentPreview(loadingState);
      await appWindow.setSize(new PhysicalSize(
        innerSize.width + expansion.previewPhysicalWidth,
        innerSize.height,
      ));
      if (expansion.direction === "left") {
        await appWindow.setPosition(new PhysicalPosition(expansion.windowX, position.y));
      }
      if (request !== previewRequestRef.current) {
        return null;
      }

      return layout;
    } catch {
      const isCurrentRequest = request === previewRequestRef.current;
      const geometry = isCurrentRequest ? originalWindowGeometryRef.current : null;
      if (isCurrentRequest) originalWindowGeometryRef.current = null;
      if (isCurrentRequest) {
        previewRef.current = null;
        previewRestoringRef.current = true;
        restoreFinishedRef.current = false;
        setContentPreview(null);
        markMainPreviewRestoring();
      }
      if (geometry) {
        try {
          await appWindow.setSize(geometry.size);
          await appWindow.setPosition(geometry.position);
        } catch {
          // 主窗口下次显示时仍会按已保存尺寸恢复。
        }
      }
      if (isCurrentRequest) {
        restoreFinishedRef.current = true;
        finishMainPreviewRestore();
      }
      return null;
    }
  }, [finishMainPreviewRestore]);

  const showPreview = useCallback(async (record: typeof records[number]) => {
    const request = ++previewRequestRef.current;
    const layout = await expandPreviewWindow(request, record.id);
    if (!layout || request !== previewRequestRef.current) return;

    try {
      let segments = previewCacheRef.current.get(record.id);
      if (!segments) {
        segments = await loadClipboardPreviewSegments(record);
        previewCacheRef.current.set(record.id, segments);
      }
      if (request !== previewRequestRef.current) return;
      const loadedState = { recordId: record.id, segments, layout };
      previewRef.current = loadedState;
      setContentPreview(loadedState);
    } catch {
      if (request !== previewRequestRef.current) return;
      const fallbackState = {
        recordId: record.id,
        segments: [{ type: "text" as const, content: record.content }],
        layout,
      };
      previewRef.current = fallbackState;
      setContentPreview(fallbackState);
    }
  }, [expandPreviewWindow]);

  const togglePreview = useCallback((record: typeof records[number]) => {
    if (previewRef.current?.recordId === record.id) {
      collapsePreview();
      return;
    }
    void showPreview(record);
  }, [collapsePreview, showPreview]);

  const handlePreviewLeave = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!previewRef.current) return;

    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Element) {
      if (relatedTarget.closest("[data-content-preview]")) return;
      const currentCard = event.currentTarget.closest(".clipboard-card");
      if (currentCard && relatedTarget.closest(".clipboard-card") === currentCard) return;
    }
    collapsePreview();
  }, [collapsePreview]);

  useEffect(() => {
    const handleWindowExit = () => collapsePreview();
    const handlePointerOut = (event: PointerEvent | MouseEvent) => {
      if (event.relatedTarget === null) collapsePreview();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") collapsePreview();
    };
    document.documentElement.addEventListener("mouseleave", handleWindowExit);
    document.documentElement.addEventListener("pointerleave", handleWindowExit);
    window.addEventListener("mouseleave", handleWindowExit);
    document.addEventListener("pointerout", handlePointerOut);
    document.addEventListener("mouseout", handlePointerOut);
    window.addEventListener("mouseout", handlePointerOut);
    window.addEventListener("blur", handleWindowExit);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.documentElement.removeEventListener("mouseleave", handleWindowExit);
      document.documentElement.removeEventListener("pointerleave", handleWindowExit);
      window.removeEventListener("mouseleave", handleWindowExit);
      document.removeEventListener("pointerout", handlePointerOut);
      document.removeEventListener("mouseout", handlePointerOut);
      window.removeEventListener("mouseout", handlePointerOut);
      window.removeEventListener("blur", handleWindowExit);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [collapsePreview]);

  useEffect(() => () => {
    previewRequestRef.current += 1;
    void restoreMainWindow().finally(clearMainPreviewLayout);
  }, [restoreMainWindow]);

  useEffect(() => {
    previewCacheRef.current.clear();
  }, [records]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor)
  );

  const isFiltered = resourcesOnly || category !== "all" || search.trim().length > 0;

  const [activeId, setActiveId] = useState<string | null>(null);
  const [previewRecords, setPreviewRecords] = useState<typeof records | null>(null);
  const [activeOverlayWidth, setActiveOverlayWidth] = useState<number | null>(null);
  const lastPreviewMoveRef = useRef<string | null>(null);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    if (isSelecting) return;
    collapsePreview();
    const id = String(event.active.id);
    setActiveId(id);
    setActiveOverlayWidth(clipboardListRef.current?.getBoundingClientRect().width ?? null);
    lastPreviewMoveRef.current = null;
    setPreviewRecords(isFiltered ? null : filtered);
  }, [collapsePreview, filtered, isFiltered, isSelecting]);

  useEffect(() => {
    if (isSelecting) collapsePreview();
  }, [collapsePreview, isSelecting]);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setActiveOverlayWidth(null);
    setPreviewRecords(null);
    lastPreviewMoveRef.current = null;
  }, []);

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      if (isSelecting || isFiltered || !event.over) return;

      const active = String(event.active.id);
      const over = String(event.over.id);
      const previewMoveKey = `${active}:${over}`;

      if (lastPreviewMoveRef.current === previewMoveKey) return;
      lastPreviewMoveRef.current = previewMoveKey;

      setPreviewRecords((current) => {
        const base = current ?? filtered;
        const next = getDragPreviewOrder(base, active, over);
        return next === base ? current : next;
      });
    },
    [filtered, isFiltered, isSelecting],
  );

  const handleDragEnd = useCallback(
    () => {
      const finalPreview = previewRecords;
      setActiveId(null);
      setActiveOverlayWidth(null);
      setPreviewRecords(null);
      lastPreviewMoveRef.current = null;

      if (isSelecting || isFiltered) return;

      const nextIds = getChangedOrderIds(filtered, finalPreview);
      if (!nextIds) return;

      useClipboardStore.getState().reorderRecords(nextIds);
    },
    [filtered, isFiltered, isSelecting, previewRecords],
  );

  const renderedRecords = previewRecords ?? filtered;
  const activeRecord = activeId ? renderedRecords.find(r => r.id === activeId) : null;
  const dragOverlay = (
    <DragOverlay dropAnimation={null} style={{ width: activeOverlayWidth ?? undefined }}>
      {activeRecord ? (
        <ClipboardCardDragPreview
          record={activeRecord}
          getTypeLabel={getTypeLabel}
          width={activeOverlayWidth}
          search={search}
        />
      ) : null}
    </DragOverlay>
  );

  return (
    <>
    <div
      className={`clipboard-page${resourcesOnly ? " resources-page" : ""}`}
    >
      <div className="page-search">
        <SearchInput
          placeholder={resourcesOnly ? t("resources.search") : t("clipboard.search")}
          value={search}
          onChange={handleSearchChange}
        />
      </div>

      {resourcesOnly ? (
        <GroupChips
          groups={resourceGroups}
          selectedGroupId={selectedResourceGroupId}
          onSelectGroup={handleSelectResourceGroup}
          onManageGroups={openResourceManageGroups}
          onAddPhrase={openResourceCreate}
          addPhraseLabel={t("resources.new")}
          manageGroupsLabel={t("resources.manageGroups")}
          selectionMode={isSelecting}
          canSelect={filtered.length > 0}
          onStartSelection={startClipboardSelection}
          onReorderGroups={(ids) => void reorderResourceGroups(ids)}
        />
      ) : (
        <div className="clipboard-categories">
          <div className="clipboard-categories-scroll" ref={categoriesScrollRef}>
            {categories.map((c) => (
              <button
                key={c.key}
                className={`category-chip ${category === c.key ? "active" : ""}`}
                onClick={() => handleCategoryChange(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="clipboard-categories-actions">
            {!isSelecting && (
              <>
                <button
                  className="phrase-add-btn"
                  onClick={() => setShowCreate(true)}
                >
                  {Icons.add}
                  <span>{t("clipboard.create")}</span>
                </button>
                {filtered.length > 0 && (
                  <button className="phrase-add-btn selection-mode-btn" onClick={startClipboardSelection}>
                    {Icons.check}
                    <span>{t("common.select")}</span>
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {isSelecting && (
        <BatchSelectionBar
          selectedCount={selectedCount}
          totalCount={visibleIds.length}
          allSelected={allVisibleSelected}
          onToggleAll={handleToggleAll}
          onDelete={handleDeleteSelected}
          onCancel={cancelClipboardSelection}
          busy={selectingAll || deletingSelected}
          busyLabel={deletingSelected ? t("common.deleting") : t("common.loading")}
        />
      )}

      <GroupDialog
        open={resourcesOnly && resourceGroupDialogOpen}
        editingId={null}
        groupName={resourceGroupName}
        setGroupName={setResourceGroupName}
        title={t("resources.newGroup")}
        placeholder={t("resources.groupName")}
        error={resourceGroupError}
        onSave={() => void handleSaveResourceGroup()}
        onClose={() => setResourceGroupDialogOpen(false)}
      />

      <ManageGroupsDialog
        open={resourcesOnly && resourceManageGroupsOpen}
        groups={resourceGroups}
        renameId={resourceRenameId}
        renameName={resourceRenameName}
        setRenameName={setResourceRenameName}
        onStartRename={startResourceRename}
        onRename={() => void handleResourceRename()}
        onDeleteGroup={handleDeleteResourceGroup}
        onClose={() => setResourceManageGroupsOpen(false)}
        onAddGroup={openNewResourceGroup}
        addGroupLabel={t("resources.newGroup")}
        title={t("resources.manageGroups")}
        renameLabel={t("resources.rename")}
        protectedGroupName="暂存"
        error={resourceGroupError}
      />

      {showCreate && (
        <div className="dialog-overlay" onClick={() => { setShowCreate(false); setCreateContent(""); }}>
          <div className="dialog-content" onClick={(e) => e.stopPropagation()}>
            <h3 className="dialog-title">{t("clipboard.create")}</h3>
            <textarea
              className="dialog-textarea"
              value={createContent}
              onChange={(e) => setCreateContent(e.target.value)}
              placeholder={t(resourcesOnly ? "resources.createPlaceholder" : "clipboard.createPlaceholder")}
              autoFocus
            />
            <div className="dialog-actions">
              <button className="dialog-btn secondary" onClick={() => { setShowCreate(false); setCreateContent(""); }}>
                {t("common.cancel")}
              </button>
              <button className="dialog-btn save" onClick={handleSubmitCreate} disabled={!createContent.trim()}>
                {t("common.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmState && (
        <div className="dialog-overlay" onClick={() => setConfirmState(null)}>
          <div className="dialog-content" onClick={(e) => e.stopPropagation()}>
            <h3 className="dialog-title">{t("common.confirm")}</h3>
            <p className="dialog-message">{confirmState.message}</p>
            <div className="dialog-actions">
              <button className="dialog-btn secondary" onClick={() => setConfirmState(null)}>
                {t("common.cancel")}
              </button>
              <button
                className="dialog-btn save"
                onClick={() => {
                  void confirmState.onConfirm();
                  setConfirmState(null);
                }}
              >
                {t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {loading && records.length === 0 ? (
        <div className="clipboard-list">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="notification skeleton">
              <div className="notibar" />
              <div className="noticontent">
                <div className="notititle">
                  <div className="skeleton-line short" />
                </div>
                <div className="notibody">
                  <div
                    className="skeleton-line"
                    style={{ width: `${55 + ((i * 17) % 35)}%` }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <>
          <div className="page-empty-compact">
            <div className="empty-icon-compact">{resourcesOnly ? Icons.file : Icons.clipboard}</div>
            <span>{resourcesOnly ? t("resources.empty") : t("clipboard.empty")}</span>
          </div>
          {resourcesOnly && hasMore && (
            <button
              className="clipboard-load-more"
              type="button"
              onClick={() => loadRecords(true)}
            >
              显示更多
            </button>
          )}
        </>
      ) : (
        <div className="clipboard-list" ref={clipboardListRef}>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel} modifiers={[restrictToVerticalAxis]}>
            <SortableContext items={renderedRecords.map(r => r.id)} strategy={verticalListSortingStrategy}>
              {renderedRecords.map((r, i) => (
                <ClipboardCard
                  key={r.id}
                  record={r}
                  index={i}
                  getTypeLabel={getTypeLabel}
                  pasteLeftClick={pasteLeftClick}
                  search={search}
                  onPasteNormal={handlePaste}
                  onPasteTerminal={handlePasteTerminal}
                  onDelete={handleDelete}
                  selectionMode={isSelecting}
                  selected={isSelected(r.id)}
                  onToggleSelected={toggleSelected}
                  previewOpen={contentPreview?.recordId === r.id}
                  onPreviewToggle={togglePreview}
                  onPreviewLeave={handlePreviewLeave}
                />
              ))}
            </SortableContext>
            {createPortal(dragOverlay, document.body)}
          </DndContext>
          {hasMore && (resourcesOnly || filtered.length > 0) && (
            <button
              className="clipboard-load-more"
              type="button"
              onClick={() => loadRecords(true)}
            >
              显示更多
            </button>
          )}
        </div>
      )}

    </div>
    {contentPreview && createPortal(
      <ContentPreviewPanel
        className={`main-window-content-preview preview-${contentPreview.layout.direction}`}
        segments={contentPreview.segments}
        onClick={(e) => e.stopPropagation()}
        onMouseLeave={(e) => {
          if (e.relatedTarget === null) collapsePreview();
        }}
      />,
      document.body,
    )}
    </>
  );
}
