// 资源页批量选择子系统：批量选择开关（含全量加载选中的请求序号
// 竞态防护）、选中删除确认与批量态条目取消。
// 自 ResourcePage.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）。
// 多选原语（useMultiSelect 解构面）、全量加载、删除通道、确认框、
// 反馈与缺失计数经 params 注入。

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord } from "../../types";
import type { ClipType, DeleteRecordsSummary } from "../../stores/clipboardStore";
import type { ResourceTypeFilter } from "../../domain/mediaKind";
import { isResourceRecord } from "../../domain/records";
import { matchesResourceType } from "../../domain/mediaKind";

export function useResourceBatchSelection({
  isSelecting,
  allVisibleSelected,
  startSelection,
  exitSelection,
  selectIds,
  toggleAllVisible,
  selectedCount,
  selectedIds,
  typeFilter,
  resourceGroup,
  hasMore,
  loadAllRecords,
  deleteRecords,
  setConfirmState,
  setMissingCount,
  showFeedback,
}: {
  isSelecting: boolean;
  allVisibleSelected: boolean;
  startSelection: () => void;
  exitSelection: () => void;
  selectIds: (ids: string[]) => void;
  toggleAllVisible: () => void;
  selectedCount: number;
  selectedIds: string[];
  // 页面本地 ResourcePageTypeFilter（ResourceTypeFilter | "missing"），
  // 此处以结构等价的联合类型承接。
  typeFilter: ResourceTypeFilter | "missing";
  resourceGroup: string | null;
  hasMore: boolean;
  loadAllRecords: (
    categoryOverride?: ClipType,
    resourceGroup?: string | null,
  ) => Promise<ClipboardRecord[] | null>;
  deleteRecords: (ids: string[]) => Promise<DeleteRecordsSummary>;
  setConfirmState: (state: {
    message: string;
    hint?: string;
    onConfirm: () => void | Promise<void>;
  } | null) => void;
  setMissingCount: (count: number) => void;
  showFeedback: (next: "deleteFailed" | "deletedWithMissing" | "openFailed") => void;
}) {
  const { t } = useTranslation();
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  // 全量选中的请求序号：连续点击时旧请求的迟到结果不得覆盖新会话。
  const selectAllRequestRef = useRef(0);

  const startResourceSelection = useCallback(() => {
    selectAllRequestRef.current += 1;
    startSelection();
  }, [startSelection]);

  const cancelResourceSelection = useCallback(() => {
    selectAllRequestRef.current += 1;
    setSelectingAll(false);
    exitSelection();
  }, [exitSelection]);

  useEffect(() => {
    if (isSelecting || !selectingAll) return;
    selectAllRequestRef.current += 1;
    setSelectingAll(false);
  }, [isSelecting, selectingAll]);

  const handleToggleAll = useCallback(async () => {
    if (selectingAll) return;
    if (allVisibleSelected && !hasMore) {
      toggleAllVisible();
      return;
    }
    const request = ++selectAllRequestRef.current;
    setSelectingAll(true);
    try {
      const allRecords = await loadAllRecords("resources", resourceGroup);
      if (!allRecords || request !== selectAllRequestRef.current) return;
      selectIds(
        allRecords
          .filter((record) => (
            isResourceRecord(record)
            && (typeFilter === "missing"
              ? Boolean(record.resource_missing)
              : matchesResourceType(record, typeFilter))
          ))
          .map((record) => record.id),
      );
    } finally {
      if (request === selectAllRequestRef.current) setSelectingAll(false);
    }
  }, [
    allVisibleSelected,
    hasMore,
    loadAllRecords,
    resourceGroup,
    selectIds,
    selectingAll,
    toggleAllVisible,
    typeFilter,
  ]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedCount === 0 || selectingAll || deletingSelected) return;
    const ids = [...selectedIds];
    setConfirmState({
      message: t("resources.confirmDeleteSelected", { count: ids.length }),
      hint: t("resources.confirmDeleteHint"),
      onConfirm: async () => {
        setDeletingSelected(true);
        try {
          const summary = await deleteRecords(ids);
          cancelResourceSelection();
          if (summary && summary.filesAlreadyMissing > 0) {
            setMissingCount(summary.filesAlreadyMissing);
            showFeedback("deletedWithMissing");
          }
        } catch {
          showFeedback("deleteFailed");
        } finally {
          setDeletingSelected(false);
        }
      },
    });
  }, [
    cancelResourceSelection,
    deleteRecords,
    deletingSelected,
    selectingAll,
    selectedCount,
    selectedIds,
    setConfirmState,
    setMissingCount,
    showFeedback,
    t,
  ]);

  return {
    selectingAll,
    deletingSelected,
    startResourceSelection,
    cancelResourceSelection,
    handleToggleAll,
    handleDeleteSelected,
  };
}
