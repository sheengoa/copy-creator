import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { RadialPreviewSegment } from "../utils/radialPreview";

interface ContentPreviewPanelProps {
  segments: RadialPreviewSegment[] | null;
  className: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: React.MouseEvent<HTMLElement>) => void;
}

let storageDirPromise: Promise<string> | null = null;

async function resolveAssetUrl(path: string) {
  if (!storageDirPromise) {
    storageDirPromise = invoke<string>("get_storage_path");
  }
  const storageDir = (await storageDirPromise).replace(/[\\/]+$/, "");
  return convertFileSrc(`${storageDir}/${path.replace(/^[\\/]+/, "")}`);
}

function PreviewImage({ path }: { path: string }) {
  const { t } = useTranslation();
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    resolveAssetUrl(path)
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
      <div className="content-preview-title">{t("radialMenu.previewTitle")}</div>
      <div className="content-preview-body" data-content-preview-scroll>
        {segments === null ? (
          <div className="content-preview-loading">{t("common.loading")}</div>
        ) : (
          segments.map((segment, index) => segment.type === "text" ? (
            <div className="content-preview-text" key={`text-${index}`}>
              {segment.content}
            </div>
          ) : (
            <PreviewImage path={segment.path} key={`image-${index}-${segment.path}`} />
          ))
        )}
      </div>
    </section>
  );
}
