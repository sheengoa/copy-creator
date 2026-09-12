import { useCallback, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";
import {
  CardActionMenu,
  CardActionMenuItem,
  CardActionMenuSeparator,
} from "../../components/CardActionMenu";
import { InlineImagePreview, InlineTextFilePreview } from "../../components/InlinePreview";
import { FileMediaVisual } from "../../components/FileMediaPreview";
import { ResourceMediaPlayer } from "../ResourcePage/ResourceMedia";
import { ImageThumb } from "./ImageThumb";
import { TYPE_META } from "./utils";
import { formatRelativeTime } from "../../utils/formatTime";
import { recordUsageTime } from "../../domain/records";
import { UsageCountBadge } from "../../components/UsageCountBadge";
import { useSettingsStore } from "../../stores/settingsStore";
import ApiKeyLabelPanel from "./ApiKeyLabelPanel";
import { HighlightText } from "../../components/HighlightText";
import { shouldUseTerminalPasteForMouseTrigger } from "../../utils/pasteMode";
import { loadRecordPreviewSegments, type RadialPreviewSegment } from "../../domain/preview";
import type { RecordView } from "../../domain/recordView";

interface ClipboardCardProps {
  /** 叶子合同：只收视图模型（DOMAIN_ARCHITECTURE_PLAN.md §3.10）。 */
  view: RecordView;
  index: number;
  getTypeLabel: (type: string) => string;
  pasteLeftClick: "normal" | "terminal";
  search?: string;
  onPasteNormal: (view: RecordView) => void;
  onPasteTerminal: (view: RecordView) => void;
  onDelete: (id: string) => void;
  /** 右键菜单「移到顶部」：搜索定位后一键置顶，径向菜单同步可见。 */
  onMoveToTop?: (id: string) => void;
  /** 数据/动作经容器回调进出（叶子禁 import stores/invoke）。 */
  getRecordContent: (view: RecordView) => Promise<string>;
  onToggleUserApiKey: (view: RecordView) => void;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelected: (id: string) => void;
}

function ClipboardExpandedPreview({
  view,
  search,
}: {
  view: RecordView;
  search?: string;
}) {
  const { t } = useTranslation();
  const [segments, setSegments] = useState<RadialPreviewSegment[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSegments(null);
    setFailed(false);
    loadRecordPreviewSegments(view)
      .then((next) => {
        if (!cancelled) setSegments(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [view]);

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
            zoomable
          />
        ) : segment.type === "text" ? (
          <div className="clipboard-card-expanded-text" key={`text-${index}`}>
            <HighlightText text={segment.content} search={search} />
          </div>
        ) : null,
      )}
    </div>
  );
}

function ClipboardCardInner({
  view,
  index,
  getTypeLabel,
  pasteLeftClick,
  search,
  onPasteNormal,
  onPasteTerminal,
  onDelete,
  onMoveToTop,
  getRecordContent,
  onToggleUserApiKey,
  selectionMode,
  selected,
  onToggleSelected,
}: ClipboardCardProps) {
  const { t } = useTranslation();
  const isCountSort = useSettingsStore((s) => s.contentSort === "count");

  const meta = TYPE_META[view.recordType] || TYPE_META.text;
  // 展开能力/预览类型全部来自视图模型的判定字段（domain/records.ts）。
  const canToggle = view.expandable;
  const canCollapseText = view.recordType !== "image" && view.recordType !== "file"
    && view.expandPreview === "text";
  const [expanded, setExpanded] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [labelOpen, setLabelOpen] = useState(false);
  const apiKey = view.apiKey;
  const isApiKey = apiKey !== undefined;

  useEffect(() => {
    if (!selectionMode) return;
    setCtxMenu(null);
    setLabelOpen(false);
  }, [selectionMode]);

  useEffect(() => {
    setExpanded(false);
  }, [view.id, view.content]);

  const handlePaste = useCallback(() => {
    if (labelOpen) return;
    if (shouldUseTerminalPasteForMouseTrigger(pasteLeftClick, "left")) onPasteTerminal(view);
    else onPasteNormal(view);
  }, [onPasteNormal, onPasteTerminal, pasteLeftClick, view, labelOpen]);

  const handleSecondaryPaste = useCallback(() => {
    if (labelOpen) return;
    if (shouldUseTerminalPasteForMouseTrigger(pasteLeftClick, "right")) onPasteTerminal(view);
    else onPasteNormal(view);
  }, [onPasteNormal, onPasteTerminal, pasteLeftClick, view, labelOpen]);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete(view.id);
    },
    [onDelete, view.id],
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

  const handleToggleUserApiKey = useCallback(() => {
    setCtxMenu(null);
    onToggleUserApiKey(view);
  }, [onToggleUserApiKey, view]);

  const handleCopyWithComment = useCallback(async () => {
    setCtxMenu(null);
    if (!apiKey?.label) return;
    try {
      const content = await getRecordContent(view);
      const text = `# ${apiKey.label.service} — ${apiKey.label.api_base}\n${content}`;
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback: silently ignore; user can use regular copy
    }
  }, [getRecordContent, view, apiKey]);

  const hasLabel = Boolean(isApiKey && apiKey?.label);
  const isUnlabeled = Boolean(isApiKey && !apiKey?.label);

  // Keep badge text in local state to ensure re-render on label change
  const [badgeText, setBadgeText] = useState("");
  useEffect(() => {
    if (apiKey?.label?.note) {
      setBadgeText(apiKey.label.note);
    } else if (apiKey?.guessedService) {
      setBadgeText(apiKey.guessedService);
    } else if (isApiKey) {
      setBadgeText(t("clipboard.unlabeled"));
    }
  }, [apiKey?.label?.note, apiKey?.guessedService, isApiKey, t]);

  return (
    <div
      className={`notification clipboard-card type-${view.recordType}${isApiKey ? " has-api-key" : ""}${isUnlabeled ? " api-key-unlabeled" : ""}${hasLabel ? " api-key-labeled" : ""}${selectionMode ? " is-selection-mode" : ""}${selected ? " is-selected" : ""}`}
      style={{ "--color": meta.color, "--enter-delay": index } as React.CSSProperties}
      onClick={selectionMode ? () => onToggleSelected(view.id) : handlePaste}
      onContextMenu={selectionMode ? (e) => { e.preventDefault(); e.stopPropagation(); } : handleContextMenu}
    >
      <div className="notibar" />
      {selectionMode && (
        <label className="card-selection-control" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            aria-label={t("common.selectItem")}
            onChange={() => onToggleSelected(view.id)}
          />
          <span className="selection-checkbox" aria-hidden="true" />
        </label>
      )}
      <div className="noticontent">
        <div className="notititle clipboard-card-header">
          <span className="noti-type-label">
            <span className="noti-type-icon">{isApiKey ? Icons.key : meta.icon}</span>
            <span className="noti-type-text">{isApiKey ? "API Key" : getTypeLabel(view.recordType)}</span>
          </span>
          {isApiKey && (
            <span
              className="api-key-badge"
              onClick={(e) => {
                e.stopPropagation();
                if (selectionMode) onToggleSelected(view.id);
                else setLabelOpen((v) => !v);
              }}
            >
              {badgeText || t("clipboard.unlabeled")}
            </span>
          )}
        </div>

        <div
          className={`notibody clipboard-card-body${canToggle ? " is-toggleable" : ""}${canCollapseText && !expanded ? " is-collapsed" : ""}${canToggle && expanded ? " is-expanded" : ""}${view.recordType === "file" && expanded ? " is-file-expanded" : ""}`}
        >
          {view.recordType === "image" ? (
            expanded ? (
              <InlineImagePreview
                path={view.content}
                alt={t("radialMenu.previewImage")}
                className="clipboard-card-expanded-image"
                zoomable
              />
            ) : (
              <ImageThumb
                id={view.id}
                content={view.content}
                onClick={(e) => {
                  e.stopPropagation();
                  if (selectionMode) onToggleSelected(view.id);
                  else handlePaste();
                }}
              />
            )
          ) : view.recordType === "link" ? (
            expanded ? (
              <ClipboardExpandedPreview view={view} search={search} />
            ) : (
              <span className="clipboard-link-content"><HighlightText text={view.content} search={search} /></span>
            )
          ) : view.recordType === "file" ? (
            <>
              {/* 展开显示媒体/大图时隐藏封面帧：视觉上封面被"拉大"为预览，不再叠两个 */}
              {(!expanded || view.expandPreview === null || view.expandPreview === "text") && (
                <FileMediaVisual path={view.content} />
              )}
              <span className="clipboard-file-content"><HighlightText text={view.displayName} search={search} /></span>
              {expanded && view.expandPreview !== null && (
                view.expandPreview === "video" || view.expandPreview === "audio" ? (
                  <div className={`clipboard-media-slot is-${view.expandPreview}`}>
                    <ResourceMediaPlayer kind={view.expandPreview} path={view.content} />
                  </div>
                ) : view.expandPreview === "image" ? (
                  <InlineImagePreview
                    path={view.content}
                    alt={t("radialMenu.previewImage")}
                    className="clipboard-card-expanded-image"
                    zoomable
                  />
                ) : (
                  <InlineTextFilePreview recordId={view.id} search={search} />
                )
              )}
            </>
          ) : (
            expanded ? (
              <ClipboardExpandedPreview view={view} search={search} />
            ) : (
              <span className="clipboard-text-content">
                <HighlightText text={view.content} search={search} />
              </span>
            )
          )}
        </div>

        {labelOpen && apiKey?.preview && (
          <ApiKeyLabelPanel
            recordId={view.id}
            keyPreview={apiKey.preview}
            existingLabel={apiKey.label}
            guessedService={apiKey.guessedService}
            onSave={handleLabelSaved}
            onCancel={() => setLabelOpen(false)}
          />
        )}

        <div className="notititle clipboard-card-footer">
          <span className="clipboard-card-time">
            {formatRelativeTime(recordUsageTime(view.lastUsedAt, view.createdAt))}
          </span>
          {isCountSort && <UsageCountBadge count={view.useCount} />}
          <div className="clipboard-card-actions">
            {!selectionMode && (
              <>
                {canToggle && (
                  <button
                    className="card-toggle-text-btn"
                    type="button"
                    aria-expanded={expanded}
                    aria-label={t(expanded ? "phrases.collapseText" : "phrases.expandText")}
                    title={t(expanded ? "phrases.collapseText" : "phrases.expandText")}
                    onClick={handleToggleExpanded}
                  >
                    {expanded ? Icons.collapse : Icons.expand}
                  </button>
                )}
                {onMoveToTop && (
                  <button
                    className="card-move-top-btn"
                    type="button"
                    aria-label={t("common.moveToTop")}
                    title={t("common.moveToTop")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onMoveToTop(view.id);
                    }}
                  >
                    {Icons.arrowUp}
                  </button>
                )}
                <button className="card-delete-btn" onClick={handleDelete}>
                  {Icons.delete}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Context menu：统一走 CardActionMenu（portal 定位），避免被卡片 transform 影响 */}
      <CardActionMenu
        open={ctxMenu !== null && !selectionMode}
        getAnchor={() => ctxMenu
          ? { left: ctxMenu.x, top: ctxMenu.y, right: ctxMenu.x, bottom: ctxMenu.y }
          : null}
        onClose={() => setCtxMenu(null)}
      >
        {isApiKey && (
          <CardActionMenuItem
            className="ctx-menu-item"
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                <line x1="7" y1="7" x2="7.01" y2="7" />
              </svg>
            }
            label={t("clipboard.labelApiSource")}
            onClick={() => setLabelOpen(true)}
          />
        )}
        {isApiKey && hasLabel && (
          <CardActionMenuItem
            className="ctx-menu-item"
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            }
            label={t("clipboard.copyWithComment")}
            onClick={() => void handleCopyWithComment()}
          />
        )}
        {view.recordType === "text" && !isApiKey && (
          <CardActionMenuItem
            className="ctx-menu-item"
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                <line x1="7" y1="7" x2="7.01" y2="7" />
              </svg>
            }
            label={t("clipboard.markAsApiKey")}
            onClick={handleToggleUserApiKey}
          />
        )}
        {apiKey?.userMarked && (
          <CardActionMenuItem
            className="ctx-menu-item"
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            }
            label={t("clipboard.unmarkApiKey")}
            onClick={handleToggleUserApiKey}
          />
        )}
        {(isApiKey || (view.recordType === "text" && !isApiKey)) && (
          <CardActionMenuSeparator />
        )}
        <CardActionMenuItem
          className="ctx-menu-item"
          icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          }
          label={pasteLeftClick === "terminal" ? t("clipboard.pasteNormal") : t("clipboard.pasteToTerminal")}
          onClick={handleSecondaryPaste}
        />
        <CardActionMenuItem
          className="ctx-menu-item"
          icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          }
          label={pasteLeftClick === "terminal" ? t("clipboard.pasteToTerminal") : t("clipboard.pasteNormal")}
          onClick={handlePaste}
        />
        {onMoveToTop && (
          <>
            <CardActionMenuSeparator />
            <CardActionMenuItem
              className="ctx-menu-item"
              icon={
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              }
              label={t("common.moveToTop")}
              onClick={() => onMoveToTop(view.id)}
            />
          </>
        )}
        <CardActionMenuSeparator />
        <CardActionMenuItem
          className="ctx-menu-item danger"
          icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          }
          label={t("common.delete")}
          onClick={() => onDelete(view.id)}
        />
      </CardActionMenu>
    </div>
  );
}

export function ClipboardCard(props: ClipboardCardProps) {
  return <ClipboardCardInner {...props} />;
}
