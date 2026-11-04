import { useTranslation } from "react-i18next";
import { Icons } from "../../../components/Icons";
import { useCanvasData } from "../dataContext";
import { NodeHint } from "./NodeHint";
import { useNoteEditing } from "./noteEditing";
import type { NodeProps } from "./types";

type NoteNode = NodeProps["node"];

// 便签节点内容层：琥珀内嵌便签体，双击（def.onDoubleClick）或工具条 edit
// 钮（NoteEditTool）进入编辑；textarea Esc 退出、Enter 提交、失焦落库。
// 便签是两画布共用节点（scope both），落库走 dataContext（默认=自由画布
// store；工程视图=工程 provider）。
export function NoteBody({ node }: NodeProps) {
  const { t } = useTranslation();
  const data = useCanvasData();
  const editingId = useNoteEditing((s) => s.editingId);
  const noteDraft = useNoteEditing((s) => s.draft);
  const setNoteDraft = useNoteEditing((s) => s.setDraft);
  const closeNoteEdit = useNoteEditing((s) => s.close);
  const meta = node.metadata;
  if (meta.kind !== "note") return null;
  return editingId === node.id ? (
    <textarea
      className="fc-note-input"
      autoFocus
      value={noteDraft}
      onChange={(event) => setNoteDraft(event.target.value)}
      onBlur={() => {
        void data.updateNode(node.id, {
          metadata: JSON.stringify({ ...meta, content: noteDraft.trim() }),
        });
        closeNoteEdit();
      }}
      onKeyDown={(event) => {
        // 输入法组合期间不响应：确认候选词的 Enter 会误退出编辑并提前
        // 落库半截内容，取消候选的 Esc 会误关编辑。
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") closeNoteEdit();
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
    />
  ) : (
    <div className="fc-note-body">
      {meta.content ? meta.content : <i>{t("project.canvas.noteEmpty")}</i>}
    </div>
  );
}

/** 工具条 edit 钮（def.ToolsExtra）：进入编辑态。 */
export function NoteEditTool({ node }: { node: NoteNode }) {
  const { t } = useTranslation();
  return (
    <NodeHint text={t("common.edit")}>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => {
          if (node.metadata.kind === "note") useNoteEditing.getState().start(node.id, node.metadata.content);
        }}
      >
        {Icons.edit}
      </button>
    </NodeHint>
  );
}
