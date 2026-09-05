import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { useClipboardStore } from "../stores/clipboardStore";
import { useMultiSelect } from "../hooks/useMultiSelect";
import { Icons } from "../components/Icons";
import IosSelect from "../components/IosSelect";
import SearchInput from "../components/SearchInput";
import BatchSelectionBar from "../components/BatchSelectionBar";
import type { ClipboardRecord } from "../types";
import ResourceDetailPage from "./ResourcePage/ResourceDetailPage";
import { ResourceCard, ResourceCardDragPreview } from "./ResourcePage/ResourceCard";
import {
  getChangedOrderIds,
  getDragPreviewOrder,
} from "../utils/reorderPreview";
import {
  matchesResourceType,
  splitResourceColumns,
  type ResourceMediaKind,
  type ResourceTypeFilter,
} from "./ResourcePage/resourceUtils";
import { isResourceRecord } from "../utils/clipboardRecord";

type ResourceSortOrder = "newest" | "oldest";

const RESOURCE_TYPE_FILTERS: ResourceTypeFilter[] = [
  "all",
  "text",
  "image",
  "video",
  "audio",
  "file",
];

export default function ResourcePage() {
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
    deleteRecord,
    deleteRecords,
    pasteRecord,
    reorderRecords,
  } = useClipboardStore();

  const [typeFilter, setTypeFilter] = useState<ResourceTypeFilter>("all");
  const [sortOrder, setSortOrder] = useState<ResourceSortOrder>("newest");
  const [detailRecordId, setDetailRecordId] = useState<string | null>(null);
  const [detailRecord, setDetailRecord] = useState<ClipboardRecord | null>(null);
  const detailHistoryRef = useRef(false);
  const pendingScrollTopRef = useRef<number | null>(null);
  const resourceListRef = useRef<HTMLDivElement>(null);
  const [feedback, setFeedback] = useState<"copied" | "copyFailed" | "deleteFailed" | "openFailed" | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  const [deletingSelected, setDeletingSelected] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [resourceLibraryPath, setResourceLibraryPath] = useState("");
  const [resourceLibraryPathLoading, setResourceLibraryPathLoading] = useState(true);
  const [resourceLibraryPathChanging, setResourceLibraryPathChanging] = useState(false);
  const [resourceLibraryPathError, setResourceLibraryPathError] = useState<string | null>(null);
  const [resourceSettingsOpen, setResourceSettingsOpen] = useState(false);
  const resourceSettingsButtonRef = useRef<HTMLButtonElement>(null);
  const resourceSettingsPopoverRef = useRef<HTMLElement>(null);
  const [confirmState, setConfirmState] = useState<{
    message: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const [dragRecords, setDragRecords] = useState<ClipboardRecord[] | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const lastDragMoveRef = useRef<string | null>(null);
  const searchEffectInitializedRef = useRef(false);
  const selectAllRequestRef = useRef(0);

  const typeLabels = useMemo<Record<ResourceMediaKind, string>>(
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

  useEffect(() => {
    setSearch("");
    init("resources");
  }, [init, setSearch]);

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
      void loadRecords(false, "resources");
    }, 300);
    return () => window.clearTimeout(timer);
  }, [loadRecords, search]);

  const filteredRecords = useMemo(() => {
    const next = records.filter((record) => (
      isResourceRecord(record)
      && matchesResourceType(record, typeFilter)
    ));
    if (sortOrder === "oldest") {
      return [...next].sort((left, right) => (
        new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
      ));
    }
    return next;
  }, [records, sortOrder, typeFilter]);

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

  const reorderEnabled = (
    !isSelecting
    && !detailRecordId
    && !search.trim()
    && typeFilter === "all"
    && sortOrder === "newest"
    && filteredRecords.length > 1
  );
  const renderedRecords = dragRecords ?? filteredRecords;
  const columns = splitResourceColumns(renderedRecords, 2);
  const renderedRecordIndexes = useMemo(
    () => new Map(renderedRecords.map((record, index) => [record.id, index])),
    [renderedRecords],
  );
  const activeDragRecord = activeDragId
    ? renderedRecords.find((record) => record.id === activeDragId)
    : null;

  useEffect(() => {
    setDragRecords(null);
    setActiveDragId(null);
    lastDragMoveRef.current = null;
  }, [filteredRecords]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    if (!reorderEnabled) return;
    setActiveDragId(String(event.active.id));
    setDragRecords(filteredRecords);
    lastDragMoveRef.current = null;
  }, [filteredRecords, reorderEnabled]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (!reorderEnabled || !event.over) return;
    const active = String(event.active.id);
    const over = String(event.over.id);
    const moveKey = `${active}:${over}`;
    if (lastDragMoveRef.current === moveKey) return;
    lastDragMoveRef.current = moveKey;
    setDragRecords((current) => getDragPreviewOrder(current ?? filteredRecords, active, over));
  }, [filteredRecords, reorderEnabled]);

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
    setDragRecords(null);
    lastDragMoveRef.current = null;
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const finalRecords = dragRecords;
    setActiveDragId(null);
    setDragRecords(null);
    lastDragMoveRef.current = null;
    if (!reorderEnabled || !finalRecords || !event.over) return;
    const nextIds = getChangedOrderIds(filteredRecords, finalRecords);
    if (nextIds) void reorderRecords(nextIds);
  }, [dragRecords, filteredRecords, reorderEnabled, reorderRecords]);

  const handleSearchChange = useCallback((value: string) => {
    cancelResourceSelection();
    setSearch(value);
  }, [cancelResourceSelection, setSearch]);

  const handleSelectType = useCallback((next: ResourceTypeFilter) => {
    cancelResourceSelection();
    setTypeFilter(next);
  }, [cancelResourceSelection]);

  const handleSortChange = useCallback((value: string) => {
    cancelResourceSelection();
    setSortOrder(value as ResourceSortOrder);
  }, [cancelResourceSelection]);

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

  const openDetail = useCallback((record: ClipboardRecord) => {
    pendingScrollTopRef.current = resourceListRef.current?.scrollTop ?? 0;
    setDetailRecord(record);
    detailHistoryRef.current = true;
    setDetailRecordId(record.id);
    window.history.pushState({ resourceDetailId: record.id }, "", `#resource/${record.id}`);
  }, []);

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
      if (event.key === "Escape" && detailRecordId) {
        event.preventDefault();
        closeDetail();
      }
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
      const allRecords = await loadAllRecords("resources");
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
    } catch (error) {
      const message = String(error).toLowerCase();
      if (!message.includes("cancelled") && !message.includes("canceled")) {
        console.error("Failed to change resource library path:", error);
        setResourceLibraryPathError(t("resources.libraryPathChangeError"));
      }
    } finally {
      setResourceLibraryPathChanging(false);
    }
  }, [resourceLibraryPathChanging, t]);

  const openResourceCreate = useCallback(async () => {
    try {
      await invoke("open_clipboard_create", {
        storageMode: "resource",
      });
    } catch {
      showFeedback("openFailed");
    }
  }, [showFeedback]);

  const confirmDialog = confirmState ? (
    <div className="dialog-overlay" onClick={() => setConfirmState(null)}>
      <div className="dialog-content" onClick={(event) => event.stopPropagation()}>
        <h3 className="dialog-title">{t("common.confirm")}</h3>
        <p className="dialog-message">{confirmState.message}</p>
        <div className="dialog-actions">
          <button type="button" className="dialog-btn secondary" onClick={() => setConfirmState(null)}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="dialog-btn save"
            onClick={() => {
              const action = confirmState.onConfirm;
              setConfirmState(null);
              void action();
            }}
          >
            {t("common.confirm")}
          </button>
        </div>
      </div>
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
        />
        {confirmDialog}
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
        <section
          ref={resourceSettingsPopoverRef}
          className="resource-settings-popover"
          role="dialog"
          aria-label={t("resources.librarySettings")}
        >
          <div className="resource-settings-header">
            <strong>{t("resources.librarySettings")}</strong>
            <button
              type="button"
              className="resource-icon-button"
              onClick={() => setResourceSettingsOpen(false)}
              aria-label={t("common.close")}
              title={t("common.close")}
            >
              {Icons.close}
            </button>
          </div>
          <code className="resource-settings-path" title={resourceLibraryPath}>
            {resourceLibraryPathLoading
              ? t("common.loading")
              : resourceLibraryPath || t("resources.libraryPathError")}
          </code>
          <p className="resource-settings-hint">{t("resources.libraryPathHint")}</p>
          {resourceLibraryPathError && (
            <span className="resource-settings-error" role="alert">
              {resourceLibraryPathError}
            </span>
          )}
          <button
            type="button"
            className="resource-secondary-button"
            onClick={() => void handleChangeResourceLibraryPath()}
            disabled={resourceLibraryPathLoading || resourceLibraryPathChanging}
          >
            {Icons.edit}
            <span>
              {resourceLibraryPathChanging
                ? t("common.saving")
                : t("resources.changeLibraryPath")}
            </span>
          </button>
        </section>
      )}

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
        <div className="resource-sort-control">
          <span>{t("resources.sort")}</span>
          <IosSelect
            value={sortOrder}
            options={sortOptions}
            onChange={handleSortChange}
          />
        </div>
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
        />
      )}

      {confirmDialog}

      <section className="resource-list-area">
        <div className="resource-list-heading">
          <div className="resource-list-heading-main">
            <h2>{t("resources.modeResource")}</h2>
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
            <button type="button" onClick={() => void loadRecords(false, "resources")}>
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
            <strong>{search.trim() || typeFilter !== "all" ? t("resources.noMatches") : t("resources.empty")}</strong>
            <span>{t("resources.modeResourceHint")}</span>
            {hasMore && (
              <button type="button" className="resource-secondary-button" onClick={() => void loadRecords(true, "resources")}>
                {t("resources.loadMore")}
              </button>
            )}
          </div>
        ) : (
          <div className="resource-list" ref={resourceListRef} data-resource-scroll>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <div className="resource-columns">
                {columns.map((column, columnIndex) => (
                  <div className="resource-column" key={`column-${columnIndex}`}>
                    <SortableContext items={column.map((record) => record.id)}>
                      {column.map((record) => (
                        <div className="resource-item" key={record.id}>
                          <ResourceCard
                            record={record}
                            index={renderedRecordIndexes.get(record.id) ?? 0}
                            search={search}
                            typeLabel={(kind) => typeLabels[kind]}
                            selectionMode={isSelecting}
                            selected={isSelected(record.id)}
                            reorderEnabled={reorderEnabled}
                            onOpenDetail={openDetail}
                            onCopy={handleCopy}
                            onDelete={handleDeleteRecord}
                            onToggleSelected={toggleSelected}
                          />
                        </div>
                      ))}
                    </SortableContext>
                  </div>
                ))}
              </div>
              {activeDragRecord && createPortal(
                <DragOverlay dropAnimation={null}>
                  <ResourceCardDragPreview
                    record={activeDragRecord}
                    search={search}
                    typeLabel={(kind) => typeLabels[kind]}
                  />
                </DragOverlay>,
                document.body,
              )}
            </DndContext>
            {hasMore && (
              <button type="button" className="clipboard-load-more" onClick={() => void loadRecords(true, "resources")}>
                {t("resources.loadMore")}
              </button>
            )}
          </div>
        )}
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
    </div>
  );
}
