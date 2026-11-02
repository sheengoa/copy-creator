import { useTranslation } from "react-i18next";
import { Icons } from "../../../components/Icons";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useNodeErrors } from "./nodeErrors";
import { NodeHint } from "./NodeHint";
import { ParamCombo } from "./ParamCombo";
import { commitImageParams, MODEL_PRESET_BASE } from "./genParams";
import type { NodeProps } from "./types";

// 视频/音频生成节点内容层：协议未接入（决策 10：按钮置灰留置），仅模型
// 参数 + 禁用生成按钮的占位渲染；协议接入后替换为完整生成体。
export function GenPlaceholderBody({ node }: NodeProps) {
  const { t } = useTranslation();
  const nodeErrors = useNodeErrors((s) => s.errors);
  const aiModel = useSettingsStore((s) => s.aiModel);
  /** 模型占位符兜底：节点未填且设置页默认模型为空时给通用示例名。 */
  const modelFallback = aiModel || "gpt-image-1";
  const meta = node.metadata;
  if (meta.kind !== "gen_video" && meta.kind !== "gen_audio") return null;
  const notReadyKey = node.type === "gen_video" ? "canvas.genVideoNotReady" : "canvas.genAudioNotReady";
  return (
    <div className="fc-node-form">
      <div className="fc-param">
        <NodeHint text={t("canvas.genModelLabel")} className="fc-param-ico-host">
          <span className="fc-param-ico">{Icons.chip}</span>
        </NodeHint>
        <ParamCombo
          comboKey={`gm-${node.id}-${node.updated_at}`}
          value={meta.params.model}
          items={[...new Set([modelFallback, ...MODEL_PRESET_BASE])].map((m) => ({ value: m, label: m }))}
          placeholder={modelFallback}
          toggleTitle={t("canvas.comboPresets")}
          onCommit={(model) => commitImageParams(node, { model })}
        />
      </div>
      <NodeHint text={t(notReadyKey)}>
        <button className="fc-node-btn accent" disabled aria-label={t(notReadyKey)}>
          {t("canvas.genButton")}
        </button>
      </NodeHint>
      {nodeErrors[node.id] && <div className="fc-gen-warn">{nodeErrors[node.id]}</div>}
    </div>
  );
}
