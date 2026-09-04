import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
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
import { isResourceRecord } from "../../utils/clipboardRecord";

type ClipType = "all" | "text" | "image" | "link" | "file" | "stash";

TYPE_META.text.icon = Icons.clipboard;
TYPE_META.image.icon = Icons.image;
TYPE_META.link.icon = Icons.link;
TYPE_META.file.icon = Icons.file;

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

  const handleDelete = useCallback(
    (id: string) => {
      setConfirmState({
        message: t("clipboard.confirmDelete"),
        onConfirm: async () => {
          try {
            await deleteRecord(id);
          } catch (error) {
            console.error("Failed to delete clipboard record:", error);
          }
        },
      });
    },
    [deleteRecord, t],
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
    const id = String(event.active.id);
    setActiveId(id);
    setActiveOverlayWidth(clipboardListRef.current?.getBoundingClientRect().width ?? null);
    lastPreviewMoveRef.current = null;
    setPreviewRecords(isFiltered ? null : filtered);
  }, [filtered, isFiltered, isSelecting]);

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
    </>
  );
}
