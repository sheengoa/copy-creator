// 详情页正文编辑子系统：进入/取消/保存编辑（双通道——record 形态经
// 调用方注入的 onSaveContent（剪切板 update_clipboard_record_content /
// 快捷输入 update_phrase），资源文件形态走 write_resource_text_content
// 并把记录归一为文件承载形态）、保存反馈（2.2s「已保存」）与编辑器
// 高度自伸缩。
// 自 ResourceDetailPage.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）。
// 已保存基准（savedContent/setSavedContent，与版本还原共享）、取材全文、
// 编辑目标路径、记录刷新通道、版本预览重置经 params 注入。

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClipboardRecord } from "../../types";

export function useResourceDetailContentEdit({
  savedContent,
  setSavedContent,
  setContentSaveError,
  fullTextContent,
  textEditPath,
  hideResourceOps,
  record,
  onSaveContent,
  onRecordUpdated,
  setPreviewEntry,
}: {
  savedContent: string;
  setSavedContent: (content: string) => void;
  setContentSaveError: (error: string | null) => void;
  fullTextContent: string | null;
  textEditPath: string | null;
  hideResourceOps: boolean;
  record: ClipboardRecord;
  onSaveContent?: (
    record: ClipboardRecord,
    draft: string,
  ) => Promise<void>;
  onRecordUpdated: (record: ClipboardRecord) => void;
  setPreviewEntry: (entry: null) => void;
}) {
  const [contentEditing, setContentEditing] = useState(false);
  const [contentDraft, setContentDraft] = useState("");
  const [contentSaving, setContentSaving] = useState(false);
  const [contentSaved, setContentSaved] = useState(false);
  const contentSavedTimerRef = useRef<number | null>(null);
  const contentEditorRef = useRef<HTMLTextAreaElement | null>(null);

  // 记录切换重置编辑态（与其他拆出 hook 的重置 effect 同键：跟随
  // record.resource_note——记录快照原地修补备注时编辑态一并复位）。
  useEffect(() => {
    setContentEditing(false);
    setContentSaved(false);
    setContentSaveError(null);
  }, [record.id, record.resource_note, setContentSaveError]);

  useEffect(() => () => {
    if (contentSavedTimerRef.current !== null) window.clearTimeout(contentSavedTimerRef.current);
  }, []);

  // 编辑器高度跟随内容伸缩，避免固定高度出现内部滚动条截断正文。
  // 加 2px 余量：分数缩放下 scrollHeight 取整可能略小于实际内容，
  // 否则会浮现一条内部滚动条（滚动统一交给主窗口页面层级）。
  useEffect(() => {
    const el = contentEditorRef.current;
    if (!el) return;
    const syncHeight = () => {
      // 同备注输入框：面板隐藏时 scrollHeight 为 0，跳过防止压扁。
      if (el.clientWidth === 0) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
    };
    syncHeight();
    window.addEventListener("resize", syncHeight);
    return () => window.removeEventListener("resize", syncHeight);
  }, [contentDraft, contentEditing]);

  const contentDirty = contentDraft.trim() !== savedContent.trim();

  const startContentEdit = () => {
    setContentDraft(fullTextContent ?? "");
    setContentSaved(false);
    setContentSaveError(null);
    setPreviewEntry(null);
    setContentEditing(true);
  };

  const cancelContentEdit = () => {
    setContentEditing(false);
    setContentDraft("");
    setContentSaveError(null);
  };

  const handleSaveContent = async () => {
    if (contentSaving || !contentDirty) return;
    // record 形态：保存经调用方注入的通道（剪切板 update_clipboard_record_
    // content / 快捷输入 update_phrase），成功后按资源库同节奏反馈
    // （「已保存」toast + onRecordUpdated 刷新列表，列表重载触发正文
    // 重新取材，savedContent 随新全文刷新）。
    if (hideResourceOps) {
      if (!onSaveContent) return;
      setContentSaving(true);
      setContentSaveError(null);
      try {
        await onSaveContent(record, contentDraft);
        setContentEditing(false);
        setContentDraft("");
        setSavedContent(contentDraft);
        setContentSaved(true);
        if (contentSavedTimerRef.current !== null) window.clearTimeout(contentSavedTimerRef.current);
        contentSavedTimerRef.current = window.setTimeout(() => {
          setContentSaved(false);
          contentSavedTimerRef.current = null;
        }, 2200);
        onRecordUpdated(record);
      } catch (error) {
        setContentSaveError(typeof error === "string" ? error : "");
      } finally {
        setContentSaving(false);
      }
      return;
    }
    if (!textEditPath) return;
    setContentSaving(true);
    setContentSaveError(null);
    try {
      const saved = await invoke<{ content: string; record_type?: string }>(
        "write_resource_text_content",
        {
          path: textEditPath,
          content: contentDraft,
          // 外部发现的记录（resource_managed=false）也传 id：改动记录按
          // record_id 记版，外部资源编辑后历史面板才有版本可看；后端归一
          // UPDATE 对已是文件承载形态的外部记录是幂等空操作。
          id: record.id,
        },
      );
      setContentEditing(false);
      setContentDraft("");
      setSavedContent(saved.content);
      setContentSaved(true);
      if (contentSavedTimerRef.current !== null) window.clearTimeout(contentSavedTimerRef.current);
      contentSavedTimerRef.current = window.setTimeout(() => {
        setContentSaved(false);
        contentSavedTimerRef.current = null;
      }, 2200);
      onRecordUpdated({
        ...record,
        // 保存后记录归一为文件承载形态（与 write_resource_text_content 的
        // 归一更新一致）：type=file、content=文件路径，全文以文件为唯一事实来源。
        type: "file",
        content: saved.content,
      });
    } catch (error) {
      // 超长、文件被外部替换等失败重试无效，后端原因必须可见；拿不到
      // 原因时展示层回退泛化文案。
      setContentSaveError(typeof error === "string" ? error : "");
    } finally {
      setContentSaving(false);
    }
  };

  return {
    contentEditing,
    setContentEditing,
    contentDraft,
    setContentDraft,
    contentDirty,
    contentSaving,
    contentSaved,
    contentEditorRef,
    startContentEdit,
    cancelContentEdit,
    handleSaveContent,
  };
}
