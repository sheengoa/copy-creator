import {
  getResourceFileThumbnail,
  loadResourceVideoPoster,
  openResourceFile,
  saveResourceVideoPoster,
} from "../../domain/mediaAssets";
import { useEffect, useRef, useState } from "react";
import { useInViewOnce } from "../../hooks/useInViewOnce";
import { useTranslation } from "react-i18next";
import type { RadialPreviewSegment } from "../../domain/preview";
import { Icons } from "../../components/Icons";
import { resolveResourceAssetUrl, resolveResourceMediaUrl } from "../../domain/mediaUrl";

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
 * 视觉为「原图虚影」：同图放大模糊铺底，前景完整展示，替代纯色留白。
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
  // 真懒加载：进入视口（含 300px 预载边）才请求后端解码缩略图。
  // 挂载即请求会让大库一次触发成百上千个解码任务，滚动直接卡死；
  // content-visibility 只省绘制，拦不住 effect，必须在这里拦。
  const [viewportRef, inView] = useInViewOnce<HTMLDivElement>();

  useEffect(() => {
    const cachedUrl = fileThumbCache.get(path);
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
        rememberFileThumb(path, dataUrl);
        setSrc(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, inView]);

  if (failed) {
    return <ResourceImage path={path} alt={alt} className={className} />;
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
}: {
  path: string;
  alt: string;
  className?: string;
  onMetadata?: (meta: ResourceImageMetadata) => void;
  onZoom?: (src: string) => void;
}) {
  const { src, failed } = useResourceAssetUrl(path);
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

/**
 * 列表卡片专用的视频封面帧：进入视口后才解析媒体地址并加载元数据，
 * 加载到后跳到代表性时间点（约 10% 处）渲染画面。元数据/寻帧失败时
 * 保持占位图标，不影响卡片其余交互。
 */
export function ResourceVideoPoster({
  path,
  fallbackLabel,
}: {
  path: string;
  fallbackLabel: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [inView, setInView] = useState(false);
  const { src, failed } = useResourceAssetUrl(path, undefined, resolveResourceMediaUrl);
  const [videoFailed, setVideoFailed] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  // 已持久化的海报：命中后列表只渲染这张图，不再挂 <video> 加载元数据
  // 与寻帧——几百个视频的库靠它保住列表流畅。
  const [savedPoster, setSavedPoster] = useState("");
  const posterSaveAttemptedRef = useRef(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setVideoFailed(false);
    setHasFrame(false);
    posterSaveAttemptedRef.current = false;
  }, [src]);

  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    loadResourceVideoPoster(path)
      .then((base64) => {
        if (!cancelled && base64) setSavedPoster(`data:image/jpeg;base64,${base64}`);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [inView, path]);

  // 寻到代表性帧后画到低分辨率画布上：放大 + 模糊作为铺底虚影，
  // 前景视频完整展示，替代纯色留白。仅绘制不读回像素，无跨源限制。
  const handleSeeked = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const media = event.currentTarget;
    const canvas = canvasRef.current;
    if (canvas) {
      const context = canvas.getContext("2d");
      if (context && media.videoWidth > 0 && media.videoHeight > 0) {
        context.drawImage(media, 0, 0, canvas.width, canvas.height);
      }
    }
    // 高清帧导出持久化（每个视频只做一次；旧版本缓存的响应无 CORS 头时
    // canvas 被污染，toDataURL 抛错——吞掉即可，下次仍走现场抽帧）。
    if (!posterSaveAttemptedRef.current && media.videoWidth > 0) {
      posterSaveAttemptedRef.current = true;
      try {
        const exportCanvas = document.createElement("canvas");
        exportCanvas.width = 640;
        exportCanvas.height = Math.max(
          1,
          Math.round((640 * media.videoHeight) / media.videoWidth),
        );
        const exportContext = exportCanvas.getContext("2d");
        if (exportContext) {
          exportContext.drawImage(media, 0, 0, exportCanvas.width, exportCanvas.height);
          const dataUrl = exportCanvas.toDataURL("image/jpeg", 0.72);
          void saveResourceVideoPoster(path, dataUrl).catch(() => {});
        }
      } catch {
        // 跨源污染等场景放弃持久化，不影响本次展示。
      }
    }
    setHasFrame(true);
  };

  const handleLoadedMetadata = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const media = event.currentTarget;
    // 首帧常为黑场，跳到约 10% 处取代表性画面；seek 失败则退回首帧。
    const target = Number.isFinite(media.duration) && media.duration > 0
      ? Math.min(media.duration * 0.1, 3)
      : 0.04;
    try {
      media.currentTime = target;
    } catch {
      handleSeeked(event);
    }
  };

  const showPlaceholder = !inView || failed || videoFailed || (!src && !savedPoster) || (!savedPoster && !hasFrame);
  const useSavedPoster = Boolean(inView && savedPoster);
  return (
    <div ref={containerRef} className="resource-video-poster" aria-hidden="true">
      {useSavedPoster ? (
        <img className="resource-video-poster-frame is-ready" src={savedPoster} alt="" draggable={false} />
      ) : inView && !failed && !videoFailed && src ? (
        <>
          <canvas ref={canvasRef} className="resource-video-poster-bg" width={48} height={27} />
          <video
            className={`resource-video-poster-frame${hasFrame ? " is-ready" : ""}`}
            src={src}
            muted
            preload="metadata"
            crossOrigin="anonymous"
            onLoadedMetadata={handleLoadedMetadata}
            onSeeked={handleSeeked}
            onError={() => setVideoFailed(true)}
          />
        </>
      ) : null}
      {showPlaceholder && (
        <div className="resource-video-poster-placeholder">
          <span className="resource-card-visual-icon">{Icons.video}</span>
          <span>{fallbackLabel}</span>
        </div>
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
