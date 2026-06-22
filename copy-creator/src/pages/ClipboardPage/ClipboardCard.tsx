import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { memo, useCallback, useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClipboardRecord } from "../../types";
import { Icons } from "../../components/Icons";
import { ImageThumb } from "./ImageThumb";
import { formatTime, getFileName, TYPE_META } from "./utils";
import ApiKeyLabelPanel from "./ApiKeyLabelPanel";
import { useClipboardStore } from "../../stores/clipboardStore";

const COLLAPSE_TEXT_LENGTH = 160;
const COLLAPSE_LINE_COUNT = 4;

interface ClipboardCardProps {
  record: ClipboardRecord;
  index: number;
  getTypeLabel: (type: string) => string;
  onPaste: (r: ClipboardRecord) => void;
  onDelete: (id: string) => void;
  onThumbHover: (thumbSrc: string, rect: DOMRect) => void;
  onThumbLeave: () => void;
}

function ClipboardCardInner({
  record,
  index,
  getTypeLabel,
  onPaste,
  onDelete,
  onThumbHover,
  onThumbLeave,
}: ClipboardCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: record.id });

  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const meta = TYPE_META[record.type] || TYPE_META.text;
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [labelOpen, setLabelOpen] = useState(false);
  const [textExpanded, setTextExpanded] = useState(false);
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [loadingFullContent, setLoadingFullContent] = useState(false);
  const ctxRef = useRef<HTMLDivElement>(null);
  const loadRecords = useClipboardStore((s) => s.loadRecords);
  const getRecordContent = useClipboardStore((s) => s.getRecordContent);
  const displayContent = fullContent ?? record.content;
  const textLineCount = displayContent.split(/\r\n|\r|\n/).length;
  const canToggleText =
    record.type === "text" &&
    (record.content_truncated ||
      (record.content_length ?? displayContent.length) > COLLAPSE_TEXT_LENGTH ||
      textLineCount > COLLAPSE_LINE_COUNT);
  const isTextExpanded = canToggleText && textExpanded;

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
    if (!labelOpen) onPaste(record);
  }, [onPaste, record, labelOpen]);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete(record.id);
    },
    [onDelete, record.id],
  );

  const handleToggleText = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const nextExpanded = !isTextExpanded;
    setTextExpanded(nextExpanded);

    if (!nextExpanded || !record.content_truncated || fullContent) return;

    setLoadingFullContent(true);
    try {
      setFullContent(await getRecordContent(record));
    } catch {
      setTextExpanded(false);
    } finally {
      setLoadingFullContent(false);
    }
  }, [fullContent, getRecordContent, isTextExpanded, record]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleLabelSaved = useCallback(() => {
    setLabelOpen(false);
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
      className={`notification clipboard-card type-${record.type}${record.is_api_key ? " has-api-key" : ""}${isUnlabeled ? " api-key-unlabeled" : ""}${hasLabel ? " api-key-labeled" : ""}${isDragging ? " is-dragging" : ""}`}
      style={{ ...sortableStyle, "--color": meta.color, "--enter-delay": index } as React.CSSProperties}
      onClick={handlePaste}
      onContextMenu={handleContextMenu}
    >
      <div className="notibar" />
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
                setLabelOpen((v) => !v);
              }}
            >
              {badgeText || "未标注"}
            </span>
          )}
        </div>

        <div
          className={`notibody clipboard-card-body${canToggleText ? " is-toggleable" : ""}${canToggleText && !isTextExpanded ? " is-collapsed" : ""}${isTextExpanded ? " is-expanded" : ""}`}
        >
          {record.type === "image" ? (
            <ImageThumb
              record={record}
              onHover={onThumbHover}
              onLeave={onThumbLeave}
              onClick={(e) => {
                e.stopPropagation();
                onPaste(record);
              }}
            />
          ) : record.type === "link" ? (
            <span className="clipboard-link-content">{record.content}</span>
          ) : record.type === "file" ? (
            <span className="clipboard-file-content">{getFileName(record.content)}</span>
          ) : (
            <span className="clipboard-text-content" aria-expanded={canToggleText ? isTextExpanded : undefined}>
              {displayContent}
            </span>
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
            {canToggleText && (
              <button
                className="card-toggle-text-btn"
                onClick={handleToggleText}
                type="button"
                aria-expanded={isTextExpanded}
                aria-label={isTextExpanded ? "收起长文本" : "展开完整文本"}
                disabled={loadingFullContent}
              >
                <span>{loadingFullContent ? "加载" : isTextExpanded ? "收起" : "展开"}</span>
              </button>
            )}
            <span className="drag-handle" {...attributes} {...listeners}>
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
          </div>
        </div>
      </div>

      {/* Context menu */}
      {ctxMenu && (
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
              onPaste(record);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            粘贴
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

export const ClipboardCard = memo(ClipboardCardInner);
