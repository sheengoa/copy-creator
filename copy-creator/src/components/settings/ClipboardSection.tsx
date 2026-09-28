import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import IosSelect from "../IosSelect";
import { useSettingsStore } from "../../stores/settingsStore";
import { InfoTip } from "./InfoTip";
import { PasteEnvironmentCard } from "./PasteEnvironmentSection";

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
  const clipboardPaused = useSettingsStore((s) => s.clipboardPaused);
  const setClipboardPaused = useSettingsStore((s) => s.setClipboardPaused);
  const clipboardMaxRecords = useSettingsStore((s) => s.clipboardMaxRecords);
  const setClipboardMaxRecords = useSettingsStore((s) => s.setClipboardMaxRecords);
  const clipboardExclusions = useSettingsStore((s) => s.clipboardExclusions);
  const setClipboardExclusions = useSettingsStore((s) => s.setClipboardExclusions);
  // 排除规则本地草稿：输入期间不落库，失焦整体保存；store 外部变化（如
  // 备份导入后重载）时回写草稿。
  const [exclusionsDraft, setExclusionsDraft] = useState(clipboardExclusions);
  useEffect(() => setExclusionsDraft(clipboardExclusions), [clipboardExclusions]);

  const retentionOptions = [
    { value: "1week", label: t("settings.retention1week") },
    { value: "1month", label: t("settings.retention1month") },
    { value: "3months", label: t("settings.retention3months") },
  ];

  // 条数上限档位（0=不限）：清理与保留期同一任务运行，上限即刻兜底。
  const maxRecordsOptions = [
    { value: "0", label: t("settings.maxRecordsUnlimited") },
    { value: "500", label: "500" },
    { value: "2000", label: "2000" },
    { value: "10000", label: "10000" },
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
          <div className="settings-row-label">{t("settings.maxRecords")}</div>
          <IosSelect
            value={String(clipboardMaxRecords)}
            options={maxRecordsOptions}
            onChange={(value) => void setClipboardMaxRecords(Number.parseInt(value, 10) || 0)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            {t("settings.pauseCapture")}
            <InfoTip text={t("settings.pauseCaptureHint")} />
          </div>
          <button
            className={`toggle-switch ${clipboardPaused ? "on" : "off"}`}
            onClick={() => void setClipboardPaused(!clipboardPaused)}
            title={clipboardPaused ? t("common.on") : t("common.off")}
          >
            <span className="toggle-thumb" />
          </button>
        </div>
        <div className="settings-row vertical">
          <div className="settings-row-label">
            {t("settings.exclusionRules")}
            <InfoTip text={t("settings.exclusionRulesHint")} />
          </div>
          <textarea
            className="settings-textarea"
            value={exclusionsDraft}
            placeholder={t("settings.exclusionsPlaceholder")}
            onChange={(e) => setExclusionsDraft(e.target.value)}
            onBlur={(e) => void setClipboardExclusions(e.target.value)}
            rows={3}
            spellCheck={false}
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
      <PasteEnvironmentCard />
    </div>
  );
}
