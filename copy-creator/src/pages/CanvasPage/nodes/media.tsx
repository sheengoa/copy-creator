import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "../../../components/Icons";
import { MediaPlayback } from "../../../components/MediaPlayback";
import { resolveCanvasMediaPath, resolveCanvasMediaUrl } from "./mediaPath";

// 画布节点共享媒体组件：缩略图（ResourceThumb）、画布产物播放器
// （CanvasMediaPlayer）、保存节点产物视图（SaveProductView/Cell/MediaBox），
// 供各节点家族模块复用。路径归一见 mediaPath.ts。自 FreeCanvas.tsx 整体
// 迁出（基座化 2026-11-03）。

/** 资源缩略图：mediaUrl 域层唯一出口，路径变化重解析。
 *  ratioFit（2026-11-04）：内容节点媒体盒的黑边根除——img 元素盒（全宽
 *  × 330 高帽）大于图像盒时 contain 留黑边（竖版加载图像左右黑条，与
 *  视频侧修复前同病），onLoad 读 naturalWidth/Height 后按实测比例收敛
 *  元素盒，与 MediaPlayback 的 ratioFit 同一公式（直接复用同套几何）。
 *  2026-11-06 起几何改经 CSS 交接：组件只写实测变量（--media-fitw/
 *  --media-ar）并挂 is-ratio-fit 类，具体呈现（自动高的 330 帽等比盒/
 *  固定高节点的填充区内最大等比盒）由样式层按节点态接管——内联样式
 *  会压住 pc-resized 规则，节点拉伸就永远无法放大媒体了。url 经异步
 *  解析后才赋给 src，onLoad 监听必先就位，缓存图也不会漏计。
 *  加载失败给可见占位（2026-11-06）：此前 onError 静默，盘选文件授权
 *  失配/文件缺失时整盒空白（用户无法分辨「没加载」与「加载失败」），
 *  与 MediaPlayback 的失败态同一处理哲学。 */
export function ResourceThumb({ path, className, ratioFit = false }: { path: string; className?: string; ratioFit?: boolean }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [ratio, setRatio] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    setRatio(null);
    setFailed(false);
    resolveCanvasMediaUrl(path)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);
  // 实测几何只进变量，不直接落样式：is-ratio-fit 类的规则消费这些
  // 变量（自动高 330 帽 / 固定高等比精确盒两态各有各的用法）。
  // --media-arw 是宽高比纯数字（w/h），供固定高路径 min(100cqw,
  // 100cqh×arw) 算两轴最大等比盒——<ratio> 值进不了 calc 乘法，
  // 必须与 --media-ar 分开各写一份。
  const fitStyle =
    ratioFit && ratio && ratio.w > 0 && ratio.h > 0
      ? ({
          "--media-fitw": `${Math.round(330 * (ratio.w / ratio.h))}px`,
          "--media-ar": `${ratio.w} / ${ratio.h}`,
          "--media-arw": String(ratio.w / ratio.h),
        } as CSSProperties)
      : undefined;
  if (!url) return null;
  if (failed) {
    return (
      <span className={`fc-media-broken${className ? ` ${className}` : ""}`}>
        {Icons.image}
        {t("canvas.mediaBroken")}
      </span>
    );
  }
  return (
    <img
      className={ratioFit ? `is-ratio-fit${className ? ` ${className}` : ""}` : className}
      style={fitStyle}
      src={url}
      alt=""
      draggable={false}
      /* 异步解码（2026-11-08 执行后平移卡顿）：产物图是视频原分辨率帧
         （1080p/4K PNG），首次挂载默认同步解码阻塞主线程数秒——用户实测
         「刚执行完平移画布卡几秒后恢复」与之吻合；decoding="async" 把
         解码挪到后台线程，平移/交互全程不被解码阻塞。 */
      decoding="async"
      onError={() => setFailed(true)}
      onLoad={(e) => {
        const el = e.currentTarget;
        setRatio({ w: el.naturalWidth, h: el.naturalHeight });
      }}
    />
  );
}

/** 画布产物播放器（保存节点的视频/音频产物预览用）：统一播放条
 *  （MediaPlayback）不感知画布相对路径语义（resource_path 存量数据是
 *  库相对语义），这里先归一再交给组件——与 ResourceThumb 同一归一语义。
 *  组件默认不自动播放（用户定案），保存盒天然静默。 */
export function CanvasMediaPlayer({ kind, path }: { kind: "video" | "audio"; path: string }) {
  const [absolute, setAbsolute] = useState("");
  useEffect(() => {
    let alive = true;
    setAbsolute("");
    resolveCanvasMediaPath(path)
      .then((p) => {
        if (alive) setAbsolute(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);
  if (!absolute) return null;
  return <MediaPlayback kind={kind} path={absolute} ratioFit={kind === "video"} />;
}

/** 保存节点产物的展示类型：随节点类型（save_image/save_video/save_audio），
 *  上游口类型矩阵保证产物类型吻合；other 兜底未知形态（占位图标）。 */
export type SaveProductKind = "image" | "video" | "audio" | "other";

/** 保存节点产物单件视图：图像走缩略图；音频/视频走可播放播放器（2026-11-02
 *  定案：保存后可直接确认内容——此前一律 <img>，音视频解码失败渲染成空白
 *  盒，产物到位毫无视觉反馈）。kind 随保存节点类型（上游口类型矩阵保证
 *  产物类型吻合），非媒体类型兜底占位图标。 */
export function SaveProductView({ path, kind }: { path: string; kind: SaveProductKind }) {
  if (kind === "video") return <CanvasMediaPlayer kind="video" path={path} />;
  if (kind === "audio") return <CanvasMediaPlayer kind="audio" path={path} />;
  if (kind === "image") return <ResourceThumb path={path} className="fc-media-box" ratioFit />;
  return <span className="fc-save-cell-icon">{Icons.file}</span>;
}

/** 保存格子内件：图像出缩略图；音/视频没有画面帧，出类型图标占位
 *  （点击仍切单件态看播放器）。 */
export function SaveProductCell({ path, kind }: { path: string; kind: SaveProductKind }) {
  if (kind === "image") return <ResourceThumb path={path} className="fc-save-cell-img" />;
  return <span className="fc-save-cell-icon">{kind === "video" ? Icons.video : Icons.audio}</span>;
}
