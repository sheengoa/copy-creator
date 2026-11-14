import { useEffect, useMemo, useRef, useState } from "react";
import { splitResourceColumns } from "../../utils/cardGrid";
import { Icons } from "../../components/Icons";
import { useArrowKeyNav } from "../../hooks/useArrowKeyNav";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslation } from "react-i18next";
import type { Phrase } from "../../types";
import { HighlightText } from "../../components/HighlightText";
import { InlineTextFilePreview } from "../../components/InlinePreview";
import { CardVisual, type CardVisualData } from "../../components/CardVisual";
import {
  CardActionMenu,
  CardActionMenuItem,
  CardActionMenuSeparator,
} from "../../components/CardActionMenu";
import { useSettingsStore } from "../../stores/settingsStore";
import { UsageCountBadge } from "../../components/UsageCountBadge";
import { fileNameFromPath } from "../../domain/fileName";
import { getResourceSummary, recordUsageTime } from "../../domain/records";
import { inferResourceMediaKind, isSlimCardKind, type ResourceMediaKind } from "../../domain/mediaKind";
import { useIsClamped } from "../../hooks/useIsClamped";
import { formatRelativeTime } from "../../utils/formatTime";

interface PhraseListProps {
  phrases: Phrase[];
  loading: boolean;
  /** 首次数据加载已完成：为 true 后分组切换不再亮骨架屏。 */
  loadedOnce: boolean;
  selectedGroupId: string | null;
  search?: string;
  /** 卡片网格列数（页面级 useCardColumns 计算，与资源库/剪切板同几何）。 */
  columnCount: number;
  /** 列表滚动容器回调 ref，供页面级「回到顶部」监视滚动。 */
  scrollRef?: (node: HTMLElement | null) => void;
  onOpenView: (phrase: Phrase) => void;
  onDelete: (id: string) => void;
  /** 卡片「移到顶部」：组内置顶，径向菜单同步可见。 */
  onMoveToTop?: (id: string) => void;
  /** 「全部」跨分组视图：卡片 meta 显示所属分组标签。 */
  showGroupTag?: boolean;
  /** 媒体 kind 文案（video/audio 等，预览角标与 meta 共用）。 */
  getKindLabel: (kind: ResourceMediaKind) => string;
  selectionMode: boolean;
  isSelected: (id: string) => boolean;
  onToggleSelected: (id: string) => void;
  /** dnd 键盘拖拽进行中禁用方向键导航（方向键此时是拖拽移动语义）。 */
  navDisabled?: boolean;
}

/** 短语 → 卡片预览窄接口（CardVisualData）：kind 按扩展名推断，文本文件
 *  走快捷输入受管副本预览命令，摘要复用 domain 摘要函数（与资源卡同形态）。 */
function phraseCardVisual(phrase: Phrase): CardVisualData {
  const isFile = phrase.input_type === "file";
  const path = phrase.content;
  const kind: ResourceMediaKind = isFile
    ? inferResourceMediaKind({ type: "file", content: path })
    : "text";
  const isTextFile = isFile && kind === "text";
  return {
    kind,
    recordType: isFile ? "file" : "text",
    title: phrase.title || fileNameFromPath(phrase.source_path || path),
    summary: getResourceSummary({ type: "text", content: phrase.content }),
    content: path,
    textPreviewPath: isTextFile ? path : null,
    textPreviewVariant: isTextFile ? "quickInput" : undefined,
    resourcePath: null,
    mediaVersion: null,
    createdAt: phrase.updated_at,
  };
}

function PhraseCard({
  phrase,
  search,
  onOpenView,
  onDelete,
  onMoveToTop,
  showGroupTag,
  getKindLabel,
  selectionMode,
  selected,
  onToggleSelected,
}: {
  phrase: Phrase;
  search?: string;
  onOpenView: (p: Phrase) => void;
  onDelete: (id: string) => void;
  onMoveToTop?: (id: string) => void;
  showGroupTag?: boolean;
  getKindLabel: (kind: ResourceMediaKind) => string;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelected: (id: string) => void;
}) {
  const { t } = useTranslation();
  const isCountSort = useSettingsStore((s) => s.contentSort === "count");
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id: phrase.id, disabled: selectionMode });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition || "transform 200ms ease",
  };

  const visual = useMemo(() => phraseCardVisual(phrase), [phrase]);
  const contentLabel = getKindLabel(visual.kind);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!selectionMode) return;
    setMoreOpen(false);
  }, [selectionMode]);

  // 卡片化主交互：点击 = 查看内容（占位符在粘贴时才展开，弹窗内提示）。
  const handleCardClick = () => {
    if (selectionMode) {
      onToggleSelected(phrase.id);
      return;
    }
    onOpenView(phrase);
  };

  // 混合形态 V2：文本短语（含文本文件）紧凑条，文件短语矮横幅媒体卡。
  const slim = isSlimCardKind(visual.kind);
  const slimContent = phrase.content.length > 600 ? `${phrase.content.slice(0, 600)}…` : phrase.content;
  // 5 行截断渐隐提示（scrollHeight 超出 clientHeight 才点亮）。
  const [slimContentRef, slimClamped] = useIsClamped();
  const metaRow = (
      <div className="resource-card-meta">
        {showGroupTag && phrase.group_name && (
          <span className="phrase-card-group-tag" title={phrase.group_name}>
            {phrase.group_name}
          </span>
        )}
        {showGroupTag && isCountSort && (
          <UsageCountBadge count={phrase.use_count ?? 0} />
        )}
        <span>{contentLabel}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={phrase.updated_at}>
          {formatRelativeTime(recordUsageTime(phrase.last_used_at ?? null, phrase.created_at))}
        </time>
        {!selectionMode && (
          <span
            ref={setActivatorNodeRef}
            className="drag-handle"
            aria-label={t("phrases.dragReorder")}
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
          >
            {Icons.drag}
          </span>
        )}
      </div>
    );
    return (
      <article
      ref={setNodeRef}
      style={style}
      className={`resource-card phrase-card${slim ? " card-slim" : " card-media"}${isDragging ? " is-dragging" : ""}${selectionMode ? " is-selection-mode" : ""}${selected ? " is-selected" : ""}`}
      onClick={handleCardClick}
      onKeyDown={(e) => {
        // 键盘可达性：Enter/Space 与单击同义（选择模式切换选中；浏览模式查看内容）。
        // 排序把手的 Space/Enter 是 dnd-kit 键盘拖拽语义，不冒泡到此
        // （否则键盘拖拽永远启动不了，反而误开详情页）。
        if (e.target instanceof HTMLElement && e.target.closest(".drag-handle")) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (selectionMode) {
          onToggleSelected(phrase.id);
          return;
        }
        onOpenView(phrase);
      }}
      tabIndex={0}
      aria-label={t("clipboard.viewContent")}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!selectionMode) setMoreOpen(true);
      }}
    >
      {selectionMode && (
        <label className="resource-card-selection" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            aria-label={t("common.selectItem")}
            onChange={() => onToggleSelected(phrase.id)}
          />
          <span className="selection-checkbox" aria-hidden="true" />
        </label>
      )}
      {slim ? (
        <div className="resource-card-body">
          <div className="card-slim-topline">
            <span className="card-slim-dot" aria-hidden="true" />
            <span>{contentLabel}</span>
            {!selectionMode && (
              <div className="resource-card-more">
                <button
                  type="button"
                  ref={moreButtonRef}
                  className="resource-card-more-button"
                  aria-label={t("resources.moreActions")}
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  title={t("resources.moreActions")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMoreOpen((open) => !open);
                  }}
                >
                  {Icons.more}
                </button>
              </div>
            )}
          </div>
          <div
            ref={slimContentRef}
            className={`card-slim-content${slimClamped ? " is-clamped" : ""}`}
          >
            {visual.textPreviewPath ? (
              <InlineTextFilePreview path={visual.textPreviewPath} search={search} />
            ) : (
              <HighlightText text={slimContent} search={search} />
            )}
          </div>
          {metaRow}
        </div>
      ) : (
        <>
          <div className="resource-card-preview">
            <CardVisual view={visual} search={search} typeLabel={getKindLabel} />
            <span className="resource-card-kind">{contentLabel}</span>
            {!selectionMode && (
              <div className="resource-card-more">
                <button
                  type="button"
                  ref={moreButtonRef}
                  className="resource-card-more-button"
                  aria-label={t("resources.moreActions")}
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  title={t("resources.moreActions")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMoreOpen((open) => !open);
                  }}
                >
                  {Icons.more}
                </button>
              </div>
            )}
          </div>
          <div className="resource-card-body">
            <div className="resource-card-title-row">
              <strong className="resource-card-title">
                <HighlightText text={phrase.title || ""} search={search} />
              </strong>
            </div>
            {metaRow}
          </div>
        </>
      )}
      <CardActionMenu
        open={moreOpen}
        align="end"
        className="resource-card-menu"
        ariaLabel={t("resources.moreActions")}
        anchorEl={moreButtonRef}
        getAnchor={() => {
          const rect = moreButtonRef.current?.getBoundingClientRect();
          if (!rect) return null;
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        }}
        onClose={() => setMoreOpen(false)}
      >
        {onMoveToTop && (
          <CardActionMenuItem
            className="ctx-menu-item"
            icon={Icons.arrowUp}
            label={t("common.moveToTop")}
            onClick={() => {
              setMoreOpen(false);
              onMoveToTop(phrase.id);
            }}
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
            setMoreOpen(false);
            onDelete(phrase.id);
          }}
        />
      </CardActionMenu>
    </article>
  );
}

export function PhraseList({
  phrases,
  loading,
  loadedOnce,
  selectedGroupId,
  search,
  columnCount,
  scrollRef,
  onOpenView,
  onDelete,
  onMoveToTop,
  showGroupTag,
  getKindLabel,
  selectionMode,
  isSelected,
  onToggleSelected,
  navDisabled,
}: PhraseListProps) {
  const { t } = useTranslation();
  // 方向键导航：容器节点同时供「回到顶部」回调用，这里用本地 ref 桥接。
  // 平铺网格按 DOM 序（行主序）前后移动，与时间序一致。
  const listRef = useRef<HTMLDivElement>(null);
  // 分列瀑布流按列分组（上下列内移动、左右跨列同位），与剪切板页同款。
  const arrowNav = useArrowKeyNav({
    containerRef: listRef,
    itemSelector: ".phrase-card",
    columnar: true,
    columnSelector: ".resource-column",
    disabled: navDisabled,
  });

  // 骨架屏只用于首屏：分组切换是本地毫秒级查询，从空分组切走时若再亮
  // 骨架屏，会出现"骨架屏闪一下再变空态"的闪烁（用户可感知）。
  if (loading && phrases.length === 0 && !loadedOnce) {
    return (
      <div className="phrase-list">
        <div className="resource-list-skeleton" aria-busy="true">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div className="resource-card-skeleton" key={i}>
              <div className="resource-skeleton-preview" />
              <div className="resource-skeleton-line long" />
              <div className="resource-skeleton-line short" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!selectedGroupId) {
    return (
      <div className="page-empty-compact">
        <div className="empty-icon-compact">{Icons.phrases}</div>
        <span>{t("phrases.empty")}</span>
      </div>
    );
  }

  // 空态乐观显示：首次加载完成后的分组切换期间（phrases 仍为上一空分组
  // 的结果）直接显示空态文案，等新结果到达自然替换，避免中间态闪烁。
  if (phrases.length === 0) {
    return (
      <div className="page-empty-compact">
        <span>
          {showGroupTag ? t("phrases.emptyAll") : t("phrases.emptyGroupPhrases")}
        </span>
      </div>
    );
  }

  return (
    <div
      className="phrase-list"
      ref={(el) => {
        listRef.current = el;
        scrollRef?.(el);
      }}
      onKeyDown={arrowNav}
    >
      {/* 分列瀑布流（列内紧贴）：phrases 已是 DOM 序（列主序，由页面
          splitResourceColumns 生成，与 SortableContext items 一致），
          拖拽 rectSorting 与方向键列导航都在此域工作。 */}
      <div
        className="resource-columns"
        style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
      >
        {splitResourceColumns(phrases, columnCount).map((column, columnIndex) => (
          <div className="resource-column" key={`column-${columnIndex}`}>
            {column.map((p) => (
              <div className="resource-item" key={p.id}>
                <PhraseCard
                  phrase={p}
                  search={search}
                  onOpenView={onOpenView}
                  onDelete={onDelete}
                  onMoveToTop={onMoveToTop}
                  showGroupTag={showGroupTag}
                  getKindLabel={getKindLabel}
                  selectionMode={selectionMode}
                  selected={isSelected(p.id)}
                  onToggleSelected={onToggleSelected}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
