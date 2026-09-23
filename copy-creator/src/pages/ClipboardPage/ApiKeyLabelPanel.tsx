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
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const trimmed = note.trim();
    const label = {
      service: defaultService,
      api_base: defaultApiBase,
      note: trimmed,
      is_expired: false,
    };

    try {
      // 先落库再关面板：曾先乐观更新并关闭、失败只写日志，用户以为保存
      // 成功，重启后标签丢失且无任何提示。
      await invoke("save_api_key_label", {
        recordId,
        keyPreview,
        service: label.service,
        apiBase: label.api_base,
        note: label.note,
      });
      updateRecordLabel(recordId, label);
      onSave();
    } catch (e) {
      console.error("Failed to save label:", e);
      setError(String(e));
    } finally {
      setSaving(false);
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
      {error && <div className="label-panel-error" role="alert">{error}</div>}
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
