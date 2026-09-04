import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord } from "../../types";
import { Icons } from "../../components/Icons";
import { getResourceGroupName } from "../../utils/clipboardRecord";
import { loadClipboardPreviewSegments } from "../../utils/contentPreview";
import type { RadialPreviewSegment } from "../../utils/radialPreview";
import {
  getResourceFileName,
  getResourceTitle,
  inferResourceMediaKind,
  resolveResourceAssetUrl,
  type ResourceMediaKind,
} from "./resourceUtils";
import { ResourceImage, ResourceMediaPlayer, ResourceSegments } from "./ResourceMedia";

interface ResourceDetailPageProps {
  record: ClipboardRecord;
  typeLabel: (kind: ResourceMediaKind) => string;
  onBack: () => void;
  onCopy: (record: ClipboardRecord) => void | Promise<void>;
  onDelete: (id: string) => void;
}

export default function ResourceDetailPage({
  record,
  typeLabel,
  onBack,
  onCopy,
  onDelete,
}: ResourceDetailPageProps) {
  const { t } = useTranslation();
  const kind = inferResourceMediaKind(record);
  const [segments, setSegments] = useState<RadialPreviewSegment[] | null>(null);
  const [error, setError] = useState(false);
  const [mediaSource, setMediaSource] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSegments(null);
    setError(false);
    setMediaSource(null);
    if (kind === "video" || kind === "audio" || kind === "file" || kind === "image") {
      if (kind === "video" || kind === "audio") {
        resolveResourceAssetUrl(record.content)
          .then((url) => {
            if (!cancelled) setMediaSource(url);
          })
          .catch(() => {
            if (!cancelled) setError(true);
          });
      }
      return () => {
        cancelled = true;
      };
    }

    loadClipboardPreviewSegments(record)
      .then((next) => {
        if (!cancelled) setSegments(next);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, record]);

  const title = getResourceTitle(record, kind);
  const detailReady = kind === "video" || kind === "audio"
    ? Boolean(mediaSource)
    : kind === "file" || kind === "image" || Boolean(segments);

  return (
    <div className="resource-detail-page">
      <header className="resource-detail-header">
        <button type="button" className="resource-back-button" onClick={onBack}>
          {Icons.arrowLeft}
          <span>{t("resources.backToLibrary")}</span>
        </button>
        <div className="resource-detail-actions">
          <button type="button" className="resource-secondary-button" onClick={() => void onCopy(record)}>
            {Icons.copy}
            <span>{t("resources.copy")}</span>
          </button>
          <button type="button" className="resource-delete-button resource-detail-delete" onClick={() => onDelete(record.id)}>
            {Icons.delete}
            <span>{t("common.delete")}</span>
          </button>
        </div>
      </header>

      <main className="resource-detail-body">
        <section className="resource-detail-main" aria-busy={!detailReady && !error}>
          <span className="resource-detail-kind">{typeLabel(kind)}</span>
          <h1>{title}</h1>
          <p className="resource-detail-subtitle">
            {typeLabel(kind)} · {getResourceGroupName(record)} · {record.source_app || t("resources.localSource")}
          </p>
          <div className={`resource-detail-stage resource-detail-stage-${kind}`}>
            {error ? (
              <div className="resource-detail-error" role="alert">
                <strong>{t("resources.detailError")}</strong>
                <button type="button" className="resource-secondary-button" onClick={onBack}>
                  {t("resources.backToLibrary")}
                </button>
              </div>
            ) : !detailReady ? (
              <div className="resource-preview-loading" role="status">{t("common.loading")}</div>
            ) : kind === "video" || kind === "audio" ? (
              <ResourceMediaPlayer kind={kind} path={record.content} resolvedSrc={mediaSource ?? undefined} />
            ) : kind === "image" ? (
              <ResourceImage
                path={record.content}
                alt={title}
                className="resource-segment-image"
              />
            ) : kind === "file" ? (
              <div className="resource-detail-file">
                {Icons.file}
                <strong>{getResourceFileName(record.content)}</strong>
                <span>{t("resources.fileDetailNote")}</span>
              </div>
            ) : (
              <ResourceSegments segments={segments || []} />
            )}
          </div>
        </section>

        <aside className="resource-detail-aside" aria-label={t("resources.info")}>
          <h2>{t("resources.info")}</h2>
          <dl>
            <div>
              <dt>{t("resources.type")}</dt>
              <dd>{typeLabel(kind)}</dd>
            </div>
            <div>
              <dt>{t("resources.group")}</dt>
              <dd>{getResourceGroupName(record)}</dd>
            </div>
            <div>
              <dt>{t("resources.createdAt")}</dt>
              <dd>{new Date(record.created_at).toLocaleString()}</dd>
            </div>
            {record.source_app && (
              <div>
                <dt>{t("resources.sourceApp")}</dt>
                <dd>{record.source_app}</dd>
              </div>
            )}
          </dl>
          <p>{t("resources.detailHint")}</p>
        </aside>
      </main>
    </div>
  );
}
