import { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
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
import { ContentPreviewPanel } from "../../components/ContentPreviewPanel";
import { loadClipboardPreviewSegments } from "../../utils/contentPreview";
import {
  calculatePreviewExpansion,
  type RadialPreviewDirection,
  type RadialPreviewSegment,
} from "../../utils/radialPreview";
import { isResourceRecord } from "../../utils/clipboardRecord";

type ClipType = "all" | "text" | "image" | "link" | "file" | "stash";

TYPE_META.text.icon = Icons.clipboard;
TYPE_META.image.icon = Icons.image;
TYPE_META.link.icon = Icons.link;
TYPE_META.file.icon = Icons.file;

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

export default function ClipboardPage() {
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
  const pasteLeftClick = useSettingsStore((s) => s.pasteLeftClick);
  const [confirmState, setConfirmState] = useState<{
    message: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);
  const [deletingSelected, setDeletingSelected] = useState(false);

  const categoriesScrollRef = useRef<HTMLDivElement>(null);
  const clipboardListRef = useRef<HTMLDivElement>(null);
  const searchEffectInitializedRef = useRef(false);
  const previewRequestRef = useRef(0);
  const previewRef = useRef<ClipboardPreviewState | null>(null);
  const previewRestoringRef = useRef(false);
  const restoreFinishedRef = useRef(false);
  const contentPreviewRef = useRef<ClipboardPreviewState | null>(null);
  const originalWindowGeometryRef = useRef<OriginalWindowGeometry | null>(null);
  const windowRestoreRef = useRef<Promise<void> | null>(null);
  const windowOperationQueueRef = useRef<Promise<void>>(Promise.resolve());
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

  const categories: { key: ClipType; label: string }[] = [
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

  const openClipboardCreate = useCallback(async () => {
    try {
      await invoke("open_clipboard_create", { storageMode: "database" });
    } catch (error) {
      console.error("Failed to open clipboard create dialog:", error);
    }
  }, []);

  const filtered = useMemo(() => {
    const clipboardRecords = records.filter((r) => !isResourceRecord(r));
    if (category === "all") return clipboardRecords;
    if (category === "stash") return [];
    return clipboardRecords.filter((r) => r.type === category);
  }, [records, category]);
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

  const handleToggleAll = useCallback(async () => {
    if (selectingAll) return;
    if (allVisibleSelected && !hasMore) {
      toggleAllVisible();
      return;
    }

    const request = ++selectAllRequestRef.current;
    setSelectingAll(true);
    try {
      const allRecords = await loadAllRecords(category);
      if (!allRecords || request !== selectAllRequestRef.current) return;
      const allVisibleRecordIds = allRecords
        .filter((record) => !isResourceRecord(record))
        .map((record) => record.id);
      selectIds(allVisibleRecordIds);
    } finally {
      if (request === selectAllRequestRef.current) setSelectingAll(false);
    }
  }, [allVisibleSelected, category, hasMore, loadAllRecords, selectIds, selectingAll, toggleAllVisible]);

  useEffect(() => {
    setSearch("");
    init("all");
  }, [init, setSearch]);

  useEffect(() => {
    if (searchEffectInitializedRef.current) {
      const timer = setTimeout(() => void loadRecords(false), 300);
      return () => clearTimeout(timer);
    }
    searchEffectInitializedRef.current = true;
  }, [loadRecords, search]);

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

  const enqueueWindowOperation = useCallback((operation: () => Promise<void>) => {
    const task = windowOperationQueueRef.current.then(
      () => operation(),
      () => operation(),
    );
    windowOperationQueueRef.current = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }, []);

  const restoreMainWindow = useCallback(() => {
    const geometry = originalWindowGeometryRef.current;
    originalWindowGeometryRef.current = null;
    if (!geometry) return windowRestoreRef.current ?? Promise.resolve();

    const restoreTask = enqueueWindowOperation(async () => {
      const appWindow = getCurrentWindow();
      try {
        await appWindow.setSize(geometry.size);
        await appWindow.setPosition(geometry.position);
      } catch {
        // 主窗口下次显示时仍会按已保存尺寸恢复。
      }
    });
    windowRestoreRef.current = restoreTask;
    void restoreTask.then(
      () => {
        if (windowRestoreRef.current === restoreTask) windowRestoreRef.current = null;
      },
      () => {
        if (windowRestoreRef.current === restoreTask) windowRestoreRef.current = null;
      },
    );
    return restoreTask;
  }, [enqueueWindowOperation]);

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

  const handleDelete = useCallback(
    (id: string) => {
      setConfirmState({
        message: t("clipboard.confirmDelete"),
        onConfirm: async () => {
          try {
            await deleteRecord(id);
            if (
              previewRef.current?.recordId === id
              || contentPreviewRef.current?.recordId === id
            ) {
              collapsePreview();
            }
          } catch (error) {
            console.error("Failed to delete clipboard record:", error);
          }
        },
      });
    },
    [collapsePreview, deleteRecord, t],
  );

  const handleDeleteSelected = useCallback(() => {
    if (selectedCount === 0 || selectingAll || deletingSelected) return;
    const ids = [...selectedIds];
    setConfirmState({
      message: t(
        "clipboard.confirmDeleteSelected",
        { count: ids.length },
      ),
      onConfirm: async () => {
        setDeletingSelected(true);
        try {
          await deleteRecords(ids);
          if (
            (previewRef.current && ids.includes(previewRef.current.recordId))
            || (contentPreviewRef.current && ids.includes(contentPreviewRef.current.recordId))
          ) {
            collapsePreview();
          }
          cancelClipboardSelection();
        } catch {
          // 删除失败时保留选择状态，便于用户重试。
        } finally {
          setDeletingSelected(false);
        }
      },
    });
  }, [
    cancelClipboardSelection,
    collapsePreview,
    deleteRecords,
    deletingSelected,
    selectingAll,
    selectedCount,
    selectedIds,
    t,
  ]);

  const handleSearchChange = useCallback(
    (value: string) => {
      cancelClipboardSelection();
      collapsePreview();
      setSearch(value);
    },
    [cancelClipboardSelection, collapsePreview, setSearch],
  );

  const handleCategoryChange = useCallback(
    (value: ClipType) => {
      cancelClipboardSelection();
      collapsePreview();
      setCategory(value);
      void loadRecords(false, value);
    },
    [cancelClipboardSelection, collapsePreview, setCategory, loadRecords],
  );

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
      await enqueueWindowOperation(async () => {
        await appWindow.setSize(new PhysicalSize(
          innerSize.width + expansion.previewPhysicalWidth,
          innerSize.height,
        ));
        if (expansion.direction === "left") {
          await appWindow.setPosition(new PhysicalPosition(expansion.windowX, position.y));
        }
      });
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
          await enqueueWindowOperation(async () => {
            await appWindow.setSize(geometry.size);
            await appWindow.setPosition(geometry.position);
          });
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
  }, [enqueueWindowOperation, finishMainPreviewRestore]);

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

  const isFiltered = category !== "all" || search.trim().length > 0;

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
    <div className="clipboard-page">
      <div className="page-search">
        <SearchInput
          placeholder={t("clipboard.search")}
          value={search}
          onChange={handleSearchChange}
        />
      </div>

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
                onClick={() => void openClipboardCreate()}
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
            <div className="empty-icon-compact">{Icons.clipboard}</div>
            <span>{t("clipboard.empty")}</span>
          </div>
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
                />
              ))}
            </SortableContext>
            {createPortal(dragOverlay, document.body)}
          </DndContext>
          {hasMore && filtered.length > 0 && (
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
        onClose={collapsePreview}
        onClick={(e) => e.stopPropagation()}
      />,
      document.body,
    )}
    </>
  );
}
