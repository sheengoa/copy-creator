import { useEffect, useState } from "react";
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
 *  视频侧修复前同病），onLoad 读 naturalWidth/Height 后把宽度收敛到
 *  「容器宽与 330px 高帽按比例换算的较小值」并锁 aspect-ratio，与
 *  MediaPlayback 的 ratioFit 同一公式（直接复用同套几何）。url 经异步
 *  解析后才赋给 src，onLoad 监听必先就位，缓存图也不会漏计。 */
export function ResourceThumb({ path, className, ratioFit = false }: { path: string; className?: string; ratioFit?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [ratio, setRatio] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    setRatio(null);
    resolveCanvasMediaUrl(path)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);
  const fitStyle =
    ratioFit && ratio && ratio.w > 0 && ratio.h > 0
      ? {
          width: `min(100%, ${Math.round(330 * (ratio.w / ratio.h))}px)`,
          aspectRatio: `${ratio.w} / ${ratio.h}`,
          marginInline: "auto",
        }
      : undefined;
  if (!url) return null;
  return (
    <img
      className={className}
      style={fitStyle}
      src={url}
      alt=""
      draggable={false}
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
