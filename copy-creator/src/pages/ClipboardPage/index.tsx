import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
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
import { useHorizontalWheelScroll } from "../../hooks/useHorizontalWheelScroll";
import { useMultiSelect } from "../../hooks/useMultiSelect";
import { useRefreshOnShow } from "../../hooks/useRefreshOnShow";
import { useRecordLocale } from "../../hooks/useRecordLocale";
import { buildRecordView, type RecordView } from "../../domain/recordView";
import { isResourceRecord } from "../../domain/records";

type ClipType = ClipboardFilter;

TYPE_META.text.icon = Icons.clipboard;
TYPE_META.image.icon = Icons.image;
TYPE_META.link.icon = Icons.link;
TYPE_META.file.icon = Icons.file;

export default function ClipboardPage() {
  const { t } = useTranslation();
  // 选择器订阅：仅这些字段变化才重渲整页（store 里其余无关状态不触发）。
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
    setRecordsPinned,
  } = useClipboardStore(
    useShallow((s) => ({
      records: s.records,
      search: s.search,
      loading: s.loading,
      hasMore: s.hasMore,
      category: s.category,
      init: s.init,
      setSearch: s.setSearch,
      setCategory: s.setCategory,
      loadRecords: s.loadRecords,
      loadAllRecords: s.loadAllRecords,
      deleteRecords: s.deleteRecords,
      deleteRecord: s.deleteRecord,
      pasteRecord: s.pasteRecord,
      pasteRecordTerminal: s.pasteRecordTerminal,
      setRecordsPinned: s.setRecordsPinned,
    })),
  );
  const pasteLeftClick = useSettingsStore((s) => s.pasteLeftClick);
  const [confirmState, setConfirmState] = useState<{
    message: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);
  const [deletingSelected, setDeletingSelected] = useState(false);

  // 粘贴结果反馈：粘贴失败此前被静默吞掉，用户会去目标应用贴出旧内容。
  // 与资源页同款 showFeedback 模式与样式（resource-feedback）。
  const [pasteFeedback, setPasteFeedback] = useState<"copied" | "copyFailed" | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const showPasteFeedback = useCallback((next: "copied" | "copyFailed") => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    setPasteFeedback(next);
    feedbackTimerRef.current = window.setTimeout(() => {
      setPasteFeedback(null);
      feedbackTimerRef.current = null;
    }, 2200);
  }, []);
  useEffect(() => () => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
  }, []);

  const categoriesScrollRef = useRef<HTMLDivElement>(null);
  const searchEffectInitializedRef = useRef(false);

  useHorizontalWheelScroll(categoriesScrollRef);

  const categories: { key: ClipType; label: string }[] = [
    { key: "all", label: t("clipboard.all") },
    { key: "favorites", label: t("clipboard.favorites") },
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
    async (view: RecordView) => {
      const record = records.find((r) => r.id === view.id);
      if (!record) return;
      const copied = await pasteRecord(record);
      showPasteFeedback(copied ? "copied" : "copyFailed");
    },
    [pasteRecord, records, showPasteFeedback],
  );

  const handlePasteTerminal = useCallback(
    async (view: RecordView) => {
      const record = records.find((r) => r.id === view.id);
      if (!record) return;
      const copied = await pasteRecordTerminal(record);
      showPasteFeedback(copied ? "copied" : "copyFailed");
    },
    [pasteRecordTerminal, records, showPasteFeedback],
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

  const handleSetPinned = useCallback(
    (id: string, pinned: boolean) => {
      void setRecordsPinned([id], pinned);
    },
    [setRecordsPinned],
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
    // 「收藏」视图：跨类别，只看收藏记录（后端已过滤，这里是对本地
    // 窗口的同口径兜底）。
    if (category === "favorites") return clipboardRecords.filter((r) => r.pinned);
    return clipboardRecords.filter((r) => r.type === category);
  }, [records, category]);
  // 容器层组装视图模型（依赖 records 引用纪律，zustand 不可变更新保证稳定）。
  const recordLocale = useRecordLocale();
  const views = useMemo(
    () => filtered.map((record) => buildRecordView(record, { locale: recordLocale })),
    [filtered, recordLocale],
  );
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

  // 主窗口从隐藏恢复显示时重载当前视图：兜底隐藏期间丢失/被节流的刷新。
  // 本页与资源页各持独立的 store 实例（见 clipboardStore 的工厂说明），
  // 这里的加载只写本页视图，不会被另一页的后台加载覆盖。
  useRefreshOnShow(useCallback(() => {
    void loadRecords(false);
  }, [loadRecords]));

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
          onPin={() => void setRecordsPinned([...selectedIds], true)}
          onUnpin={() => void setRecordsPinned([...selectedIds], false)}
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
              onSetPinned={handleSetPinned}
              getRecordContent={getRecordContent}
              onToggleUserApiKey={handleToggleUserApiKey}
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

      {pasteFeedback && (
        <div
          className={`resource-feedback ${pasteFeedback === "copied" ? "success" : "error"}`}
          role="status"
          aria-live="polite"
        >
          {pasteFeedback === "copied" ? t("resources.copied") : t("resources.copyFailed")}
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
