import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import IconButton from "@mui/material/IconButton";
import CloseFullscreenIcon from "@mui/icons-material/CloseFullscreen";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord } from "../../types";
import { Icons } from "../../components/Icons";
import { InlineImagePreview, InlineTextFilePreview } from "../../components/InlinePreview";
import { ImageThumb } from "./ImageThumb";
import { formatTime, getFileName, TYPE_META } from "./utils";
import ApiKeyLabelPanel from "./ApiKeyLabelPanel";
import { HighlightText } from "../../components/HighlightText";
import { useClipboardStore } from "../../stores/clipboardStore";
import { shouldUseTerminalPasteForMouseTrigger } from "../../utils/pasteMode";
import { loadClipboardPreviewSegments } from "../../utils/contentPreview";
import type { RadialPreviewSegment } from "../../utils/radialPreview";
import {
  hasInlineTextPreviewExtension,
  shouldShowInlineTextToggle,
} from "../../utils/inlinePreview";

interface ClipboardCardProps {
  record: ClipboardRecord;
  index: number;
  getTypeLabel: (type: string) => string;
  pasteLeftClick: "normal" | "terminal";
  search?: string;
  onPasteNormal: (r: ClipboardRecord) => void;
  onPasteTerminal: (r: ClipboardRecord) => void;
  onDelete: (id: string) => void;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelected: (id: string) => void;
}

type ClipboardCardPreviewProps = {
  record: ClipboardRecord;
  getTypeLabel: (type: string) => string;
  width: number | null;
  search?: string;
};

function ClipboardCardBodyPreview({
  record,
  getTypeLabel,
  width,
  search,
}: ClipboardCardPreviewProps) {
  const meta = TYPE_META[record.type] || TYPE_META.text;
  const hasLabel = Boolean(record.is_api_key && record.label);
  const isUnlabeled = Boolean(record.is_api_key && !record.label);
  const badgeText = record.label?.note || record.guessed_service || (record.is_api_key ? "未标注" : "");

  return (
    <div
      className={`notification clipboard-card type-${record.type}${record.is_api_key ? " has-api-key" : ""}${isUnlabeled ? " api-key-unlabeled" : ""}${hasLabel ? " api-key-labeled" : ""} drag-overlay-card`}
      style={{ "--color": meta.color, width: width ?? undefined } as React.CSSProperties}
    >
      <div className="notibar" />
      <div className="noticontent">
        <div className="notititle clipboard-card-header">
          <span className="noti-type-label">
            <span className="noti-type-icon">{record.is_api_key ? Icons.key : meta.icon}</span>
            <span className="noti-type-text">{record.is_api_key ? "API Key" : getTypeLabel(record.type)}</span>
          </span>
          {record.is_api_key && (
            <span className="api-key-badge">{badgeText || "未标注"}</span>
          )}
        </div>

        <div className={`notibody clipboard-card-body${record.type === "image" ? "" : " is-content-summary"}`}>
          {record.type === "image" ? (
            <ImageThumb
              record={record}
              onClick={(e) => e.stopPropagation()}
            />
          ) : record.type === "link" ? (
            <span className="clipboard-link-content"><HighlightText text={record.content} search={search} /></span>
          ) : record.type === "file" ? (
            <span className="clipboard-file-content"><HighlightText text={getFileName(record.content)} search={search} /></span>
          ) : (
            <span className="clipboard-text-content"><HighlightText text={record.content} search={search} /></span>
          )}
        </div>

        <div className="notititle clipboard-card-footer">
          <span className="clipboard-card-time">{formatTime(record.created_at)}</span>
          <div className="clipboard-card-actions">
            <span className="drag-handle">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="9" cy="5" r="1.5" />
                <circle cx="15" cy="5" r="1.5" />
                <circle cx="9" cy="12" r="1.5" />
                <circle cx="15" cy="12" r="1.5" />
                <circle cx="9" cy="19" r="1.5" />
                <circle cx="15" cy="19" r="1.5" />
              </svg>
            </span>
            <button className="card-delete-btn" type="button" disabled>
              {Icons.delete}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ClipboardExpandedPreview({
  record,
  search,
}: {
  record: ClipboardRecord;
  search?: string;
}) {
  const { t } = useTranslation();
  const [segments, setSegments] = useState<RadialPreviewSegment[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSegments(null);
    setFailed(false);
    loadClipboardPreviewSegments(record)
      .then((next) => {
        if (!cancelled) setSegments(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [record]);

  if (failed) {
    return (
      <div className="inline-preview-error" role="alert">
        {t("resources.previewError")}
      </div>
    );
  }
  if (segments === null) {
    return <div className="inline-preview-loading" aria-label={t("common.loading")} />;
  }

  return (
    <div className="clipboard-card-expanded-content">
      {segments.map((segment, index) =>
        segment.type === "image" ? (
          <InlineImagePreview
            key={`image-${index}-${segment.path}`}
            path={segment.path}
            alt={t("radialMenu.previewImage")}
            className="clipboard-card-expanded-image"
          />
        ) : (
          <div className="clipboard-card-expanded-text" key={`text-${index}`}>
            <HighlightText text={segment.content} search={search} />
          </div>
        ),
      )}
    </div>
  );
}

function ClipboardCardInner({
  record,
  index,
  getTypeLabel,
  pasteLeftClick,
  search,
  onPasteNormal,
  onPasteTerminal,
  onDelete,
  selectionMode,
  selected,
  onToggleSelected,
}: ClipboardCardProps) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: record.id, disabled: selectionMode });

  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition: transition || "transform 200ms ease",
  };

  const meta = TYPE_META[record.type] || TYPE_META.text;
  const canPreviewFile = record.type === "file" && hasInlineTextPreviewExtension(record.content);
  const canToggleText = record.type === "file"
    ? canPreviewFile
    : Boolean(record.has_images)
      || shouldShowInlineTextToggle(record.content, record.content_truncated);
  const canToggle = record.type === "image" || canToggleText;
  const canCollapseText = record.type !== "image" && record.type !== "file"
    && shouldShowInlineTextToggle(record.content, record.content_truncated);
  const [expanded, setExpanded] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [labelOpen, setLabelOpen] = useState(false);
  const ctxRef = useRef<HTMLDivElement>(null);
  const loadRecords = useClipboardStore((s) => s.loadRecords);
  const getRecordContent = useClipboardStore((s) => s.getRecordContent);

  useEffect(() => {
    if (!selectionMode) return;
    setCtxMenu(null);
    setLabelOpen(false);
  }, [selectionMode]);

  useEffect(() => {
    setExpanded(false);
  }, [record.id, record.content]);

  // Close context menu on outside click / ESC
  useEffect(() => {
    if (!ctxMenu) return;
    const handler = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [ctxMenu]);

  const handlePaste = useCallback(() => {
    if (labelOpen) return;
    if (shouldUseTerminalPasteForMouseTrigger(pasteLeftClick, "left")) onPasteTerminal(record);
    else onPasteNormal(record);
  }, [onPasteNormal, onPasteTerminal, pasteLeftClick, record, labelOpen]);

  const handleSecondaryPaste = useCallback(() => {
    if (labelOpen) return;
    if (shouldUseTerminalPasteForMouseTrigger(pasteLeftClick, "right")) onPasteTerminal(record);
    else onPasteNormal(record);
  }, [onPasteNormal, onPasteTerminal, pasteLeftClick, record, labelOpen]);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete(record.id);
    },
    [onDelete, record.id],
  );

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleLabelSaved = useCallback(() => {
    setLabelOpen(false);
  }, []);

  const handleToggleExpanded = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setExpanded((value) => !value);
  }, []);

  const handleToggleUserApiKey = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      setCtxMenu(null);
      const newValue = !record.user_api_key;
      try {
        await invoke("set_user_api_key", { id: record.id, value: newValue });
        await loadRecords();
      } catch {
        // ignore
      }
    },
    [record.id, record.user_api_key, loadRecords],
  );

  const handleCopyWithComment = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      setCtxMenu(null);
      if (!record.label) return;
      try {
        const content = await getRecordContent(record);
        const text = `# ${record.label.service} — ${record.label.api_base}\n${content}`;
        await navigator.clipboard.writeText(text);
      } catch {
        // Fallback: silently ignore; user can use regular copy
      }
    },
    [getRecordContent, record],
  );

  const hasLabel = Boolean(record.is_api_key && record.label);
  const isUnlabeled = Boolean(record.is_api_key && !record.label);

  // Keep badge text in local state to ensure re-render on label change
  const [badgeText, setBadgeText] = useState("");
  useEffect(() => {
    if (record.label?.note) {
      setBadgeText(record.label.note);
    } else if (record.guessed_service) {
      setBadgeText(record.guessed_service);
    } else if (record.is_api_key) {
      setBadgeText("未标注");
    }
  }, [record.label?.note, record.guessed_service, record.is_api_key]);

  return (
    <div
      ref={setNodeRef}
      className={`notification clipboard-card type-${record.type}${record.is_api_key ? " has-api-key" : ""}${isUnlabeled ? " api-key-unlabeled" : ""}${hasLabel ? " api-key-labeled" : ""}${isDragging ? " is-dragging" : ""}${selectionMode ? " is-selection-mode" : ""}${selected ? " is-selected" : ""}`}
      style={{ ...sortableStyle, "--color": meta.color, "--enter-delay": index } as React.CSSProperties}
      onClick={selectionMode ? () => onToggleSelected(record.id) : handlePaste}
      onContextMenu={selectionMode ? (e) => { e.preventDefault(); e.stopPropagation(); } : handleContextMenu}
    >
      <div className="notibar" />
      {selectionMode && (
        <label className="card-selection-control" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            aria-label={t("common.selectItem")}
            onChange={() => onToggleSelected(record.id)}
          />
          <span className="selection-checkbox" aria-hidden="true" />
        </label>
      )}
      <div className="noticontent">
        <div className="notititle clipboard-card-header">
          <span className="noti-type-label">
            <span className="noti-type-icon">{record.is_api_key ? Icons.key : meta.icon}</span>
            <span className="noti-type-text">{record.is_api_key ? "API Key" : getTypeLabel(record.type)}</span>
          </span>
          {record.is_api_key && (
            <span
              className="api-key-badge"
              onClick={(e) => {
                e.stopPropagation();
                if (selectionMode) onToggleSelected(record.id);
                else setLabelOpen((v) => !v);
              }}
            >
              {badgeText || "未标注"}
            </span>
          )}
        </div>

        <div
          className={`notibody clipboard-card-body${canToggle ? " is-toggleable" : ""}${canCollapseText && !expanded ? " is-collapsed" : ""}${canToggle && expanded ? " is-expanded" : ""}${record.type === "file" && expanded ? " is-file-expanded" : ""}`}
        >
          {record.type === "image" ? (
            expanded ? (
              <InlineImagePreview
                path={record.content}
                alt={t("radialMenu.previewImage")}
                className="clipboard-card-expanded-image"
              />
            ) : (
              <ImageThumb
                record={record}
                onClick={(e) => {
                  e.stopPropagation();
                  if (selectionMode) onToggleSelected(record.id);
                  else handlePaste();
                }}
              />
            )
          ) : record.type === "link" ? (
            expanded ? (
              <ClipboardExpandedPreview record={record} search={search} />
            ) : (
              <span className="clipboard-link-content"><HighlightText text={record.content} search={search} /></span>
            )
          ) : record.type === "file" ? (
            <>
              <span className="clipboard-file-content"><HighlightText text={getFileName(record.content)} search={search} /></span>
              {expanded && canPreviewFile && (
                <InlineTextFilePreview recordId={record.id} search={search} />
              )}
            </>
          ) : (
            expanded ? (
              <ClipboardExpandedPreview record={record} search={search} />
            ) : (
              <span className="clipboard-text-content">
                <HighlightText text={record.content} search={search} />
              </span>
            )
          )}
        </div>

        {labelOpen && record.is_api_key && record.key_preview && (
          <ApiKeyLabelPanel
            recordId={record.id}
            keyPreview={record.key_preview}
            existingLabel={record.label}
            guessedService={record.guessed_service}
            onSave={handleLabelSaved}
            onCancel={() => setLabelOpen(false)}
          />
        )}

        <div className="notititle clipboard-card-footer">
          <span className="clipboard-card-time">{formatTime(record.created_at)}</span>
          <div className="clipboard-card-actions">
            {!selectionMode && (
              <>
                {canToggle && (
                  <IconButton
                    className="card-toggle-text-btn"
                    type="button"
                    size="small"
                    disableRipple
                    aria-expanded={expanded}
                    aria-label={t(expanded ? "phrases.collapseText" : "phrases.expandText")}
                    title={t(expanded ? "phrases.collapseText" : "phrases.expandText")}
                    onClick={handleToggleExpanded}
                  >
                    {expanded ? (
                      <CloseFullscreenIcon fontSize="inherit" />
                    ) : (
                      <OpenInFullIcon fontSize="inherit" />
                    )}
                  </IconButton>
                )}
                <span ref={setActivatorNodeRef} className="drag-handle" {...attributes} {...listeners}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="9" cy="5" r="1.5" />
                    <circle cx="15" cy="5" r="1.5" />
                    <circle cx="9" cy="12" r="1.5" />
                    <circle cx="15" cy="12" r="1.5" />
                    <circle cx="9" cy="19" r="1.5" />
                    <circle cx="15" cy="19" r="1.5" />
                  </svg>
                </span>
                <button className="card-delete-btn" onClick={handleDelete}>
                  {Icons.delete}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Context menu */}
      {ctxMenu && !selectionMode && (
        <div
          ref={ctxRef}
          className="clipboard-ctx-menu"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {record.is_api_key && (
            <button
              className="ctx-menu-item"
              onClick={(e) => {
                e.stopPropagation();
                setCtxMenu(null);
                setLabelOpen(true);
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                <line x1="7" y1="7" x2="7.01" y2="7" />
              </svg>
              标注 API 来源
            </button>
          )}
          {record.is_api_key && hasLabel && (
            <button className="ctx-menu-item" onClick={handleCopyWithComment}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              复制含注释
            </button>
          )}
          {record.type === "text" && !record.is_api_key && (
            <button className="ctx-menu-item" onClick={handleToggleUserApiKey}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                <line x1="7" y1="7" x2="7.01" y2="7" />
              </svg>
              标记为 API Key
            </button>
          )}
          {record.user_api_key && (
            <button className="ctx-menu-item" onClick={handleToggleUserApiKey}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              取消 API Key 标记
            </button>
          )}
          {(record.is_api_key || (record.type === "text" && !record.is_api_key)) && <div className="ctx-menu-sep" />}
          <button
            className="ctx-menu-item"
            onClick={(e) => {
              e.stopPropagation();
              setCtxMenu(null);
              handleSecondaryPaste();
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            {pasteLeftClick === "terminal" ? t("clipboard.pasteNormal") : t("clipboard.pasteToTerminal")}
          </button>
          <button
            className="ctx-menu-item"
            onClick={(e) => {
              e.stopPropagation();
              setCtxMenu(null);
              handlePaste();
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            {pasteLeftClick === "terminal" ? t("clipboard.pasteToTerminal") : t("clipboard.pasteNormal")}
          </button>
          <div className="ctx-menu-sep" />
          <button
            className="ctx-menu-item danger"
            onClick={(e) => {
              e.stopPropagation();
              setCtxMenu(null);
              onDelete(record.id);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
            删除
          </button>
        </div>
      )}
    </div>
  );
}

export function ClipboardCard(props: ClipboardCardProps) {
  return <ClipboardCardInner {...props} />;
}

export function ClipboardCardDragPreview(props: ClipboardCardPreviewProps) {
  return <ClipboardCardBodyPreview {...props} />;
}
