import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RadialPreviewSegment } from "../../utils/radialPreview";
import { Icons } from "../../components/Icons";
import { resolveResourceAssetUrl } from "./resourceUtils";

function useResourceAssetUrl(path: string, resolvedSrc?: string) {
  const [src, setSrc] = useState(resolvedSrc ?? "");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(resolvedSrc ?? "");
    setFailed(false);
    if (resolvedSrc) {
      return () => {
        cancelled = true;
      };
    }
    resolveResourceAssetUrl(path)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, resolvedSrc]);

  return { src, failed };
}

export function ResourceImage({
  path,
  alt,
  className = "",
}: {
  path: string;
  alt: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const { src, failed } = useResourceAssetUrl(path);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [src]);

  if (failed || imageFailed) {
    return (
      <div className={`resource-media-fallback ${className}`} role="img" aria-label={t("resources.mediaUnavailable")}>
        {Icons.image}
        <span>{t("resources.mediaUnavailable")}</span>
      </div>
    );
  }
  if (!src) return <div className={`resource-media-loading ${className}`} aria-hidden="true" />;
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      draggable={false}
      onError={() => setImageFailed(true)}
    />
  );
}

export function ResourceSegments({
  segments,
  compact = false,
}: {
  segments: RadialPreviewSegment[];
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className={`resource-segments${compact ? " compact" : ""}`}>
      {segments.map((segment, index) =>
        segment.type === "text" ? (
          <pre className="resource-segment-text" key={`text-${index}`}>
            {segment.content}
          </pre>
        ) : (
          <ResourceImage
            key={`image-${index}-${segment.path}`}
            path={segment.path}
            alt={t("resources.imagePreview")}
            className="resource-segment-image"
          />
        ),
      )}
    </div>
  );
}

export function ResourceMediaPlayer({
  kind,
  path,
  compact = false,
  resolvedSrc,
}: {
  kind: "video" | "audio";
  path: string;
  compact?: boolean;
  resolvedSrc?: string;
}) {
  const { t } = useTranslation();
  const { src, failed } = useResourceAssetUrl(path, resolvedSrc);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);

  useEffect(() => {
    setAutoplayBlocked(false);
    setMediaFailed(false);
    const media = mediaRef.current;
    if (!media || !src) return;
    const playResult = media.play();
    if (playResult) {
      playResult.catch(() => setAutoplayBlocked(true));
    }
    return () => {
      media.pause();
      media.removeAttribute("src");
    };
  }, [src]);

  if (failed) {
    return (
      <div className="resource-media-fallback resource-media-player-fallback" role="status">
        {kind === "video" ? Icons.video : Icons.audio}
        <span>{t("resources.mediaUnavailable")}</span>
      </div>
    );
  }
  if (!src) return <div className="resource-media-loading resource-media-player-loading" aria-hidden="true" />;

  const player = kind === "video" ? (
    <video
      ref={mediaRef as React.RefObject<HTMLVideoElement>}
      className="resource-media-video"
      src={src}
      controls
      autoPlay
      playsInline
      preload="metadata"
      onError={() => setMediaFailed(true)}
    />
  ) : (
    <audio
      ref={mediaRef as React.RefObject<HTMLAudioElement>}
      className="resource-media-audio"
      src={src}
      controls
      autoPlay
      preload="metadata"
      onError={() => setMediaFailed(true)}
    />
  );

  return (
    <div className={`resource-media-player${compact ? " compact" : ""}`}>
      {player}
      {mediaFailed && (
        <span className="resource-media-note" role="status">
          {t("resources.mediaUnavailable")}
        </span>
      )}
      {!mediaFailed && autoplayBlocked && (
        <span className="resource-media-note" role="status">
          {t("resources.autoplayBlocked")}
        </span>
      )}
    </div>
  );
}
