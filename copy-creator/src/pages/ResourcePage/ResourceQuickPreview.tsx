import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord } from "../../types";
import { Icons } from "../../components/Icons";
import { loadClipboardPreviewSegments } from "../../utils/contentPreview";
import type { RadialPreviewSegment } from "../../utils/radialPreview";
import {
  calculateResourceScrollDelta,
  getResourceTitle,
  inferResourceMediaKind,
  resolveResourceAssetUrl,
  type ResourceMediaKind,
} from "./resourceUtils";
import { ResourceImage, ResourceMediaPlayer, ResourceSegments } from "./ResourceMedia";

interface ResourceQuickPreviewProps {
  record: ClipboardRecord;
  typeLabel: (kind: ResourceMediaKind) => string;
  onClose: () => void;
  onOpenDetail: (record: ClipboardRecord) => void;
  onCopy: (record: ClipboardRecord) => void | Promise<void>;
}

interface PreviewData {
  segments: RadialPreviewSegment[] | null;
  mediaSource: string | null;
}

async function loadPreviewData(record: ClipboardRecord, kind: ResourceMediaKind): Promise<PreviewData> {
  const [segments, mediaSource] = await Promise.all([
    kind === "video" || kind === "audio" || kind === "file" || kind === "image"
      ? Promise.resolve(null)
      : loadClipboardPreviewSegments(record),
    kind === "video" || kind === "audio"
      ? resolveResourceAssetUrl(record.content)
      : Promise.resolve(null),
  ]);
  return { segments, mediaSource };
}

function ResourceFilePreview({ record, kind }: { record: ClipboardRecord; kind: ResourceMediaKind }) {
  const { t } = useTranslation();
  return (
    <div className="resource-file-preview">
      {Icons.file}
      <strong>{getResourceTitle(record, kind)}</strong>
      <span>{t("resources.filePreviewNote")}</span>
    </div>
  );
}

export function ResourceQuickPreview({
  record,
  typeLabel,
  onClose,
  onOpenDetail,
  onCopy,
}: ResourceQuickPreviewProps) {
  const { t } = useTranslation();
  const kind = inferResourceMediaKind(record);
  const previewRef = useRef<HTMLElement>(null);
  const [data, setData] = useState<PreviewData>({ segments: null, mediaSource: null });
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData({ segments: null, mediaSource: null });
    setError(false);
    loadPreviewData(record, kind)
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, record]);

  const isReady = kind === "video" || kind === "audio"
    ? Boolean(data.mediaSource)
    : kind === "file" || kind === "image"
      ? true
      : Boolean(data.segments);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const element = previewRef.current;
      const container = element?.closest<HTMLElement>("[data-resource-scroll]");
      if (!element || !container) return;
      const rect = element.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const delta = calculateResourceScrollDelta({
        previewTop: rect.top,
        previewBottom: rect.bottom,
        containerTop: containerRect.top,
        containerBottom: containerRect.bottom,
        padding: 14,
      });
      if (!delta) return;
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      container.scrollBy({ top: delta, behavior: reducedMotion ? "auto" : "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [error, isReady, kind, record.content, record.id]);

  return (
    <section className="resource-quick-preview" ref={previewRef} aria-label={t("resources.quickPreview")}>
      <div className="resource-quick-preview-header">
        <div>
          <span className="resource-preview-eyebrow">{t("resources.quickPreview")}</span>
          <strong>{typeLabel(kind)}</strong>
        </div>
        <button
          type="button"
          className="resource-icon-button"
          onClick={onClose}
          aria-label={t("resources.closePreview")}
          title={t("resources.closePreview")}
        >
          {Icons.close}
        </button>
      </div>
      <div className="resource-quick-preview-body">
        {error ? (
          <div className="resource-preview-error" role="alert">{t("resources.previewError")}</div>
        ) : !isReady ? (
          <div className="resource-preview-loading" role="status">{t("common.loading")}</div>
        ) : kind === "video" || kind === "audio" ? (
          <ResourceMediaPlayer
            kind={kind}
            path={record.content}
            resolvedSrc={data.mediaSource ?? undefined}
            compact
          />
        ) : kind === "image" ? (
          <ResourceImage
            path={record.content}
            alt={getResourceTitle(record, kind)}
            className="resource-segment-image"
          />
        ) : kind === "file" ? (
          <ResourceFilePreview record={record} kind={kind} />
        ) : (
          <ResourceSegments segments={data.segments || []} compact />
        )}
      </div>
      <div className="resource-quick-preview-actions">
        <button
          type="button"
          className="resource-secondary-button"
          onClick={() => void onCopy(record)}
        >
          {Icons.copy}
          <span>{t("resources.copy")}</span>
        </button>
        <button
          type="button"
          className="resource-primary-button"
          onClick={() => onOpenDetail(record)}
        >
          <span>{t("resources.openDetail")}</span>
        </button>
      </div>
    </section>
  );
}
