import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";

interface PhraseGroup {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface ManageGroupsDialogProps {
  open: boolean;
  groups: PhraseGroup[];
  renameId: string | null;
  renameName: string;
  setRenameName: (name: string) => void;
  onStartRename: (id: string, name: string) => void;
  onRename: () => void;
  onDeleteGroup: (id: string) => void;
  onClose: () => void;
  onAddGroup?: () => void;
  addGroupLabel?: string;
  title?: string;
  renameLabel?: string;
  protectedGroupName?: string;
  error?: string | null;
}

export function ManageGroupsDialog({
  open,
  groups,
  renameId,
  renameName,
  setRenameName,
  onStartRename,
  onRename,
  onDeleteGroup,
  onClose,
  onAddGroup,
  addGroupLabel,
  title,
  renameLabel,
  protectedGroupName = "暂存",
  error,
}: ManageGroupsDialogProps) {
  const { t } = useTranslation();

  if (!open) return null;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-content large" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title-row">
          <h3 className="dialog-title">{title || t("phrases.manageGroups")}</h3>
          {onAddGroup && (
            <button
              className="group-add-btn group-manage-add-btn"
              onClick={onAddGroup}
              title={addGroupLabel || t("phrases.newGroup")}
              aria-label={addGroupLabel || t("phrases.newGroup")}
            >
              {Icons.add}
            </button>
          )}
        </div>
        {error && <span className="dialog-error-text" role="alert">{error}</span>}
        <div className="phrase-group-manage-list">
          {groups.map((g) => (
            <div key={g.id} className="phrase-group-manage-row">
              {renameId === g.id ? (
                <input
                  className="dialog-input"
                  autoFocus
                  value={renameName}
                  onChange={(e) => setRenameName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onRename();
                    if (e.key === "Escape") {
                      onStartRename("", "");
                    }
                  }}
                  onBlur={onRename}
                />
              ) : (
                <span className="phrase-group-manage-name">{g.name}</span>
              )}
              <div className="phrase-group-manage-actions">
                <button
                  className="card-edit-btn"
                  style={{ opacity: 1 }}
                  onClick={() => onStartRename(g.id, g.name)}
                  title={renameLabel || t("phrases.rename")}
                >
                  {Icons.edit}
                </button>
                {g.name !== protectedGroupName && (
                  <button
                    className="card-delete-btn"
                    style={{ opacity: 1 }}
                    onClick={() => onDeleteGroup(g.id)}
                    title={t("common.delete")}
                  >
                    {Icons.delete}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
