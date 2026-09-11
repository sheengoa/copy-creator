import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord } from "../../types";
import { Icons } from "../../components/Icons";
import {
  CardActionMenu,
  CardActionMenuItem,
} from "../../components/CardActionMenu";
import { HighlightText } from "../../components/HighlightText";
import { InlineTextFilePreview } from "../../components/InlinePreview";
import { formatTime } from "../../utils/formatTime";
import { ImageThumb } from "../ClipboardPage/ImageThumb";
import { ResourceFileImage, ResourceVideoPoster } from "./ResourceMedia";
import { inferResourceMediaKind, type ResourceMediaKind } from "../../domain/mediaKind";
import { getResourcePath, getResourceSummary, getResourceTitle } from "../../domain/records";

interface ResourceCardProps {
  record: ClipboardRecord;
  search: string;
  typeLabel: (kind: ResourceMediaKind) => string;
  selectionMode: boolean;
  selected: boolean;
  /** 「最多使用」模式且处于「全部分组」时显示次数徽标；分组浏览不应用。 */
  showUsageBadge?: boolean;
  onOpenDetail: (record: ClipboardRecord) => void;
  onCopy: (record: ClipboardRecord) => void | Promise<void>;
  onDelete: (id: string) => void;
  onToggleSelected: (id: string) => void;
  onMove?: (record: ClipboardRecord) => void;
}

function ResourceCardVisual({
  record,
  search,
  typeLabel,
  onActivate,
}: Pick<ResourceCardProps, "record" | "search" | "typeLabel"> & {
  onActivate?: () => void;
}) {
  const kind = inferResourceMediaKind(record);
  const summary = getResourceSummary(record);
  const resourcePath = getResourcePath(record);

  if (kind === "image" && record.type === "image") {
    return (
      <ImageThumb
        id={record.id}
        content={record.content}
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
        alt={getResourceTitle(record, kind)}
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

  if (record.type === "file" && record.resource_path) {
    return (
      <div className="resource-card-text-preview">
        <InlineTextFilePreview
          resourcePath={record.resource_path}
          resourceVersion={record.created_at}
          search={search}
        />
      </div>
    );
  }

  return (
    <div className={`resource-card-text-preview${record.type === "link" ? " is-link" : ""}`}>
      <HighlightText text={summary || " "} search={search} />
    </div>
  );
}

export function ResourceCard({
  record,
  search,
  typeLabel,
  selectionMode,
  selected,
  showUsageBadge,
  onOpenDetail,
  onCopy,
  onDelete,
  onToggleSelected,
  onMove,
}: ResourceCardProps) {
  const { t } = useTranslation();
  const kind = inferResourceMediaKind(record);
  const title = getResourceTitle(record, kind);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!selectionMode) return;
    setMenuOpen(false);
  }, [selectionMode]);

  const activateDetail = useCallback(() => {
    if (selectionMode) {
      onToggleSelected(record.id);
      return;
    }
    onOpenDetail(record);
  }, [onOpenDetail, onToggleSelected, record, selectionMode]);

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
            onChange={() => onToggleSelected(record.id)}
          />
          <span className="selection-checkbox" aria-hidden="true" />
        </label>
      )}
      <div className="resource-card-preview">
        <ResourceCardVisual
          record={record}
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
            onClick={() => void onCopy(record)}
          />
          <CardActionMenuItem
            icon={Icons.expand}
            label={t("resources.openDetail")}
            onClick={() => onOpenDetail(record)}
          />
          <CardActionMenuItem
            className="is-primary"
            icon={Icons.arrowRight}
            label={t("resources.moveToGroup")}
            onClick={() => onMove(record)}
          />
          <CardActionMenuItem
            className="is-danger"
            icon={Icons.delete}
            label={t("common.delete")}
            onClick={() => onDelete(record.id)}
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
          <span>{typeLabel(kind)}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={record.created_at}>{formatTime(record.created_at)}</time>
          {showUsageBadge && (
            <span className="usage-count-badge">
              {t("common.usageCount", { count: record.use_count ?? 0 })}
            </span>
          )}
        </div>
        <div className="resource-card-footer">
          <span className="resource-card-source">
            {record.has_images ? t("resources.withImages") : record.source_app || t("resources.localSource")}
          </span>
          <div className="resource-card-actions">
            {!selectionMode && (
              <>
                <button
                  type="button"
                  className="resource-copy-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void onCopy(record);
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
                    onDelete(record.id);
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
