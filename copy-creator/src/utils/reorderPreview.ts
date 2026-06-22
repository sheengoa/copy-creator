import { arrayMove } from "@dnd-kit/sortable";

export type ReorderableItem = {
  id: string;
};

export function getDragPreviewOrder<T extends ReorderableItem>(
  items: T[],
  activeId: string | null,
  overId: string | null,
): T[] {
  if (!activeId || !overId || activeId === overId) return items;

  const oldIndex = items.findIndex((item) => item.id === activeId);
  const newIndex = items.findIndex((item) => item.id === overId);

  if (oldIndex === -1 || newIndex === -1) return items;

  return arrayMove(items, oldIndex, newIndex);
}
