import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RadialPreviewSegment } from "../utils/radialPreview";
import { resolveResourceAssetUrl } from "../pages/ResourcePage/resourceUtils";
import { ResourceMediaPlayer } from "../pages/ResourcePage/ResourceMedia";
import { Icons } from "./Icons";

interface ContentPreviewPanelProps {
  segments: RadialPreviewSegment[] | null;
  className: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: React.MouseEvent<HTMLElement>) => void;
  onClose?: () => void;
}

function PreviewImage({ path }: { path: string }) {
  const { t } = useTranslation();
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc("");
    setFailed(false);
    resolveResourceAssetUrl(path)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [path]);

  if (failed) {
    return (
      <span className="content-preview-image-error">
        {t("radialMenu.imageUnavailable")}
      </span>
    );
  }
  if (!src) return <span className="content-preview-image-loading" aria-hidden="true" />;
  return (
    <img
      className="content-preview-image"
      src={src}
      alt={t("radialMenu.previewImage")}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

export function ContentPreviewPanel({
  segments,
  className,
  onClick,
  onMouseLeave,
  onClose,
}: ContentPreviewPanelProps) {
  const { t } = useTranslation();

  return (
    <section
      className={`content-preview-panel ${className}`}
      aria-label={t("radialMenu.previewTitle")}
      data-content-preview
      onClick={onClick}
      onMouseLeave={onMouseLeave}
    >
      <div className="content-preview-header">
        <div className="content-preview-title">{t("radialMenu.previewTitle")}</div>
        {onClose && (
          <button
            className="content-preview-close"
            type="button"
            aria-label={t("radialMenu.closePreview")}
            title={t("radialMenu.closePreview")}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }}
          >
            {Icons.close}
          </button>
        )}
      </div>
      <div className="content-preview-body" data-content-preview-scroll>
        {segments === null ? (
          <div className="content-preview-loading">{t("common.loading")}</div>
        ) : (
          segments.map((segment, index) => segment.type === "text" ? (
            <div className="content-preview-text" key={`text-${index}`}>
              {segment.content}
            </div>
          ) : segment.type === "image" ? (
            <PreviewImage path={segment.path} key={`image-${index}-${segment.path}`} />
          ) : (
            <ResourceMediaPlayer
              kind={segment.type}
              path={segment.path}
              key={`media-${index}-${segment.path}`}
            />
          ))
        )}
      </div>
    </section>
  );
}
