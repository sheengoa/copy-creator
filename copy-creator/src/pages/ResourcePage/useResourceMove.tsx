// 资源移动子系统：卡片/批量移动入口、移动对话框状态机、移动确认
// （后端按请求下标回填修补详情记录）、移动成功反馈条与对话框 JSX。
// 自 ResourcePage.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）。
// 记录视图列表、详情记录修补、批量选择取消、分组列表与共享反馈
// 定时器经 params 注入。

import { useCallback, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord, ResourceFolder } from "../../types";
import type { RecordView } from "../../domain/recordView";
import { useRecordLocale } from "../../hooks/useRecordLocale";
import ResourceMoveDialog from "./ResourceMoveDialog";
import {
  formatResourceFolderPath,
} from "../../domain/groups";
import { inferResourceMediaKind } from "../../domain/mediaKind";
import { getResourceTitle } from "../../domain/records";

export type ResourceMoveDialogState = {
  ids: string[];
  label: string;
  meta: string;
  folders: string[];
} | null;

export function useResourceMove({
  filteredRecords,
  detailRecord,
  setDetailRecord,
  cancelResourceSelection,
  feedbackTimerRef,
  resourceGroups,
}: {
  filteredRecords: ClipboardRecord[];
  detailRecord: ClipboardRecord | null;
  setDetailRecord: (
    updater: (current: ClipboardRecord | null) => ClipboardRecord | null,
  ) => void;
  cancelResourceSelection: () => void;
  feedbackTimerRef: RefObject<number | null>;
  resourceGroups: ResourceFolder[];
}) {
  const { t } = useTranslation();
  const recordLocale = useRecordLocale();
  const [moveDialog, setMoveDialog] = useState<ResourceMoveDialogState>(null);
  const [movingResource, setMovingResource] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moveFeedback, setMoveFeedback] = useState<string | null>(null);

  const openResourceMove = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const selected = filteredRecords.filter((record) => ids.includes(record.id));
    // 详情页记录可能尚未出现在已加载的列表里（如刚改名/移动完），用详情记录兜底。
    if (selected.length === 0 && detailRecord && ids.includes(detailRecord.id)) {
      selected.push(detailRecord);
    }
    if (selected.length === 0) return;
    const folders = [...new Set(selected.map((record) => record.resource_folder ?? ""))];
    const label = selected.length === 1
      ? getResourceTitle(selected[0], inferResourceMediaKind(selected[0]), recordLocale)
      : t("resources.moveSelectedCount", { count: selected.length });
    const meta = folders.length === 1
      ? t("resources.moveCurrentLocation", {
        name: folders[0] === "" ? t("resources.ungrouped") : formatResourceFolderPath(folders[0]),
      })
      : t("resources.moveMultipleLocations");
    setMoveError(null);
    setMoveDialog({ ids, label, meta, folders });
  }, [detailRecord, filteredRecords, recordLocale, t]);

  const handleMoveCard = useCallback(
    (moveView: RecordView) => openResourceMove([moveView.id]),
    [openResourceMove],
  );

  const handleMoveConfirm = useCallback(async (targetFolder: string) => {
    if (!moveDialog || movingResource) return;
    setMovingResource(true);
    setMoveError(null);
    try {
      const results = await invoke<
        Array<{
          id: string;
          resource_path?: string;
          resource_relative_path?: string | null;
          resource_folder?: string | null;
          content?: string;
        }>
      >("move_resource_records", {
        ids: moveDialog.ids,
        targetFolder,
      });
      const targetLabel = targetFolder === ""
        ? t("resources.ungrouped")
        : formatResourceFolderPath(targetFolder);
      setMoveFeedback(t("resources.moveSuccess", { count: moveDialog.ids.length, name: targetLabel }));
      if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = window.setTimeout(() => {
        setMoveFeedback(null);
        feedbackTimerRef.current = null;
      }, 2600);
      setDetailRecord((current) => {
        if (!current) return null;
        // 自动发现记录的 id 随路径变化，结果按请求下标对齐后整条修补。
        const index = moveDialog.ids.indexOf(current.id);
        if (index < 0 || index >= results.length) return current;
        const updated = results[index];
        return {
          ...current,
          ...(updated.id ? { id: updated.id } : null),
          ...(updated.resource_path ? { resource_path: updated.resource_path } : null),
          ...(updated.resource_relative_path
            ? { resource_relative_path: updated.resource_relative_path }
            : null),
          ...(updated.resource_folder !== undefined ? { resource_folder: updated.resource_folder } : null),
          ...(updated.content ? { content: updated.content } : null),
        };
      });
      setMoveDialog(null);
      cancelResourceSelection();
    } catch (error) {
      console.error("Failed to move resource records:", error);
      setMoveError(String(error));
    } finally {
      setMovingResource(false);
    }
  }, [cancelResourceSelection, feedbackTimerRef, moveDialog, movingResource, setDetailRecord, t]);

  const moveDialogElement = (
    <ResourceMoveDialog
      open={moveDialog !== null}
      itemsLabel={moveDialog?.label ?? ""}
      itemsMeta={moveDialog?.meta ?? ""}
      currentFolders={moveDialog?.folders ?? []}
      groups={resourceGroups}
      moving={movingResource}
      error={moveError}
      onClose={() => {
        setMoveDialog(null);
        setMoveError(null);
      }}
      onConfirm={(target) => void handleMoveConfirm(target)}
    />
  );

  const moveFeedbackElement = moveFeedback ? (
    <div className="resource-feedback success" role="status" aria-live="polite">
      {moveFeedback}
    </div>
  ) : null;

  return {
    moveDialog,
    openResourceMove,
    handleMoveCard,
    moveDialogElement,
    moveFeedbackElement,
  };
}
