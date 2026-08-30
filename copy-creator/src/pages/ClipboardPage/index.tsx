import { useEffect, useState, useRef, useCallback, useMemo } from "react";
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
import { ContentPreviewPanel } from "../../components/ContentPreviewPanel";
import { loadClipboardPreviewSegments } from "../../utils/contentPreview";
import {
  calculatePreviewExpansion,
  CONTENT_PREVIEW_DELAY_MS,
  shouldScheduleContentPreview,
  type RadialPreviewDirection,
  type RadialPreviewSegment,
} from "../../utils/radialPreview";

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
    deleteRecords,
    deleteRecord,
    pasteRecord,
    pasteRecordTerminal,
  } = useClipboardStore();
  const pasteLeftClick = useSettingsStore((s) => s.pasteLeftClick);
  const createRecord = useClipboardStore((s) => s.createRecord);
  const [showCreate, setShowCreate] = useState(false);
  const [createContent, setCreateContent] = useState("");
  const [confirmState, setConfirmState] = useState<{
    message: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const categoriesScrollRef = useRef<HTMLDivElement>(null);
  const clipboardListRef = useRef<HTMLDivElement>(null);
  const previewTimerRef = useRef<number | null>(null);
  const previewRequestRef = useRef(0);
  const previewRef = useRef<ClipboardPreviewState | null>(null);
  const originalWindowGeometryRef = useRef<OriginalWindowGeometry | null>(null);
  const windowRestoreRef = useRef<Promise<void> | null>(null);
  const previewCacheRef = useRef(new Map<string, RadialPreviewSegment[]>());
  const [pendingPreviewId, setPendingPreviewId] = useState<string | null>(null);
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
      return records.filter((r) => r.group_name === "暂存" || r.group_name === "stash");
    }
    if (category === "all") return records;
    if (category === "stash") {
      return records.filter((r) => r.group_name === "暂存" || r.group_name === "stash");
    }
    return records.filter((r) => r.type === category);
  }, [records, category, resourcesOnly]);
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
  } = useMultiSelect(visibleIds);

  const handleSearchChange = useCallback(
    (value: string) => {
      exitSelection();
      setSearch(value);
    },
    [exitSelection, setSearch],
  );

  const handleCategoryChange = useCallback(
    (value: ClipType) => {
      exitSelection();
      setCategory(value);
      void loadRecords(false, value);
    },
    [exitSelection, setCategory, loadRecords],
  );

  const handleDeleteSelected = useCallback(() => {
    if (selectedCount === 0) return;
    const ids = [...selectedIds];
    setConfirmState({
      message: t("clipboard.confirmDeleteSelected", { count: ids.length }),
      onConfirm: async () => {
        await deleteRecords(ids);
        exitSelection();
      },
    });
  }, [deleteRecords, exitSelection, selectedCount, selectedIds, t]);

  useEffect(() => {
    init(resourcesOnly ? "stash" : "all");
    setCategory(resourcesOnly ? "stash" : "all");
    void loadRecords(false, resourcesOnly ? "stash" : "all");
  }, [init, loadRecords, resourcesOnly, setCategory]);

  useEffect(() => {
    const timer = setTimeout(() => loadRecords(false, resourcesOnly ? "stash" : undefined), 300);
    return () => clearTimeout(timer);
  }, [loadRecords, resourcesOnly, search]);

  const clearPreviewTimer = useCallback(() => {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    setPendingPreviewId(null);
  }, []);

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
    clearPreviewTimer();
    const request = ++previewRequestRef.current;
    previewRef.current = null;
    setContentPreview(null);
    markMainPreviewRestoring();

    const restoreTask = windowRestoreRef.current ?? restoreMainWindow();
    windowRestoreRef.current = restoreTask;
    void restoreTask.finally(() => {
      if (windowRestoreRef.current === restoreTask) windowRestoreRef.current = null;
      if (request === previewRequestRef.current && !previewRef.current) {
        clearMainPreviewLayout();
      }
    });
  }, [clearPreviewTimer, restoreMainWindow]);

  const expandPreviewWindow = useCallback(async (
    request: number,
    recordId: string,
  ): Promise<PreviewLayout | null> => {
    if (windowRestoreRef.current) await windowRestoreRef.current;
    if (request !== previewRequestRef.current) return null;

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

      const geometry = { position, size: innerSize };
      originalWindowGeometryRef.current = geometry;
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
        originalWindowGeometryRef.current = null;
        await appWindow.setSize(innerSize);
        await appWindow.setPosition(position);
        return null;
      }

      return layout;
    } catch {
      const geometry = originalWindowGeometryRef.current;
      originalWindowGeometryRef.current = null;
      if (request === previewRequestRef.current) {
        previewRef.current = null;
        setContentPreview(null);
      }
      if (geometry) {
        try {
          await appWindow.setSize(geometry.size);
          await appWindow.setPosition(geometry.position);
        } catch {
          // 主窗口下次显示时仍会按已保存尺寸恢复。
        }
      }
      if (request === previewRequestRef.current) clearMainPreviewLayout();
      return null;
    }
  }, []);

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

  const schedulePreview = useCallback((
    record: typeof records[number],
    element: HTMLElement,
  ) => {
    clearPreviewTimer();
    if (previewRef.current?.recordId === record.id) return;
    if (previewRef.current) collapsePreview();

    const isClipped = element.scrollHeight > element.clientHeight + 1;
    if (!shouldScheduleContentPreview({
      type: record.type,
      contentTruncated: record.content_truncated,
      hasImages: record.has_images,
    }, isClipped)) return;

    setPendingPreviewId(record.id);
    previewTimerRef.current = window.setTimeout(() => {
      previewTimerRef.current = null;
      setPendingPreviewId(null);
      void showPreview(record);
    }, CONTENT_PREVIEW_DELAY_MS);
  }, [clearPreviewTimer, collapsePreview, showPreview]);

  const handlePreviewLeave = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!previewRef.current) {
      clearPreviewTimer();
      return;
    }

    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Element) {
      if (relatedTarget.closest("[data-content-preview]")) return;
      const currentCard = event.currentTarget.closest(".clipboard-card");
      if (currentCard && relatedTarget.closest(".clipboard-card") === currentCard) return;
    }
    collapsePreview();
  }, [clearPreviewTimer, collapsePreview]);

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
    if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
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
                onClick={() => {
                  if (resourcesOnly) {
                    void invoke("open_clipboard_create");
                  } else {
                    setShowCreate(true);
                  }
                }}
              >
                {Icons.add}
                <span>{t("clipboard.create")}</span>
              </button>
              {filtered.length > 0 && (
                <button className="phrase-add-btn selection-mode-btn" onClick={startSelection}>
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
          onToggleAll={toggleAllVisible}
          onDelete={handleDeleteSelected}
          onCancel={exitSelection}
        />
      )}

      {showCreate && (
        <div className="dialog-overlay" onClick={() => { setShowCreate(false); setCreateContent(""); }}>
          <div className="dialog-content" onClick={(e) => e.stopPropagation()}>
            <h3 className="dialog-title">{t("clipboard.create")}</h3>
            <textarea
              className="dialog-textarea"
              value={createContent}
              onChange={(e) => setCreateContent(e.target.value)}
              placeholder={t("clipboard.createPlaceholder")}
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
        <div className="page-empty-compact">
          <div className="empty-icon-compact">{resourcesOnly ? Icons.file : Icons.clipboard}</div>
          <span>{resourcesOnly ? t("resources.empty") : t("clipboard.empty")}</span>
        </div>
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
                  previewPending={pendingPreviewId === r.id}
                  onPreviewEnter={schedulePreview}
                  onPreviewLeave={handlePreviewLeave}
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
