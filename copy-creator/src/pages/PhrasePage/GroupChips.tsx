import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";
import {
  DndContext,
  PointerSensor,
  useSensors,
  useSensor,
  closestCenter,
  DragOverlay,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  arrayMove,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";

interface PhraseGroup {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface GroupChipsProps {
  groups: PhraseGroup[];
  selectedGroupId: string | null;
  onSelectGroup: (id: string) => void;
  onAddGroup: () => void;
  onManageGroups: () => void;
  onAddPhrase: () => void;
  onReorderGroups: (ids: string[]) => void;
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
  onAddGroup,
  onManageGroups,
  onAddPhrase,
  onReorderGroups,
}: GroupChipsProps) {
  const { t } = useTranslation();
  const groupsScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = groupsScrollRef.current;
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );

  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);

  const handleGroupDragStart = (event: DragStartEvent) => {
    setActiveGroupId(String(event.active.id));
  };

  const handleGroupDragCancel = () => {
    setActiveGroupId(null);
  };

  const handleGroupDragEnd = (event: DragEndEvent, groups: PhraseGroup[]) => {
    setActiveGroupId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = groups.findIndex((g) => g.id === active.id);
    const newIndex = groups.findIndex((g) => g.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const newOrder = arrayMove(groups, oldIndex, newIndex);
    onReorderGroups(newOrder.map((g) => g.id));
  };

  const activeGroup = activeGroupId ? groups.find(g => g.id === activeGroupId) : null;

  return (
    <div className="phrase-groups">
      <div className="groups-scroll" ref={groupsScrollRef}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleGroupDragStart} onDragEnd={(e) => handleGroupDragEnd(e, groups)} onDragCancel={handleGroupDragCancel} modifiers={[restrictToHorizontalAxis]}>
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
          <DragOverlay dropAnimation={null}>
            {activeGroup ? (
              <div className={`group-chip active drag-overlay-chip`}>
                {activeGroup.name}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
      <button className="group-add-btn" onClick={onAddGroup}>
        {Icons.add}
      </button>
      <button className="group-add-btn" onClick={onManageGroups} title={t("phrases.manageGroups")}>
        {Icons.edit}
      </button>
      {selectedGroupId && (
        <button className="phrase-add-btn" onClick={onAddPhrase}>
          {Icons.add}
          <span>{t("phrases.newPhrase")}</span>
        </button>
      )}
    </div>
  );
}
