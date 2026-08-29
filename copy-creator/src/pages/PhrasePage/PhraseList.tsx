import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icons } from "../../components/Icons";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslation } from "react-i18next";
import type { Phrase } from "../../types";
import { HighlightText } from "../../components/HighlightText";
import { isImageFilePath } from "../../stores/phraseStore";

interface PhraseListProps {
  phrases: Phrase[];
  loading: boolean;
  selectedGroupId: string | null;
  search?: string;
  onPaste: (phrase: Phrase) => void;
  onSecondaryPaste: (phrase: Phrase) => void;
  onEdit: (phrase: Phrase) => void;
  onDelete: (id: string) => void;
  selectionMode: boolean;
  isSelected: (id: string) => boolean;
  onToggleSelected: (id: string) => void;
}

const filenameFromPath = (path: string) => path.replace(/\\/g, "/").split("/").pop() || path;

function formatBytes(bytes: number) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** 图像文件短语的缩略图：content 为相对存储目录的路径，加载失败回退图标。 */
function PhraseFileImage({ content }: { content: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_image_thumbnail", { path: content, maxSize: 96 })
      .then((base64) => {
        if (!cancelled) setSrc(`data:image/png;base64,${base64}`);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [content]);

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
  selectionMode: boolean;
  selected: boolean;
  onToggleSelected: (id: string) => void;
}) {
  const { t } = useTranslation();
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id: phrase.id, disabled: selectionMode });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition || "transform 200ms ease",
  };
  const isFile = phrase.input_type === "file";
  const fileName = filenameFromPath(phrase.source_path || phrase.content);

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
        <div className={`notibody phrase-card-body${isFile ? " phrase-card-file-body" : ""}`}>
          {isFile ? (
            <>
              {isImageFilePath(phrase.source_path || phrase.content) ? (
                <PhraseFileImage content={phrase.content} />
              ) : (
                <span className="phrase-card-file-icon">{Icons.file}</span>
              )}
              <span className="phrase-card-file-name"><HighlightText text={fileName} search={search} /></span>
              <span className="phrase-card-file-size">{formatBytes(phrase.file_size)}</span>
            </>
          ) : (
            <HighlightText text={phrase.content} search={search} />
          )}
        </div>
        <div className="notititle phrase-card-footer">
          <span className="phrase-card-remark"><HighlightText text={phrase.title || ""} search={search} /></span>
          {!selectionMode && (
            <div className="phrase-card-actions">
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
  onPaste,
  onSecondaryPaste,
  onEdit,
  onDelete,
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
        <span>{t("phrases.emptyGroupPhrases")}</span>
      </div>
    );
  }

  return (
    <div className="phrase-list">
      {phrases.map((p) => (
        <PhraseCard
          key={p.id}
          phrase={p}
          search={search}
          onPaste={onPaste}
          onSecondaryPaste={onSecondaryPaste}
          onEdit={onEdit}
          onDelete={onDelete}
          selectionMode={selectionMode}
          selected={isSelected(p.id)}
          onToggleSelected={onToggleSelected}
        />
      ))}
    </div>
  );
}
