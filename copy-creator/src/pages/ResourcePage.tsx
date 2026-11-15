import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useResourceStore } from "../stores/clipboardStore";
import { useProjectStore } from "../stores/projectStore";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore, RESOURCE_CARD_SIZE_MAX, RESOURCE_CARD_SIZE_MIN } from "../stores/settingsStore";
import { useMultiSelect } from "../hooks/useMultiSelect";
import { useArrowKeyNav } from "../hooks/useArrowKeyNav";
import { useCardColumns } from "../hooks/useCardColumns";
import { Icons } from "../components/Icons";
import { IosSelect } from "../components/ui";
import SearchInput from "../components/SearchInput";
import BatchSelectionBar from "../components/BatchSelectionBar";
import { BackToTopButton } from "../components/BackToTop";
import { useBackToTop } from "../hooks/useBackToTop";
import { useRecordLocale } from "../hooks/useRecordLocale";
import { useEscapeKey } from "../hooks/useEscapeKey";
import ResourceDetailPage from "./ResourcePage/ResourceDetailPage";
import { useResourceGroupSync } from "./ResourcePage/useResourceGroupSync";
import { useResourceDetail } from "./ResourcePage/useResourceDetail";
import { useResourceMissingTrace } from "./ResourcePage/useResourceMissingTrace";
import { useResourceGroupAdmin } from "./ResourcePage/useResourceGroupAdmin";
import { ResourceGroupDialogs } from "./ResourcePage/ResourceGroupDialogs";
import { useResourceMove } from "./ResourcePage/useResourceMove";
import ResourceGroupChips from "./ResourcePage/ResourceGroupChips";
import { TrashPanel } from "./ResourcePage/TrashPanel";
import type { ResourceMediaKind as ResourceMediaKindLabel } from "../domain/mediaKind";
import { RESOURCE_MEDIA_KIND_LABEL_KEYS } from "../domain/mediaKind";
import { ResourceCard } from "./ResourcePage/ResourceCard";
import { buildRecordView, type RecordView } from "../domain/recordView";
import { type ResourceTypeFilter } from "../domain/mediaKind";
import { resourceCardScale, splitResourceColumns } from "../utils/cardGrid";
import { findResourceFolder, getResourceFolderRoot } from "../domain/groups";
import { matchesResourceType } from "../domain/mediaKind";
import ProjectView from "./ResourcePage/ProjectView";
import ProjectViewSwitch from "./ResourcePage/ProjectViewSwitch";
import ProjectSearchResults from "./ResourcePage/ProjectSearchResults";
import { isResourceRecord } from "../domain/records";

const RESOURCE_TYPE_FILTERS: ResourceTypeFilter[] = [
  "all",
  "text",
  "image",
  "video",
  "audio",
  "file",
];

/** 页面级类型筛选：标准媒体类型 + 「缺失」伪筛选（按 resource_missing 事实字段）。 */
type ResourcePageTypeFilter = ResourceTypeFilter | "missing";

export default function ResourcePage() {
  const { t } = useTranslation();
  const {
    records,
    search,
    loading,
    loadedOnce,
    loadError,
    hasMore,
    init,
    setSearch,
    loadRecords,
    loadAllRecords,
    resourceGroup,
    setResourceGroup: setStoreResourceGroup,
    deleteRecord,
    deleteRecords,
  } = useResourceStore(
    useShallow((s) => ({
      records: s.records,
      search: s.search,
      loading: s.loading,
      loadedOnce: s.loadedOnce,
      loadError: s.loadError,
      hasMore: s.hasMore,
      init: s.init,
      setSearch: s.setSearch,
      loadRecords: s.loadRecords,
      loadAllRecords: s.loadAllRecords,
      resourceGroup: s.resourceGroup,
      setResourceGroup: s.setResourceGroup,
      deleteRecord: s.deleteRecord,
      deleteRecords: s.deleteRecords,
    })),
  );
  const contentSort = useSettingsStore((s) => s.contentSort);
  const resourceCardSize = useSettingsStore((s) => s.resourceCardSize);
  const setResourceCardSize = useSettingsStore((s) => s.setResourceCardSize);
  // 卡片大小滑块的本地即时值：拖动实时重排列表，防抖后持久化到设置表。
  const [cardSizeDraft, setCardSizeDraft] = useState<number | null>(null);
  const cardSize = cardSizeDraft ?? resourceCardSize;
  const cardSizeSaveTimerRef = useRef<number | null>(null);
  const handleCardSizeChange = useCallback(
    (size: number) => {
      setCardSizeDraft(size);
      if (cardSizeSaveTimerRef.current !== null) window.clearTimeout(cardSizeSaveTimerRef.current);
      cardSizeSaveTimerRef.current = window.setTimeout(() => {
        cardSizeSaveTimerRef.current = null;
        void setResourceCardSize(size);
      }, 400);
    },
    [setResourceCardSize],
  );
  useEffect(
    () => () => {
      if (cardSizeSaveTimerRef.current !== null) window.clearTimeout(cardSizeSaveTimerRef.current);
    },
    [],
  );

  const [typeFilter, setTypeFilter] = useState<ResourcePageTypeFilter>("all");
  const resourceListRef = useRef<HTMLDivElement>(null);
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  const [feedback, setFeedback] = useState<"deleteFailed" | "deletedWithMissing" | "openFailed" | null>(null);
  // deletedWithMissing 消息的动态计数：文件在删除前就已不在磁盘、仅删除
  // 了记录的条目数（后端删除统计如实带回）。
  const [missingCount, setMissingCount] = useState(0);
  const feedbackTimerRef = useRef<number | null>(null);

  const [deletingSelected, setDeletingSelected] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [resourceSettingsOpen, setResourceSettingsOpen] = useState(false);
  // 分组选中态以 store 为单一来源：store 字段同时驱动 record-updated 事件
  // 的过滤（recordMatchesCategory），页面只读写 store，不再维护本地副本。
  const resourceSettingsButtonRef = useRef<HTMLButtonElement>(null);
  const resourceSettingsPopoverRef = useRef<HTMLElement>(null);
  const [confirmState, setConfirmState] = useState<{
    message: string;
    hint?: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);
  // 回收站：入口角标随 resource-groups-changed 刷新（删除入站即触发）。
  const [trashOpen, setTrashOpen] = useState(false);
  // 工程视图与文件视图共用本页工具行与对话框，仅内容区切换。
  const projectView = useProjectStore((state) => state.view);
  const runProjectSearch = useProjectStore((state) => state.runProjectSearch);
  const searchResults = useProjectStore((state) => state.searchResults);
  const clearProjectSearch = useProjectStore((state) => state.runProjectSearch);
  const [trashCount, setTrashCount] = useState(0);

  // 缺失追溯与清理子系统收口于 useResourceMissingTrace（见下方调用）。


  const refreshTrashCount = useCallback(() => {
    invoke<number>("trash_items_count")
      .then((count) => setTrashCount(count))
      .catch((e) => console.error("Failed to count trash items:", e));
  }, []);

  useEffect(() => {
    refreshTrashCount();
  }, [refreshTrashCount]);

  const searchEffectInitializedRef = useRef(false);
  const selectAllRequestRef = useRef(0);

  // kind→文案键映射收口在 domain/mediaKind.ts，本页只负责 t() 取值。
  const typeFilterLabel = useCallback(
    (kind: ResourceTypeFilter) => kind === "all" ? t("resources.typeAll") : t(RESOURCE_MEDIA_KIND_LABEL_KEYS[kind]),
    [t],
  );
  // 卡片回调保持引用稳定：ResourceCard 已 memo，内联箭头函数会让 memo 失效。
  const cardTypeLabel = useCallback(
    (kind: ResourceMediaKindLabel) => t(RESOURCE_MEDIA_KIND_LABEL_KEYS[kind]),
    [t],
  );
  // 分组浏览的本地排序（最新/最旧）。「全部」视图按内容排序偏好展示，控件隐藏。
  const [sortOrderLocal, setSortOrderLocal] = useState<"newest" | "oldest">("newest");
  const sortOptions = useMemo(() => ([
    { value: "newest", label: t("resources.sortNewest") },
    { value: "oldest", label: t("resources.sortOldest") },
  ]), [t]);

  const showFeedback = useCallback((next: "deleteFailed" | "deletedWithMissing" | "openFailed") => {
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

  // 详情子系统：详情记录状态与打开/关闭（history 联动）、滚动记忆恢复、
  // Esc 关闭、单条删除确认收口于 useResourceDetail；删除通道、确认框、
  // 反馈与列表滚动容器经参数注入。
  const {
    detailRecord,
    setDetailRecord,
    detailRecordId,
    closeDetail,
    openDetail,
    handleDeleteRecord,
  } = useResourceDetail({
    records,
    deleteRecord,
    setConfirmState,
    showFeedback,
    setMissingCount,
    resourceListRef,
  });

  // 分组列表加载/库修订号对账/资源库路径子系统收口于 useResourceGroupSync；
  // 分组数据与库路径状态自持，浏览态（resourceGroup）与列表重载经参数注入。
  const {
    resourceGroups,
    setResourceGroups,
    resourceGroupsLoading,
    resourceGroupsError,
    setResourceGroupsError,
    loadResourceGroups,
    resourceLibraryPath,
    resourceLibraryPathLoading,
    resourceLibraryPathChanging,
    resourceLibraryPathError,
    handleChangeResourceLibraryPath,
  } = useResourceGroupSync({
    resourceGroup,
    loadRecords,
    refreshTrashCount,
    setStoreResourceGroup,
    resourceListRef,
  });

  useEffect(() => {
    setSearch("");
    setStoreResourceGroup(null);
    init("resources");
  }, [init, setSearch, setStoreResourceGroup]);

  useEffect(() => {
    if (!resourceSettingsOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (resourceSettingsPopoverRef.current?.contains(target)) return;
      if (resourceSettingsButtonRef.current?.contains(target)) return;
      setResourceSettingsOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [resourceSettingsOpen]);
  useEscapeKey(() => setResourceSettingsOpen(false), resourceSettingsOpen);

  useEffect(() => {
    if (!searchEffectInitializedRef.current) {
      searchEffectInitializedRef.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      void loadRecords(false, "resources", resourceGroup);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [loadRecords, resourceGroup, search]);

  const filteredRecords = useMemo(() => {
    const next = records.filter((record) => (
      isResourceRecord(record)
      && (typeFilter === "missing"
        ? Boolean(record.resource_missing)
        : matchesResourceType(record, typeFilter))
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

  // 缺失追溯与清理子系统：缺失计数/追溯对话框/清理确认/复查通知自持；
  // 记录列表、详情修补、删除通道、批量选择取消与反馈、库路径与设置
  // 入口经参数注入。
  const {
    missingAllCount,
    traceRecord,
    cleanupOpen,
    missingRecheckRunning,
    runMissingRecheck,
    openMissingCleanup,
    handleTraceCard,
    handleTraceDetail,
    traceDialogElement,
    cleanupDialogElement,
    missingNoticeElement,
  } = useResourceMissingTrace({
    records,
    setDetailRecord,
    deleteRecords,
    cancelResourceSelection,
    setMissingCount,
    showFeedback,
    resourceLibraryPath,
    setResourceSettingsOpen,
  });

  // 「缺失」筛选下的记录被追溯/清理/自动恢复清零后，chip 会消失，
  // 筛选状态跟着退回「全部」，避免停留在无提示的空视图。
  useEffect(() => {
    if (typeFilter === "missing" && !loading && missingAllCount === 0) {
      setTypeFilter("all");
    }
  }, [typeFilter, loading, missingAllCount]);

  // 移动子系统：移动入口（卡片/批量/详情）、对话框状态机、确认修补
  // 详情记录、成功反馈条与对话框 JSX 收口于 useResourceMove。
  const {
    moveDialog,
    openResourceMove,
    handleMoveCard,
    moveDialogElement,
    moveFeedbackElement,
  } = useResourceMove({
    filteredRecords,
    detailRecord,
    setDetailRecord,
    cancelResourceSelection,
    feedbackTimerRef,
    resourceGroups,
  });

  // 视图模型与分列都 memo 化：避免任意一次无关 state 变化触发全量重建
  // （buildRecordView 每卡一次）导致整页卡片级重渲。
  const recordLocale = useRecordLocale();
  const resourceViews = useMemo(() => {
    const views = new Map<string, RecordView>();
    for (const record of filteredRecords) {
      views.set(record.id, buildRecordView(record, { locale: recordLocale }));
    }
    return views;
  }, [filteredRecords, recordLocale]);
  // 列数随列表宽度动态变化（最少两列）；卡片大小设置改变最小列宽槽位，
  // 紧凑档同宽容纳更多列。三页共用 hook，观察与钳制集中在其中。
  const columnCount = useCardColumns(listElement, cardSize);
  const columns = useMemo(
    () => splitResourceColumns(filteredRecords, columnCount),
    [filteredRecords, columnCount],
  );

  // 统一的「回到顶部」：批量选择模式下隐藏。
  const backToTop = useBackToTop({ enabled: !isSelecting });

  // 方向键导航：瀑布流按列分组（上下列内移动、左右跨列同位）。
  const columnsRef = useRef<HTMLDivElement>(null);
  const arrowNav = useArrowKeyNav({
    containerRef: columnsRef,
    itemSelector: ".resource-card",
    columnar: true,
    columnSelector: ".resource-column",
  });

  const handleSearchChange = useCallback((value: string) => {
    cancelResourceSelection();
    setSearch(value);
  }, [cancelResourceSelection, setSearch]);

  const handleSelectType = useCallback((next: ResourcePageTypeFilter) => {
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

  useEffect(() => {
    if (
      resourceGroup === null
      || resourceGroup === ""
      || resourceGroupsLoading
      || findResourceFolder(resourceFolderGroups, resourceGroup)
    ) {
      return;
    }
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
    setStoreResourceGroup(name);
  }, [cancelResourceSelection, setStoreResourceGroup]);

  // 工程视图下工具行搜索框联动跨实体搜索（300ms 防抖）；文件视图仍走
  // 原记录搜索，工程结果清空。
  useEffect(() => {
    if (projectView !== "project") {
      if (searchResults.length > 0) void clearProjectSearch("");
      return;
    }
    const timer = window.setTimeout(() => {
      void runProjectSearch(search);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [projectView, search, runProjectSearch, clearProjectSearch, searchResults.length]);

  // 工程侧「在资源库中显示」：切回文件视图并定位到素材所在分组
  // （path 首段；库根文件为未分组）。分组级定位，卡片级高亮后续打磨。
  const locateRequest = useProjectStore((state) => state.locateRequest);
  useEffect(() => {
    if (!locateRequest) return;
    const group = locateRequest.path.split("/")[0] ?? "";
    handleSelectResourceGroup(group || null);
    // 按文件名（去扩展名）过滤列表，目标文件立即可见；清空搜索即回全组。
    const fileName = locateRequest.path.split("/").pop() ?? "";
    const stem = fileName.replace(/\.[^.]+$/, "");
    if (stem) setSearch(stem);
  }, [locateRequest, handleSelectResourceGroup, setSearch]);

  // 分组管理子系统（对话框状态机/树形派生/CRUD/排序持久化）收口于
  // useResourceGroupAdmin；浏览态与加载通道由主组件注入。
  const {
    resourceGroupManageOpen,
    setResourceGroupManageOpen,
    resourceGroupDialog,
    setResourceGroupDialog,
    resourceGroupName,
    setResourceGroupName,
    resourceGroupSaving,
    resourceGroupMove,
    setResourceGroupMove,
    movingGroup,
    movingGroupError,
    setMovingGroupError,
    groupParentMap,
    manageRows,
    groupMoveRows,
    activeGroupRow,
    activeGroupRowWidth,
    handleManageRowDragStart,
    setActiveGroupRowId,
    setActiveGroupRowWidth,
    openNewResourceGroup,
    openRenameResourceGroup,
    toggleGroupCollapsed,
    collapsedGroupPaths,
    openGroupMove,
    handleMoveGroupConfirm,
    handleSaveResourceGroup,
    handleOpenResourceGroup,
    handleReorderTopGroups,
    handleReorderManageRows,
    handleDeleteResourceGroup,
  } = useResourceGroupAdmin({
    resourceGroups,
    setResourceGroups,
    resourceGroup,
    setStoreResourceGroup,
    loadResourceGroups,
    loadRecords,
    setConfirmState,
    setResourceGroupsError,
  });

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
            && (typeFilter === "missing"
              ? Boolean(record.resource_missing)
              : matchesResourceType(record, typeFilter))
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
      hint: t("resources.confirmDeleteHint"),
      onConfirm: async () => {
        setDeletingSelected(true);
        try {
          const summary = await deleteRecords(ids);
          cancelResourceSelection();
          if (summary && summary.filesAlreadyMissing > 0) {
            setMissingCount(summary.filesAlreadyMissing);
            showFeedback("deletedWithMissing");
          }
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

  // 批量选择模式下按 Delete 键等同操作条删除按钮：复用同一确认流程；
  // 焦点在输入框、详情页或任一对话框打开时不响应。
  useEffect(() => {
    if (!isSelecting || selectedCount === 0) return;
    if (projectView !== "file" || trashOpen || detailRecordId) return;
    if (confirmState || moveDialog || cleanupOpen || traceRecord || resourceGroupManageOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" || event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      handleDeleteSelected();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    cleanupOpen,
    confirmState,
    detailRecordId,
    handleDeleteSelected,
    isSelecting,
    moveDialog,
    projectView,
    resourceGroupManageOpen,
    selectedCount,
    traceRecord,
    trashOpen,
  ]);

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
      hint={confirmState.hint}
      onConfirm={confirmState.onConfirm}
      onCancel={() => setConfirmState(null)}
    />
  ) : null;

  if (detailRecord) {
    return (
      <>
        <ResourceDetailPage
          record={detailRecord}
          typeLabel={cardTypeLabel}
          onBack={closeDetail}
          onDelete={handleDeleteRecord}
          onRecordUpdated={setDetailRecord}
          onMoveRecord={(record) => openResourceMove([record.id])}
          onTrace={handleTraceDetail}
        />
        {confirmDialog}
        {moveDialogElement}
        {moveFeedbackElement}
        {traceDialogElement}
        {cleanupDialogElement}
      </>
    );
  }

  return (
    <div className="resource-library-page">
      {/* 回收站视图整条隐藏库工具栏（搜索/库设置/新建均与场景无关，
          回收站面板自带完整头部：返回/标题计数/选择/清空）。 */}
      {!trashOpen && (
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
            className={`resource-secondary-button resource-trash-button${trashOpen ? " active" : ""}`}
            onClick={() => setTrashOpen((open) => !open)}
            aria-pressed={trashOpen}
          >
            {Icons.delete}
            <span>{t("resources.trashTitle")}</span>
            {trashCount > 0 && <span className="resource-trash-badge">{trashCount}</span>}
          </button>
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
      )}

      {/* 文件视图 / 工程视图切换：与工具行共用，回收站全屏时隐藏。
          文件视图的分组条上移到切换按钮同一行（children），省一行纵向空间。 */}
      {!trashOpen && (
        <ProjectViewSwitch>
          {projectView === "file" && (
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
          )}
        </ProjectViewSwitch>
      )}

      {!trashOpen && projectView === "project" && search.trim() !== "" && (
        <ProjectSearchResults
          search={search}
          onJumped={() => {
            setSearch("");
          }}
        />
      )}

      {resourceSettingsOpen && !trashOpen && (
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
          <div className="resource-card-size-section">
            <div className="resource-card-size-label">{t("resources.cardSize")}</div>
            <div className="resource-card-size-row">
              <span className="resource-card-size-end">{t("resources.cardSizeCompact")}</span>
              <input
                type="range"
                className="resource-card-size-slider"
                min={RESOURCE_CARD_SIZE_MIN}
                max={RESOURCE_CARD_SIZE_MAX}
                step={10}
                value={cardSize}
                onChange={(event) => handleCardSizeChange(Number(event.target.value))}
                aria-label={t("resources.cardSize")}
              />
              <span className="resource-card-size-end">{t("resources.cardSizeSpacious")}</span>
              <span className="resource-card-size-value">{cardSize}px</span>
            </div>
            <p className="resource-card-size-hint">{t("resources.cardSizeHint")}</p>
          </div>
        </section>
      )}

      {trashOpen && <TrashPanel onBack={() => setTrashOpen(false)} />}

      {!trashOpen && projectView === "file" && (
        <>
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
          {missingAllCount > 0 && (
            <button
              type="button"
              className={`resource-filter-chip is-missing${typeFilter === "missing" ? " active" : ""}`}
              onClick={() => handleSelectType("missing")}
              aria-pressed={typeFilter === "missing"}
            >
              <span aria-hidden="true">⚠</span>
              {t("resources.missingFilterChip", { count: missingAllCount })}
            </button>
          )}
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

      {/* 缺失筛选视图的操作条：重新检查（实时对账救回）与批量清理入口。 */}
      {typeFilter === "missing" && !isSelecting && (
        <div className="resource-missing-bar" role="status">
          <span className="resource-missing-bar-mark" aria-hidden="true" />
          <span>{t("resources.missingBarText", { count: missingAllCount })}</span>
          <span className="resource-missing-bar-grow" />
          <button
            type="button"
            className="resource-missing-bar-btn"
            disabled={missingRecheckRunning}
            onClick={() => void runMissingRecheck()}
          >
            {Icons.recent}
            <span>{missingRecheckRunning ? t("resources.rechecking") : t("resources.recheck")}</span>
          </button>
          <button
            type="button"
            className="resource-missing-bar-btn is-danger"
            disabled={missingAllCount === 0}
            onClick={() => void openMissingCleanup()}
          >
            {Icons.delete}
            <span>{t("resources.cleanAllMissing")}</span>
          </button>
        </div>
      )}
        </>
      )}

      {/* 分组三对话框（管理/新建改名/移动目标树）收口于 ResourceGroupDialogs。 */}
      <ResourceGroupDialogs
        admin={{
          resourceGroupManageOpen,
          setResourceGroupManageOpen,
          resourceGroupDialog,
          setResourceGroupDialog,
          resourceGroupName,
          setResourceGroupName,
          resourceGroupSaving,
          resourceGroupMove,
          setResourceGroupMove,
          movingGroup,
          movingGroupError,
          setMovingGroupError,
          groupParentMap,
          manageRows,
          groupMoveRows,
          collapsedGroupPaths,
          activeGroupRow,
          activeGroupRowWidth,
          handleManageRowDragStart,
          setActiveGroupRowId,
          setActiveGroupRowWidth,
          openNewResourceGroup,
          openRenameResourceGroup,
          toggleGroupCollapsed,
          openGroupMove,
          handleMoveGroupConfirm,
          handleSaveResourceGroup,
          handleOpenResourceGroup,
          handleReorderTopGroups,
          handleReorderManageRows,
          handleDeleteResourceGroup,
        }}
        resourceGroupsError={resourceGroupsError}
      />

      {confirmDialog}

      {projectView === "project" && !trashOpen && <ProjectView />}

      {!trashOpen && projectView === "file" && (
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

        {loading && records.length === 0 && !loadedOnce ? (
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
              ref={columnsRef}
              onKeyDown={arrowNav}
              style={{
                gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                // 卡片整体缩放：字号/内边距随滑块等比（预览区经 aspect-ratio 天然随列宽缩放）。
                "--card-scale": resourceCardScale(cardSize),
              } as CSSProperties}
            >
              {columns.map((column, columnIndex) => (
                <div className="resource-column" key={`column-${columnIndex}`}>
                  {column.map((record) => {
                    const view = resourceViews.get(record.id);
                    if (!view) return null;
                    return (
                    <div className="resource-item" key={record.id}>
                      <ResourceCard
                        view={view}
                        search={search}
                        typeLabel={cardTypeLabel}
                        selectionMode={isSelecting}
                        selected={isSelected(view.id)}
                        showGroupTag={resourceGroup === null}
                        showUsageBadge={contentSort === "count" && resourceGroup === null}
                        onOpenDetail={openDetail}
                        onDelete={handleDeleteRecord}
                        onToggleSelected={toggleSelected}
                        onMove={handleMoveCard}
                        onTrace={handleTraceCard}
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
      )}

      {feedback && (
        <div className={`resource-feedback ${feedback === "deletedWithMissing" ? "warn" : "error"}`} role="status" aria-live="polite">
          {feedback === "deleteFailed"
            ? t("resources.deleteFailed")
            : feedback === "deletedWithMissing"
              ? t("resources.deletedWithMissing", { count: missingCount })
              : t("resources.openFailed")}
        </div>
      )}
      {moveDialogElement}
      {moveFeedbackElement}
      {missingNoticeElement}
      {traceDialogElement}
      {cleanupDialogElement}
    </div>
  );
}
