// 新建/重命名分组的输入对话框：受控组件，名称与保存状态由容器持有。
import { useTranslation } from "react-i18next";
import { formatResourceFolderPath } from "../../domain/groups";
import type { ResourceGroupDialogState } from "./dialogTypes";

interface ResourceGroupNameDialogProps {
  dialog: NonNullable<ResourceGroupDialogState>;
  name: string;
  saving: boolean;
  error: string | null;
  onNameChange: (name: string) => void;
  onClose: () => void;
  onSave: () => void;
}

export default function ResourceGroupNameDialog({
  dialog,
  name,
  saving,
  error,
  onNameChange,
  onClose,
  onSave,
}: ResourceGroupNameDialogProps) {
  const { t } = useTranslation();
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-content" onClick={(event) => event.stopPropagation()}>
        <h3 className="dialog-title">
          {dialog.mode === "rename"
            ? t("resources.renameGroup")
            : t("resources.newGroup")}
        </h3>
        {dialog.mode === "create" && dialog.parentPath && (
          <p className="resource-group-path-hint">
            {t("resources.groupCreateAt", {
              path: formatResourceFolderPath(dialog.parentPath),
            })}
          </p>
        )}
        {dialog.mode === "rename" && dialog.oldName && (
          <p className="resource-group-path-hint">
            {t("resources.groupLocationAt", {
              path: formatResourceFolderPath(
                dialog.oldName.split("/").slice(0, -1).join("/"),
              ),
            })}
          </p>
        )}
        <input
          className="dialog-input"
          autoFocus
          value={name}
          placeholder={t("resources.groupName")}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSave();
          }}
        />
        {error && (
          <span className="dialog-error-text" role="alert">{error}</span>
        )}
        <div className="dialog-actions">
          <button type="button" className="dialog-btn secondary" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="dialog-btn save"
            onClick={onSave}
            disabled={!name.trim() || saving}
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
