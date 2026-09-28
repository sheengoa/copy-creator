import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

interface EditRecordDialogProps {
  recordId: string;
  initialContent: string;
  onClose: () => void;
  /** 保存成功后回调（父组件刷新列表）。 */
  onSaved: () => void;
}

// 记录正文编辑对话框：与 ConfirmDialog 同一弹层视觉语言（dialog-overlay /
// dialog-content），textarea 聚焦并置光标于文末，Ctrl+Enter 快捷保存。
export function EditRecordDialog({
  recordId,
  initialContent,
  onClose,
  onSaved,
}: EditRecordDialogProps) {
  const { t } = useTranslation();
  const [content, setContent] = useState(initialContent);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(initialContent.length, initialContent.length);
    return () => window.removeEventListener("keydown", onKeyDown);
    // 仅挂载时执行一次：initialContent 即初始值，不随后续渲染重置光标。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("update_clipboard_record_content", { id: recordId, content });
      onClose();
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog-content dialog-edit-content"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label={t("clipboard.editContent")}
      >
        <h3 className="dialog-title">{t("clipboard.editContent")}</h3>
        <textarea
          ref={textareaRef}
          className="dialog-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void handleSave();
            }
          }}
          spellCheck={false}
          rows={10}
        />
        {error && (
          <p className="dialog-message" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="dialog-btn secondary" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="dialog-btn save"
            disabled={saving}
            onClick={() => void handleSave()}
          >
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
