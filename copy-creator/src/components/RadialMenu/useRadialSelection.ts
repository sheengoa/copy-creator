// 径向菜单悬停定位与 Shift 加减选：条目 hover 高亮与 shift 多选状态机。
// 自 index.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）；选择态
// ref 由 index 注入（拖拽/切换/收起路径共享同一份实况）。

import { useCallback } from "react";

export function useRadialSelection({
  dragActiveRef,
  nativeDragRef,
  shiftClickSelectionModeRef,
  selectedItemIdsRef,
  selectedItemIdRef,
  setSelectedItemId,
  setSelectedItemIds,
}: {
  dragActiveRef: { current: boolean };
  nativeDragRef: { current: unknown };
  shiftClickSelectionModeRef: { current: boolean };
  selectedItemIdsRef: { current: string[] };
  selectedItemIdRef: { current: string | null };
  setSelectedItemId: (id: string | null) => void;
  setSelectedItemIds: (ids: string[]) => void;
}) {
  const updateHoverFromPoint = useCallback((cssX: number, cssY: number) => {
    if (
      dragActiveRef.current
      || nativeDragRef.current
      || shiftClickSelectionModeRef.current
    ) return;
    const el = document.elementFromPoint(cssX, cssY);
    if (!el) {
      selectedItemIdRef.current = null;
      setSelectedItemId(null);
      return;
    }
    if ((el as HTMLElement).closest("[data-content-preview]")) {
      return;
    }
    const itemEl = (el as HTMLElement).closest("[data-radial-item-id]");
    if (itemEl) {
      const id = itemEl.getAttribute("data-radial-item-id");
      selectedItemIdRef.current = id;
      setSelectedItemId(id);
    } else {
      selectedItemIdRef.current = null;
      setSelectedItemId(null);
    }
  }, [dragActiveRef, nativeDragRef, selectedItemIdRef, setSelectedItemId, shiftClickSelectionModeRef]);

  const selectItemWithShift = useCallback((itemId: string) => {
    shiftClickSelectionModeRef.current = true;
    const nextIds = selectedItemIdsRef.current.includes(itemId)
      ? selectedItemIdsRef.current
      : [...selectedItemIdsRef.current, itemId];
    selectedItemIdsRef.current = nextIds;
    setSelectedItemIds(nextIds);
    selectedItemIdRef.current = itemId;
    setSelectedItemId(itemId);
  }, [selectedItemIdRef, selectedItemIdsRef, setSelectedItemId, setSelectedItemIds, shiftClickSelectionModeRef]);

  const deselectItemWithShift = useCallback((itemId: string) => {
    shiftClickSelectionModeRef.current = true;
    const nextIds = selectedItemIdsRef.current.filter((id) => id !== itemId);
    selectedItemIdsRef.current = nextIds;
    setSelectedItemIds(nextIds);
    if (selectedItemIdRef.current === itemId) {
      selectedItemIdRef.current = null;
      setSelectedItemId(null);
    }
  }, [selectedItemIdRef, selectedItemIdsRef, setSelectedItemId, setSelectedItemIds, shiftClickSelectionModeRef]);

  return { updateHoverFromPoint, selectItemWithShift, deselectItemWithShift };
}
