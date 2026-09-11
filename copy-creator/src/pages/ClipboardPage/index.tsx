import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useClipboardStore, type ClipboardFilter } from "../../stores/clipboardStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { Icons } from "../../components/Icons";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import SearchInput from "../../components/SearchInput";
import { ClipboardCard } from "./ClipboardCard";
import { TYPE_META } from "./utils";
import BatchSelectionBar from "../../components/BatchSelectionBar";
import { BackToTopButton } from "../../components/BackToTop";
import { useBackToTop } from "../../hooks/useBackToTop";
import { useMultiSelect } from "../../hooks/useMultiSelect";
import { buildRecordView, type RecordView } from "../../domain/recordView";
import { isResourceRecord } from "../../domain/records";

type ClipType = ClipboardFilter;

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
    moveRecordsToTop,
  } = useClipboardStore();
  const pasteLeftClick = useSettingsStore((s) => s.pasteLeftClick);
  const [confirmState, setConfirmState] = useState<{
    message: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);
  const [deletingSelected, setDeletingSelected] = useState(false);

  const categoriesScrollRef = useRef<HTMLDivElement>(null);
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
    (view: RecordView) => {
      const record = records.find((r) => r.id === view.id);
      if (record) void pasteRecord(record);
    },
    [pasteRecord, records],
  );

  const handlePasteTerminal = useCallback(
    (view: RecordView) => {
      const record = records.find((r) => r.id === view.id);
      if (record) void pasteRecordTerminal(record);
    },
    [pasteRecordTerminal, records],
  );

  const getRecordContent = useCallback(
    (view: RecordView) => {
      const record = records.find((r) => r.id === view.id);
      if (!record) return Promise.reject(new Error("record not found"));
      return useClipboardStore.getState().getRecordContent(record);
    },
    [records],
  );

  const handleToggleUserApiKey = useCallback(
    async (view: RecordView) => {
      const record = records.find((r) => r.id === view.id);
      if (!record) return;
      try {
        await invoke("set_user_api_key", { id: record.id, value: !record.user_api_key });
        await loadRecords();
      } catch {
        // ignore
      }
    },
    [loadRecords, records],
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
    return clipboardRecords.filter((r) => r.type === category);
  }, [records, category]);
  // 容器层组装视图模型（依赖 records 引用纪律，zustand 不可变更新保证稳定）。
  const views = useMemo(() => filtered.map((record) => buildRecordView(record)), [filtered]);
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

  // 统一的「回到顶部」：监视剪贴板列表滚动容器，批量选择模式下隐藏。
  const backToTop = useBackToTop({ enabled: !isSelecting });
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

  // 手动拖拽排序已移除：列表顺序由内容排序偏好（最近使用 / 最多使用）决定。

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
          onMoveTop={() => void moveRecordsToTop([...selectedIds])}
        />
      )}

      {confirmState && (
        <ConfirmDialog
          message={confirmState.message}
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
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
        <div
          className="clipboard-list"
          ref={(el) => {
            backToTop.containerRef(el);
          }}
        >
          {views.map((view, i) => (
            <ClipboardCard
              key={view.id}
              view={view}
              index={i}
              getTypeLabel={getTypeLabel}
              pasteLeftClick={pasteLeftClick}
              search={search}
              onPasteNormal={handlePaste}
              onPasteTerminal={handlePasteTerminal}
              onDelete={handleDelete}
              onMoveToTop={(id) => void moveRecordsToTop([id])}
              getRecordContent={getRecordContent}
              onToggleUserApiKey={(v) => void handleToggleUserApiKey(v)}
              selectionMode={isSelecting}
              selected={isSelected(view.id)}
              onToggleSelected={toggleSelected}
            />
          ))}
          {hasMore && filtered.length > 0 && (
            <button
              className="clipboard-load-more"
              type="button"
              onClick={() => loadRecords(true)}
            >
              {t("clipboard.loadMore")}
            </button>
          )}
        </div>
      )}

      <BackToTopButton
        visible={backToTop.visible}
        onTop={backToTop.scrollToTop}
        label={t("common.backToTop")}
      />
    </div>
    </>
  );
}
