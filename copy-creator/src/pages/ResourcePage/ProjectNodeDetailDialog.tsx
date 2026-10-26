import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";

/** 详情窗口条目：一个节点（或一类节点里的一项）的预览 + 信息 + 动作。 */
export interface NodeDetailEntry {
  key: string;
  title: string;
  badge?: string;
  preview: ReactNode;
  info: { label: string; value: string }[];
  actions?: ReactNode;
}

interface ProjectNodeDetailDialogProps {
  /** 窗口标题（如「角色」「片段 #1」「素材」）。 */
  title: string;
  /** 类型色（节点 accent，同样式变量）。 */
  accent: string;
  entries: NodeDetailEntry[];
  /** 当前/全部切换：传入即显示切换按钮（如片段窗口的 当前角色/全部角色）。 */
  scope?: "current" | "all";
  scopeLabels?: { current: string; all: string };
  onScopeChange?: (scope: "current" | "all") => void;
  /** 附加区块（如片段窗口底部的视频挂接区）。 */
  extra?: ReactNode;
  /** 动作失败提示（如本机不支持文件选择时）。 */
  error?: string;
  onClose: () => void;
}

/** 节点详情预览窗口：双击节点弹出的独立窗口——大预览 + 节点信息 +
 *  动作（上传/从库选择/打开文件）。多文件类别（角色/场景/道具）以
 *  条目网格呈现，配合 当前/全部 切换。 */
export default function ProjectNodeDetailDialog({
  title,
  accent,
  entries,
  scope,
  scopeLabels,
  onScopeChange,
  extra,
  error,
  onClose,
}: ProjectNodeDetailDialogProps) {
  const { t } = useTranslation();
  return (
    <div
      className="pc-detail-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="pc-detail"
        style={{ ["--node-accent" as string]: accent } as React.CSSProperties}
      >
        <div className="pc-detail-head">
          <span className="pc-detail-dot" />
          <b className="pc-detail-title">{title}</b>
          <span className="pc-detail-count">{entries.length}</span>
          {scope && onScopeChange && scopeLabels && (
            <span className="pc-detail-scope">
              <button
                type="button"
                className={scope === "current" ? "on" : ""}
                onClick={() => onScopeChange("current")}
              >
                {scopeLabels.current}
              </button>
              <button
                type="button"
                className={scope === "all" ? "on" : ""}
                onClick={() => onScopeChange("all")}
              >
                {scopeLabels.all}
              </button>
            </span>
          )}
          <button
            type="button"
            className="pc-detail-close"
            data-tooltip={t("common.close")}
            onClick={onClose}
          >
            {Icons.close}
          </button>
        </div>
        <div className={`pc-detail-body${entries.length > 1 ? " grid" : ""}`}>
          {entries.map((entry) => (
            <div key={entry.key} className="pc-detail-card">
              <div className="pc-detail-preview">{entry.preview}</div>
              <div className="pc-detail-meta">
                <b className="pc-detail-name" title={entry.title}>
                  {entry.title}
                </b>
                {entry.badge && <span className="pc-detail-badge">{entry.badge}</span>}
              </div>
              <dl className="pc-detail-info">
                {entry.info.map((row) => (
                  <div key={row.label} className="pc-detail-row">
                    <dt>{row.label}</dt>
                    <dd title={row.value}>{row.value}</dd>
                  </div>
                ))}
              </dl>
              {entry.actions && <div className="pc-detail-actions">{entry.actions}</div>}
            </div>
          ))}
          {entries.length === 0 && (
            <div className="pc-detail-empty">{t("project.canvas.detailNone")}</div>
          )}
        </div>
        {error && <div className="pc-detail-error">{error}</div>}
        {extra}
      </div>
    </div>
  );
}
