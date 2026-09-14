import { useEffect, useRef, useState } from "react";
import { loadResourceVideoPoster, saveResourceVideoPoster } from "../domain/mediaAssets";
import { resolveResourceMediaUrl } from "../domain/mediaUrl";
import { Icons } from "./Icons";

/**
 * 视频封面帧（全应用唯一实现，替代 FileMediaPreview / ResourceMedia 里的
 * 两份逐行复制）：进入视口后才解析媒体地址并加载元数据，加载到后跳到
 * 代表性时间点（约 10% 处）渲染画面；已持久化的海报命中后只渲染这张图，
 * 不再挂 <video> 加载元数据与寻帧——几百个视频的库靠它保住列表流畅。
 * 元数据/寻帧失败保持图标占位。画布铺底虚影 + 前景完整帧，仅绘制不读回
 * 像素，无跨源限制。
 */
export interface VideoPosterProps {
  path: string;
  version?: string;
  fallbackLabel: string;
  /** 占位图标的样式类：调用方各自的视觉体系不同。 */
  iconClassName?: string;
}

export function VideoPoster({
  path,
  version,
  fallbackLabel,
  iconClassName = "resource-card-visual-icon",
}: VideoPosterProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [inView, setInView] = useState(false);
  const [src, setSrc] = useState("");
  const [resolveFailed, setResolveFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  // 已持久化的海报：命中后只渲染这张图，不再挂 <video> 加载元数据与寻帧。
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
    let cancelled = false;
    setSrc("");
    setResolveFailed(false);
    setVideoFailed(false);
    setHasFrame(false);
    posterSaveAttemptedRef.current = false;
    resolveResourceMediaUrl(path, version)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setResolveFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, version]);

  // 持久化海报按需加载：进入视口才读取（老库批量浏览时避免一次性解码）。
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
        // 放弃持久化，不影响本次展示。
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

  const showPlaceholder =
    !inView ||
    resolveFailed ||
    videoFailed ||
    (!src && !savedPoster) ||
    (!savedPoster && !hasFrame);
  const useSavedPoster = Boolean(inView && savedPoster);
  return (
    <div ref={containerRef} className="resource-video-poster" aria-hidden="true">
      {useSavedPoster ? (
        <img className="resource-video-poster-frame is-ready" src={savedPoster} alt="" draggable={false} />
      ) : inView && !resolveFailed && !videoFailed && src ? (
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
          <span className={iconClassName}>{Icons.video}</span>
          <span>{fallbackLabel}</span>
        </div>
      )}
    </div>
  );
}
