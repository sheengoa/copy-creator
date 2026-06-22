import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useClipboardStore } from "../../stores/clipboardStore";
import { Icons } from "../../components/Icons";
import SearchInput from "../../components/SearchInput";
import { ClipboardCard } from "./ClipboardCard";
import { TYPE_META } from "./utils";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensors,
  useSensor,
  closestCenter,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";

type ClipType = "all" | "text" | "image" | "link" | "file";

TYPE_META.text.icon = Icons.clipboard;
TYPE_META.image.icon = Icons.image;
TYPE_META.link.icon = Icons.link;
TYPE_META.file.icon = Icons.file;

export default function ClipboardPage() {
  const { t } = useTranslation();
  const {
    records,
    search,
    loading,
    hasMore,
    category,
    init,
    setSearch,
    setCategory,
    loadRecords,
    deleteRecord,
    deleteAllRecords,
    deleteRecordsByType,
    pasteRecord,
  } = useClipboardStore();

  const [hoverPreview, setHoverPreview] = useState<{ src: string; x: number; y: number } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const categories: { key: ClipType; label: string }[] = [
    { key: "all", label: t("clipboard.all") },
    { key: "text", label: t("clipboard.text") },
    { key: "image", label: t("clipboard.image") },
    { key: "link", label: t("clipboard.link") },
    { key: "file", label: t("clipboard.file") },
  ];

  const labels: Record<string, string> = useMemo(
    () => ({
      text: t("clipboard.text"),
      image: t("clipboard.image"),
      link: t("clipboard.link"),
      file: t("clipboard.file"),
    }),
    [t],
  );

  const getTypeLabel = useCallback(
    (type: string): string => labels[type] || labels.text,
    [labels],
  );

  const handlePaste = useCallback(
    (r: typeof records[number]) => pasteRecord(r),
    [pasteRecord],
  );

  const handleDelete = useCallback(
    (id: string) => deleteRecord(id),
    [deleteRecord],
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearch(value);
    },
    [setSearch],
  );

  const handleCategoryChange = useCallback(
    (value: ClipType) => {
      setCategory(value);
      loadRecords();
    },
    [setCategory, loadRecords],
  );

  const filtered = useMemo(() => {
    if (category === "all") return records;
    return records.filter((r) => r.type === category);
  }, [records, category]);

  useEffect(() => {
    init();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => loadRecords(), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const handleThumbHover = useCallback((thumbSrc: string, rect: DOMRect) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoverPreview({ src: thumbSrc, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, []);

  const handleThumbLeave = useCallback(() => {
    hoverTimerRef.current = setTimeout(() => setHoverPreview(null), 150);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor)
  );

  const isFiltered = category !== "all" || search.trim().length > 0;

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (isFiltered) return;
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = filtered.findIndex((r) => r.id === active.id);
      const newIndex = filtered.findIndex((r) => r.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const newOrder = arrayMove(filtered, oldIndex, newIndex);
      useClipboardStore.getState().reorderRecords(newOrder.map((r) => r.id));
    },
    [filtered, isFiltered]
  );

  return (
    <div className="clipboard-page">
      <div className="page-search">
        <SearchInput
          placeholder={t("clipboard.search")}
          value={search}
          onChange={handleSearchChange}
        />
      </div>

      <div className="clipboard-categories">
        {categories.map((c) => (
          <button
            key={c.key}
            className={`category-chip ${category === c.key ? "active" : ""}`}
            onClick={() => handleCategoryChange(c.key)}
          >
            {c.label}
          </button>
        ))}
        <div className="clipboard-categories-spacer" />
        {records.length > 0 && (
          <button
            className="category-chip category-chip-danger"
            onClick={() => {
              if (category === "all") {
                if (confirm(t("clipboard.confirmDeleteAll"))) {
                  deleteAllRecords();
                }
              } else {
                const typeLabel = t(`clipboard.${category}`);
                if (confirm(t("clipboard.confirmDeleteType", { type: typeLabel }))) {
                  deleteRecordsByType(category);
                }
              }
            }}
          >
            {category === "all"
              ? t("clipboard.deleteAll")
              : t("clipboard.deleteType", { type: t(`clipboard.${category}`) })}
          </button>
        )}
      </div>

      {loading && records.length === 0 ? (
        <div className="clipboard-list">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="notification skeleton">
              <div className="notibar" />
              <div className="noticontent">
                <div className="notititle">
                  <div className="skeleton-line short" />
                </div>
                <div className="notibody">
                  <div
                    className="skeleton-line"
                    style={{ width: `${55 + ((i * 17) % 35)}%` }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="page-empty-compact">
          <div className="empty-icon-compact">{Icons.clipboard}</div>
          <span>{t("clipboard.empty")}</span>
        </div>
      ) : (
        <div className="clipboard-list">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={filtered.map(r => r.id)} strategy={verticalListSortingStrategy}>
              {filtered.map((r, i) => (
                <ClipboardCard
                  key={r.id}
                  record={r}
                  index={i}
                  getTypeLabel={getTypeLabel}
                  onPaste={handlePaste}
                  onDelete={handleDelete}
                  onThumbHover={handleThumbHover}
                  onThumbLeave={handleThumbLeave}
                />
              ))}
            </SortableContext>
          </DndContext>
          {hasMore && filtered.length > 0 && (
            <button
              className="clipboard-load-more"
              type="button"
              onClick={() => loadRecords(true)}
            >
              显示更多
            </button>
          )}
        </div>
      )}

      {hoverPreview && (
        <div className="thumb-hover-overlay">
          <img src={hoverPreview.src} alt="" />
        </div>
      )}

    </div>
  );
}
