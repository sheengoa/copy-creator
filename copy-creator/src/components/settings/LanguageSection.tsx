import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";

interface LanguageSectionProps {
  localLang: string;
  setLocalLang: (lang: string) => void;
}

export function LanguageSection({
  localLang,
  setLocalLang,
}: LanguageSectionProps) {
  const { t, i18n } = useTranslation();
  const setSetting = useSettingsStore((s) => s.setSetting);

  const handleChangeLang = (lang: string) => {
    setLocalLang(lang);
    i18n.changeLanguage(lang);
    setSetting("language", lang);
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.language")}</div>
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
      </div>
    </div>
  );
}
