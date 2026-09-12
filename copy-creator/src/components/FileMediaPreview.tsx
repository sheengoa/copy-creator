import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "./Icons";
import { fileMediaKindFromPath } from "../domain/mediaKind";
import { resolveResourceMediaUrl } from "../domain/mediaUrl";
import { loadResourceVideoPoster, saveResourceVideoPoster } from "../domain/mediaAssets";
import { ResourceImage } from "../pages/ResourcePage/ResourceMedia";

/**
 * 剪切板/径向菜单文件条目的媒体视觉，也是图片内容的统一列表态：
 * 图片一律出全宽横幅并直接流式加载原图（asset 协议 + 懒解码，不在任何
 * 目录生成缩略图文件），横幅可视数量少，全尺寸解码开销可接受；清晰度
 * 优先，256px 缩略图管线只留给密集小网格卡片。视频出封面帧（元数据
 * 寻帧，失败回退图标占位），音频出类型图标条。普通文件渲染 null，
 * 调用方按原样展示文件名。视频地址经后端回环媒体服务提供。
 */
export function FileMediaVisual({
  path,
  className = "",
}: {
  path: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const kind = fileMediaKindFromPath(path);

  if (kind === "video") {
    return (
      <div className={`clipboard-file-media is-video${className ? ` ${className}` : ""}`}>
        <VideoPosterFrame path={path} fallbackLabel={t("resources.typeVideo")} />
        <span className="clipboard-file-media-play" aria-hidden="true">{Icons.play}</span>
      </div>
    );
  }

  if (kind === "image") {
    return (
      <div className={`clipboard-file-media is-image${className ? ` ${className}` : ""}`}>
        <ResourceImage
          path={path}
          alt={t("resources.typeImage")}
          className="clipboard-file-media-image"
        />
      </div>
    );
  }

  if (kind === "audio") {
    return (
      <div className={`clipboard-file-media is-audio${className ? ` ${className}` : ""}`}>
        <span className="clipboard-file-media-icon" aria-hidden="true">{Icons.audio}</span>
        <span>{t("resources.typeAudio")}</span>
      </div>
    );
  }

  return null;
}

/**
 * 视频封面帧：进入视口后才解析媒体地址并加载元数据，加载到后跳到代表性
 * 时间点（约 10% 处）渲染画面；元数据/寻帧失败保持图标占位。与资源区
 * ResourceVideoPoster 同一套视觉，画布铺底虚影 + 前景完整帧。
 */
function VideoPosterFrame({
  path,
  fallbackLabel,
}: {
  path: string;
  fallbackLabel: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [inView, setInView] = useState(false);
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  // 已持久化的海报：命中后横幅只渲染这张图，不再挂 <video> 加载元数据
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
    let cancelled = false;
    setSrc("");
    setFailed(false);
    setHasFrame(false);
    posterSaveAttemptedRef.current = false;
    resolveResourceMediaUrl(path)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    loadResourceVideoPoster(path)
      .then((base64) => {
        if (!cancelled && base64) setSavedPoster(`data:image/jpeg;base64,${base64}`);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path]);

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
    // 高清帧导出持久化（每视频一次；canvas 被污染等场景吞错放弃存盘）。
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

  const showPlaceholder = !inView || failed || (!src && !savedPoster) || (!savedPoster && !hasFrame);
  return (
    <div ref={containerRef} className="resource-video-poster" aria-hidden="true">
      {inView && savedPoster ? (
        <img
          className="resource-video-poster-frame is-ready"
          src={savedPoster}
          alt=""
          draggable={false}
        />
      ) : inView && !failed && src ? (
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
            onError={() => setFailed(true)}
          />
        </>
      ) : null}
      {showPlaceholder && (
        <div className="resource-video-poster-placeholder">
          <span className="clipboard-file-media-icon">{Icons.video}</span>
          <span>{fallbackLabel}</span>
        </div>
      )}
    </div>
  );
}
