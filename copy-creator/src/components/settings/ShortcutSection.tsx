import { useTranslation } from "react-i18next";

interface ShortcutSectionProps {
  localShortcutKey: string;
  setLocalShortcutKey: (key: string) => void;
  recording: boolean;
  startRecording: () => void;
  stopRecording: () => void;
  localRadialShortcutKey: string;
  setLocalRadialShortcutKey: (key: string) => void;
  radialRecording: boolean;
  startRadialRecording: () => void;
  stopRadialRecording: () => void;
}

export function ShortcutSection({
  localShortcutKey,
  recording,
  startRecording,
  stopRecording,
  localRadialShortcutKey,
  radialRecording,
  startRadialRecording,
  stopRadialRecording,
}: ShortcutSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.shortcut")}</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.windowShortcut")}</div>
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
          <div className="settings-row-label">{t("settings.radialShortcut")}</div>
          <div className="shortcut-setting">
            <div className="shortcut-keyboard-row">
              <span className={`shortcut-display${radialRecording ? " recording" : ""}`}>
                {radialRecording ? t("settings.recording") : (localRadialShortcutKey || t("settings.shortcutPlaceholder"))}
              </span>
              <button
                className="shortcut-record-btn"
                onClick={radialRecording ? stopRadialRecording : startRadialRecording}
              >
                {radialRecording ? t("settings.stopRecord") : t("settings.recordShortcut")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
