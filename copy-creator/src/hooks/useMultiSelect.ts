import { useCallback, useMemo, useState } from "react";
import { useEscapeKey } from "./useEscapeKey";

export function useMultiSelect(visibleIds: string[]) {
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const selectedVisibleIds = useMemo(
    () => visibleIds.filter((id) => selectedIds.has(id)),
    [selectedIds, visibleIds],
  );
  const allVisibleSelected =
    visibleIds.length > 0 && selectedVisibleIds.length === visibleIds.length;

  const startSelection = useCallback(() => {
    setSelectedIds(new Set());
    setIsSelecting(true);
  }, []);

  const exitSelection = useCallback(() => {
    setSelectedIds(new Set());
    setIsSelecting(false);
  }, []);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  const toggleAllVisible = useCallback(() => {
    setSelectedIds((current) => {
      const next = new Set(current);
      const shouldClear = visibleIds.length > 0 && visibleIds.every((id) => next.has(id));
      for (const id of visibleIds) {
        if (shouldClear) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, [visibleIds]);

  const selectIds = useCallback((ids: string[]) => {
    setSelectedIds(new Set(ids));
  }, []);

  // Esc 退出多选收口在 useEscapeKey（isSelecting 门控）。
  useEscapeKey(exitSelection, isSelecting);

  return {
    isSelecting,
    selectedIds: selectedVisibleIds,
    selectedCount: selectedVisibleIds.length,
    allVisibleSelected,
    startSelection,
    exitSelection,
    toggleSelected,
    isSelected,
    toggleAllVisible,
    selectIds,
  };
}
