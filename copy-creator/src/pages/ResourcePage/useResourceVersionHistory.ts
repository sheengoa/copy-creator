// 详情页改动记录（版本历史）子系统：顶栏按钮 + 弹出面板；预览与
// 还原在正文区完成。versions=null 表示列表未加载（面板刚打开的
// 加载态）；previewEntry 是正在只读预览的版本。还原走正文写入通道
// 并自动记「还原」版，永远可逆。
// 自 ResourceDetailPage.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）。
// 外部文本路径、记录与列表刷新通道、已保存基准（setSavedContent）、
// 保存错误置空经 params 注入。

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  clearResourceTextVersions,
  fetchResourceTextVersions,
  fetchTextVersionContent,
  restoreResourceTextVersion,
  type ResourceTextVersion,
} from "../../domain/textVersions";
import type { ClipboardRecord } from "../../types";

export function useResourceVersionHistory({
  externalTextPath,
  record,
  onRecordUpdated,
  setSavedContent,
  setContentSaveError,
}: {
  externalTextPath: string | null;
  record: ClipboardRecord;
  onRecordUpdated: (record: ClipboardRecord) => void;
  setSavedContent: (content: string) => void;
  setContentSaveError: (error: string | null) => void;
}) {
  const { t } = useTranslation();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<ResourceTextVersion[] | null>(null);
  const [previewEntry, setPreviewEntry] = useState<{
    version: ResourceTextVersion;
    content: string;
  } | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyToast, setHistoryToast] = useState<string | null>(null);
  const historyAnchorRef = useRef<HTMLSpanElement | null>(null);
  const historyToastTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (historyToastTimerRef.current !== null) window.clearTimeout(historyToastTimerRef.current);
  }, []);

  // 改动记录与版本预览都绑定单条记录：记录切换时整体重置。
  useEffect(() => {
    setHistoryOpen(false);
    setPreviewEntry(null);
    setVersions(null);
  }, [record.id, record.resource_note]);

  const showHistoryToast = useCallback((message: string) => {
    setHistoryToast(message);
    if (historyToastTimerRef.current !== null) window.clearTimeout(historyToastTimerRef.current);
    historyToastTimerRef.current = window.setTimeout(() => {
      setHistoryToast(null);
      historyToastTimerRef.current = null;
    }, 2600);
  }, []);

  const formatVersionTime = useCallback((iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  }, []);

  const refreshVersions = useCallback(() => {
    if (!externalTextPath) return;
    fetchResourceTextVersions(record.id, externalTextPath)
      .then((list) => setVersions(list))
      .catch(() => {
        // 失败也要脱离加载态，否则面板停在「加载中」直到重开。
        setVersions([]);
        showHistoryToast(t("resources.textHistoryLoadFailed"));
      });
  }, [externalTextPath, record.id, showHistoryToast, t]);

  const toggleHistory = useCallback(() => {
    // 副作用（拉列表）放在 updater 之外：StrictMode 下 updater 会被
    // 双调用，内联触发会重复请求。
    if (!historyOpen) {
      setVersions(null);
      refreshVersions();
    }
    setHistoryOpen(!historyOpen);
  }, [historyOpen, refreshVersions]);

  // 面板打开时点击面板外任意处关闭（pointerdown 捕获按下瞬间）。
  useEffect(() => {
    if (!historyOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (historyAnchorRef.current?.contains(event.target as Node)) return;
      setHistoryOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [historyOpen]);

  const handlePreviewVersion = useCallback(
    (version: ResourceTextVersion) => {
      // 选中即收起面板：预览横幅（还原此版本/退出预览）就挂在面板正下方，
      // 面板开着会正好盖住这两个按钮，逼用户先「点面板外」收起才能点。
      setHistoryOpen(false);
      fetchTextVersionContent(version.id)
        .then((content) => setPreviewEntry({ version, content }))
        .catch(() => showHistoryToast(t("resources.textHistoryLoadFailed")));
    },
    [showHistoryToast, t],
  );

  // 「当前」项点击：退出预览回到最新内容（与横幅「退出预览」同效）。
  // 版本预览中从列表点「当前」即可回最新状态，不必先收面板再找横幅按钮。
  const handleBackToCurrent = useCallback(() => {
    setPreviewEntry(null);
    setHistoryOpen(false);
  }, []);

  const handleRestoreVersion = useCallback(async () => {
    if (!previewEntry || historyBusy) return;
    const { version, content } = previewEntry;
    setHistoryBusy(true);
    try {
      const saved = await restoreResourceTextVersion(version.id);
      setPreviewEntry(null);
      // 还原内容成为新的「已保存」基准；记录归一为文件承载形态后触发
      // 全文重读，与正文保存路径同款。
      setSavedContent(content);
      setContentSaveError(null);
      onRecordUpdated({
        ...record,
        type: "file",
        content: saved.content,
      });
      refreshVersions();
      showHistoryToast(
        t("resources.versionRestored", { time: formatVersionTime(version.createdAt) }),
      );
    } catch (error) {
      showHistoryToast(
        typeof error === "string" && error ? error : t("resources.versionRestoreFailed"),
      );
    } finally {
      setHistoryBusy(false);
    }
  }, [previewEntry, historyBusy, record, onRecordUpdated, refreshVersions, showHistoryToast, t, formatVersionTime, setSavedContent, setContentSaveError]);

  const handleClearVersions = useCallback(async () => {
    if (historyBusy) return;
    setHistoryBusy(true);
    try {
      await clearResourceTextVersions(record.id);
      setPreviewEntry(null);
      // 本地直接置空：清空后立即重拉会经懒对齐再次出现条目，视觉上
      // 与「已清空」矛盾；下次打开面板时按需重新对齐。
      setVersions([]);
      showHistoryToast(t("resources.versionClearDone"));
    } catch {
      showHistoryToast(t("resources.textHistoryLoadFailed"));
    } finally {
      setHistoryBusy(false);
    }
  }, [historyBusy, record.id, showHistoryToast, t]);

  return {
    historyOpen,
    setHistoryOpen,
    versions,
    previewEntry,
    setPreviewEntry,
    historyBusy,
    historyToast,
    historyAnchorRef,
    formatVersionTime,
    toggleHistory,
    handleClearVersions,
    handlePreviewVersion,
    handleBackToCurrent,
    handleRestoreVersion,
  };
}
