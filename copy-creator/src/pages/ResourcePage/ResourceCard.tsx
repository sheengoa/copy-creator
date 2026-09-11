import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";
import {
  CardActionMenu,
  CardActionMenuItem,
} from "../../components/CardActionMenu";
import { HighlightText } from "../../components/HighlightText";
import { InlineTextFilePreview } from "../../components/InlinePreview";
import { formatTime, formatRelativeTime } from "../../utils/formatTime";
import { recordUsageTime, resourceGroupLeafLabel } from "../../domain/records";
import { UsageCountBadge } from "../../components/UsageCountBadge";
import { ImageThumb } from "../ClipboardPage/ImageThumb";
import { ResourceFileImage, ResourceVideoPoster } from "./ResourceMedia";
import { type ResourceMediaKind } from "../../domain/mediaKind";
import { getResourceSummary } from "../../domain/records";
import type { RecordView } from "../../domain/recordView";

interface ResourceCardProps {
  /** 叶子合同：只收视图模型（DOMAIN_ARCHITECTURE_PLAN.md §3.10）。 */
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
  onCopy: (view: RecordView) => void | Promise<void>;
  onDelete: (id: string) => void;
  onToggleSelected: (id: string) => void;
  onMove?: (view: RecordView) => void;
}

function ResourceCardVisual({
  view,
  search,
  typeLabel,
  onActivate,
}: Pick<ResourceCardProps, "view" | "search" | "typeLabel"> & {
  onActivate?: () => void;
}) {
  const kind = view.kind;
  const summary = getResourceSummary({ type: view.recordType, content: view.content });
  const resourcePath = view.resourcePath ?? view.content;

  if (kind === "image" && view.recordType === "image") {
    return (
      <ImageThumb
        id={view.id}
        content={view.content}
        onClick={(event) => {
          event.stopPropagation();
          onActivate?.();
        }}
      />
    );
  }

  if (kind === "video") {
    return (
      <div className={`resource-card-visual resource-card-${kind}`}>
        <ResourceVideoPoster path={resourcePath} fallbackLabel={typeLabel(kind)} />
        <span className="resource-card-play">{Icons.play}</span>
      </div>
    );
  }

  if (kind === "audio") {
    return (
      <div className={`resource-card-visual resource-card-${kind}`}>
        <span className="resource-card-visual-icon">{Icons.audio}</span>
        <span>{typeLabel(kind)}</span>
      </div>
    );
  }

  if (kind === "image") {
    return (
      <ResourceFileImage
        path={resourcePath}
        alt={view.title}
        className="resource-card-file-image"
      />
    );
  }

  if (kind === "file") {
    return (
      <div className="resource-card-visual resource-card-file">
        {Icons.file}
        <span>{typeLabel(kind)}</span>
      </div>
    );
  }

  if (view.recordType === "file" && view.resourcePath) {
    return (
      <div className="resource-card-text-preview">
        <InlineTextFilePreview
          resourcePath={view.resourcePath}
          resourceVersion={view.createdAt}
          search={search}
        />
      </div>
    );
  }

  return (
    <div className={`resource-card-text-preview${view.recordType === "link" ? " is-link" : ""}`}>
      <HighlightText text={summary || " "} search={search} />
    </div>
  );
}

export function ResourceCard({
  view,
  search,
  typeLabel,
  selectionMode,
  selected,
  showGroupTag,
  showUsageBadge,
  onOpenDetail,
  onCopy,
  onDelete,
  onToggleSelected,
  onMove,
}: ResourceCardProps) {
  const { t } = useTranslation();
  const kind = view.kind;
  const title = view.title;
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
        <label className="resource-card-selection" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            aria-label={t("common.selectItem")}
            onChange={() => onToggleSelected(view.id)}
          />
          <span className="selection-checkbox" aria-hidden="true" />
        </label>
      )}
      <div className="resource-card-preview">
        <ResourceCardVisual
          view={view}
          search={search}
          typeLabel={typeLabel}
          onActivate={activateDetail}
        />
        <span className="resource-card-kind">{typeLabel(kind)}</span>
        {onMove && !selectionMode && (
          <div className="resource-card-more">
            <button
              type="button"
              ref={moreButtonRef}
              className="resource-card-more-button"
              aria-label={t("resources.moreActions")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title={t("resources.moreActions")}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((open) => !open);
              }}
            >
              {Icons.more}
            </button>
          </div>
        )}
      </div>
      {onMove && !selectionMode && (
        <CardActionMenu
          open={menuOpen}
          align="end"
          className="resource-card-menu"
          ariaLabel={t("resources.moreActions")}
          anchorEl={moreButtonRef}
          getAnchor={() => {
            const rect = moreButtonRef.current?.getBoundingClientRect();
            if (!rect) return null;
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
          }}
          onClose={() => setMenuOpen(false)}
        >
          <CardActionMenuItem
            icon={Icons.copy}
            label={t("resources.copy")}
            onClick={() => void onCopy(view)}
          />
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
        <div className="resource-card-footer">
          <span className="resource-card-source">
            {view.hasImages ? t("resources.withImages") : view.sourceApp || t("resources.localSource")}
          </span>
          <div className="resource-card-actions">
            {!selectionMode && (
              <>
                <button
                  type="button"
                  className="resource-copy-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void onCopy(view);
                  }}
                >
                  {Icons.copy}
                  <span>{t("resources.copy")}</span>
                </button>
                <button
                  type="button"
                  className="resource-delete-button"
                  aria-label={t("common.delete")}
                  title={t("common.delete")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(view.id);
                  }}
                >
                  {Icons.delete}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
