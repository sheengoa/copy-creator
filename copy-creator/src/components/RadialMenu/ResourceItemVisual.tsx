// 径向菜单资源条目的视觉渲染（叶子组件：props 进、渲染出）。
import { useTranslation } from "react-i18next";
import { useClipboardStore } from "../../stores/clipboardStore";
import { Icons } from "../Icons";
import { FileMediaVisual } from "../FileMediaPreview";
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
    // 图片列表态统一全宽横幅（与图片文件一致）。
    return <RadialImageBanner recordId={item.id} />;
  }

  if (kind === "image" && item.resourcePath) {
    return <FileMediaVisual path={item.resourcePath} className="radial-menu-file-media" />;
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

/** 径向菜单剪切板图片条目的横幅（图片列表态统一全宽，经 FileMediaVisual）。 */
export function RadialImageBanner({ recordId }: { recordId: string }) {
  const { records } = useClipboardStore();
  const record = records.find((entry) => entry.id === recordId);
  if (!record) return <span className="radial-menu-item-text">…</span>;
  return <FileMediaVisual path={record.content} className="radial-menu-file-media" />;
}
