// 径向菜单条目的图像文件短语缩略图（叶子组件）。
// content 为相对存储目录的路径，加载失败回退文件名。
import { useEffect, useState } from "react";
import { getImageThumbnail } from "../../domain/mediaAssets";
import { fileNameFromPath } from "../../domain/fileName";

export function FileThumb({ path }: { path: string }) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    let cancelled = false;
    getImageThumbnail(path, 200)
      .then((base64) => {
        if (!cancelled) setSrc(`data:image/png;base64,${base64}`);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path]);

  if (!src) return <span className="radial-menu-item-text">{fileNameFromPath(path)}</span>;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      style={{ width: 48, height: 36, objectFit: "contain", borderRadius: 5 }}
    />
  );
}
