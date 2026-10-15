import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";
import { isMassMissing } from "./resourceUtils";

export interface CleanupMissingEntry {
  id: string;
  name: string;
}

export interface CleanupCheckSummary {
  libraryAccessible: boolean;
  totalResources: number;
  stillMissing: CleanupMissingEntry[];
}

interface ResourceCleanupDialogProps {
  open: boolean;
  /** 打开时先实时复查（磁盘逐条 stat），期间展示检查中状态。 */
  checking: boolean;
  /** 复查结果（null = 尚未完成）。 */
  check: CleanupCheckSummary | null;
  cleaning: boolean;
  /** 资源库根路径（离线面板展示用）。 */
  libraryPath: string;
  onClose: () => void;
  /** 确认删除复查后仍缺失的全部记录（进回收站）。 */
  onConfirm: (entries: CleanupMissingEntry[]) => void;
  /** 「重新检查」/「先检查存储」：关闭对话框回到列表重新校准。 */
  onRecheck: () => void;
  /** 「先检查存储」：关闭对话框并打开资源库设置。 */
  onOpenLibrarySettings: () => void;
}

const MAX_LIST_ROWS = 12;

/**
 * 清理缺失记录确认对话框：结构为「复查结论 → 将删除的文件清单 →
 * 回收站兜底说明 → 动作」。库不可访问时拒绝清理（防止存储离线时
 * 误删全部记录）；缺失占比触阈值时升级强确认并给出「先检查存储」出口。
 */
export default function ResourceCleanupDialog({
  open,
  checking,
  check,
  cleaning,
  libraryPath,
  onClose,
  onConfirm,
  onRecheck,
  onOpenLibrarySettings,
}: ResourceCleanupDialogProps) {
  const { t } = useTranslation();
  if (!open) return null;

  // 字段归一化前置：清单与总数先取默认值再参与计算，序列化命名的任何
  // 偏差都降级为「空清单」而非渲染抛错整页卸载（曾有字段命名错位导致
  // undefined.length 崩掉整页的事故）。
  const entries = check?.stillMissing ?? [];
  const totalResources = check?.totalResources ?? 0;
  const count = entries.length;
  const mass = check !== null
    && check.libraryAccessible === true
    && isMassMissing(count, totalResources);
  const percent = totalResources > 0
    ? Math.round((count / totalResources) * 100)
    : 0;
  const visibleEntries = entries.slice(0, MAX_LIST_ROWS);
  const overflow = count - visibleEntries.length;

  return (
    <div className="dialog-overlay" onClick={checking || cleaning ? undefined : onClose}>
      <div className="dialog-content resource-cleanup-dialog" onClick={(event) => event.stopPropagation()}>
        <h3 className="dialog-title">
          {mass ? t("resources.cleanupMassTitle") : t("resources.cleanupTitle")}
        </h3>

        {checking && (
          <div className="resource-trace-searching" aria-busy="true">
            <span className="resource-trace-spinner" aria-hidden="true" />
            <span>{t("resources.rechecking")}</span>
          </div>
        )}

        {!checking && check && check.libraryAccessible !== true && (
          <>
            <div className="dialog-callout error" role="alert">
              <span className="resource-trace-warn-mark" aria-hidden="true" />
              <span>
                {t("resources.cleanupOfflineReason")}
                <br />
                <b className="resource-cleanup-offline-path">{libraryPath}</b>
              </span>
            </div>
            <div className="dialog-footnote">
              {Icons.expand}
              <span>{t("resources.cleanupOfflineAdvice")}</span>
            </div>
            <div className="dialog-actions">
              <button type="button" className="dialog-btn secondary" onClick={onClose}>
                {t("resources.cleanupOfflineDismiss")}
              </button>
              <button type="button" className="dialog-btn primary" onClick={onRecheck}>
                {t("resources.recheck")}
              </button>
            </div>
          </>
        )}

        {!checking && check?.libraryAccessible && count === 0 && (
          <>
            <div className="dialog-callout ok" role="status">
              {Icons.check}
              <span>{t("resources.cleanupEmpty")}</span>
            </div>
            <div className="dialog-actions">
              <button type="button" className="dialog-btn primary" onClick={onClose}>
                {t("resources.traceDone")}
              </button>
            </div>
          </>
        )}

        {!checking && check?.libraryAccessible && count > 0 && (
          <>
            {mass ? (
              <div className="dialog-callout error" role="alert">
                <span className="resource-trace-warn-mark" aria-hidden="true" />
                <span>
                  {t("resources.cleanupMassWarn", { count, total: totalResources, percent })}
                </span>
              </div>
            ) : (
              <div className="dialog-callout ok" role="status">
                {Icons.check}
                <span>{t("resources.cleanupRechecked", { count })}</span>
              </div>
            )}

            <div className="dialog-section-label">
              {mass
                ? t("resources.cleanupWillDelete")
                : t("resources.cleanupStillMissing", { count })}
            </div>
            <div className="dialog-file-list" role="list">
              {visibleEntries.map((entry) => (
                <div className="dialog-file-row" role="listitem" key={entry.id}>
                  {Icons.file}
                  <span className="name">{entry.name}</span>
                </div>
              ))}
              {overflow > 0 && (
                <div className="dialog-file-row is-more">
                  {t("resources.cleanupMore", { count: overflow })}
                </div>
              )}
            </div>
            <div className="dialog-footnote">
              {Icons.expand}
              <span>
                {mass ? t("resources.cleanupMassNote") : t("resources.cleanupFootnote")}
              </span>
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="dialog-btn secondary"
                disabled={cleaning}
                onClick={onClose}
              >
                {t("common.cancel")}
              </button>
              {mass && (
                <button
                  type="button"
                  className="dialog-btn save"
                  disabled={cleaning}
                  onClick={onOpenLibrarySettings}
                >
                  {t("resources.cleanupCheckStorage")}
                </button>
              )}
              <button
                type="button"
                className={`dialog-btn ${mass ? "destructive" : "save"}`}
                disabled={cleaning}
                onClick={() => onConfirm(entries)}
              >
                {mass
                  ? t("resources.cleanupMassConfirm", { count })
                  : t("resources.cleanupConfirm", { count })}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
