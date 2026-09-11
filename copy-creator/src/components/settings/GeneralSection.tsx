import { useTranslation } from "react-i18next";
import { useSettingsStore, type ContentSortMode } from "../../stores/settingsStore";

interface GeneralSectionProps {
  localLang: string;
  setLocalLang: (lang: string) => void;
  localAutostart: boolean;
  setLocalAutostart: (enabled: boolean) => void;
  localContentSort: ContentSortMode;
  setLocalContentSort: (mode: ContentSortMode) => void;
}

export function GeneralSection({
  localLang,
  setLocalLang,
  localAutostart,
  setLocalAutostart,
  localContentSort,
  setLocalContentSort,
}: GeneralSectionProps) {
  const { t, i18n } = useTranslation();
  const setSetting = useSettingsStore((s) => s.setSetting);

  const handleChangeLang = (lang: string) => {
    setLocalLang(lang);
    i18n.changeLanguage(lang);
    setSetting("language", lang);
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.generalSection")}</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.language")}</div>
          <div className="settings-lang-toggle">
            <button
              className={`lang-toggle-btn${localLang === "zh-CN" ? " active" : ""}`}
              onClick={() => handleChangeLang("zh-CN")}
            >
              ZH
            </button>
            <button
              className={`lang-toggle-btn${localLang === "en" ? " active" : ""}`}
              onClick={() => handleChangeLang("en")}
            >
              EN
            </button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.startup")}</div>
          <button
            className={`toggle-switch ${localAutostart ? "on" : "off"}`}
            onClick={() => setLocalAutostart(!localAutostart)}
            title={localAutostart ? t("common.on") : t("common.off")}
          >
            <span className="toggle-thumb" />
          </button>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.contentListSort")}</div>
          <div className="settings-lang-toggle">
            <button
              className={`lang-toggle-btn${localContentSort === "recent" ? " active" : ""}`}
              onClick={() => setLocalContentSort("recent")}
            >
              {t("settings.sortRecent")}
            </button>
            <button
              className={`lang-toggle-btn${localContentSort === "count" ? " active" : ""}`}
              onClick={() => setLocalContentSort("count")}
            >
              {t("settings.sortCount")}
            </button>
          </div>
        </div>
        <div className="settings-row-hint">{t("settings.contentSortHint")}</div>
      </div>
    </div>
  );
}
