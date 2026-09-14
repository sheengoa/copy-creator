import { getResourceFileThumbnail, openResourceFile } from "../../domain/mediaAssets";
import { useEffect, useRef, useState } from "react";
import { useInViewOnce } from "../../hooks/useInViewOnce";
import { useTranslation } from "react-i18next";
import type { RadialPreviewSegment } from "../../domain/preview";
import { Icons } from "../../components/Icons";
import { resolveResourceAssetUrl, resolveResourceMediaUrl } from "../../domain/mediaUrl";
import { VideoPoster, type VideoPosterProps } from "../../components/VideoPoster";

function useResourceAssetUrl(
  path: string,
  resolvedSrc?: string,
  resolve: (path: string, version?: string) => Promise<string> = resolveResourceAssetUrl,
  version?: string,
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
    resolve(path, version)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, resolvedSrc, resolve, version]);

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

function rememberFileThumb(key: string, dataUrl: string) {
  fileThumbCache.delete(key);
  fileThumbCache.set(key, dataUrl);
  if (fileThumbCache.size > MAX_FILE_THUMBS) {
    const oldest = fileThumbCache.keys().next().value;
    if (oldest !== undefined) fileThumbCache.delete(oldest);
  }
}

/** 进程内缩略图缓存键：路径 + 文件版本，覆盖保存后自然失效取新。 */
function fileThumbCacheKey(path: string, version?: string) {
  return version ? `${path}\u0000${version}` : path;
}

/**
 * 列表卡片专用的文件图片缩略图：后端按"路径+大小+修改时间"解码缩放缓存，
 * 滚动时无需解码原图。后端解不了的格式（svg/heic 等）回退原图 ResourceImage。
 * 视觉为「原图虚影」：同图放大模糊铺底，前景完整展示，替代纯色留白。
 */
export function ResourceFileImage({
  path,
  alt,
  className = "",
  version,
}: {
  path: string;
  alt: string;
  className?: string;
  /** 文件版本（修改毫秒）：失效进程内缓存与后端缩放缓存。 */
  version?: string;
}) {
  const cacheKey = fileThumbCacheKey(path, version);
  const cached = fileThumbCache.get(cacheKey);
  const [src, setSrc] = useState(cached ?? "");
  const [failed, setFailed] = useState(false);
  // 真懒加载：进入视口（含 300px 预载边）才请求后端解码缩略图。
  // 挂载即请求会让大库一次触发成百上千个解码任务，滚动直接卡死；
  // content-visibility 只省绘制，拦不住 effect，必须在这里拦。
  const [viewportRef, inView] = useInViewOnce<HTMLDivElement>();

  useEffect(() => {
    const cachedUrl = fileThumbCache.get(cacheKey);
    if (cachedUrl) {
      setSrc(cachedUrl);
      setFailed(false);
      return;
    }
    if (!inView) return;
    let cancelled = false;
    setSrc("");
    setFailed(false);
    getResourceFileThumbnail(path, 256)
      .then((base64) => {
        if (cancelled) return;
        const dataUrl = `data:image/png;base64,${base64}`;
        rememberFileThumb(cacheKey, dataUrl);
        setSrc(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, inView, path]);

  if (failed) {
    return <ResourceImage path={path} alt={alt} className={className} version={version} />;
  }
  if (!src) {
    return (
      <div
        ref={viewportRef}
        className={`resource-media-loading ${className}`}
        aria-hidden="true"
      />
    );
  }
  return (
    <div className={`resource-thumb-blur ${className}`.trim()}>
      <img className="resource-thumb-blur-bg" src={src} alt="" aria-hidden="true" />
      <img
        className="resource-thumb-blur-fg"
        src={src}
        alt={alt}
        draggable={false}
        decoding="async"
      />
    </div>
  );
}

export function ResourceImage({
  path,
  alt,
  className = "",
  onMetadata,
  version,
}: {
  path: string;
  alt: string;
  className?: string;
  onMetadata?: (meta: ResourceImageMetadata) => void;
  /** 文件版本（修改毫秒）：URL 随覆盖保存变化，绕开 WebView 旧缓存。 */
  version?: string;
}) {
  const { t } = useTranslation();
  const { src, failed } = useResourceAssetUrl(path, undefined, resolveResourceAssetUrl, version);
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

/**
 * 详情页原图干净展示：中性舞台上 contain 完整呈现原图，不做模糊虚影
 * 铺底——那是列表缩略图卡片的视觉，放进详情页会让整图看起来发糊。
 * className 施加于图片，高度约束由使用方 CSS 给定（如详情页的 62vh）。
 * onZoom 提供时图片可点击，回调携带已解析的图片 URL 供全屏灯箱使用。
 */
export function ResourceImageOriginal({
  path,
  alt,
  className = "",
  onMetadata,
  onZoom,
  version,
}: {
  path: string;
  alt: string;
  className?: string;
  onMetadata?: (meta: ResourceImageMetadata) => void;
  onZoom?: (src: string) => void;
  version?: string;
}) {
  const { src, failed } = useResourceAssetUrl(path, undefined, resolveResourceAssetUrl, version);
  const [imageFailed, setImageFailed] = useState(false);
  const reportedSizeRef = useRef("");

  useEffect(() => {
    setImageFailed(false);
    reportedSizeRef.current = "";
  }, [src]);

  if (failed || imageFailed) {
    return (
      <div className={`resource-media-fallback ${className}`} role="img" aria-label={alt}>
        {Icons.image}
        <span>{alt}</span>
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
      decoding="async"
      onClick={onZoom
        ? (event) => {
            // 阻止冒泡，避免触发外层容器的点击行为。
            event.stopPropagation();
            onZoom(src);
          }
        : undefined}
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
            key={`image-${index}-${segment.path}-${segment.version ?? ""}`}
            path={segment.path}
            alt={t("resources.imagePreview")}
            className="resource-segment-image"
            version={segment.version}
          />
        ),
      )}
    </div>
  );
}

/**
 * 列表卡片专用的视频封面帧：统一实现见 components/VideoPoster.tsx，
 * 这里保留原函数名作为资源卡片的转发出口（占位图标用资源卡视觉）。
 */
export function ResourceVideoPoster(
  props: Omit<VideoPosterProps, "iconClassName">,
) {
  return <VideoPoster iconClassName="resource-card-visual-icon" {...props} />;
}


export function ResourceMediaPlayer({
  kind,
  path,
  compact = false,
  resolvedSrc,
  onMediaMetadata,
  version,
}: {
  kind: "video" | "audio";
  path: string;
  compact?: boolean;
  resolvedSrc?: string;
  onMediaMetadata?: (meta: ResourceMediaMetadata) => void;
  version?: string;
}) {
  const { t } = useTranslation();
  const { src, failed } = useResourceAssetUrl(path, resolvedSrc, resolveResourceMediaUrl, version);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);

  const openInSystemPlayer = async () => {
    setOpenFailed(false);
    try {
      await openResourceFile(path);
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
