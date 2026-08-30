import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { usePhraseStore, isImageFilePath } from "../../stores/phraseStore";
import type { QuickInputFileSelection } from "../../stores/phraseStore";

const filenameFromPath = (path: string) => path.replace(/\\/g, "/").split("/").pop() || path;
import { useSettingsStore } from "../../stores/settingsStore";
import SearchInput from "../../components/SearchInput";
import { GroupChips } from "./GroupChips";
import { PhraseList } from "./PhraseList";
import { GroupDialog } from "./GroupDialog";
import { PhraseDialog } from "./PhraseDialog";
import { ManageGroupsDialog } from "./ManageGroupsDialog";
import type { Phrase } from "../../types";
import { shouldUseTerminalPasteForMouseTrigger } from "../../utils/pasteMode";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensors,
  useSensor,
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
    onConfirm: () => void | Promise<void>;
  } | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");

  const {
    groups,
    phrases,
    selectedGroupId,
    search,
    loading,
    setSearch,
    setSelectedGroup,
    init,
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
    pastePhrase,
    pastePhraseTerminal,
    selectQuickInputFile,
    getQuickInputFileInfo,
    getQuickInputFileLimit,
  } = usePhraseStore();
  const pasteLeftClick = useSettingsStore((s) => s.pasteLeftClick);

  useEffect(() => {
    init();
  }, []);

  useEffect(() => {
    if (selectedGroupId) {
      loadPhrases(selectedGroupId);
    }
  }, [selectedGroupId]);

  useEffect(() => {
    getQuickInputFileLimit()
      .then(setQuickInputFileLimit)
      .catch(() => undefined);
  }, [getQuickInputFileLimit]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor)
  );

  const [activePhraseId, setActivePhraseId] = useState<string | null>(null);
  const [previewPhrases, setPreviewPhrases] = useState<typeof phrases | null>(null);
  const lastPhrasePreviewMoveRef = useRef<string | null>(null);

  const handlePhraseDragStart = useCallback((event: DragStartEvent) => {
    setActivePhraseId(String(event.active.id));
    lastPhrasePreviewMoveRef.current = null;
    setPreviewPhrases(phrases);
  }, [phrases]);

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
        const base = current ?? phrases;
        const next = getDragPreviewOrder(base, active, over);
        return next === base ? current : next;
      });
    },
    [phrases],
  );

  const handlePhraseDragEnd = useCallback(
    () => {
      const finalPreview = previewPhrases;
      setActivePhraseId(null);
      setPreviewPhrases(null);
      lastPhrasePreviewMoveRef.current = null;

      const nextIds = getChangedOrderIds(phrases, finalPreview);
      if (!nextIds) return;

      usePhraseStore.getState().reorderPhrases(nextIds);
    },
    [phrases, previewPhrases],
  );

  const handlePaste = useCallback(
    (p: Phrase) => {
      if (shouldUseTerminalPasteForMouseTrigger(pasteLeftClick, "left")) pastePhraseTerminal(p);
      else pastePhrase(p);
    },
    [pasteLeftClick, pastePhrase, pastePhraseTerminal],
  );

  const handleSecondaryPaste = useCallback(
    (p: Phrase) => {
      if (shouldUseTerminalPasteForMouseTrigger(pasteLeftClick, "right")) pastePhraseTerminal(p);
      else pastePhrase(p);
    },
    [pasteLeftClick, pastePhrase, pastePhraseTerminal],
  );

  const renderedPhrases = previewPhrases ?? phrases;
  const searchedPhrases = useMemo(() => {
    if (!search.trim()) return renderedPhrases;
    const q = search.toLowerCase();
    return renderedPhrases.filter(p =>
      p.content.toLowerCase().includes(q) ||
      (p.title && p.title.toLowerCase().includes(q))
    );
  }, [renderedPhrases, search]);
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
  const activePhrase = activePhraseId ? renderedPhrases.find(p => p.id === activePhraseId) : null;
  const activePhraseBody = activePhrase?.input_type === "file"
    ? filenameFromPath(activePhrase.source_path || activePhrase.content)
    : activePhrase?.content.slice(0, 80);
  const phraseDragOverlay = (
    <DragOverlay dropAnimation={null}>
      {activePhrase ? (
        <div className="notification phrase-card drag-overlay-card">
          <div className="notibar" />
          <div className="noticontent">
            <div className="notibody phrase-card-body">{activePhraseBody}</div>
            <div className="notititle phrase-card-footer">
              <span className="phrase-card-remark">{activePhrase.title}</span>
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

  const openEditPhrase = (p: Phrase) => {
    setEditingId(p.id);
    setEditingFilePhrase(p.input_type === "file");
    setPhraseRemark(p.title);
    setPhraseContent(p.input_type === "file" ? "" : p.content);
    setPhraseFilePath("");
    setPhraseFileName(p.input_type === "file" ? filenameFromPath(p.source_path || p.content) : "");
    setPhraseFileSize(p.input_type === "file" ? p.file_size : 0);
    // 编辑时仅预览原文件（source_path 为原始绝对路径）；不写入 phraseFilePath，
    // 避免保存时被误当作"更换文件"。
    const sourcePath = p.source_path || p.content;
    setPhraseFilePreviewSrc(
      p.input_type === "file" && isImageFilePath(sourcePath) ? convertFileSrc(sourcePath) : null,
    );
    setPhraseError(false);
    setPhraseErrorMessage("");
    setPhraseDialogOpen(true);
  };

  const applyQuickInputFile = useCallback((file: QuickInputFileSelection) => {
    const fileName = filenameFromPath(file.path);
    setPhraseFilePath(file.path);
    setPhraseFileName(fileName);
    setPhraseFileSize(file.file_size);
    setPhraseFilePreviewSrc(isImageFilePath(file.path) ? convertFileSrc(file.path) : null);
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
      onConfirm: async () => {
        await deleteGroup(id);
        if (groups.length <= 1) {
          setManageGroupsOpen(false);
        }
      },
    });
  };

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
        onAddPhrase={openNewPhrase}
        selectionMode={isSelecting}
        canSelect={searchedPhrases.length > 0}
        onStartSelection={startSelection}
        onReorderGroups={(ids) => usePhraseStore.getState().reorderGroups(ids)}
      />

      {isSelecting && (
        <BatchSelectionBar
          selectedCount={selectedCount}
          totalCount={visiblePhraseIds.length}
          allSelected={allVisibleSelected}
          onToggleAll={toggleAllVisible}
          onDelete={handleDeleteSelected}
          onCancel={exitSelection}
        />
      )}

      <DndContext sensors={sensors} onDragStart={handlePhraseDragStart} onDragOver={handlePhraseDragOver} onDragEnd={handlePhraseDragEnd} onDragCancel={handlePhraseDragCancel} modifiers={[restrictToVerticalAxis]}>
        <SortableContext items={renderedPhrases.map(p => p.id)} strategy={verticalListSortingStrategy}>
          <PhraseList
            phrases={searchedPhrases}
            loading={loading}
            selectedGroupId={selectedGroupId}
            search={search}
            onPaste={handlePaste}
            onSecondaryPaste={handleSecondaryPaste}
            onEdit={openEditPhrase}
            onDelete={handleDeletePhrase}
            selectionMode={isSelecting}
            isSelected={isSelected}
            onToggleSelected={toggleSelected}
          />
        </SortableContext>
        {createPortal(phraseDragOverlay, document.body)}
      </DndContext>

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
                  const fn = confirmState.onConfirm;
                  setConfirmState(null);
                  void fn();
                }}
              >
                {t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
