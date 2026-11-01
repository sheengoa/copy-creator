import { useTranslation } from "react-i18next";
import { useSettingsStore, type ContentSortMode } from "../../stores/settingsStore";
import type { ThemePreference } from "../../utils/theme";
import { InfoTip, Segmented, Toggle } from "../ui";

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
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const autoHideOnBlur = useSettingsStore((s) => s.autoHideOnBlur);
  const setAutoHideOnBlur = useSettingsStore((s) => s.setAutoHideOnBlur);

  const handleChangeLang = (lang: string) => {
    setLocalLang(lang);
    i18n.changeLanguage(lang);
    setSetting("language", lang);
  };

  const themeOptions: { value: ThemePreference; label: string }[] = [
    { value: "light", label: t("settings.light") },
    { value: "dark", label: t("settings.dark") },
    { value: "system", label: t("settings.themeSystem") },
  ];

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.generalSection")}</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.language")}</div>
          <Segmented
            value={localLang}
            options={[
              { value: "zh-CN", label: "ZH" },
              { value: "en", label: "EN" },
            ]}
            onChange={handleChangeLang}
            ariaLabel={t("settings.language")}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.theme")}</div>
          <Segmented
            value={themeMode}
            options={themeOptions}
            onChange={(mode) => void setThemeMode(mode)}
            ariaLabel={t("settings.theme")}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.startup")}</div>
          <Toggle
            checked={localAutostart}
            onChange={setLocalAutostart}
            title={localAutostart ? t("common.on") : t("common.off")}
            ariaLabel={t("settings.startup")}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            {t("settings.autoHideOnBlur")}
            <InfoTip text={t("settings.autoHideOnBlurHint")} />
          </div>
          <Toggle
            checked={autoHideOnBlur}
            onChange={(next) => void setAutoHideOnBlur(next)}
            title={autoHideOnBlur ? t("common.on") : t("common.off")}
            ariaLabel={t("settings.autoHideOnBlur")}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            {t("settings.contentListSort")}
            <InfoTip text={t("settings.contentSortHint")} />
          </div>
          <Segmented
            value={localContentSort}
            options={[
              { value: "recent", label: t("settings.sortRecent") },
              { value: "count", label: t("settings.sortCount") },
            ]}
            onChange={setLocalContentSort}
            ariaLabel={t("settings.contentListSort")}
          />
        </div>
      </div>
    </div>
  );
}
