import { Icons } from "../../components/Icons";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface Phrase {
  id: string;
  group_id: string;
  title: string;
  content: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface PhraseListProps {
  phrases: Phrase[];
  loading: boolean;
  selectedGroupId: string | null;
  onPaste: (phrase: Phrase) => void;
  onEdit: (phrase: Phrase) => void;
  onDelete: (id: string) => void;
}

function PhraseCard({
  phrase,
  onPaste,
  onEdit,
  onDelete,
}: {
  phrase: Phrase;
  onPaste: (p: Phrase) => void;
  onEdit: (p: Phrase) => void;
  onDelete: (id: string) => void;
}) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id: phrase.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition || "transform 200ms ease",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`notification phrase-card${isDragging ? " is-dragging" : ""}`}
      onClick={() => onPaste(phrase)}
    >
      <div className="notibar" />
      <div className="noticontent">
        <div className="notibody phrase-card-body">{phrase.content}</div>
        <div className="notititle phrase-card-footer">
          <span className="phrase-card-remark">{phrase.title}</span>
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
        </div>
      </div>
    </div>
  );
}

export function PhraseList({
  phrases,
  loading,
  selectedGroupId,
  onPaste,
  onEdit,
  onDelete,
}: PhraseListProps) {
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
        <span>选择一个场景组查看短语</span>
      </div>
    );
  }

  if (phrases.length === 0 && !loading) {
    return (
      <div className="page-empty-compact">
        <span>当前分组中无快捷短语</span>
      </div>
    );
  }

  return (
    <div className="phrase-list">
      {phrases.map((p) => (
        <PhraseCard key={p.id} phrase={p} onPaste={onPaste} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </div>
  );
}
