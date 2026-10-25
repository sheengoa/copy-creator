import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore, type ProjectPrompt } from "../../stores/projectStore";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icons } from "../../components/Icons";
import { PROMPT_CATEGORIES, promptCategoryKey } from "../../domain/projectView";

interface PromptDraft {
  id?: string;
  title: string;
  content: string;
  category: string;
}

const EMPTY_PROMPT: PromptDraft = { title: "", content: "", category: "" };


/** 全局提示词库：内容入库即点即复制（复制走浏览器剪切板），分类按
 *  用途（场景/角色/镜头/其他），编辑内联于列表。 */
export default function ProjectPromptPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { prompts, loadPrompts, savePrompt, deletePrompt } = useProjectStore(
    useShallow((state) => ({
      prompts: state.prompts,
      loadPrompts: state.loadPrompts,
      savePrompt: state.savePrompt,
      deletePrompt: state.deletePrompt,
    })),
  );

  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectPrompt | null>(null);

  useEffect(() => {
    void loadPrompts();
  }, [loadPrompts]);

  const handleCopy = async (prompt: ProjectPrompt) => {
    try {
      await navigator.clipboard.writeText(prompt.content);
      setCopiedId(prompt.id);
      window.setTimeout(() => setCopiedId((current) => (current === prompt.id ? null : current)), 1600);
    } catch {
      // WebView 剪切板不可用时静默失败：复制按钮仅是快捷方式。
    }
  };

  const handleSave = async () => {
    if (!draft || !draft.title.trim()) return;
    const ok = await savePrompt(draft);
    if (ok) setDraft(null);
  };

  return (
    <div
      className="project-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="project-dialog project-library-panel">
        <div className="project-dialog-head">
          <h4>
            {t("project.prompt.title")}
            <span className="project-library-count">{prompts.length}</span>
          </h4>
          <button
            type="button"
            className="project-dialog-close"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            {Icons.close}
          </button>
        </div>

        <div className="project-library-body">
          {prompts.length === 0 && !draft && (
            <div className="project-library-empty">
              {Icons.empty}
              <p>{t("project.prompt.empty")}</p>
            </div>
          )}
          {prompts.map((prompt) => (
            <div key={prompt.id} className="project-prompt-card">
              <div className="project-prompt-main">
                <b>
                  {prompt.title}
                  {prompt.category && (
                    <span className="project-prompt-cat">{t(promptCategoryKey(prompt.category))}</span>
                  )}
                </b>
                <i>{prompt.content || t("project.prompt.noContent")}</i>
              </div>
              <span className="project-library-actions">
                <button
                  type="button"
                  className={`project-mini-btn${copiedId === prompt.id ? " copied" : ""}`}
                  title={copiedId === prompt.id ? t("project.prompt.copied") : t("project.prompt.copy")}
                  disabled={!prompt.content}
                  onClick={() => void handleCopy(prompt)}
                >
                  {copiedId === prompt.id ? Icons.check : Icons.copy}
                </button>
                <button
                  type="button"
                  className="project-mini-btn"
                  title={t("common.edit")}
                  onClick={() =>
                    setDraft({
                      id: prompt.id,
                      title: prompt.title,
                      content: prompt.content,
                      category: prompt.category,
                    })
                  }
                >
                  {Icons.edit}
                </button>
                <button
                  type="button"
                  className="project-mini-btn"
                  title={t("common.delete")}
                  onClick={() => setDeleteTarget(prompt)}
                >
                  {Icons.delete}
                </button>
              </span>
            </div>
          ))}

          {draft ? (
            <div className="project-library-form">
              <div className="project-library-form-title">
                {t(draft.id ? "project.prompt.edit" : "project.prompt.new")}
              </div>
              <div className="project-form-row two">
                <label>
                  <span>{t("project.prompt.field.title")}</span>
                  <input
                    value={draft.title}
                    onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                    autoFocus
                  />
                </label>
                <label>
                  <span>{t("project.prompt.field.category")}</span>
                  <select
                    value={draft.category}
                    onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                  >
                    {PROMPT_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {t(promptCategoryKey(category))}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="project-form-row">
                <label>
                  <span>{t("project.prompt.field.content")}</span>
                  <textarea
                    rows={5}
                    value={draft.content}
                    onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                  />
                </label>
              </div>
              <div className="project-library-form-foot">
                <span className="project-library-form-hint">{t("project.prompt.copyHint")}</span>
                <span className="project-title-spacer" />
                <button type="button" className="project-dialog-btn" onClick={() => setDraft(null)}>
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="project-dialog-btn primary"
                  disabled={!draft.title.trim()}
                  onClick={() => void handleSave()}
                >
                  {t("common.save")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="project-library-new"
              onClick={() => setDraft({ ...EMPTY_PROMPT, category: "scene" })}
            >
              {Icons.add}
              {t("project.prompt.new")}
            </button>
          )}
        </div>
      </div>

      {deleteTarget && (
        <ConfirmDialog
          message={t("project.prompt.deleteConfirm", { title: deleteTarget.title })}
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            void deletePrompt(target.id);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
