import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePhraseStore } from "../../stores/phraseStore";
import SearchInput from "../../components/SearchInput";
import { GroupChips } from "./GroupChips";
import { PhraseList } from "./PhraseList";
import { GroupDialog } from "./GroupDialog";
import { PhraseDialog } from "./PhraseDialog";
import { ManageGroupsDialog } from "./ManageGroupsDialog";
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
import { getChangedOrderIds, getDragPreviewOrder } from "../../utils/reorderPreview";

export default function PhrasePage() {
  const { t } = useTranslation();
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [phraseDialogOpen, setPhraseDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [phraseRemark, setPhraseRemark] = useState("");
  const [phraseContent, setPhraseContent] = useState("");
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
    updatePhrase,
    deletePhrase,
    deleteGroup,
    pastePhrase,
  } = usePhraseStore();

  useEffect(() => {
    init();
  }, []);

  useEffect(() => {
    if (selectedGroupId) {
      loadPhrases(selectedGroupId);
    }
  }, [selectedGroupId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor)
  );

  const [activePhraseId, setActivePhraseId] = useState<string | null>(null);
  const [previewPhrases, setPreviewPhrases] = useState<typeof phrases | null>(null);

  const handlePhraseDragStart = useCallback((event: DragStartEvent) => {
    setActivePhraseId(String(event.active.id));
    setPreviewPhrases(phrases);
  }, [phrases]);

  const handlePhraseDragCancel = useCallback(() => {
    setActivePhraseId(null);
    setPreviewPhrases(null);
  }, []);

  const handlePhraseDragOver = useCallback(
    (event: DragOverEvent) => {
      if (!event.over) return;

      const active = String(event.active.id);
      const over = String(event.over.id);

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

      const nextIds = getChangedOrderIds(phrases, finalPreview);
      if (!nextIds) return;

      usePhraseStore.getState().reorderPhrases(nextIds);
    },
    [phrases, previewPhrases],
  );

  const renderedPhrases = previewPhrases ?? phrases;
  const activePhrase = activePhraseId ? renderedPhrases.find(p => p.id === activePhraseId) : null;

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
    setPhraseError(false);
    setPhraseDialogOpen(true);
  };

  const openEditPhrase = (p: { id: string; title: string; content: string }) => {
    setEditingId(p.id);
    setPhraseRemark(p.title);
    setPhraseContent(p.content);
    setPhraseError(false);
    setPhraseDialogOpen(true);
  };

  const handleSavePhrase = async () => {
    if (!phraseContent.trim()) {
      setPhraseError(true);
      return;
    }
    setPhraseError(false);
    if (editingId) {
      await updatePhrase(editingId, phraseRemark.trim(), phraseContent.trim());
    } else if (selectedGroupId) {
      await createPhrase(selectedGroupId, phraseRemark.trim(), phraseContent.trim());
    }
    setPhraseDialogOpen(false);
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

      <DndContext sensors={sensors} onDragStart={handlePhraseDragStart} onDragOver={handlePhraseDragOver} onDragEnd={handlePhraseDragEnd} onDragCancel={handlePhraseDragCancel}>
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
        <DragOverlay dropAnimation={null}>
          {activePhrase ? (
            <div className="notification phrase-card drag-overlay-card">
              <div className="notibar" />
              <div className="noticontent">
                <div className="notibody phrase-card-body">{activePhrase.content.slice(0, 80)}</div>
                <div className="notititle phrase-card-footer">
                  <span className="phrase-card-remark">{activePhrase.title}</span>
                </div>
              </div>
            </div>
          ) : null}
        </DragOverlay>
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
        phraseError={phraseError}
        setPhraseRemark={setPhraseRemark}
        setPhraseContent={(content) => {
          setPhraseContent(content);
          if (content.trim()) setPhraseError(false);
        }}
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
