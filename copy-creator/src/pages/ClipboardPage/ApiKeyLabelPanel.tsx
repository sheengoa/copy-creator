import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import type { ApiKeyLabel } from "../../types";
import { useClipboardStore } from "../../stores/clipboardStore";

const SERVICE_TEMPLATES = [
  { name: "OpenAI", apiBase: "https://api.openai.com/v1" },
  { name: "DeepSeek", apiBase: "https://api.deepseek.com/v1" },
  { name: "Kimi", apiBase: "https://api.moonshot.cn/v1" },
  { name: "通义千问", apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { name: "智谱 GLM", apiBase: "https://open.bigmodel.cn/api/paas/v4" },
  { name: "Grok", apiBase: "https://api.x.ai/v1" },
  { name: "Gemini", apiBase: "https://generativelanguage.googleapis.com/v1beta" },
  { name: "Claude", apiBase: "https://api.anthropic.com/v1" },
  { name: "自定义", apiBase: "" },
];

interface Props {
  recordId: string;
  keyPreview: string;
  existingLabel: ApiKeyLabel | null | undefined;
  guessedService: string | null | undefined;
  onSave: () => void;
  onCancel: () => void;
}

export default function ApiKeyLabelPanel({
  recordId,
  keyPreview,
  existingLabel,
  guessedService,
  onSave,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const updateRecordLabel = useClipboardStore((s) => s.updateRecordLabel);
  const defaultService =
    existingLabel?.service ||
    (guessedService && SERVICE_TEMPLATES.find((t) => t.name === guessedService)
      ? guessedService
      : "OpenAI");

  const defaultApiBase =
    existingLabel?.api_base ||
    SERVICE_TEMPLATES.find((t) => t.name === defaultService)?.apiBase ||
    "";

  const [note, setNote] = useState(existingLabel?.note || "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const trimmed = note.trim();
    const label = {
      service: defaultService,
      api_base: defaultApiBase,
      note: trimmed,
      is_expired: false,
    };

    // Close panel and update store immediately
    updateRecordLabel(recordId, label);
    onSave();

    try {
      await invoke("save_api_key_label", {
        recordId,
        keyPreview,
        service: label.service,
        apiBase: label.api_base,
        note: label.note,
      });
    } catch (e) {
      console.error("Failed to save label:", e);
    }
  };

  return (
    <div className="api-key-label-panel" onClick={(e) => e.stopPropagation()}>
      <div className="label-panel-row">
        <span className="label-panel-field-name">{t("clipboard.apiKeyNote")}</span>
        <input
          className="dialog-input label-panel-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("clipboard.apiKeyNotePlaceholder")}
          maxLength={10}
        />
      </div>
      <div className="label-panel-actions">
        <button className="label-panel-chip-btn secondary" onClick={onCancel} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="label-panel-chip-btn primary"
          onClick={handleSave}
          disabled={saving}
          type="button"
        >
          {saving ? t("clipboard.apiKeySaving") : t("common.save")}
        </button>
      </div>
    </div>
  );
}
