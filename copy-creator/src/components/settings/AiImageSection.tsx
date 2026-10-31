import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";

// AI 生图配置区（画布区方案 3.4）：自持久化——每项改动即落库，不走设置页
// 统一保存按钮（Key 类配置改完即生效，避免「忘了点保存」的排查成本）。
// Key 明文本机存储，与既有 google_api_key 同级安全。
export function AiImageSection() {
  const { t } = useTranslation();
  const settings = useSettingsStore();
  const [showOpenaiKey, setShowOpenaiKey] = useState(false);
  const [showGeminiKey, setShowGeminiKey] = useState(false);

  const input = (value: string, onChange: (v: string) => void, type = "text") => (
    <input
      className="settings-ai-input"
      type={type}
      value={value}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onChange(value.trim())}
    />
  );

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.aiSection")}</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.aiProvider")}</div>
          <div className="settings-ai-provider">
            {(["openai", "gemini"] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={`settings-ai-provider-btn${settings.aiProvider === p ? " active" : ""}`}
                onClick={() => void settings.saveAiSettings({ aiProvider: p })}
              >
                {t(`settings.aiProvider${p === "openai" ? "Openai" : "Gemini"}`)}
              </button>
            ))}
          </div>
        </div>

        {settings.aiProvider === "openai" ? (
          <>
            <div className="settings-row">
              <div className="settings-row-label">{t("settings.aiOpenaiKey")}</div>
              <div className="settings-ai-key">
                {input(settings.aiOpenaiKey, (v) => void settings.saveAiSettings({ aiOpenaiKey: v }), showOpenaiKey ? "text" : "password")}
                <button type="button" className="settings-ai-eye" onClick={() => setShowOpenaiKey((v) => !v)}>
                  {showOpenaiKey ? t("settings.aiHide") : t("settings.aiShow")}
                </button>
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-label">
                {t("settings.aiOpenaiBase")}
                <span className="settings-ai-hint">{t("settings.aiOpenaiBaseHint")}</span>
              </div>
              {input(settings.aiOpenaiBase, (v) => void settings.saveAiSettings({ aiOpenaiBase: v }))}
            </div>
          </>
        ) : (
          <>
            <div className="settings-row">
              <div className="settings-row-label">{t("settings.aiGeminiKey")}</div>
              <div className="settings-ai-key">
                {input(settings.aiGeminiKey, (v) => void settings.saveAiSettings({ aiGeminiKey: v }), showGeminiKey ? "text" : "password")}
                <button type="button" className="settings-ai-eye" onClick={() => setShowGeminiKey((v) => !v)}>
                  {showGeminiKey ? t("settings.aiHide") : t("settings.aiShow")}
                </button>
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-label">
                {t("settings.aiGeminiBase")}
                <span className="settings-ai-hint">{t("settings.aiGeminiBaseHint")}</span>
              </div>
              {input(settings.aiGeminiBase, (v) => void settings.saveAiSettings({ aiGeminiBase: v }))}
            </div>
          </>
        )}

        <div className="settings-row">
          <div className="settings-row-label">
            {t("settings.aiModel")}
            <span className="settings-ai-hint">{t("settings.aiModelHint")}</span>
          </div>
          {input(settings.aiModel, (v) => void settings.saveAiSettings({ aiModel: v }))}
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.aiTimeout")}</div>
          {input(String(settings.aiTimeout), (v) => {
            const secs = Math.max(5, Math.min(600, Number.parseInt(v, 10) || 60));
            void settings.saveAiSettings({ aiTimeout: secs });
          })}
        </div>
      </div>
    </div>
  );
}
