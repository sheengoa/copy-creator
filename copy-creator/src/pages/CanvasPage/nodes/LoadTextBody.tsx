import { useTranslation } from "react-i18next";
import { useCanvasStore } from "../../../stores/canvasStore";
import type { NodeProps } from "./types";

// 加载文本内容层：常驻编辑框（失焦提交；key 带 updated_at——外部更新
// content 时重挂同步）。固定高特例由 def.fixedHeight 驱动壳渲染。
export function LoadTextBody({ node }: NodeProps) {
  const { t } = useTranslation();
  const meta = node.metadata;
  if (meta.kind !== "load_text") return null;
  return (
    <div className="fc-node-form">
      <textarea
        className="fc-node-edit is-inline"
        key={`t-${node.id}-${node.updated_at}`}
        defaultValue={meta.content}
        placeholder={t("canvas.loadTextPlaceholder")}
        onBlur={(e) => {
          const meta2 = { ...meta, content: e.target.value };
          void useCanvasStore.getState().updateNode(node.id, { metadata: JSON.stringify(meta2) });
        }}
      />
    </div>
  );
}
