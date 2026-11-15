// 资源详情子系统：详情记录状态、打开/关闭（含 history pushState 与
// popstate 回退联动）、滚动位置记忆恢复、Esc 关闭与单条删除确认。
// 自 ResourcePage.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）。
// 记录列表（records）、删除通道、确认框、反馈与缺失计数、列表滚动
// 容器经 params 注入。

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RefObject } from "react";
import type { ClipboardRecord } from "../../types";
import type { RecordView } from "../../domain/recordView";
import type { DeleteRecordsSummary } from "../../stores/clipboardStore";
import { useEscapeKey } from "../../hooks/useEscapeKey";

export function useResourceDetail({
  records,
  deleteRecord,
  setConfirmState,
  showFeedback,
  setMissingCount,
  resourceListRef,
}: {
  records: ClipboardRecord[];
  deleteRecord: (id: string) => Promise<DeleteRecordsSummary>;
  setConfirmState: (state: {
    message: string;
    hint?: string;
    onConfirm: () => void | Promise<void>;
  } | null) => void;
  showFeedback: (next: "deleteFailed" | "deletedWithMissing" | "openFailed") => void;
  setMissingCount: (count: number) => void;
  resourceListRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const [detailRecordId, setDetailRecordId] = useState<string | null>(null);
  const [detailRecord, setDetailRecord] = useState<ClipboardRecord | null>(null);
  const detailHistoryRef = useRef(false);
  const pendingScrollTopRef = useRef<number | null>(null);

  const closeDetail = useCallback(() => {
    if (!detailRecordId) return;
    if (detailHistoryRef.current) {
      window.history.back();
      return;
    }
    setDetailRecord(null);
    setDetailRecordId(null);
  }, [detailRecordId]);

  const handleDeleteRecord = useCallback((id: string) => {
    setConfirmState({
      message: t("resources.confirmDelete"),
      hint: t("resources.confirmDeleteHint"),
      onConfirm: async () => {
        try {
          const summary = await deleteRecord(id);
          if (detailRecordId === id) closeDetail();
          if (summary && summary.filesAlreadyMissing > 0) {
            setMissingCount(summary.filesAlreadyMissing);
            showFeedback("deletedWithMissing");
          }
        } catch {
          showFeedback("deleteFailed");
        }
      },
    });
  }, [closeDetail, deleteRecord, detailRecordId, setConfirmState, setMissingCount, showFeedback, t]);

  const openDetail = useCallback((view: RecordView) => {
    const record = records.find((r) => r.id === view.id);
    if (!record) return;
    pendingScrollTopRef.current = resourceListRef.current?.scrollTop ?? 0;
    setDetailRecord(record);
    detailHistoryRef.current = true;
    setDetailRecordId(record.id);
    window.history.pushState({ resourceDetailId: record.id }, "", `#resource/${record.id}`);
  }, [records, resourceListRef]);

  // 浏览器返回键（popstate）时关闭详情：openDetail pushState 的对向操作。
  useEffect(() => {
    const handlePopState = () => {
      if (!detailRecordId) return;
      detailHistoryRef.current = false;
      setDetailRecord(null);
      setDetailRecordId(null);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [detailRecordId]);

  // 关闭详情后恢复进入前的列表滚动位置（下一帧执行，等列表重新挂载）。
  useEffect(() => {
    if (detailRecordId || pendingScrollTopRef.current === null) return;
    const top = pendingScrollTopRef.current;
    pendingScrollTopRef.current = null;
    const frame = requestAnimationFrame(() => {
      resourceListRef.current?.scrollTo({ top, behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [detailRecordId, resourceListRef]);

  // 详情页 Esc 关闭：输入控件内不拦（先让输入框自己响应）。
  useEscapeKey((event) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
    event.preventDefault();
    closeDetail();
  }, Boolean(detailRecordId));

  return {
    detailRecord,
    setDetailRecord,
    detailRecordId,
    closeDetail,
    openDetail,
    handleDeleteRecord,
  };
}
