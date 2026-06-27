import { useTranslation } from "react-i18next";

interface PhraseDialogProps {
  open: boolean;
  editingId: string | null;
  phraseRemark: string;
  phraseContent: string;
  inputType: "text" | "file";
  selectedFileName: string;
  selectedFileSize: number;
  fileLimitBytes: number;
  phraseError: boolean;
  phraseErrorMessage: string;
  setInputType: (inputType: "text" | "file") => void;
  setPhraseRemark: (remark: string) => void;
  setPhraseContent: (content: string) => void;
  onSelectFile: () => void;
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
  phraseRemark,
  phraseContent,
  inputType,
  selectedFileName,
  selectedFileSize,
  fileLimitBytes,
  phraseError,
  phraseErrorMessage,
  setInputType,
  setPhraseRemark,
  setPhraseContent,
  onSelectFile,
  onSave,
  onClose,
}: PhraseDialogProps) {
  const { t } = useTranslation();

  if (!open) return null;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-content large" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">
          {editingId ? t("common.edit") : t("phrases.newInput")}
        </h3>

        <div className="quick-input-type-tabs">
          <button
            className={`quick-input-type-btn${inputType === "text" ? " active" : ""}`}
            onClick={() => setInputType("text")}
            type="button"
          >
            {t("phrases.textInput")}
          </button>
          <button
            className={`quick-input-type-btn${inputType === "file" ? " active" : ""}`}
            onClick={() => setInputType("file")}
            type="button"
          >
            {t("phrases.fileInput")}
          </button>
        </div>

        {inputType === "text" ? (
          <textarea
            className={`dialog-textarea${phraseError ? " error" : ""}`}
            autoFocus
            placeholder={t("phrases.content")}
            value={phraseContent}
            onChange={(e) => {
              setPhraseContent(e.target.value);
            }}
          />
        ) : (
          <div className={`quick-input-file-box${phraseError ? " error" : ""}`}>
            <button className="dialog-btn secondary quick-input-file-btn" onClick={onSelectFile} type="button">
              {selectedFileName ? t("phrases.changeFile") : t("phrases.selectFile")}
            </button>
            <div className="quick-input-file-meta">
              <span className="quick-input-file-name">
                {selectedFileName || t("phrases.noFileSelected")}
              </span>
              <span className="quick-input-file-size">
                {selectedFileName
                  ? formatBytes(selectedFileSize)
                  : t("phrases.fileLimit", { size: formatBytes(fileLimitBytes) })}
              </span>
            </div>
          </div>
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
