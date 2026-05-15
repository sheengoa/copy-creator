import { Icons } from "../../components/Icons";

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
      {phrases.map((p, i) => (
        <div
          key={p.id}
          className="notification phrase-card"
          style={{ "--enter-delay": i } as React.CSSProperties}
          onClick={() => onPaste(p)}
        >
          <div className="notibar" />
          <div className="noticontent">
            <div className="notibody phrase-card-body">{p.content}</div>
            <div className="notititle phrase-card-footer">
              <span className="phrase-card-remark">{p.title}</span>
              <div className="phrase-card-actions">
                <button
                  className="card-edit-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(p);
                  }}
                >
                  {Icons.edit}
                </button>
                <button
                  className="card-delete-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(p.id);
                  }}
                >
                  {Icons.delete}
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
