import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";
import {
  CardActionMenu,
  CardActionMenuItem,
} from "../../components/CardActionMenu";
import { HighlightText } from "../../components/HighlightText";
import { CardVisual } from "../../components/CardVisual";
import { formatTime, formatRelativeTime } from "../../utils/formatTime";
import { recordUsageTime, resourceGroupLeafLabel } from "../../domain/records";
import { revealResourceFile } from "../../domain/mediaAssets";
import { UsageCountBadge } from "../../components/UsageCountBadge";
import { CardMoreTrigger, CardSelectionCheckbox } from "../../components/CardShell";
import { cardActionMenuAnchor } from "../../utils/cardShell";
import { type ResourceMediaKind } from "../../domain/mediaKind";
import type { RecordView } from "../../domain/recordView";

interface ResourceCardProps {
  /** 叶子合同：只收视图模型。 */
  view: RecordView;
  search: string;
  typeLabel: (kind: ResourceMediaKind) => string;
  selectionMode: boolean;
  selected: boolean;
  /** 「全部分组」视图：显示所属分组标签与相对使用时间（分组浏览保持现状）。 */
  showGroupTag?: boolean;
  /** 「最多使用」模式且处于「全部分组」时显示次数徽标；分组浏览不应用。 */
  showUsageBadge?: boolean;
  onOpenDetail: (view: RecordView) => void;
  onDelete: (id: string) => void;
  onToggleSelected: (id: string) => void;
  onMove?: (view: RecordView) => void;
  /** 追溯文件（缺失记录的菜单项）；与详情页共用同一入口语义（守卫规则 23）。 */
  onTrace?: (view: RecordView) => void;
}

function ResourceCardInner({
  view,
  search,
  typeLabel,
  selectionMode,
  selected,
  showGroupTag,
  showUsageBadge,
  onOpenDetail,
  onDelete,
  onToggleSelected,
  onMove,
  onTrace,
}: ResourceCardProps) {
  const { t } = useTranslation();
  const kind = view.kind;
  const title = view.title;
  // 打开所在位置：仅文件承载记录可用（数据库承载的文本无文件可定位）。
  const revealPath = view.resourcePath ?? (view.recordType === "file" ? view.content : null);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!selectionMode) return;
    setMenuOpen(false);
  }, [selectionMode]);

  const activateDetail = useCallback(() => {
    if (selectionMode) {
      onToggleSelected(view.id);
      return;
    }
    onOpenDetail(view);
  }, [onOpenDetail, onToggleSelected, view, selectionMode]);

  return (
    <article
      className={`resource-card${selected ? " is-selected" : ""}`}
      onClick={activateDetail}
      tabIndex={0}
      aria-label={t("resources.openDetail")}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        activateDetail();
      }}
    >
      {selectionMode && (
        <CardSelectionCheckbox
          checked={selected}
          onToggle={() => onToggleSelected(view.id)}
        />
      )}
      <div className="resource-card-preview">
        <CardVisual
          view={view}
          search={search}
          typeLabel={typeLabel}
        />
        <span className="resource-card-kind">{typeLabel(kind)}</span>
        {onMove && !selectionMode && (
          <CardMoreTrigger
            open={menuOpen}
            onToggle={() => setMenuOpen((open) => !open)}
            buttonRef={moreButtonRef}
            label={t("resources.moreActions")}
          />
        )}
      </div>
      {onMove && !selectionMode && (
        <CardActionMenu
          open={menuOpen}
          align="end"
          className="resource-card-menu"
          ariaLabel={t("resources.moreActions")}
          anchorEl={moreButtonRef}
          getAnchor={() => cardActionMenuAnchor(moreButtonRef)}
          onClose={() => setMenuOpen(false)}
        >
          {revealPath && (
            <CardActionMenuItem
              icon={Icons.folderOpen}
              label={t("resources.openLocation")}
              disabled={view.resourceMissing}
              disabledTitle={t("resources.openLocationMissingDisabled")}
              onClick={() => void revealResourceFile(revealPath).catch(() => {})}
            />
          )}
          {view.resourceMissing && onTrace && (
            <CardActionMenuItem
              icon={Icons.search}
              label={t("resources.traceFile")}
              onClick={() => onTrace(view)}
            />
          )}
          <CardActionMenuItem
            icon={Icons.expand}
            label={t("resources.openDetail")}
            onClick={() => onOpenDetail(view)}
          />
          <CardActionMenuItem
            className="is-primary"
            icon={Icons.arrowRight}
            label={t("resources.moveToGroup")}
            onClick={() => onMove(view)}
          />
          <CardActionMenuItem
            className="is-danger"
            icon={Icons.delete}
            label={t("common.delete")}
            onClick={() => onDelete(view.id)}
          />
        </CardActionMenu>
      )}
      <div className="resource-card-body">
        <div className="resource-card-title-row">
          <strong className="resource-card-title">
            <HighlightText text={title} search={search} />
          </strong>
          {/* 缺失事实角标：recordView.resourceMissing（对账持久化标志），
              脱节当天在列表可见，不再等删除/恢复才暴露。 */}
          {view.resourceMissing && (
            <span className="resource-card-missing">{t("resources.fileMissing")}</span>
          )}
        </div>
        <div className="resource-card-meta">
          {showGroupTag && view.resourceGroup && (
            <span className="resource-card-group-tag" title={view.resourceGroup}>
              {resourceGroupLeafLabel(view.resourceGroup)}
            </span>
          )}
          <span>{typeLabel(kind)}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={view.createdAt}>
            {showGroupTag
              ? formatRelativeTime(recordUsageTime(view.lastUsedAt, view.createdAt))
              : formatTime(view.createdAt)}
          </time>
          {showUsageBadge && <UsageCountBadge count={view.useCount} />}
        </div>
      </div>
    </article>
  );
}

export const ResourceCard = memo(ResourceCardInner);
