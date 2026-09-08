import { useTranslation } from "react-i18next";
import IosSelect from "../IosSelect";

type PasteMode = "normal" | "terminal";

interface ClipboardSectionProps {
  localRetention: string;
  setLocalRetention: (retention: string) => void;
  localPasteLeftClick: PasteMode;
  setLocalPasteLeftClick: (mode: PasteMode) => void;
}

export function ClipboardSection({
  localRetention,
  setLocalRetention,
  localPasteLeftClick,
  setLocalPasteLeftClick,
}: ClipboardSectionProps) {
  const { t } = useTranslation();

  const retentionOptions = [
    { value: "1week", label: t("settings.retention1week") },
    { value: "1month", label: t("settings.retention1month") },
    { value: "3months", label: t("settings.retention3months") },
  ];

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.clipboardSection")}</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.fileRetention")}</div>
          <IosSelect
            value={localRetention}
            options={retentionOptions}
            onChange={setLocalRetention}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.pasteLeftClick")}</div>
          <div className="settings-lang-toggle">
            <button
              className={`lang-toggle-btn${localPasteLeftClick === "normal" ? " active" : ""}`}
              onClick={() => setLocalPasteLeftClick("normal")}
            >
              {t("settings.pasteNormal")}
            </button>
            <button
              className={`lang-toggle-btn${localPasteLeftClick === "terminal" ? " active" : ""}`}
              onClick={() => setLocalPasteLeftClick("terminal")}
            >
              {t("settings.pasteTerminal")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
