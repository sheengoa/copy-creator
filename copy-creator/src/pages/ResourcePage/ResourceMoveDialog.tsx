import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResourceFolder } from "../../types";
import { Icons } from "../../components/Icons";
import { flattenResourceFolders } from "./resourceUtils";

interface ResourceMoveDialogProps {
  open: boolean;
  itemsLabel: string;
  itemsMeta: string;
  currentFolders: string[];
  groups: ResourceFolder[];
  moving: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (targetFolder: string) => void;
}

// 移动内容到分组的树形选择对话框；targetFolder 为多级路径，"" 表示未分组。
export default function ResourceMoveDialog({
  open,
  itemsLabel,
  itemsMeta,
  currentFolders,
  groups,
  moving,
  error,
  onClose,
  onConfirm,
}: ResourceMoveDialogProps) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (open) setTarget(null);
  }, [open]);

  const rows = useMemo(() => {
    const topLevel = groups.filter((group) => group.name !== "");
    return [{ folder: null, depth: 0 }, ...flattenResourceFolders(topLevel)];
  }, [groups]);

  if (!open) return null;

  const isCurrentFolder = (path: string) => currentFolders.includes(path);

  return (
    <div className="dialog-overlay" onClick={moving ? undefined : onClose}>
      <div className="dialog-content resource-move-dialog" onClick={(event) => event.stopPropagation()}>
        <h3 className="dialog-title">{t("resources.moveTitle")}</h3>
        <div className="resource-move-source">
          <span className="resource-move-source-icon">{Icons.resources}</span>
          <div className="resource-move-source-names">
            <strong>{itemsLabel}</strong>
            <span>{itemsMeta}</span>
          </div>
        </div>
        <div className="resource-move-tree" role="listbox" aria-label={t("resources.moveTitle")}>
          <button
            type="button"
            className={`resource-move-row${target === "" ? " selected" : ""}${isCurrentFolder("") ? " current" : ""}`}
            role="option"
            aria-selected={target === ""}
            disabled={isCurrentFolder("")}
            onClick={() => setTarget("")}
          >
            <span className="resource-move-icon">{Icons.resources}</span>
            <span>{t("resources.ungrouped")}</span>
            {isCurrentFolder("") && (
              <span className="resource-move-current-tag">{t("resources.moveCurrentTag")}</span>
            )}
          </button>
          {rows.map(({ folder, depth }) =>
            folder ? (
              <button
                key={folder.path}
                type="button"
                className={`resource-move-row${target === folder.path ? " selected" : ""}${isCurrentFolder(folder.path) ? " current" : ""}`}
                style={{ paddingLeft: `${8 + depth * 16}px` }}
                role="option"
                aria-selected={target === folder.path}
                disabled={isCurrentFolder(folder.path)}
                title={folder.path}
                onClick={() => setTarget(folder.path)}
              >
                <span className="resource-move-icon">{Icons.resources}</span>
                <span>{folder.name}</span>
                {isCurrentFolder(folder.path) && (
                  <span className="resource-move-current-tag">{t("resources.moveCurrentTag")}</span>
                )}
              </button>
            ) : null,
          )}
        </div>
        <p className="resource-move-hint">{t("resources.moveHint")}</p>
        {error && (
          <span className="dialog-error-text" role="alert">{error}</span>
        )}
        <div className="dialog-actions">
          <button type="button" className="dialog-btn secondary" onClick={onClose} disabled={moving}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="dialog-btn save"
            disabled={target === null || moving}
            onClick={() => target !== null && onConfirm(target)}
          >
            {moving ? t("common.saving") : t("resources.move")}
          </button>
        </div>
      </div>
    </div>
  );
}
