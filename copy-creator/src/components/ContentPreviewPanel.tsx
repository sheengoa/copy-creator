import { useTranslation } from "react-i18next";
import type { RadialPreviewSegment } from "../domain/preview";
import { useResourceMediaSrc } from "../hooks/useResourceMediaSrc";
import { ResourceMediaPlayer } from "../pages/ResourcePage/ResourceMedia";
import { Icons } from "./Icons";

interface ContentPreviewPanelProps {
  segments: RadialPreviewSegment[] | null;
  className: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: React.MouseEvent<HTMLElement>) => void;
  onClose?: () => void;
}

function PreviewImage({ path, version }: { path: string; version?: string }) {
  const { t } = useTranslation();
  // 解析/加载失败统一收口在 useResourceMediaSrc（含 <img> onError 上报）。
  const { src, failed, reportFailed } = useResourceMediaSrc(path, version);

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
      onError={reportFailed}
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
            <PreviewImage
              path={segment.path}
              version={segment.version}
              key={`image-${index}-${segment.path}-${segment.version ?? ""}`}
            />
          ) : (
            <ResourceMediaPlayer
              kind={segment.type}
              path={segment.path}
              version={segment.version}
              key={`media-${index}-${segment.path}-${segment.version ?? ""}`}
            />
          ))
        )}
      </div>
    </section>
  );
}
