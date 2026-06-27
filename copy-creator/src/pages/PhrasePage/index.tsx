import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { usePhraseStore } from "../../stores/phraseStore";
import SearchInput from "../../components/SearchInput";
import { GroupChips } from "./GroupChips";
import { PhraseList } from "./PhraseList";
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
} from "@dnd-kit/core";
import type { DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { getChangedOrderIds, getDragPreviewOrder } from "../../utils/reorderPreview";

type PhraseInputType = "text" | "file";

const filenameFromPath = (path: string) => path.replace(/\\/g, "/").split("/").pop() || path;

export default function PhrasePage() {
  const { t } = useTranslation();
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [phraseDialogOpen, setPhraseDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [phraseRemark, setPhraseRemark] = useState("");
  const [phraseContent, setPhraseContent] = useState("");
  const [phraseInputType, setPhraseInputType] = useState<PhraseInputType>("text");
  const [phraseFilePath, setPhraseFilePath] = useState("");
  const [phraseFileName, setPhraseFileName] = useState("");
  const [phraseFileSize, setPhraseFileSize] = useState(0);
  const [phraseErrorMessage, setPhraseErrorMessage] = useState("");
  const [quickInputFileLimit, setQuickInputFileLimit] = useState(50 * 1024 * 1024);
  const [phraseError, setPhraseError] = useState(false);
  const [manageGroupsOpen, setManageGroupsOpen] = useState(false);
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
    deletePhrase,
    deleteGroup,
    pastePhrase,
    selectQuickInputFile,
    getQuickInputFileLimit,
  } = usePhraseStore();

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

  const renderedPhrases = previewPhrases ?? phrases;
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
    setPhraseRemark("");
    setPhraseContent("");
    setPhraseInputType("text");
    setPhraseFilePath("");
    setPhraseFileName("");
    setPhraseFileSize(0);
    setPhraseError(false);
    setPhraseErrorMessage("");
    setPhraseDialogOpen(true);
  };

  const openEditPhrase = (p: Phrase) => {
    setEditingId(p.id);
    setPhraseRemark(p.title);
    setPhraseInputType(p.input_type);
    setPhraseContent(p.input_type === "text" ? p.content : "");
    setPhraseFilePath("");
    setPhraseFileName(p.input_type === "file" ? filenameFromPath(p.source_path || p.content) : "");
    setPhraseFileSize(p.input_type === "file" ? p.file_size : 0);
    setPhraseError(false);
    setPhraseErrorMessage("");
    setPhraseDialogOpen(true);
  };

  const handleSelectPhraseFile = async () => {
    setPhraseError(false);
    setPhraseErrorMessage("");
    try {
      const file = await selectQuickInputFile();
      const fileName = filenameFromPath(file.path);
      setPhraseFilePath(file.path);
      setPhraseFileName(fileName);
      setPhraseFileSize(file.file_size);
      if (!phraseRemark.trim()) {
        setPhraseRemark(fileName);
      }
    } catch (e) {
      const message = String(e);
      if (message !== "cancelled") {
        setPhraseError(true);
        setPhraseErrorMessage(message);
      }
    }
  };

  const handleSavePhrase = async () => {
    if (phraseInputType === "text" && !phraseContent.trim()) {
      setPhraseError(true);
      setPhraseErrorMessage(t("phrases.contentRequired"));
      return;
    }
    if (phraseInputType === "file" && !phraseFilePath && !phraseFileName) {
      setPhraseError(true);
      setPhraseErrorMessage(t("phrases.fileRequired"));
      return;
    }
    setPhraseError(false);
    setPhraseErrorMessage("");
    try {
      if (phraseInputType === "text") {
        if (editingId) {
          await updatePhrase(editingId, phraseRemark.trim(), phraseContent.trim());
        } else if (selectedGroupId) {
          await createPhrase(selectedGroupId, phraseRemark.trim(), phraseContent.trim());
        }
      } else {
        const title = phraseRemark.trim() || phraseFileName;
        if (editingId) {
          await updateFilePhrase(editingId, phraseFilePath, title);
        } else if (selectedGroupId) {
          await createFilePhrase(selectedGroupId, phraseFilePath, title);
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

  const handleDeleteGroup = async (id: string) => {
    await deleteGroup(id);
    if (groups.length <= 1) {
      setManageGroupsOpen(false);
    }
  };

  return (
    <div className="phrase-page">
      <div className="page-search">
        <SearchInput
          placeholder={t("phrases.search")}
          value={search}
          onChange={setSearch}
        />
      </div>

      <GroupChips
        groups={groups}
        selectedGroupId={selectedGroupId}
        onSelectGroup={setSelectedGroup}
        onAddGroup={openNewGroup}
        onManageGroups={openManageGroups}
        onAddPhrase={openNewPhrase}
        onReorderGroups={(ids) => usePhraseStore.getState().reorderGroups(ids)}
      />

      <DndContext sensors={sensors} onDragStart={handlePhraseDragStart} onDragOver={handlePhraseDragOver} onDragEnd={handlePhraseDragEnd} onDragCancel={handlePhraseDragCancel} modifiers={[restrictToVerticalAxis]}>
        <SortableContext items={renderedPhrases.map(p => p.id)} strategy={verticalListSortingStrategy}>
          <PhraseList
            phrases={renderedPhrases}
            loading={loading}
            selectedGroupId={selectedGroupId}
            onPaste={pastePhrase}
            onEdit={openEditPhrase}
            onDelete={deletePhrase}
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
        phraseRemark={phraseRemark}
        phraseContent={phraseContent}
        inputType={phraseInputType}
        selectedFileName={phraseFileName}
        selectedFileSize={phraseFileSize}
        fileLimitBytes={quickInputFileLimit}
        phraseError={phraseError}
        phraseErrorMessage={phraseErrorMessage}
        setInputType={setPhraseInputType}
        setPhraseRemark={setPhraseRemark}
        setPhraseContent={(content) => {
          setPhraseContent(content);
          if (content.trim()) {
            setPhraseError(false);
            setPhraseErrorMessage("");
          }
        }}
        onSelectFile={handleSelectPhraseFile}
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
      />
    </div>
  );
}
