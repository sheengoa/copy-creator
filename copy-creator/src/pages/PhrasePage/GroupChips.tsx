import { useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { Icons } from "../../components/Icons";
import { ChipDragOverlay } from "../../components/ChipDragOverlay";
import { useChipStripReorder } from "../../hooks/useChipStripReorder";
import { useHorizontalWheelScroll } from "../../hooks/useHorizontalWheelScroll";
import type { PhraseGroup } from "../../types";

interface GroupChipsProps {
  groups: PhraseGroup[];
  selectedGroupId: string | null;
  onSelectGroup: (id: string) => void;
  onManageGroups: () => void;
  onAddPhrase?: () => void;
  addPhraseLabel?: string;
  manageGroupsLabel?: string;
  selectionMode: boolean;
  canSelect: boolean;
  onStartSelection: () => void;
  onReorderGroups: (ids: string[]) => void;
  /** 「全部」跨分组视图：固定首位、不参与分组拖拽排序的 chip。 */
  allViewActive: boolean;
  onSelectAllView: () => void;
  allViewLabel: string;
}

function SortableGroupChip({
  group,
  isActive,
  onSelect,
}: {
  group: PhraseGroup;
  isActive: boolean;
  onSelect: (id: string) => void;
}) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: group.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition || "transform 200ms ease",
  };

  return (
    <button
      ref={setNodeRef}
      style={style}
      className={`group-chip${isActive ? " active" : ""}${isDragging ? " is-dragging" : ""}`}
      onClick={() => onSelect(group.id)}
      {...attributes}
      {...listeners}
    >
      {group.name}
    </button>
  );
}

export function GroupChips({
  groups,
  selectedGroupId,
  onSelectGroup,
  onManageGroups,
  onAddPhrase,
  addPhraseLabel,
  manageGroupsLabel,
  selectionMode,
  canSelect,
  onStartSelection,
  onReorderGroups,
  allViewActive,
  onSelectAllView,
  allViewLabel,
}: GroupChipsProps) {
  const { t } = useTranslation();
  const groupsScrollRef = useRef<HTMLDivElement>(null);
  useHorizontalWheelScroll(groupsScrollRef);

  const {
    activeItem: activeGroup,
    sensors,
    handleDragStart,
    handleDragCancel,
    handleDragEnd,
  } = useChipStripReorder(groups, (group) => group.id, onReorderGroups);

  return (
    <div className="phrase-groups">
      <div className="groups-scroll" ref={groupsScrollRef}>
        {/* 「全部」chip 固定首位、置于拖拽上下文之外：不参与分组排序。 */}
        <button
          className={`group-chip group-chip-all${allViewActive ? " active" : ""}`}
          onClick={onSelectAllView}
        >
          {allViewLabel}
        </button>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel} modifiers={[restrictToHorizontalAxis]}>
          <SortableContext items={groups.map(g => g.id)} strategy={horizontalListSortingStrategy}>
            {groups.map((g) => (
              <SortableGroupChip
                key={g.id}
                group={g}
                isActive={g.id === selectedGroupId}
                onSelect={onSelectGroup}
              />
            ))}
          </SortableContext>
          {activeGroup ? <ChipDragOverlay label={activeGroup.name} className="group-chip" /> : null}
        </DndContext>
      </div>
      {!selectionMode && (
        <>
          <button
            className="group-add-btn"
            onClick={onManageGroups}
            title={manageGroupsLabel || t("phrases.manageGroups")}
            aria-label={manageGroupsLabel || t("phrases.manageGroups")}
          >
            {Icons.edit}
          </button>
          {selectedGroupId && onAddPhrase && (
            <button className="phrase-add-btn" onClick={onAddPhrase}>
              {Icons.add}
              <span>{addPhraseLabel || t("phrases.newPhrase")}</span>
            </button>
          )}
          {canSelect && (
            <button className="phrase-add-btn selection-mode-btn" onClick={onStartSelection}>
              {Icons.check}
              <span>{t("common.select")}</span>
            </button>
          )}
        </>
      )}
    </div>
  );
}
