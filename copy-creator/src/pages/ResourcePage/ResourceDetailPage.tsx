import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord } from "../../types";
import { Icons } from "../../components/Icons";
import { HighlightText } from "../../components/HighlightText";
import { loadClipboardPreviewSegments } from "../../utils/contentPreview";
import type { RadialPreviewSegment } from "../../utils/radialPreview";
import {
  formatResourceFileSize,
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
  const [textContent, setTextContent] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [mediaSource, setMediaSource] = useState<string | null>(null);
  const externalTextPath = kind === "text" && record.type === "file"
    ? record.resource_path || record.content
    : null;

  useEffect(() => {
    let cancelled = false;
    setSegments(null);
    setTextContent(null);
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

    if (externalTextPath) {
      invoke<string>("read_resource_text_preview", { path: externalTextPath })
        .then((content) => {
          if (!cancelled) setTextContent(content);
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
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
  }, [externalTextPath, kind, record]);

  const title = getResourceTitle(record, kind);
  const detailReady = kind === "video" || kind === "audio"
    ? Boolean(mediaSource)
    : kind === "file" || kind === "image" || Boolean(segments);
  const textDetailReady = externalTextPath ? textContent !== null : Boolean(segments);
  const contentReady = externalTextPath ? textDetailReady : detailReady;

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
        <section className="resource-detail-main" aria-busy={!(externalTextPath ? textDetailReady : detailReady) && !error}>
          <span className="resource-detail-kind">{typeLabel(kind)}</span>
          <h1>{title}</h1>
          <p className="resource-detail-subtitle">
            {typeLabel(kind)} · {record.source_app || t("resources.localSource")}
          </p>
          <div className={`resource-detail-stage resource-detail-stage-${kind}`}>
            {error ? (
              <div className="resource-detail-error" role="alert">
                <strong>{t("resources.detailError")}</strong>
                <button type="button" className="resource-secondary-button" onClick={onBack}>
                  {t("resources.backToLibrary")}
                </button>
              </div>
            ) : !contentReady ? (
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
                <span>
                  {t("resources.fileDetailNote")}
                  {record.resource_file_size !== undefined && ` · ${formatResourceFileSize(record.resource_file_size)}`}
                </span>
                <code>{record.resource_relative_path || record.resource_path || record.content}</code>
              </div>
            ) : externalTextPath ? (
              <pre className="resource-segment-text resource-detail-text-file">
                <HighlightText text={textContent || ""} />
              </pre>
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
              <dt>{t("resources.createdAt")}</dt>
              <dd>{new Date(record.created_at).toLocaleString()}</dd>
            </div>
            {record.resource_file_size !== undefined && (
              <div>
                <dt>{t("resources.fileSize")}</dt>
                <dd>{formatResourceFileSize(record.resource_file_size)}</dd>
              </div>
            )}
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
