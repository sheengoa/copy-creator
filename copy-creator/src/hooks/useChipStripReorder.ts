import { useCallback, useState } from "react";
import { PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";

/**
 * 分组 chip 条的横向拖拽排序逻辑（快捷输入 / 资源分组条共用）：
 * 与 dnd-kit 的 DndContext 配合，拖拽结束按新顺序回调 ids；
 * activeId/activeItem 供拖拽虚影展示。
 */
export function useChipStripReorder<T>(
  items: readonly T[],
  getId: (item: T) => string,
  onReorder: (orderedIds: string[]) => void,
) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((item) => getId(item) === active.id);
    const newIndex = items.findIndex((item) => getId(item) === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove([...items], oldIndex, newIndex).map(getId));
  }, [items, getId, onReorder]);

  const activeItem = activeId
    ? items.find((item) => getId(item) === activeId) ?? null
    : null;

  return { activeId, activeItem, sensors, handleDragStart, handleDragCancel, handleDragEnd };
}
