// 详情页备注与重命名子系统：备注草稿/保存（显式保存按钮，高度随内容
// 自动伸缩）、标题重命名（基于文件名 stem，rename_resource_file 单命令，
// 结果按后端归一响应整条修补记录）。
// 自 ResourceDetailPage.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）。
// 记录、列表刷新通道（onRecordUpdated）、store 备注同步通道
// （updateResourceNote）经 params 注入。

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord } from "../../types";

export function useResourceDetailNoteRename({
  record,
  onRecordUpdated,
  updateResourceNote,
}: {
  record: ClipboardRecord;
  onRecordUpdated: (record: ClipboardRecord) => void;
  updateResourceNote: (id: string, note: string) => void;
}) {
  const { t } = useTranslation();
  const [noteDraft, setNoteDraft] = useState(record.resource_note ?? "");
  const [savedNote, setSavedNote] = useState(record.resource_note ?? "");
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);
  const [noteError, setNoteError] = useState(false);
  const noteSavedTimerRef = useRef<number | null>(null);
  const noteInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  // 记录切换重置备注与标题草稿（两者都绑定单条记录）。
  useEffect(() => {
    setNoteDraft(record.resource_note ?? "");
    setSavedNote(record.resource_note ?? "");
    setNoteSaved(false);
    setNoteError(false);
    setRenameDraft(null);
    setRenameError(null);
  }, [record.id, record.resource_note]);

  useEffect(() => () => {
    if (noteSavedTimerRef.current !== null) window.clearTimeout(noteSavedTimerRef.current);
  }, []);

  // 备注输入框与正文编辑器同款：高度随内容自动伸缩（含分数缩放下
  // scrollHeight 取整的 2px 余量），右下角不再提供手动拉伸把手；
  // CSS 侧用 max-height 封顶（粘性侧栏不随页面滚动，不封顶时长备注
  // 会把底部的保存按钮顶出视口外），封顶后由输入框内部滚动承接。
  useEffect(() => {
    const el = noteInputRef.current;
    if (!el) return;
    const syncHeight = () => {
      // 所在面板 display:none 时 scrollHeight 恒为 0，会把高度压成 2px
      // 且切回时依赖不变不会重算——此时跳过，等下次内容变化再校准。
      if (el.clientWidth === 0) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
    };
    syncHeight();
    window.addEventListener("resize", syncHeight);
    return () => window.removeEventListener("resize", syncHeight);
  }, [noteDraft, record.id]);

  const noteDirty = noteDraft.trim() !== savedNote;

  const handleSaveNote = async () => {
    const note = noteDraft.trim();
    if (noteSaving || note === savedNote) return;
    setNoteSaving(true);
    setNoteError(false);
    try {
      const saved = await invoke<string>("set_resource_note", {
        id: record.id,
        note,
      });
      setSavedNote(saved);
      setNoteDraft(saved);
      updateResourceNote(record.id, saved);
      setNoteSaved(true);
      if (noteSavedTimerRef.current !== null) window.clearTimeout(noteSavedTimerRef.current);
      noteSavedTimerRef.current = window.setTimeout(() => {
        setNoteSaved(false);
        noteSavedTimerRef.current = null;
      }, 2200);
    } catch {
      setNoteError(true);
    } finally {
      setNoteSaving(false);
    }
  };

  const cancelRename = () => {
    setRenameDraft(null);
    setRenameError(null);
  };

  const commitRename = async (currentStem: string) => {
    if (renameDraft === null || renameSaving) return;
    const stem = renameDraft.trim();
    if (!stem) {
      setRenameError(t("resources.nameRequired"));
      return;
    }
    if (stem === currentStem) {
      cancelRename();
      return;
    }
    setRenameSaving(true);
    setRenameError(null);
    try {
      const updated = await invoke<{
        id: string;
        resource_path?: string;
        resource_relative_path?: string | null;
        content?: string;
      }>("rename_resource_file", { id: record.id, newName: stem });
      onRecordUpdated({
        ...record,
        ...(updated.id ? { id: updated.id } : null),
        ...(updated.resource_path !== undefined
          ? { resource_path: updated.resource_path }
          : null),
        ...(updated.content !== undefined ? { content: updated.content } : null),
        ...(updated.resource_relative_path
          ? { resource_relative_path: updated.resource_relative_path }
          : null),
      });
      setRenameDraft(null);
    } catch (error) {
      setRenameError(String(error));
    } finally {
      setRenameSaving(false);
    }
  };

  return {
    noteDraft,
    setNoteDraft,
    noteDirty,
    noteSaving,
    noteSaved,
    noteError,
    setNoteError,
    noteInputRef,
    handleSaveNote,
    renameDraft,
    setRenameDraft,
    setRenameError,
    renameSaving,
    renameError,
    cancelRename,
    commitRename,
  };
}
