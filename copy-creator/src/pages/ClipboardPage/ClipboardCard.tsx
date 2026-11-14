import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";
import {
  CardActionMenu,
  CardActionMenuItem,
  CardActionMenuSeparator,
} from "../../components/CardActionMenu";
import { HighlightText } from "../../components/HighlightText";
import { InlineTextFilePreview } from "../../components/InlinePreview";
import { CardVisual } from "../../components/CardVisual";
import { formatRelativeTime } from "../../utils/formatTime";
import { recordUsageTime } from "../../domain/records";
import { UsageCountBadge } from "../../components/UsageCountBadge";
import { CardMoreTrigger, CardSelectionCheckbox } from "../../components/CardShell";
import { cardActionMenuAnchor } from "../../utils/cardShell";
import { useSettingsStore } from "../../stores/settingsStore";
import ApiKeyLabelPanel from "./ApiKeyLabelPanel";
import { isSlimCardKind, type ResourceMediaKind } from "../../domain/mediaKind";
import { useIsClamped } from "../../hooks/useIsClamped";
import type { RecordView } from "../../domain/recordView";

interface ClipboardCardProps {
  /** 叶子合同：只收视图模型。 */
  view: RecordView;
  /** 记录类型标签（link 等原始类型文案）。 */
  getTypeLabel: (type: string) => string;
  /** 媒体 kind 标签（video/audio 等资源 kind 文案，预览角标与 meta 共用）。 */
  getKindLabel: (kind: ResourceMediaKind) => string;
  search?: string;
  /** 点击卡片 = 打开详情视图（2026-11-14 用户定案：主窗口纯展示预览，
   *  粘贴只在径向菜单）。 */
  onOpenView: (view: RecordView) => void;
  onDelete: (id: string) => void;
  /** 收藏/取消收藏（菜单项共用）：防保留期清理，恒定浮顶。 */
  onSetPinned?: (id: string, pinned: boolean) => void;
  /** 数据/动作经容器回调进出（叶子禁 import stores/invoke）。 */
  getRecordContent: (view: RecordView) => Promise<string>;
  onToggleUserApiKey: (view: RecordView) => void;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelected: (id: string) => void;
}

// 卡片形态与资源库 ResourceCard 同骨架（resource-card 类三页共用）：
// 16:10 预览区（CardVisual 按 kind 分支）+ 标题行 + meta 行，操作全部
// 收进「⋯」菜单与右键菜单，无卡内展开/收起（全文与媒体播放走查看弹窗）。
function ClipboardCardInner({
  view,
  getTypeLabel,
  getKindLabel,
  search,
  onOpenView,
  onDelete,
  onSetPinned,
  getRecordContent,
  onToggleUserApiKey,
  selectionMode,
  selected,
  onToggleSelected,
}: ClipboardCardProps) {
  const { t } = useTranslation();
  const isCountSort = useSettingsStore((s) => s.contentSort === "count");

  const apiKey = view.apiKey;
  const isApiKey = apiKey !== undefined;
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!selectionMode) return;
    setCtxMenu(null);
    setMoreOpen(false);
    setLabelOpen(false);
  }, [selectionMode]);

  // 卡片化主交互：点击 = 打开详情视图；选择模式点击 = 切换选中。
  const handleCardClick = useCallback(() => {
    if (selectionMode) {
      onToggleSelected(view.id);
      return;
    }
    onOpenView(view);
  }, [selectionMode, onToggleSelected, onOpenView, view]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMoreOpen(false);
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // 「⋯」开菜单：顺带关掉可能开着的右键菜单（同一组项，避免双开）。
  const openMoreMenu = useCallback(() => {
    setCtxMenu(null);
    setMoreOpen((open) => !open);
  }, []);

  const handleLabelSaved = useCallback(() => {
    setLabelOpen(false);
  }, []);

  const handleToggleUserApiKey = useCallback(() => {
    setCtxMenu(null);
    setMoreOpen(false);
    onToggleUserApiKey(view);
  }, [onToggleUserApiKey, view]);

  const handleCopyWithComment = useCallback(async () => {
    setCtxMenu(null);
    setMoreOpen(false);
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

  // 键盘可达性：卡片根节点可聚焦，Enter/Space 触发与单击一致的主操作。
  const handleCardKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      if (selectionMode) {
        onToggleSelected(view.id);
        return;
      }
      onOpenView(view);
    },
    [selectionMode, onToggleSelected, onOpenView, view],
  );

  // 预览角标与 meta 行的内容类型文案：link 折叠进 text，文案保留「链接」。
  const contentLabel = view.recordType === "link" ? getTypeLabel("link") : getKindLabel(view.kind);

  // 「⋯」与右键共用同一组菜单项（卡片化定案：操作收敛进菜单）。
  const menuItems = (
    <>
      {onSetPinned && (
        <CardActionMenuItem
          className="ctx-menu-item"
          icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          }
          label={t(view.pinned ? "common.unfavorite" : "common.favorite")}
          onClick={() => {
            setCtxMenu(null);
            setMoreOpen(false);
            onSetPinned(view.id, !view.pinned);
          }}
        />
      )}
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
          onClick={() => {
            setCtxMenu(null);
            setMoreOpen(false);
            setLabelOpen(true);
          }}
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
        onClick={() => {
          setCtxMenu(null);
          setMoreOpen(false);
          onDelete(view.id);
        }}
      />
    </>
  );

  // 混合形态 V2：文本/链接（含文本文件）紧凑条，媒体卡矮横幅预览。
  const slim = isSlimCardKind(view.kind);
  // 紧凑条正文直排：内容截 600 字（约 5 行满幅），搜索高亮同源。
  const slimContent = view.content.length > 600 ? `${view.content.slice(0, 600)}…` : view.content;
  // 5 行截断渐隐提示（scrollHeight 超出 clientHeight 才点亮）。
  const [slimContentRef, slimClamped] = useIsClamped();

  return (
    <article
      className={`resource-card clipboard-card type-${view.recordType}${slim ? " card-slim" : " card-media"}${isApiKey ? " has-api-key" : ""}${isUnlabeled ? " api-key-unlabeled" : ""}${hasLabel ? " api-key-labeled" : ""}${selectionMode ? " is-selection-mode" : ""}${selected ? " is-selected" : ""}`}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      tabIndex={0}
      aria-label={t("clipboard.viewContent")}
      onContextMenu={selectionMode ? (e) => { e.preventDefault(); e.stopPropagation(); } : handleContextMenu}
    >
      {selectionMode && (
        <CardSelectionCheckbox
          checked={selected}
          onToggle={() => onToggleSelected(view.id)}
        />
      )}
      {slim ? (
        <div className="resource-card-body">
          <div className="card-slim-topline">
            <span className="card-slim-dot" aria-hidden="true" />
            <span>{contentLabel}</span>
            {view.pinned && (
              <span className="clipboard-card-pinned" title={t("common.favorite")}>
                {Icons.star}
              </span>
            )}
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
            {!selectionMode && (
              <CardMoreTrigger
                open={moreOpen}
                onToggle={openMoreMenu}
                buttonRef={moreButtonRef}
                label={t("resources.moreActions")}
              />
            )}
          </div>
          <div
            ref={slimContentRef}
            className={`card-slim-content${view.recordType === "link" ? " is-link" : ""}${slimClamped ? " is-clamped" : ""}`}
          >
            {view.textPreviewPath ? (
              <InlineTextFilePreview recordId={view.id} search={search} />
            ) : (
              <HighlightText text={slimContent} search={search} />
            )}
          </div>
          {labelOpen && apiKey && apiKey.preview && (
            <div className="clipboard-card-label-panel" onClick={(e) => e.stopPropagation()}>
              <ApiKeyLabelPanel
                recordId={view.id}
                keyPreview={apiKey.preview}
                existingLabel={apiKey.label}
                guessedService={apiKey.guessedService}
                onSave={handleLabelSaved}
                onCancel={() => setLabelOpen(false)}
              />
            </div>
          )}
          <div className="resource-card-meta">
            {isCountSort && <UsageCountBadge count={view.useCount} />}
            <span>{contentLabel}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={view.createdAt}>
              {formatRelativeTime(recordUsageTime(view.lastUsedAt, view.createdAt))}
            </time>
          </div>
        </div>
      ) : (
      <div className="resource-card-preview">
        <CardVisual view={view} search={search} typeLabel={getKindLabel} />
        <span className="resource-card-kind">{contentLabel}</span>
        {!selectionMode && (
          <CardMoreTrigger
            open={moreOpen}
            onToggle={openMoreMenu}
            buttonRef={moreButtonRef}
            label={t("resources.moreActions")}
          />
        )}
      </div>
      )}
      <CardActionMenu
        open={moreOpen}
        align="end"
        className="resource-card-menu"
        ariaLabel={t("resources.moreActions")}
        anchorEl={moreButtonRef}
        getAnchor={() => cardActionMenuAnchor(moreButtonRef)}
        onClose={() => setMoreOpen(false)}
      >
        {menuItems}
      </CardActionMenu>
      {/* 右键菜单：与「⋯」同一组项，按鼠标命位定位（统一走 portal 免 transform 裁剪）。 */}
      <CardActionMenu
        open={ctxMenu !== null && !selectionMode}
        getAnchor={() => ctxMenu
          ? { left: ctxMenu.x, top: ctxMenu.y, right: ctxMenu.x, bottom: ctxMenu.y }
          : null}
        onClose={() => setCtxMenu(null)}
      >
        {menuItems}
      </CardActionMenu>
      {!slim && (
      <div className="resource-card-body">
        <div className="resource-card-title-row">
          <strong className="resource-card-title">
            <HighlightText text={view.displayName} search={search} />
          </strong>
          {view.pinned && (
            <span className="clipboard-card-pinned" title={t("common.favorite")}>
              {Icons.star}
            </span>
          )}
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
        {labelOpen && apiKey && apiKey.preview && (
          <div className="clipboard-card-label-panel" onClick={(e) => e.stopPropagation()}>
            <ApiKeyLabelPanel
              recordId={view.id}
              keyPreview={apiKey.preview}
              existingLabel={apiKey.label}
              guessedService={apiKey.guessedService}
              onSave={handleLabelSaved}
              onCancel={() => setLabelOpen(false)}
            />
          </div>
        )}
        <div className="resource-card-meta">
          {isCountSort && <UsageCountBadge count={view.useCount} />}
          <span>{contentLabel}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={view.createdAt}>
            {formatRelativeTime(recordUsageTime(view.lastUsedAt, view.createdAt))}
          </time>
        </div>
      </div>
      )}
    </article>
  );
}

export const ClipboardCard = memo(ClipboardCardInner);
