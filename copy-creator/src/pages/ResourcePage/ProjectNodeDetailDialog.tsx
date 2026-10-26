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

/** 详情窗口区块：同类资源的分组（如片段窗口的 角色/场景/道具 三区），
 *  每区带独立的 当前/全部 切换——文案按类别各异（当前角色/当前场景/…）。 */
export interface NodeDetailSection {
  key: string;
  title: string;
  scope: "current" | "all";
  scopeLabels: { current: string; all: string };
  onScopeChange: (scope: "current" | "all") => void;
  entries: NodeDetailEntry[];
}

interface ProjectNodeDetailDialogProps {
  /** 窗口标题（如「角色」「片段 #1」「素材」）。 */
  title: string;
  /** 类型色（节点 accent，同样式变量）。 */
  accent: string;
  /** 单列表条目（多区块窗口可省略，改传 sections）。 */
  entries?: NodeDetailEntry[];
  /** 覆盖头部计数（多区块窗口传各区块条目总数；缺省用 entries.length）。 */
  count?: number;
  /** 当前/全部切换：传入即显示切换按钮（资料窗口，文案随类别）。 */
  scope?: "current" | "all";
  scopeLabels?: { current: string; all: string };
  onScopeChange?: (scope: "current" | "all") => void;
  /** 多区块分组（片段窗口：角色/场景/道具各自独立切换）。 */
  sections?: NodeDetailSection[];
  /** 附加区块（如片段窗口底部的视频挂接区）。 */
  extra?: ReactNode;
  /** 动作失败提示（如本机不支持文件选择时）。 */
  error?: string;
  onClose: () => void;
}

/** 条目卡：预览 + 名称 + 信息表 + 动作（entries 与 sections 共用）。 */
function DetailCard({ entry }: { entry: NodeDetailEntry }) {
  return (
    <div className="pc-detail-card">
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
  );
}

/** 当前/全部 切换按钮对（头部与区块头共用）。 */
function ScopeToggle({
  scope,
  labels,
  onChange,
}: {
  scope: "current" | "all";
  labels: { current: string; all: string };
  onChange: (scope: "current" | "all") => void;
}) {
  return (
    <span className="pc-detail-scope">
      <button type="button" className={scope === "current" ? "on" : ""} onClick={() => onChange("current")}>
        {labels.current}
      </button>
      <button type="button" className={scope === "all" ? "on" : ""} onClick={() => onChange("all")}>
        {labels.all}
      </button>
    </span>
  );
}

/** 节点详情预览窗口：双击节点弹出的独立窗口——大预览 + 节点信息 +
 *  动作（上传/从库选择/打开文件）。多文件类别（角色/场景/道具）以
 *  条目呈现，配合按类别命名的 当前/全部 切换；片段窗口为三区块分组。 */
export default function ProjectNodeDetailDialog({
  title,
  accent,
  entries = [],
  count,
  scope,
  scopeLabels,
  onScopeChange,
  sections,
  extra,
  error,
  onClose,
}: ProjectNodeDetailDialogProps) {
  const { t } = useTranslation();
  const total = count ?? entries.length;
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
          <span className="pc-detail-count">{total}</span>
          {scope && onScopeChange && scopeLabels && (
            <ScopeToggle scope={scope} labels={scopeLabels} onChange={onScopeChange} />
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
            <DetailCard key={entry.key} entry={entry} />
          ))}
          {sections?.map((section) => (
            <div key={section.key} className="pc-detail-section">
              <div className="pc-detail-section-head">
                <b>{section.title}</b>
                <span className="pc-detail-count">{section.entries.length}</span>
                <ScopeToggle
                  scope={section.scope}
                  labels={section.scopeLabels}
                  onChange={section.onScopeChange}
                />
              </div>
              <div className={`pc-detail-section-body${section.entries.length > 1 ? " grid" : ""}`}>
                {section.entries.map((entry) => (
                  <DetailCard key={entry.key} entry={entry} />
                ))}
                {section.entries.length === 0 && (
                  <div className="pc-detail-empty">{t("project.canvas.detailNone")}</div>
                )}
              </div>
            </div>
          ))}
          {!sections && entries.length === 0 && (
            <div className="pc-detail-empty">{t("project.canvas.detailNone")}</div>
          )}
        </div>
        {error && <div className="pc-detail-error">{error}</div>}
        {extra}
      </div>
    </div>
  );
}
