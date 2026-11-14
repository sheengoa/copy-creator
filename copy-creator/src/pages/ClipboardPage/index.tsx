import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import ResourceDetailPage from "../ResourcePage/ResourceDetailPage";
import BatchSelectionBar from "../../components/BatchSelectionBar";
import { BackToTopButton } from "../../components/BackToTop";
import { useBackToTop } from "../../hooks/useBackToTop";
import { useHorizontalWheelScroll } from "../../hooks/useHorizontalWheelScroll";
import { useMultiSelect } from "../../hooks/useMultiSelect";
import { useRefreshOnShow } from "../../hooks/useRefreshOnShow";
import { useRecordLocale } from "../../hooks/useRecordLocale";
import { useArrowKeyNav } from "../../hooks/useArrowKeyNav";
import { useCardColumns } from "../../hooks/useCardColumns";
import { COMPACT_CARD_MIN_WIDTH, splitResourceColumns } from "../../utils/cardGrid";
import { buildRecordView, type RecordView } from "../../domain/recordView";
import type { ClipboardRecord } from "../../types";
import { RESOURCE_MEDIA_KIND_LABEL_KEYS, type ResourceMediaKind } from "../../domain/mediaKind";
import { isResourceRecord, recordMatchesCategory, RECORD_CATEGORY_KEYS } from "../../domain/records";

type ClipType = ClipboardFilter;

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
      setRecordsPinned: s.setRecordsPinned,
    })),
  );
  const [confirmState, setConfirmState] = useState<{
    message: string;
    hint?: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);
  const [deletingSelected, setDeletingSelected] = useState(false);
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

  // 媒体 kind 文案（video/audio 等）：kind→文案键映射收口在 domain/mediaKind.ts。
  const getKindLabel = useCallback(
    (kind: ResourceMediaKind): string => t(RESOURCE_MEDIA_KIND_LABEL_KEYS[kind]),
    [t],
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

  // 详情页内联编辑的保存通道（2026-11-14 定案：与资源库同交互——双击
  // 正文进编辑态、页内保存，无弹窗）：数据库文本/链接写
  // update_clipboard_record_content，成功后详情页经 onRecordUpdated
  // 刷新列表拿新预览。
  const handleSaveDetailContent = useCallback(
    (record: ClipboardRecord, content: string): Promise<void> =>
      invoke("update_clipboard_record_content", { id: record.id, content }).then(() => undefined),
    [],
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
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  // 卡片网格：列数随列表宽度动态变化（与资源页同一 hook），交错分配
  // 保证双列按行阅读时间序正确。
  const columnCount = useCardColumns(listElement, COMPACT_CARD_MIN_WIDTH);
  const columns = useMemo(
    () => splitResourceColumns(views, columnCount),
    [views, columnCount],
  );
  const columnsRef = useRef<HTMLDivElement>(null);
  const arrowNav = useArrowKeyNav({
    containerRef: columnsRef,
    itemSelector: ".clipboard-card",
    columnar: true,
    columnSelector: ".resource-column",
  });
  const selectAllRequestRef = useRef(0);

  // 详情视图：存 id 而非记录对象，records 重载（编辑/收藏变更）后按 id
  // 从最新数据解析，详情页内容保持新鲜。点击卡片 = 页内详情（资源库
  // 同款形态），主窗口纯展示预览，粘贴只在径向菜单。
  const [viewingRecordId, setViewingRecordId] = useState<string | null>(null);
  const viewingRecord = useMemo(
    () => (viewingRecordId ? records.find((record) => record.id === viewingRecordId) ?? null : null),
    [records, viewingRecordId],
  );
  const openViewer = useCallback((view: RecordView) => {
    setViewingRecordId(view.id);
  }, [setViewingRecordId]);

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
      hint: t("clipboard.confirmDeleteSelectedHint"),
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

  // 详情视图：完全复用资源库详情页形态（hideResourceOps 隐藏备注/重命名/
  // 版本记录/标注/文件内联编辑），正文编辑走双击页内编辑（onSaveContent
  // 通道），文件类记录保持只读。
  if (viewingRecord) {
    return (
      <div className="clipboard-page">
        <ResourceDetailPage
          record={viewingRecord}
          typeLabel={getKindLabel}
          onBack={() => setViewingRecordId(null)}
          onDelete={handleDelete}
          onRecordUpdated={() => void loadRecords(false)}
          hideResourceOps
          onSaveContent={handleSaveDetailContent}
          backLabel={t("common.backToList")}
        />
        {confirmState && (
          <ConfirmDialog
            message={confirmState.message}
            hint={confirmState.hint}
            onConfirm={confirmState.onConfirm}
            onCancel={() => setConfirmState(null)}
          />
        )}
      </div>
    );
  }

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
          hint={confirmState.hint}
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
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
          <div className="resource-list-skeleton" aria-busy="true">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div className="resource-card-skeleton" key={i}>
                <div className="resource-skeleton-preview" />
                <div className="resource-skeleton-line long" />
                <div className="resource-skeleton-line short" />
              </div>
            ))}
          </div>
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
        >
          <div
            className="resource-columns"
            ref={columnsRef}
            onKeyDown={arrowNav}
            style={{
              gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
            }}
          >
            {columns.map((column, columnIndex) => (
              <div className="resource-column" key={`column-${columnIndex}`}>
                {column.map((view) => (
                  <div className="resource-item" key={view.id}>
                    <ClipboardCard
                      view={view}
                      getTypeLabel={getTypeLabel}
                      getKindLabel={getKindLabel}
                      search={search}
                      onOpenView={openViewer}
                      onDelete={handleDelete}
                      onSetPinned={handleSetPinned}
                      getRecordContent={getRecordContent}
                      onToggleUserApiKey={handleToggleUserApiKey}
                      selectionMode={isSelecting}
                      selected={isSelected(view.id)}
                      onToggleSelected={toggleSelected}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
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
