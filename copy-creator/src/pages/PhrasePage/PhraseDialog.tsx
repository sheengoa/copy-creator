import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWebview } from "@tauri-apps/api/webview";

interface PhraseDialogProps {
  open: boolean;
  editingId: string | null;
  /** 编辑中的短语是否为文件类型：决定是否显示文件信息行与移除按钮。 */
  editingFilePhrase: boolean;
  phraseRemark: string;
  phraseContent: string;
  selectedFileName: string;
  selectedFileSize: number;
  /** 选中文件为图像时的预览地址（asset 协议），非图像或未选文件时为 null。 */
  selectedFilePreviewSrc: string | null;
  fileLimitBytes: number;
  phraseError: boolean;
  phraseErrorMessage: string;
  setPhraseRemark: (remark: string) => void;
  setPhraseContent: (content: string) => void;
  onImportFile: () => void;
  onDropFile: (path: string) => void;
  onRemoveFile: () => void;
  onSave: () => void;
  onClose: () => void;
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function PhraseDialog({
  open,
  editingId,
  editingFilePhrase,
  phraseRemark,
  phraseContent,
  selectedFileName,
  selectedFileSize,
  selectedFilePreviewSrc,
  fileLimitBytes,
  phraseError,
  phraseErrorMessage,
  setPhraseRemark,
  setPhraseContent,
  onImportFile,
  onDropFile,
  onRemoveFile,
  onSave,
  onClose,
}: PhraseDialogProps) {
  const { t } = useTranslation();
  const [dragActive, setDragActive] = useState(false);
  const hasFile = Boolean(selectedFileName);

  // 主窗口 dragDropEnabled 默认开启，HTML5 drop 事件被拦截，
  // 文件路径需通过 Tauri 的 drag-drop 事件获取。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) return;
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragActive(true);
        } else if (event.payload.type === "leave") {
          setDragActive(false);
        } else if (event.payload.type === "drop") {
          setDragActive(false);
          const path = event.payload.paths[0];
          if (path) onDropFile(path);
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [open, onDropFile]);

  if (!open) return null;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-content large" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">
          {editingId ? t("common.edit") : t("phrases.newInput")}
        </h3>

        <textarea
          className={`dialog-textarea${phraseError ? " error" : ""}${dragActive ? " is-dragover" : ""}`}
          autoFocus
          placeholder={t("phrases.unifiedPlaceholder")}
          value={hasFile ? t("phrases.fileTag", { name: selectedFileName }) : phraseContent}
          readOnly={hasFile}
          onChange={(e) => {
            setPhraseContent(e.target.value);
          }}
        />
        <div className="quick-input-file-row">
          {hasFile ? (
            <>
              {selectedFilePreviewSrc && (
                <img
                  className="quick-input-file-preview"
                  src={selectedFilePreviewSrc}
                  alt=""
                  onError={(e) => { e.currentTarget.style.display = "none"; }}
                />
              )}
              <span className="quick-input-file-name">{selectedFileName}</span>
              <span className="quick-input-file-size">{formatBytes(selectedFileSize)}</span>
              {!editingFilePhrase && (
                <button
                  className="quick-input-file-remove"
                  onClick={onRemoveFile}
                  title={t("phrases.removeFile")}
                  type="button"
                >
                  ×
                </button>
              )}
            </>
          ) : (
            <span className="quick-input-file-hint">
              {t("phrases.dropHint", { size: formatBytes(fileLimitBytes) })}
            </span>
          )}
          <button className="dialog-btn secondary quick-input-file-btn" onClick={onImportFile} type="button">
            {hasFile ? t("phrases.changeFile") : t("phrases.importFile")}
          </button>
        </div>
        {hasFile && selectedFilePreviewSrc && (
          <span className="quick-input-file-hint">{t("phrases.imageFileHint")}</span>
        )}
        {phraseError && phraseErrorMessage && (
          <span className="dialog-error-text">{phraseErrorMessage}</span>
        )}
        <input
          className="dialog-input"
          placeholder={t("phrases.remark")}
          value={phraseRemark}
          onChange={(e) => setPhraseRemark(e.target.value)}
        />
        <div className="dialog-actions">
          <button className="dialog-btn secondary" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="dialog-btn save" onClick={onSave}>
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
