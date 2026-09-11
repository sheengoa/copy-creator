import { useEffect, useState } from "react";
import { Icons } from "../../components/Icons";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslation } from "react-i18next";
import type { Phrase } from "../../types";
import { HighlightText } from "../../components/HighlightText";
import { InlineImagePreview, InlineTextFilePreview } from "../../components/InlinePreview";
import { usePhraseStore, isImageFilePath } from "../../stores/phraseStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { fileNameFromPath } from "../../domain/fileName";
import { isInlineTextPreviewFilePath, shouldShowInlineTextToggle } from "../../domain/records";

interface PhraseListProps {
  phrases: Phrase[];
  loading: boolean;
  selectedGroupId: string | null;
  search?: string;
  /** 列表滚动容器回调 ref，供页面级「回到顶部」监视滚动。 */
  scrollRef?: (node: HTMLElement | null) => void;
  onPaste: (phrase: Phrase) => void;
  onSecondaryPaste: (phrase: Phrase) => void;
  onEdit: (phrase: Phrase) => void;
  onDelete: (id: string) => void;
  /** 卡片「移到顶部」：组内置顶，径向菜单同步可见。 */
  onMoveToTop?: (id: string) => void;
  /** 「全部」跨分组视图：卡片尾部显示所属分组标签。 */
  showGroupTag?: boolean;
  selectionMode: boolean;
  isSelected: (id: string) => boolean;
  onToggleSelected: (id: string) => void;
}


function formatBytes(bytes: number) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** 图像文件短语的缩略图：content 为相对存储目录的路径，加载失败回退图标。 */
function PhraseFileImage({ content }: { content: string }) {
  const getImageThumbnail = usePhraseStore((s) => s.getImageThumbnail);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getImageThumbnail(content)
      .then((base64) => {
        if (!cancelled) setSrc(`data:image/png;base64,${base64}`);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [content, getImageThumbnail]);

  if (failed) return <span className="phrase-card-file-icon">{Icons.image}</span>;
  if (!src) return <span className="phrase-card-file-icon">{Icons.file}</span>;
  return <img className="phrase-card-file-thumb" src={src} alt="" loading="lazy" />;
}

function PhraseCard({
  phrase,
  search,
  onPaste,
  onSecondaryPaste,
  onEdit,
  onDelete,
  onMoveToTop,
  showGroupTag,
  selectionMode,
  selected,
  onToggleSelected,
}: {
  phrase: Phrase;
  search?: string;
  onPaste: (p: Phrase) => void;
  onSecondaryPaste: (p: Phrase) => void;
  onEdit: (p: Phrase) => void;
  onDelete: (id: string) => void;
  onMoveToTop?: (id: string) => void;
  showGroupTag?: boolean;
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
  const isFile = phrase.input_type === "file";
  const fileName = fileNameFromPath(phrase.source_path || phrase.content);
  const [textExpanded, setTextExpanded] = useState(false);
  const imageFile = isFile && isImageFilePath(phrase.source_path || phrase.content);
  const textFile = isFile && isInlineTextPreviewFilePath(phrase.content);
  const canToggleText = isFile
    ? imageFile || textFile
    : shouldShowInlineTextToggle(phrase.content);
  const canCollapseText = !isFile && shouldShowInlineTextToggle(phrase.content);
  const isTextExpanded = canToggleText && textExpanded;

  useEffect(() => {
    setTextExpanded(false);
  }, [phrase.id, phrase.content]);

  const handleToggleText = (e: React.MouseEvent) => {
    e.stopPropagation();
    setTextExpanded((expanded) => !expanded);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`notification phrase-card${isDragging ? " is-dragging" : ""}${selectionMode ? " is-selection-mode" : ""}${selected ? " is-selected" : ""}`}
      onClick={selectionMode ? () => onToggleSelected(phrase.id) : () => onPaste(phrase)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!selectionMode) onSecondaryPaste(phrase);
      }}
    >
      <div className="notibar" />
      {selectionMode && (
        <label className="card-selection-control" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            aria-label={t("common.selectItem")}
            onChange={() => onToggleSelected(phrase.id)}
          />
          <span className="selection-checkbox" aria-hidden="true" />
        </label>
      )}
      <div className="noticontent">
        <div
          className={`notibody phrase-card-body${isFile ? " phrase-card-file-body" : ""}${canToggleText ? " is-toggleable" : ""}${canCollapseText && !isTextExpanded ? " is-collapsed" : ""}${isTextExpanded ? " is-expanded" : ""}${isFile && isTextExpanded ? " is-file-expanded" : ""}`}
        >
          {isFile ? (
            <>
              <div className="phrase-card-file-summary">
                {imageFile && isTextExpanded ? (
                  <span className="phrase-card-file-icon">{Icons.image}</span>
                ) : imageFile ? (
                  <PhraseFileImage content={phrase.content} />
                ) : (
                  <span className="phrase-card-file-icon">{Icons.file}</span>
                )}
                <span className="phrase-card-file-name"><HighlightText text={fileName} search={search} /></span>
                <span className="phrase-card-file-size">{formatBytes(phrase.file_size)}</span>
              </div>
              {isTextExpanded && imageFile && (
                <InlineImagePreview
                  path={phrase.content}
                  alt={t("resources.imagePreview")}
                  className="phrase-card-expanded-image"
                />
              )}
              {isTextExpanded && textFile && (
                <InlineTextFilePreview path={phrase.content} search={search} />
              )}
            </>
          ) : (
            <HighlightText text={phrase.content} search={search} />
          )}
        </div>
        <div className="notititle phrase-card-footer">
          {showGroupTag && phrase.group_name && (
            <span className="phrase-card-group-tag" title={phrase.group_name}>
              {phrase.group_name}
            </span>
          )}
          {showGroupTag && isCountSort && (
            <span className="usage-count-badge">
              {t("common.usageCount", { count: phrase.use_count ?? 0 })}
            </span>
          )}
          <span className="phrase-card-remark"><HighlightText text={phrase.title || ""} search={search} /></span>
          {!selectionMode && (
            <div className="phrase-card-actions">
              {canToggleText && (
                <button
                  className="card-toggle-text-btn"
                  type="button"
                  aria-expanded={isTextExpanded}
                  aria-label={t(isTextExpanded ? "phrases.collapseText" : "phrases.expandText")}
                  title={t(isTextExpanded ? "phrases.collapseText" : "phrases.expandText")}
                  onClick={handleToggleText}
                >
                  {isTextExpanded ? Icons.collapse : Icons.expand}
                </button>
              )}
              <span ref={setActivatorNodeRef} className="drag-handle" {...attributes} {...listeners}>
                {Icons.drag}
              </span>
              {onMoveToTop && (
                <button
                  className="card-move-top-btn"
                  type="button"
                  aria-label={t("common.moveToTop")}
                  title={t("common.moveToTop")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMoveToTop(phrase.id);
                  }}
                >
                  {Icons.arrowUp}
                </button>
              )}
              <button className="card-edit-btn" onClick={(e) => { e.stopPropagation(); onEdit(phrase); }}>
                {Icons.edit}
              </button>
              <button className="card-delete-btn" onClick={(e) => { e.stopPropagation(); onDelete(phrase.id); }}>
                {Icons.delete}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function PhraseList({
  phrases,
  loading,
  selectedGroupId,
  search,
  scrollRef,
  onPaste,
  onSecondaryPaste,
  onEdit,
  onDelete,
  onMoveToTop,
  showGroupTag,
  selectionMode,
  isSelected,
  onToggleSelected,
}: PhraseListProps) {
  const { t } = useTranslation();

  if (loading && phrases.length === 0) {
    return (
      <div className="phrase-list">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="notification skeleton">
            <div className="notibar" />
            <div className="noticontent">
              <div className="notibody">
                <div className="skeleton-line" style={{ width: `${40 + ((i * 13) % 30)}%` }} />
              </div>
              <div className="notititle">
                <div className="skeleton-line short" />
              </div>
            </div>
          </div>
        ))}
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

  if (phrases.length === 0 && !loading) {
    return (
      <div className="page-empty-compact">
        <span>
          {showGroupTag ? t("phrases.emptyAll") : t("phrases.emptyGroupPhrases")}
        </span>
      </div>
    );
  }

  return (
    <div className="phrase-list" ref={scrollRef}>
      {phrases.map((p) => (
        <PhraseCard
          key={p.id}
          phrase={p}
          search={search}
          onPaste={onPaste}
          onSecondaryPaste={onSecondaryPaste}
          onEdit={onEdit}
          onDelete={onDelete}
          onMoveToTop={onMoveToTop}
          showGroupTag={showGroupTag}
          selectionMode={selectionMode}
          selected={isSelected(p.id)}
          onToggleSelected={onToggleSelected}
        />
      ))}
    </div>
  );
}
