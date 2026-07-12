import { useTranslation } from "react-i18next";

type PasteMode = "normal" | "terminal";

interface PasteSectionProps {
  localPasteLeftClick: PasteMode;
  setLocalPasteLeftClick: (mode: PasteMode) => void;
}

export function PasteSection({
  localPasteLeftClick,
  setLocalPasteLeftClick,
}: PasteSectionProps) {
  const { t } = useTranslation();
  const rightClickMode: PasteMode =
    localPasteLeftClick === "normal" ? "terminal" : "normal";

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.paste")}</div>
      <div className="settings-card">
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
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.pasteRightClick")}</div>
          <div className="settings-row-value">
            {rightClickMode === "normal"
              ? t("settings.pasteNormal")
              : t("settings.pasteTerminal")}
          </div>
        </div>
      </div>
    </div>
  );
}
