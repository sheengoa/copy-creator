import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { getResourceFileThumbnail } from "../../domain/mediaAssets";
import { useRefreshOnShow } from "../../hooks/useRefreshOnShow";
import {
  usePhraseStore,
  isImageFilePath,
  ALL_PHRASES_GROUP_ID,
} from "../../stores/phraseStore";
import type { QuickInputFileSelection } from "../../stores/phraseStore";
import { fileNameFromPath } from "../../domain/fileName";
import { type ResourceMediaKind } from "../../domain/mediaKind";

import { ConfirmDialog } from "../../components/ConfirmDialog";
import SearchInput from "../../components/SearchInput";
import { GroupChips } from "./GroupChips";
import { PhraseList } from "./PhraseList";
import ResourceDetailPage from "../ResourcePage/ResourceDetailPage";
import { GroupDialog } from "./GroupDialog";
import { PhraseDialog } from "./PhraseDialog";
import { ManageGroupsDialog } from "./ManageGroupsDialog";
import type { Phrase } from "../../types";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensors,
  useSensor,
  DragOverlay,
  closestCenter,
} from "@dnd-kit/core";
import type { DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { getChangedOrderIds, getDragPreviewOrder } from "../../utils/reorderPreview";
import BatchSelectionBar from "../../components/BatchSelectionBar";
import { useMultiSelect } from "../../hooks/useMultiSelect";
import { useCardColumns } from "../../hooks/useCardColumns";
import { COMPACT_CARD_MIN_WIDTH, restoreInterleavedOrder, splitResourceColumns } from "../../utils/cardGrid";
import { BackToTopButton } from "../../components/BackToTop";
import { useBackToTop } from "../../hooks/useBackToTop";

export default function PhrasePage() {
  const { t } = useTranslation();
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [phraseDialogOpen, setPhraseDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [phraseRemark, setPhraseRemark] = useState("");
  const [phraseContent, setPhraseContent] = useState("");
  /** 编辑中的短语是否为文件类型：未更换文件时保存只更新备注。 */
  const [editingFilePhrase, setEditingFilePhrase] = useState(false);
  const [phraseFilePath, setPhraseFilePath] = useState("");
  const [phraseFileName, setPhraseFileName] = useState("");
  const [phraseFileSize, setPhraseFileSize] = useState(0);
  const [phraseFilePreviewSrc, setPhraseFilePreviewSrc] = useState<string | null>(null);
  const [phraseErrorMessage, setPhraseErrorMessage] = useState("");
  const [quickInputFileLimit, setQuickInputFileLimit] = useState(50 * 1024 * 1024);
  const [phraseError, setPhraseError] = useState(false);
  const [manageGroupsOpen, setManageGroupsOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<{
    message: string;
    hint?: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");

  // 选择器订阅：仅这些字段变化才重渲整页。
  const {
    groups,
    phrases,
    selectedGroupId,
    search,
    loading,
    loadedOnce,
    setSearch,
    setSelectedGroup,
    init,
    loadGroups,
    loadPhrases,
    createGroup,
    updateGroup,
    createPhrase,
    createFilePhrase,
    updatePhrase,
    updateFilePhrase,
    deletePhrases,
    deletePhrase,
    deleteGroup,
    selectQuickInputFile,
    getQuickInputFileInfo,
    getQuickInputFileLimit,
    movePhrasesToTop,
  } = usePhraseStore(
    useShallow((s) => ({
      groups: s.groups,
      phrases: s.phrases,
      selectedGroupId: s.selectedGroupId,
      search: s.search,
      loading: s.loading,
      loadedOnce: s.loadedOnce,
      setSearch: s.setSearch,
      setSelectedGroup: s.setSelectedGroup,
      init: s.init,
      loadGroups: s.loadGroups,
      loadPhrases: s.loadPhrases,
      createGroup: s.createGroup,
      updateGroup: s.updateGroup,
      createPhrase: s.createPhrase,
      createFilePhrase: s.createFilePhrase,
      updatePhrase: s.updatePhrase,
      updateFilePhrase: s.updateFilePhrase,
      deletePhrases: s.deletePhrases,
      deletePhrase: s.deletePhrase,
      deleteGroup: s.deleteGroup,
      selectQuickInputFile: s.selectQuickInputFile,
      getQuickInputFileInfo: s.getQuickInputFileInfo,
      getQuickInputFileLimit: s.getQuickInputFileLimit,
      movePhrasesToTop: s.movePhrasesToTop,
    })),
  );
  // 媒体 kind 文案（video/audio 等）：与资源卡同一组 resources.type* 键。
  const getKindLabel = useCallback(
    (kind: ResourceMediaKind): string =>
      t(
        kind === "text" ? "resources.typeText"
          : kind === "image" ? "resources.typeImage"
            : kind === "video" ? "resources.typeVideo"
              : kind === "audio" ? "resources.typeAudio"
                : "resources.typeFile",
      ),
    [t],
  );

  // 详情视图：存 id 而非短语对象，列表重载（拖拽/置顶）后按 id 从最新
  // 数据解析。快捷输入复用资源库详情页形态（hideResourceOps），短语
  // 适配成 ClipboardRecord：文本短语走 segments 全文，文件短语按扩展名
  // 渲染媒体/文本文件（受管副本在存储目录下，命令链同资源文件）。
  const [viewingPhraseId, setViewingPhraseId] = useState<string | null>(null);
  const viewingPhrase = useMemo(
    () => (viewingPhraseId ? phrases.find((p) => p.id === viewingPhraseId) ?? null : null),
    [phrases, viewingPhraseId],
  );
  const viewingRecord = useMemo(() => {
    if (!viewingPhrase) return null;
    return viewingPhrase.input_type === "file"
      ? {
          id: viewingPhrase.id,
          type: "file" as const,
          content: viewingPhrase.content,
          source_app: "",
          created_at: viewingPhrase.created_at,
        }
      : {
          id: viewingPhrase.id,
          type: "text" as const,
          content: viewingPhrase.content,
          content_length: viewingPhrase.content.length,
          source_app: "",
          created_at: viewingPhrase.created_at,
        };
  }, [viewingPhrase]);
  const openViewer = useCallback((p: Phrase) => {
    setViewingPhraseId(p.id);
  }, [setViewingPhraseId]);

  useEffect(() => {
    // zustand action 引用恒定，加入依赖仅为满足 exhaustive-deps。
    init();
  }, [init]);

  useEffect(() => {
    if (selectedGroupId) {
      loadPhrases(selectedGroupId);
    }
  }, [selectedGroupId, loadPhrases]);

  // 窗口从隐藏恢复显示时重载分组与当前分组短语：兜底隐藏期间丢失或被
  // WebView 节流的刷新事件（短语可能在其他窗口被增删改）。与剪切板/
  // 资源两页的 useRefreshOnShow 同款兜底。
  useRefreshOnShow(
    useCallback(() => {
      void loadGroups();
      if (selectedGroupId) {
        void loadPhrases(selectedGroupId);
      }
    }, [loadGroups, loadPhrases, selectedGroupId]),
  );

  useEffect(() => {
    getQuickInputFileLimit()
      .then(setQuickInputFileLimit)
      .catch(() => undefined);
  }, [getQuickInputFileLimit]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // 键盘拖拽用 sortable 官方 getter：一次方向键直接跳到目标槽位矩形。
    // 默认 getter 每按挪 25px——旧纵向列表行行紧贴尚可达成，瀑布流网格
    // 跨列 300+px 永远走不到，键盘排序形同虚设。
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // 「全部」视图按最近使用排序，拖拽排序仅分组视图可用：以无传感器禁用拖拽。
  const noDragSensors = useSensors();

  const [activePhraseId, setActivePhraseId] = useState<string | null>(null);
  const [previewPhrases, setPreviewPhrases] = useState<Phrase[] | null>(null);
  const lastPhrasePreviewMoveRef = useRef<string | null>(null);

  const searchedPhrases = useMemo(() => {
    if (!search.trim()) return phrases;
    const q = search.toLowerCase();
    return phrases.filter(p =>
      p.content.toLowerCase().includes(q) ||
      (p.title && p.title.toLowerCase().includes(q))
    );
  }, [phrases, search]);
  const visiblePhraseIds = useMemo(
    () => searchedPhrases.map((phrase) => phrase.id),
    [searchedPhrases],
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
  } = useMultiSelect(visiblePhraseIds);
  // 统一的「回到顶部」：监视快捷输入列表滚动容器，批量选择模式下隐藏。
  const backToTop = useBackToTop({ enabled: !isSelecting });
  const [phraseListElement, setPhraseListElement] = useState<HTMLElement | null>(null);
  // 卡片网格列数：随列表宽度动态变化（与资源库/剪切板同一 hook 同几何）。
  const columnCount = useCardColumns(phraseListElement, COMPACT_CARD_MIN_WIDTH);
  const handlePhraseListScrollRef = useCallback((el: HTMLElement | null) => {
    backToTop.containerRef(el);
    setPhraseListElement(el);
  }, [backToTop]);
  // 分列瀑布流的 DOM 序（列主序）：渲染序 = SortableContext items 序，
  // 拖拽在此域计算，提交时还原逻辑序（见 handlePhraseDragEnd）。
  const domPhrases = useMemo(
    () => splitResourceColumns(searchedPhrases, columnCount).flat(),
    [searchedPhrases, columnCount],
  );
  const renderedPhrases = previewPhrases ?? domPhrases;

  // 拖拽预览与提交都在「DOM 序」域操作（分列瀑布流的列主序，与
  // SortableContext items / 渲染序一致，rectSorting 才能正确移动）；
  // 结束提交时经 restoreInterleavedOrder 还原回列表逻辑序。
  const handlePhraseDragStart = useCallback((event: DragStartEvent) => {
    setActivePhraseId(String(event.active.id));
    lastPhrasePreviewMoveRef.current = null;
    setPreviewPhrases(domPhrases);
  }, [domPhrases]);

  const handlePhraseDragCancel = useCallback(() => {
    setActivePhraseId(null);
    setPreviewPhrases(null);
    lastPhrasePreviewMoveRef.current = null;
  }, []);

  const handlePhraseDragOver = useCallback(
    (event: DragOverEvent) => {
      if (!event.over) return;

      const active = String(event.active.id);
      const over = String(event.over.id);
      const previewMoveKey = `${active}:${over}`;

      if (lastPhrasePreviewMoveRef.current === previewMoveKey) return;
      lastPhrasePreviewMoveRef.current = previewMoveKey;

      setPreviewPhrases((current) => {
        const base = current ?? domPhrases;
        const next = getDragPreviewOrder(base, active, over);
        return next === base ? current : next;
      });
    },
    [domPhrases],
  );

  const handlePhraseDragEnd = useCallback(
    () => {
      const finalPreview = previewPhrases;
      setActivePhraseId(null);
      setPreviewPhrases(null);
      lastPhrasePreviewMoveRef.current = null;

      const nextDomIds = getChangedOrderIds(domPhrases, finalPreview);
      if (!nextDomIds) return;

      const logicalIds = restoreInterleavedOrder(
        searchedPhrases.map((p) => p.id),
        nextDomIds,
        columnCount,
      );
      usePhraseStore.getState().reorderPhrases(logicalIds);
    },
    [columnCount, domPhrases, searchedPhrases, previewPhrases],
  );



  const activePhrase = activePhraseId ? domPhrases.find(p => p.id === activePhraseId) : null;
  const activePhraseBody = activePhrase?.input_type === "file"
    ? fileNameFromPath(activePhrase.source_path || activePhrase.content)
    : activePhrase?.content.slice(0, 80);
  const phraseDragOverlay = (
    <DragOverlay dropAnimation={null}>
      {activePhrase ? (
        <div className="resource-card phrase-card is-drag-overlay">
          <div className="resource-card-preview">
            <div className="resource-card-text-preview">{activePhraseBody}</div>
          </div>
          <div className="resource-card-body">
            <div className="resource-card-title-row">
              <strong className="resource-card-title">{activePhrase.title}</strong>
            </div>
          </div>
        </div>
      ) : null}
    </DragOverlay>
  );

  const openNewGroup = () => {
    setManageGroupsOpen(false);
    setEditingId(null);
    setGroupName("");
    setGroupDialogOpen(true);
  };

  const handleSaveGroup = async () => {
    if (groupName.trim()) {
      if (editingId) {
        await updateGroup(editingId, groupName.trim());
      } else {
        await createGroup(groupName.trim());
      }
    }
    setGroupDialogOpen(false);
  };

  const openNewPhrase = () => {
    setEditingId(null);
    setEditingFilePhrase(false);
    setPhraseRemark("");
    setPhraseContent("");
    setPhraseFilePath("");
    setPhraseFileName("");
    setPhraseFileSize(0);
    setPhraseFilePreviewSrc(null);
    setPhraseError(false);
    setPhraseErrorMessage("");
    setPhraseDialogOpen(true);
  };

  const applyQuickInputFile = useCallback((file: QuickInputFileSelection) => {
    const fileName = fileNameFromPath(file.path);
    setPhraseFilePath(file.path);
    setPhraseFileName(fileName);
    setPhraseFileSize(file.file_size);
    if (isImageFilePath(file.path)) {
      // 刚挑选、尚未保存的文件不在任何记录里，同样走缩略图命令。
      void getResourceFileThumbnail(file.path, 256)
        .then((base64) => setPhraseFilePreviewSrc(`data:image/png;base64,${base64}`))
        .catch(() => setPhraseFilePreviewSrc(null));
    } else {
      setPhraseFilePreviewSrc(null);
    }
    if (!phraseRemark.trim()) {
      setPhraseRemark(fileName);
    }
  }, [phraseRemark]);

  const handleImportFile = async () => {
    setPhraseError(false);
    setPhraseErrorMessage("");
    try {
      const file = await selectQuickInputFile();
      applyQuickInputFile(file);
    } catch (e) {
      const message = String(e);
      if (message !== "cancelled") {
        setPhraseError(true);
        setPhraseErrorMessage(message);
      }
    }
  };

  const handleDropFile = async (path: string) => {
    setPhraseError(false);
    setPhraseErrorMessage("");
    try {
      const file = await getQuickInputFileInfo(path);
      applyQuickInputFile(file);
    } catch (e) {
      setPhraseError(true);
      setPhraseErrorMessage(String(e));
    }
  };

  const handleRemoveFile = () => {
    setPhraseFilePath("");
    setPhraseFileName("");
    setPhraseFileSize(0);
    setPhraseFilePreviewSrc(null);
  };

  const handleSavePhrase = async () => {
    setPhraseError(false);
    setPhraseErrorMessage("");
    try {
      if (phraseFilePath) {
        // 拖入或导入了新文件：按文件短语保存
        const title = phraseRemark.trim() || phraseFileName;
        if (editingId) {
          await updateFilePhrase(editingId, phraseFilePath, title);
        } else if (selectedGroupId) {
          await createFilePhrase(selectedGroupId, phraseFilePath, title);
        }
      } else if (editingFilePhrase) {
        // 编辑文件短语且未更换文件：仅更新备注
        await updateFilePhrase(editingId!, "", phraseRemark.trim() || phraseFileName);
      } else {
        if (!phraseContent.trim()) {
          setPhraseError(true);
          setPhraseErrorMessage(t("phrases.contentRequired"));
          return;
        }
        if (editingId) {
          await updatePhrase(editingId, phraseRemark.trim(), phraseContent.trim());
        } else if (selectedGroupId) {
          await createPhrase(selectedGroupId, phraseRemark.trim(), phraseContent.trim());
        }
      }
      setPhraseDialogOpen(false);
    } catch (e) {
      setPhraseError(true);
      setPhraseErrorMessage(String(e));
    }
  };

  const openManageGroups = () => {
    setRenameId(null);
    setRenameName("");
    setManageGroupsOpen(true);
  };

  const startRename = (id: string, name: string) => {
    setRenameId(id);
    setRenameName(name);
  };

  const handleRename = async () => {
    if (renameId && renameName.trim()) {
      await updateGroup(renameId, renameName.trim());
    }
    setRenameId(null);
    setRenameName("");
  };

  const handleDeletePhrase = useCallback(
    (id: string) => {
      setConfirmState({
        message: t("phrases.confirmDelete"),
        onConfirm: () => deletePhrase(id),
      });
    },
    [deletePhrase, t],
  );

  const handleDeleteSelected = useCallback(() => {
    if (selectedCount === 0) return;
    const ids = [...selectedIds];
    setConfirmState({
      message: t("phrases.confirmDeleteSelected", { count: ids.length }),
      hint: t("phrases.confirmDeleteHint"),
      onConfirm: async () => {
        await deletePhrases(ids);
        exitSelection();
      },
    });
  }, [deletePhrases, exitSelection, selectedCount, selectedIds, t]);

  const handleSearchChange = useCallback((value: string) => {
    exitSelection();
    setSearch(value);
  }, [exitSelection, setSearch]);

  const handleSelectGroup = useCallback((id: string) => {
    exitSelection();
    setSelectedGroup(id);
  }, [exitSelection, setSelectedGroup]);

  const handleDeleteGroup = (id: string) => {
    setConfirmState({
      message: t("phrases.confirmDeleteGroup"),
      hint: t("phrases.confirmDeleteHint"),
      onConfirm: async () => {
        await deleteGroup(id);
        if (groups.length <= 1) {
          setManageGroupsOpen(false);
        }
      },
    });
  };

  // 「全部」= 跨分组聚合视图：按最近使用排序、显示来源分组标签，
  // 拖拽排序与置顶（使用时间的排序语义）不适用，新建需先落到具体分组。
  const isAllView = selectedGroupId === ALL_PHRASES_GROUP_ID;

  // 详情视图：完全复用资源库详情页形态（hideResourceOps），编辑走本页
  // PhraseDialog（文件短语在详情页只读，备注经编辑弹窗变更）。
  if (viewingPhrase && viewingRecord) {
    return (
      <div className="phrase-page">
        <ResourceDetailPage
          record={viewingRecord}
          typeLabel={getKindLabel}
          onBack={() => setViewingPhraseId(null)}
          onDelete={handleDeletePhrase}
          onRecordUpdated={() => {
            if (selectedGroupId) void loadPhrases(selectedGroupId);
          }}
          hideResourceOps
          onSaveContent={
            viewingPhrase.input_type === "text"
              ? (record, content) => {
                  const phrase = phrases.find((p) => p.id === record.id);
                  if (!phrase) return Promise.reject(new Error("phrase not found"));
                  return updatePhrase(phrase.id, phrase.title, content);
                }
              : undefined
          }
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
    <div className="phrase-page">
      <div className="page-search">
        <SearchInput
          placeholder={t("phrases.search")}
          value={search}
          onChange={handleSearchChange}
        />
      </div>

      <GroupChips
        groups={groups}
        selectedGroupId={selectedGroupId}
        onSelectGroup={handleSelectGroup}
        onManageGroups={openManageGroups}
        onAddPhrase={isAllView ? undefined : openNewPhrase}
        selectionMode={isSelecting}
        canSelect={searchedPhrases.length > 0}
        onStartSelection={startSelection}
        onReorderGroups={(ids) => usePhraseStore.getState().reorderGroups(ids)}
        allViewActive={isAllView}
        onSelectAllView={() => handleSelectGroup(ALL_PHRASES_GROUP_ID)}
        allViewLabel={t("clipboard.all")}
      />

      {isSelecting && (
        <BatchSelectionBar
          selectedCount={selectedCount}
          totalCount={visiblePhraseIds.length}
          allSelected={allVisibleSelected}
          onToggleAll={toggleAllVisible}
          onDelete={handleDeleteSelected}
          onCancel={exitSelection}
          onMoveTop={isAllView ? undefined : () => void movePhrasesToTop([...selectedIds])}
        />
      )}

      {/* 平铺网格拖拽：rectSortingStrategy + 无轴限制（网格内自由换位）；
          collisionDetection=closestCenter——瀑布流卡片互不重叠，默认
          rectIntersection 永远找不到落点（键盘方向键只挪 25px 即停，
          鼠标拖进列间隙也无预览），网格配方的标准选择是最近中心。
          「全部」视图仍无传感器禁拖。 */}
      <DndContext sensors={isAllView ? noDragSensors : sensors} collisionDetection={closestCenter} onDragStart={handlePhraseDragStart} onDragOver={handlePhraseDragOver} onDragEnd={handlePhraseDragEnd} onDragCancel={handlePhraseDragCancel}>
        <SortableContext items={renderedPhrases.map(p => p.id)} strategy={rectSortingStrategy}>
          <PhraseList
            phrases={searchedPhrases}
            loading={loading}
            loadedOnce={loadedOnce}
            selectedGroupId={selectedGroupId}
            search={search}
            columnCount={columnCount}
            scrollRef={handlePhraseListScrollRef}
            navDisabled={activePhraseId !== null}
            onOpenView={openViewer}
            onDelete={handleDeletePhrase}
            onMoveToTop={isAllView ? undefined : (id) => void movePhrasesToTop([id])}
            showGroupTag={isAllView}
            getKindLabel={getKindLabel}
            selectionMode={isSelecting}
            isSelected={isSelected}
            onToggleSelected={toggleSelected}
          />
        </SortableContext>
        {createPortal(phraseDragOverlay, document.body)}
      </DndContext>


      <BackToTopButton
        visible={backToTop.visible}
        onTop={backToTop.scrollToTop}
        label={t("common.backToTop")}
      />

      <GroupDialog
        open={groupDialogOpen}
        editingId={editingId}
        groupName={groupName}
        setGroupName={setGroupName}
        onSave={handleSaveGroup}
        onClose={() => setGroupDialogOpen(false)}
      />

      <PhraseDialog
        open={phraseDialogOpen}
        editingId={editingId}
        editingFilePhrase={editingFilePhrase}
        phraseRemark={phraseRemark}
        phraseContent={phraseContent}
        selectedFileName={phraseFileName}
        selectedFileSize={phraseFileSize}
        selectedFilePreviewSrc={phraseFilePreviewSrc}
        fileLimitBytes={quickInputFileLimit}
        phraseError={phraseError}
        phraseErrorMessage={phraseErrorMessage}
        setPhraseRemark={setPhraseRemark}
        setPhraseContent={(content) => {
          setPhraseContent(content);
          if (content.trim()) {
            setPhraseError(false);
            setPhraseErrorMessage("");
          }
        }}
        onImportFile={handleImportFile}
        onDropFile={handleDropFile}
        onRemoveFile={handleRemoveFile}
        onSave={handleSavePhrase}
        onClose={() => setPhraseDialogOpen(false)}
      />

      <ManageGroupsDialog
        open={manageGroupsOpen}
        groups={groups}
        renameId={renameId}
        renameName={renameName}
        setRenameName={setRenameName}
        onStartRename={startRename}
        onRename={handleRename}
        onDeleteGroup={handleDeleteGroup}
        onClose={() => setManageGroupsOpen(false)}
        onAddGroup={openNewGroup}
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
