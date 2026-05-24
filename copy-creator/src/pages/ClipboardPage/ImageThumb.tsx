import { useState, useEffect, useRef } from "react";
import { useClipboardStore } from "../../stores/clipboardStore";

interface ImageThumbProps {
  record: { id: string; content: string };
  onHover: (src: string, rect: DOMRect) => void;
  onLeave: () => void;
  onClick: (e: React.MouseEvent) => void;
}

export function ImageThumb({ record, onHover, onLeave, onClick }: ImageThumbProps) {
  const { getThumbnail, thumbnailCache } = useClipboardStore();
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cachedSrc = thumbnailCache[record.id] ?? null;
  const src = loadedSrc ?? cachedSrc;

  useEffect(() => {
    if (!visible || cachedSrc) return;
    getThumbnail(record).then((dataUrl) => {
      if (dataUrl) setLoadedSrc(dataUrl);
    });
  }, [cachedSrc, getThumbnail, record, visible]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true);
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="clipboard-card-thumb"
      onMouseEnter={(e) => {
        if (!src) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onHover(src, rect);
      }}
      onMouseLeave={onLeave}
      onClick={onClick}
    >
      {src ? (
        <img src={src} alt="" />
      ) : (
        <div className="thumb-spinner" />
      )}
    </div>
  );
}
