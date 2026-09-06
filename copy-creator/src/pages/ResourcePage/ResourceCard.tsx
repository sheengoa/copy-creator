import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord } from "../../types";
import { Icons } from "../../components/Icons";
import { HighlightText } from "../../components/HighlightText";
import { InlineTextFilePreview } from "../../components/InlinePreview";
import { ImageThumb } from "../ClipboardPage/ImageThumb";
import { ResourceFileImage } from "./ResourceMedia";
import {
  formatResourceTime,
  getResourcePath,
  getResourceSummary,
  getResourceTitle,
  inferResourceMediaKind,
  type ResourceMediaKind,
} from "./resourceUtils";

interface ResourceCardProps {
  record: ClipboardRecord;
  search: string;
  typeLabel: (kind: ResourceMediaKind) => string;
  selectionMode: boolean;
  selected: boolean;
  reorderEnabled: boolean;
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
        record={record}
        onClick={(event) => {
          event.stopPropagation();
          onActivate?.();
        }}
      />
    );
  }

  if (kind === "video" || kind === "audio") {
    return (
      <div className={`resource-card-visual resource-card-${kind}`}>
        <span className="resource-card-visual-icon">{kind === "video" ? Icons.video : Icons.audio}</span>
        <span>{typeLabel(kind)}</span>
        {kind === "video" && <span className="resource-card-play">{Icons.play}</span>}
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
  reorderEnabled,
  onOpenDetail,
  onCopy,
  onDelete,
  onToggleSelected,
  onMove,
}: ResourceCardProps) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: record.id, disabled: !reorderEnabled || selectionMode });
  const kind = inferResourceMediaKind(record);
  const title = getResourceTitle(record, kind);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 卡片有 overflow 裁剪，菜单挂在文档根节点上按按钮位置定位。
  const updateMenuPosition = useCallback(() => {
    const buttonRect = moreButtonRef.current?.getBoundingClientRect();
    if (!buttonRect) return;
    const menuRect = menuRef.current?.getBoundingClientRect();
    const menuWidth = menuRect?.width ?? 158;
    const menuHeight = menuRect?.height ?? 148;
    const padding = 8;
    const left = Math.max(
      padding,
      Math.min(buttonRect.right - menuWidth, window.innerWidth - menuWidth - padding),
    );
    const fitsBelow = buttonRect.bottom + menuHeight + 6 <= window.innerHeight - padding;
    const top = fitsBelow
      ? buttonRect.bottom + 4
      : Math.max(padding, buttonRect.top - menuHeight - 4);
    setMenuPosition({ left, top });
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      if (moreButtonRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    const frame = requestAnimationFrame(updateMenuPosition);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
      cancelAnimationFrame(frame);
    };
  }, [menuOpen, updateMenuPosition]);

  const activateDetail = useCallback(() => {
    if (selectionMode) {
      onToggleSelected(record.id);
      return;
    }
    onOpenDetail(record);
  }, [onOpenDetail, onToggleSelected, record, selectionMode]);

  const runMenuAction = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  return (
    <article
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: transition || "transform 180ms ease",
      } as React.CSSProperties}
      className={`resource-card${selected ? " is-selected" : ""}${isDragging ? " is-dragging" : ""}`}
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
                setMenuPosition(null);
                setMenuOpen((open) => !open);
              }}
            >
              {Icons.more}
            </button>
          </div>
        )}
      </div>
      {onMove && !selectionMode && menuOpen && createPortal(
        <div
          ref={menuRef}
          className="resource-card-menu"
          role="menu"
          aria-label={t("resources.moreActions")}
          style={{
            left: menuPosition?.left ?? 0,
            top: menuPosition?.top ?? 0,
            visibility: menuPosition ? "visible" : "hidden",
          }}
        >
          <button type="button" role="menuitem" onClick={() => runMenuAction(() => void onCopy(record))}>
            {Icons.copy}
            <span>{t("resources.copy")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => runMenuAction(() => onOpenDetail(record))}>
            {Icons.expand}
            <span>{t("resources.openDetail")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="is-primary"
            onClick={() => runMenuAction(() => onMove(record))}
          >
            {Icons.arrowRight}
            <span>{t("resources.moveToGroup")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            onClick={() => runMenuAction(() => onDelete(record.id))}
          >
            {Icons.delete}
            <span>{t("common.delete")}</span>
          </button>
        </div>,
        document.body,
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
          <time dateTime={record.created_at}>{formatResourceTime(record.created_at)}</time>
        </div>
        <div className="resource-card-footer">
          <span className="resource-card-source">
            {record.has_images ? t("resources.withImages") : record.source_app || t("resources.localSource")}
          </span>
          <div className="resource-card-actions">
            {reorderEnabled && !selectionMode && (
              <button
                type="button"
                ref={setActivatorNodeRef}
                className="resource-drag-handle"
                {...attributes}
                {...listeners}
                title={t("resources.reorder")}
                aria-label={t("resources.reorder")}
                onClick={(event) => event.stopPropagation()}
              >
                {Icons.drag}
              </button>
            )}
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

export function ResourceCardDragPreview({
  record,
  search,
  typeLabel,
}: Pick<ResourceCardProps, "record" | "search" | "typeLabel">) {
  const kind = inferResourceMediaKind(record);
  return (
    <article className="resource-card is-drag-overlay">
      <div className="resource-card-preview">
        <ResourceCardVisual record={record} search={search} typeLabel={typeLabel} />
        <span className="resource-card-kind">{typeLabel(kind)}</span>
      </div>
      <div className="resource-card-body">
        <strong className="resource-card-title">{getResourceTitle(record, kind)}</strong>
        <div className="resource-card-meta">
          <span>{typeLabel(kind)}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={record.created_at}>{formatResourceTime(record.created_at)}</time>
        </div>
      </div>
    </article>
  );
}
