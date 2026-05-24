import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useClipboardStore } from "../../stores/clipboardStore";
import { Icons } from "../../components/Icons";
import SearchInput from "../../components/SearchInput";
import { ClipboardCard } from "./ClipboardCard";
import { TYPE_META } from "./utils";

type ClipType = "all" | "text" | "image" | "link" | "file" | "apikey";
const INITIAL_VISIBLE_RECORDS = 120;
const VISIBLE_RECORD_INCREMENT = 120;

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
    category,
    init,
    setSearch,
    setCategory,
    loadRecords,
    deleteRecord,
    pasteRecord,
  } = useClipboardStore();

  const [hoverPreview, setHoverPreview] = useState<{ src: string; x: number; y: number } | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_RECORDS);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const categories: { key: ClipType; label: string }[] = [
    { key: "all", label: t("clipboard.all") },
    { key: "text", label: t("clipboard.text") },
    { key: "image", label: t("clipboard.image") },
    { key: "link", label: t("clipboard.link") },
    { key: "file", label: t("clipboard.file") },
    { key: "apikey", label: t("clipboard.apikey") },
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
      setVisibleCount(INITIAL_VISIBLE_RECORDS);
      setSearch(value);
    },
    [setSearch],
  );

  const handleCategoryChange = useCallback(
    (value: ClipType) => {
      setVisibleCount(INITIAL_VISIBLE_RECORDS);
      setCategory(value);
    },
    [setCategory],
  );

  const filtered = useMemo(() => {
    if (category === "all") return records;
    if (category === "apikey") return records.filter((r) => r.is_api_key);
    return records.filter((r) => r.type === category);
  }, [records, category]);

  const visibleRecords = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );

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
          {visibleRecords.map((r, i) => (
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
          {visibleRecords.length < filtered.length && (
            <button
              className="clipboard-load-more"
              type="button"
              onClick={() => setVisibleCount((count) => count + VISIBLE_RECORD_INCREMENT)}
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
