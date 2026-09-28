import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
import { useClipboardStore, type ClipboardFilter } from "../../stores/clipboardStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { Icons } from "../../components/Icons";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import SearchInput from "../../components/SearchInput";
import { ClipboardCard } from "./ClipboardCard";
import { EditRecordDialog } from "./EditRecordDialog";
import { Virtuoso } from "react-virtuoso";
import { TYPE_META } from "./utils";
import BatchSelectionBar from "../../components/BatchSelectionBar";
import { BackToTopButton } from "../../components/BackToTop";
import { useBackToTop } from "../../hooks/useBackToTop";
import { useHorizontalWheelScroll } from "../../hooks/useHorizontalWheelScroll";
import { useMultiSelect } from "../../hooks/useMultiSelect";
import { useRefreshOnShow } from "../../hooks/useRefreshOnShow";
import { useRecordLocale } from "../../hooks/useRecordLocale";
import { useArrowKeyNav } from "../../hooks/useArrowKeyNav";
import { buildRecordView, type RecordView } from "../../domain/recordView";
import { isResourceRecord, recordMatchesCategory, RECORD_CATEGORY_KEYS } from "../../domain/records";

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
    loadedOnce,
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
      loadedOnce: s.loadedOnce,
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
  // 记录正文编辑：打开时先取全文（列表载荷是截断预览）。
  const [editingRecord, setEditingRecord] = useState<{ id: string; content: string } | null>(null);

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

  // 类别键序唯一来源在 domain（RECORD_CATEGORY_KEYS），与径向菜单同源。
  const categories: { key: ClipType; label: string }[] = RECORD_CATEGORY_KEYS.map(
    (key) => ({ key, label: t(`clipboard.${key}`) }),
  );

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

  // 编辑正文：读全文打开对话框，保存成功后重载当前视图拿新预览。
  const handleEditRecord = useCallback(
    (view: RecordView) => {
      void getRecordContent(view)
        .then((content) => setEditingRecord({ id: view.id, content }))
        .catch((error) => console.error("Failed to load record content:", error));
    },
    [getRecordContent],
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

  // 类别过滤走 domain 唯一判定（含收藏语义），不再内联副本。
  const filtered = useMemo(
    () => records.filter((r) => recordMatchesCategory(r, category)),
    [records, category],
  );
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
  const listRef = useRef<HTMLDivElement>(null);
  const arrowNav = useArrowKeyNav({ containerRef: listRef, itemSelector: ".clipboard-card" });
  // 虚拟滚动以既有滚动容器为滚动源（customScrollParent）：容器 CSS/滚动条
  // 与键盘导航、回到顶部全部保持原状；DOM 就绪后再挂 Virtuoso。
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  // 「显示更多」作为虚拟列表 Footer 渲染：恒在最后一条内容之后，杜绝
  // 初次测量窗口期与卡片重叠（曾以兄弟节点挂在 Virtuoso 之后，高度
  // 未测量时占位偏短，按钮压在卡片上）。
  const LoadMoreFooter = useMemo(
    () =>
      forwardRef<HTMLDivElement, { context?: unknown }>(function LoadMoreFooter(_props, ref) {
        if (!hasMore || filtered.length === 0) return null;
        return (
          <div ref={ref} style={{ display: "flex", justifyContent: "center", padding: "2px 0 8px" }}>
            <button
              className="clipboard-load-more"
              type="button"
              onClick={() => loadRecords(true)}
            >
              {t("clipboard.loadMore")}
            </button>
          </div>
        );
      }),
    [hasMore, filtered.length, loadRecords, t],
  );
  // 不用 firstItemIndex 前插锚定：该协议在 customScrollParent 模式下
  // 位移补偿不准，偏移累积会在首屏留下大段空白（实测回归）。新复制
  // 前插的表现退回虚拟化前语义——内容下移一卡，与历史版本一致。
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

  // 采集暂停提示条：托盘菜单切换由 Rust 侧广播，设置页开关由前端广播，
  // 这里统一监听并同步 store（本页提示条与设置页开关共用同一状态源）。
  const clipboardPaused = useSettingsStore((s) => s.clipboardPaused);
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<{ paused: boolean }>("clipboard-pause-changed", (e) => {
      useSettingsStore.setState({ clipboardPaused: e.payload.paused });
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

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

      {editingRecord && (
        <EditRecordDialog
          recordId={editingRecord.id}
          initialContent={editingRecord.content}
          onClose={() => setEditingRecord(null)}
          onSaved={() => void loadRecords(false)}
        />
      )}

      {clipboardPaused && (
        <div className="clipboard-paused-notice" role="status">
          {Icons.pause}
          <span>{t("clipboard.pausedNotice")}</span>
        </div>
      )}

      {loading && records.length === 0 && !loadedOnce ? (
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
            listRef.current = el;
            setListElement(el);
            backToTop.containerRef(el);
          }}
          onKeyDown={arrowNav}
        >
          {listElement && (
            <Virtuoso
              customScrollParent={listElement}
              data={views}
              computeItemKey={(_, view) => view.id}
              // 大预载边：条目在远离视口处挂载/卸载，入场动画只离屏重放；
              // 视口内条目稳定挂载不闪烁。
              increaseViewportBy={{ top: 600, bottom: 1200 }}
              components={{ Footer: LoadMoreFooter }}
              itemContent={(index, view) => (
                <div className="clipboard-virtual-item">
                  <ClipboardCard
                    view={view}
                    index={index}
                    getTypeLabel={getTypeLabel}
                    pasteLeftClick={pasteLeftClick}
                    search={search}
                    onPasteNormal={handlePaste}
                    onPasteTerminal={handlePasteTerminal}
                    onDelete={handleDelete}
                    onSetPinned={handleSetPinned}
                    onEditRecord={handleEditRecord}
                    getRecordContent={getRecordContent}
                    onToggleUserApiKey={handleToggleUserApiKey}
                    selectionMode={isSelecting}
                    selected={isSelected(view.id)}
                    onToggleSelected={toggleSelected}
                  />
                </div>
              )}
            />
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
