import { useTranslation } from "react-i18next";
import IosSelect from "../IosSelect";

interface LanguageSectionProps {
  localLang: string;
  setLocalLang: (lang: string) => void;
  localRetention: string;
  setLocalRetention: (retention: string) => void;
  localShortcutKey: string;
  setLocalShortcutKey: (key: string) => void;
  recording: boolean;
  startRecording: () => void;
  stopRecording: () => void;
}

export function LanguageSection({
  localLang,
  setLocalLang,
  localRetention,
  setLocalRetention,
  localShortcutKey,
  recording,
  startRecording,
  stopRecording,
}: LanguageSectionProps) {
  const { t } = useTranslation();

  const retentionOptions = [
    { value: "1week", label: t("settings.retention1week") },
    { value: "1month", label: t("settings.retention1month") },
    { value: "3months", label: t("settings.retention3months") },
  ];

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.language")}</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.language")}</div>
          <div className="settings-lang-toggle">
            <button
              className={`lang-toggle-btn${localLang === "zh-CN" ? " active" : ""}`}
              onClick={() => setLocalLang("zh-CN")}
            >
              ZH
            </button>
            <button
              className={`lang-toggle-btn${localLang === "en" ? " active" : ""}`}
              onClick={() => setLocalLang("en")}
            >
              EN
            </button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.shortcut")}</div>
          <div className="shortcut-setting">
            <div className="shortcut-keyboard-row">
              <span className={`shortcut-display${recording ? " recording" : ""}`}>
                {recording ? t("settings.recording") : (localShortcutKey || t("settings.shortcutPlaceholder"))}
              </span>
              <button
                className="shortcut-record-btn"
                onClick={recording ? stopRecording : startRecording}
              >
                {recording ? t("settings.stopRecord") : t("settings.recordShortcut")}
              </button>
            </div>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.clipboardRetention")}</div>
          <IosSelect
            value={localRetention}
            options={retentionOptions}
            onChange={setLocalRetention}
          />
        </div>
      </div>
    </div>
  );
}
