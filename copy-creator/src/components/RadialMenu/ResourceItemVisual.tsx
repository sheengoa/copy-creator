// 径向菜单资源条目的视觉渲染（叶子组件：props 进、渲染出）。
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { useClipboardStore } from "../../stores/clipboardStore";
import { Icons } from "../Icons";
import { FileMediaVisual } from "../FileMediaPreview";
import { ResourceFileImage } from "../../pages/ResourcePage/ResourceMedia";
import { InlineTextFilePreview } from "../InlinePreview";
import { type ResourceMediaKind } from "../../domain/mediaKind";

/** 结构子集 props：避免依赖容器内部的 RadialItem 完整类型。 */
export interface ResourceItemVisualProps {
  item: {
    id: string;
    type: string;
    resourceKind?: ResourceMediaKind;
    resourcePath?: string;
    resourceTitle?: string;
    resourceSummary?: string;
    createdAt?: string;
  };
}

export function ResourceItemVisual({ item }: ResourceItemVisualProps) {
  const { t } = useTranslation();
  const kind = item.resourceKind;

  if (!kind) return null;

  if (kind === "image" && item.type === "image") {
    // 与文件图片一致：全宽完整展示，不再使用 48×36 小缩略图。
    return <RadialImageThumb recordId={item.id} wide />;
  }

  if (kind === "image" && item.resourcePath) {
    return (
      <ResourceFileImage
        path={item.resourcePath}
        alt={item.resourceTitle || t("resources.imagePreview")}
        className="radial-menu-resource-image"
      />
    );
  }

  if (kind === "text" && item.type === "file" && item.resourcePath) {
    return (
      <div className="radial-menu-resource-text-file">
        <InlineTextFilePreview
          resourcePath={item.resourcePath}
          resourceVersion={item.createdAt}
        />
      </div>
    );
  }

  if (kind === "text") {
    return (
      <div className="radial-menu-resource-text">
        {item.resourceSummary || t("resources.empty")}
      </div>
    );
  }

  if (kind === "video" && item.resourcePath) {
    return (
      <FileMediaVisual
        path={item.resourcePath}
        className="radial-menu-file-media"
      />
    );
  }

  return (
    <div className={`radial-menu-resource-type radial-menu-resource-type-${kind}`}>
      {kind === "video" ? Icons.video : kind === "audio" ? Icons.audio : Icons.file}
      <span>{t(`resources.type${kind[0].toUpperCase()}${kind.slice(1)}`)}</span>
    </div>
  );
}

export function RadialImageThumb({
  recordId,
  wide = false,
}: {
  recordId: string;
  /** 资源列表内全宽完整展示；默认 48×36 小缩略图。 */
  wide?: boolean;
}) {
  const [src, setSrc] = useState("");
  const { records, getThumbnail } = useClipboardStore();

  useEffect(() => {
    const record = records.find((r) => r.id === recordId);
    if (!record || record.type !== "image") return;
    let cancelled = false;
    getThumbnail(record).then((url) => {
      if (!cancelled && url) setSrc(url);
    });
    return () => { cancelled = true; };
  }, [recordId, records, getThumbnail]);

  if (!src) return <span className="radial-menu-item-text">…</span>;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      style={wide
        ? { display: "block", width: "100%", maxHeight: 120, objectFit: "contain", borderRadius: 6 }
        : { width: 48, height: 36, objectFit: "contain", borderRadius: 5 }}
    />
  );
}
