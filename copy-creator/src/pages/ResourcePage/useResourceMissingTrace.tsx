// 资源缺失追溯与清理子系统：缺失计数、追溯详情对话框、清理确认
// 对话框（实时复查→逐条确认→走删除通道进回收站）、重新检查与
// 反馈通知条。自 ResourcePage.tsx 拆出（2026-11-14，架构守卫规则 27）。
// 记录列表（records）、详情修补（setDetailRecord）、删除通道
// （deleteRecords）、批量选择取消与反馈、库路径与设置入口经 params 注入。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord } from "../../types";
import type { RecordView } from "../../domain/recordView";
import { isResourceRecord } from "../../domain/records";
import ResourceTraceDialog, { type TraceRelinkResult } from "./ResourceTraceDialog";
import ResourceCleanupDialog, {
  type CleanupCheckSummary,
  type CleanupMissingEntry,
} from "./ResourceCleanupDialog";

export function useResourceMissingTrace({
  records,
  setDetailRecord,
  deleteRecords,
  cancelResourceSelection,
  setMissingCount,
  showFeedback,
  resourceLibraryPath,
  setResourceSettingsOpen,
}: {
  records: ClipboardRecord[];
  setDetailRecord: (
    updater: (current: ClipboardRecord | null) => ClipboardRecord | null,
  ) => void;
  deleteRecords: (ids: string[]) => Promise<{ filesAlreadyMissing?: number }>;
  cancelResourceSelection: () => void;
  setMissingCount: (count: number) => void;
  showFeedback: (next: "deleteFailed" | "deletedWithMissing" | "openFailed") => void;
  resourceLibraryPath: string;
  setResourceSettingsOpen: (open: boolean) => void;
}) {
  const { t } = useTranslation();

  // 缺失计数来自已加载记录（分页视野内，与列表展示一致）；清理前的
  // 实时复查走后端全量口径，不受分页影响。
  const missingAllCount = useMemo(
    () => records.reduce(
      (count, record) => count + (isResourceRecord(record) && record.resource_missing ? 1 : 0),
      0,
    ),
    [records],
  );
  const [traceRecord, setTraceRecord] = useState<ClipboardRecord | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupChecking, setCleanupChecking] = useState(false);
  const [cleanupCheck, setCleanupCheck] = useState<CleanupCheckSummary | null>(null);
  const [cleaningMissing, setCleaningMissing] = useState(false);
  const [missingRecheckRunning, setMissingRecheckRunning] = useState(false);
  const [missingNotice, setMissingNotice] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const missingNoticeTimerRef = useRef<number | null>(null);

  const showMissingNotice = useCallback((text: string, tone: "ok" | "warn") => {
    if (missingNoticeTimerRef.current !== null) window.clearTimeout(missingNoticeTimerRef.current);
    setMissingNotice({ text, tone });
    missingNoticeTimerRef.current = window.setTimeout(() => {
      setMissingNotice(null);
      missingNoticeTimerRef.current = null;
    }, 2600);
  }, []);

  useEffect(() => () => {
    if (missingNoticeTimerRef.current !== null) window.clearTimeout(missingNoticeTimerRef.current);
  }, []);

  /** 重新检查：逐条实时 stat，文件回来的清缺失标志（后端发事件刷新列表）。 */
  const runMissingRecheck = useCallback(async () => {
    if (missingRecheckRunning) return;
    setMissingRecheckRunning(true);
    try {
      const summary = await invoke<{ recovered: number }>("recheck_missing_resources");
      if (summary.recovered > 0) {
        showMissingNotice(t("resources.recheckRecovered", { count: summary.recovered }), "ok");
      } else {
        showMissingNotice(t("resources.recheckNoChange"), "warn");
      }
    } catch (error) {
      console.error("Failed to recheck missing resources:", error);
      showMissingNotice(String(error), "warn");
    } finally {
      setMissingRecheckRunning(false);
    }
  }, [missingRecheckRunning, showMissingNotice, t]);

  /** 清理入口：先实时复查拿权威缺失清单（不受分页视野限制），再进确认。 */
  const openMissingCleanup = useCallback(async () => {
    if (cleanupChecking) return;
    setCleanupOpen(true);
    setCleanupChecking(true);
    setCleanupCheck(null);
    try {
      const summary = await invoke<CleanupCheckSummary>("recheck_missing_resources");
      setCleanupCheck(summary);
    } catch (error) {
      console.error("Failed to check missing resources:", error);
      setCleanupOpen(false);
      showMissingNotice(String(error), "warn");
    } finally {
      setCleanupChecking(false);
    }
  }, [cleanupChecking, showMissingNotice]);

  const handleTraceCard = useCallback((view: RecordView) => {
    const record = records.find((item) => item.id === view.id);
    if (record) setTraceRecord(record);
  }, [records]);

  const handleTraceDetail = useCallback((record: ClipboardRecord) => {
    setTraceRecord(record);
  }, []);

  const handleRelinked = useCallback((result: TraceRelinkResult) => {
    // 详情页的记录对象按旧 id 对齐后整条修补（id 随路径级联改写）。
    setDetailRecord((current) => {
      if (!current || !traceRecord || current.id !== traceRecord.id) return current;
      return {
        ...current,
        id: result.id,
        resource_path: result.resource_path,
        resource_relative_path: result.resource_relative_path ?? undefined,
        content: result.content,
        resource_group: result.group_name || null,
        resource_folder: result.resource_folder,
        resource_missing: false,
      };
    });
  }, [setDetailRecord, traceRecord]);

  const handleCleanupConfirm = useCallback(async (entries: CleanupMissingEntry[]) => {
    if (cleaningMissing || entries.length === 0) return;
    setCleaningMissing(true);
    try {
      // 走既有删除通道：进回收站，可恢复记录信息（文件本已不在磁盘）。
      const summary = await deleteRecords(entries.map((entry) => entry.id));
      setCleanupOpen(false);
      cancelResourceSelection();
      setMissingCount(summary?.filesAlreadyMissing ?? entries.length);
      showFeedback("deletedWithMissing");
    } catch {
      showFeedback("deleteFailed");
    } finally {
      setCleaningMissing(false);
    }
  }, [cancelResourceSelection, cleaningMissing, deleteRecords, setMissingCount, showFeedback]);

  const traceDialogElement = (
    <ResourceTraceDialog
      open={traceRecord !== null}
      record={traceRecord}
      libraryPath={resourceLibraryPath}
      onClose={() => setTraceRecord(null)}
      onRelinked={handleRelinked}
    />
  );

  const cleanupDialogElement = (
    <ResourceCleanupDialog
      open={cleanupOpen}
      checking={cleanupChecking}
      check={cleanupCheck}
      cleaning={cleaningMissing}
      libraryPath={resourceLibraryPath}
      onClose={() => setCleanupOpen(false)}
      onConfirm={(entries) => void handleCleanupConfirm(entries)}
      onRecheck={() => {
        setCleanupOpen(false);
        void runMissingRecheck();
      }}
      onOpenLibrarySettings={() => {
        setCleanupOpen(false);
        setResourceSettingsOpen(true);
      }}
    />
  );

  const missingNoticeElement = missingNotice ? (
    <div className={`resource-feedback ${missingNotice.tone === "ok" ? "success" : "warn"}`} role="status" aria-live="polite">
      {missingNotice.text}
    </div>
  ) : null;

  return {
    missingAllCount,
    traceRecord,
    cleanupOpen,
    missingRecheckRunning,
    runMissingRecheck,
    openMissingCleanup,
    handleTraceCard,
    handleTraceDetail,
    traceDialogElement,
    cleanupDialogElement,
    missingNoticeElement,
  };
}
