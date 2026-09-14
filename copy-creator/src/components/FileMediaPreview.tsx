import { useTranslation } from "react-i18next";
import { Icons } from "./Icons";
import { fileMediaKindFromPath } from "../domain/mediaKind";
import { ResourceImage } from "../pages/ResourcePage/ResourceMedia";
import { VideoPoster } from "./VideoPoster";

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
  version,
  className = "",
}: {
  path: string;
  /** 文件版本（修改毫秒）：文件被覆盖保存后 URL 变化，WebView 不再命中旧缓存。 */
  version?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const kind = fileMediaKindFromPath(path);

  if (kind === "video") {
    return (
      <div className={`clipboard-file-media is-video${className ? ` ${className}` : ""}`}>
        <VideoPoster
          path={path}
          version={version}
          fallbackLabel={t("resources.typeVideo")}
          iconClassName="clipboard-file-media-icon"
        />
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
          version={version}
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
