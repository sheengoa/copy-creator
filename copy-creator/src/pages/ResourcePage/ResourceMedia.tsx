import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { RadialPreviewSegment } from "../../utils/radialPreview";
import { Icons } from "../../components/Icons";
import { resolveResourceAssetUrl, resolveResourceMediaUrl } from "./resourceUtils";

function useResourceAssetUrl(
  path: string,
  resolvedSrc?: string,
  resolve: (path: string) => Promise<string> = resolveResourceAssetUrl,
) {
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
    resolve(path)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, resolvedSrc, resolve]);

  return { src, failed };
}

export interface ResourceImageMetadata {
  width: number;
  height: number;
}

export interface ResourceMediaMetadata {
  duration?: number;
  width?: number;
  height?: number;
}

// 文件图片缩略图的进程内缓存（LRU），列表卡片滚动时避免重复请求后端。
const fileThumbCache = new Map<string, string>();
const MAX_FILE_THUMBS = 240;

function rememberFileThumb(path: string, dataUrl: string) {
  fileThumbCache.delete(path);
  fileThumbCache.set(path, dataUrl);
  if (fileThumbCache.size > MAX_FILE_THUMBS) {
    const oldest = fileThumbCache.keys().next().value;
    if (oldest !== undefined) fileThumbCache.delete(oldest);
  }
}

/**
 * 列表卡片专用的文件图片缩略图：后端按"路径+大小+修改时间"解码缩放缓存，
 * 滚动时无需解码原图。后端解不了的格式（svg/heic 等）回退原图 ResourceImage。
 */
export function ResourceFileImage({
  path,
  alt,
  className = "",
}: {
  path: string;
  alt: string;
  className?: string;
}) {
  const cached = fileThumbCache.get(path);
  const [src, setSrc] = useState(cached ?? "");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const cachedUrl = fileThumbCache.get(path);
    if (cachedUrl) {
      setSrc(cachedUrl);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setSrc("");
    setFailed(false);
    invoke<string>("get_resource_file_thumbnail", { path, maxSize: 256 })
      .then((base64) => {
        if (cancelled) return;
        const dataUrl = `data:image/png;base64,${base64}`;
        rememberFileThumb(path, dataUrl);
        setSrc(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (failed) {
    return <ResourceImage path={path} alt={alt} className={className} />;
  }
  if (!src) return <div className={`resource-media-loading ${className}`} aria-hidden="true" />;
  return <img className={className} src={src} alt={alt} draggable={false} decoding="async" />;
}

export function ResourceImage({
  path,
  alt,
  className = "",
  onMetadata,
}: {
  path: string;
  alt: string;
  className?: string;
  onMetadata?: (meta: ResourceImageMetadata) => void;
}) {
  const { t } = useTranslation();
  const { src, failed } = useResourceAssetUrl(path);
  const [imageFailed, setImageFailed] = useState(false);
  const reportedSizeRef = useRef("");

  useEffect(() => {
    setImageFailed(false);
    reportedSizeRef.current = "";
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
      loading="lazy"
      decoding="async"
      onLoad={(event) => {
        const image = event.currentTarget;
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
        const sizeKey = `${image.naturalWidth}x${image.naturalHeight}`;
        if (reportedSizeRef.current === sizeKey) return;
        reportedSizeRef.current = sizeKey;
        onMetadata?.({ width: image.naturalWidth, height: image.naturalHeight });
      }}
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
  onMediaMetadata,
}: {
  kind: "video" | "audio";
  path: string;
  compact?: boolean;
  resolvedSrc?: string;
  onMediaMetadata?: (meta: ResourceMediaMetadata) => void;
}) {
  const { t } = useTranslation();
  const { src, failed } = useResourceAssetUrl(path, resolvedSrc, resolveResourceMediaUrl);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);

  const openInSystemPlayer = async () => {
    setOpenFailed(false);
    try {
      await invoke("open_resource_file", { path });
    } catch {
      setOpenFailed(true);
    }
  };

  const handlePlaybackFailure = (error: unknown) => {
    const errorName = error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "";
    if (errorName === "NotAllowedError") {
      setAutoplayBlocked(true);
    } else if (errorName !== "AbortError") {
      setMediaFailed(true);
    }
  };

  const startPlayback = (media: HTMLMediaElement) => {
    const playResult = media.play();
    if (playResult) {
      void playResult.catch(handlePlaybackFailure);
    }
  };

  useEffect(() => {
    setAutoplayBlocked(false);
    setMediaFailed(false);
    setOpenFailed(false);
    const media = mediaRef.current;
    if (!media || !src) return;
    return () => {
      media.pause();
    };
  }, [src]);

  if (failed || mediaFailed) {
    return (
      <div className="resource-media-fallback resource-media-player-fallback" role="status">
        {kind === "video" ? Icons.video : Icons.audio}
        <span>{t("resources.mediaUnavailable")}</span>
        <button type="button" className="resource-secondary-button resource-media-open-button" onClick={() => void openInSystemPlayer()}>
          {Icons.play}
          <span>{t("resources.openInSystemPlayer")}</span>
        </button>
        {openFailed && <span className="resource-media-note">{t("resources.openMediaFailed")}</span>}
      </div>
    );
  }
  if (!src) return <div className="resource-media-loading resource-media-player-loading" aria-hidden="true" />;

  const player = kind === "video" ? (
    <video
      ref={mediaRef as React.RefObject<HTMLVideoElement>}
      className="resource-media-video"
      src={src}
      key={`video-${src}`}
      controls
      autoPlay
      playsInline
      preload="metadata"
      onLoadedMetadata={(event) => {
        setMediaFailed(false);
        const media = event.currentTarget;
        if (!onMediaMetadata) return;
        onMediaMetadata({
          duration: Number.isFinite(media.duration) && media.duration > 0 ? media.duration : undefined,
          width: kind === "video" ? (media as HTMLVideoElement).videoWidth || undefined : undefined,
          height: kind === "video" ? (media as HTMLVideoElement).videoHeight || undefined : undefined,
        });
      }}
      onCanPlay={(event) => {
        setMediaFailed(false);
        startPlayback(event.currentTarget);
      }}
      onPlay={() => {
        setMediaFailed(false);
        setAutoplayBlocked(false);
      }}
      onError={(event) => {
        if (event.currentTarget !== mediaRef.current) return;
        setMediaFailed(true);
      }}
    />
  ) : (
    <audio
      ref={mediaRef as React.RefObject<HTMLAudioElement>}
      className="resource-media-audio"
      src={src}
      key={`audio-${src}`}
      controls
      autoPlay
      preload="metadata"
      onLoadedMetadata={(event) => {
        setMediaFailed(false);
        const media = event.currentTarget;
        if (!onMediaMetadata) return;
        onMediaMetadata({
          duration: Number.isFinite(media.duration) && media.duration > 0 ? media.duration : undefined,
        });
      }}
      onCanPlay={(event) => {
        setMediaFailed(false);
        startPlayback(event.currentTarget);
      }}
      onPlay={() => {
        setMediaFailed(false);
        setAutoplayBlocked(false);
      }}
      onError={(event) => {
        if (event.currentTarget !== mediaRef.current) return;
        setMediaFailed(true);
      }}
    />
  );

  return (
    <div className={`resource-media-player${compact ? " compact" : ""}`}>
      {player}
      {!mediaFailed && autoplayBlocked && (
        <span className="resource-media-note" role="status">
          {t("resources.autoplayBlocked")}
        </span>
      )}
    </div>
  );
}
