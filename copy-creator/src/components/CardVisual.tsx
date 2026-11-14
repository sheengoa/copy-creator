import { Icons } from "./Icons";
import { HighlightText } from "./HighlightText";
import { InlineTextFilePreview } from "./InlinePreview";
import { ResourceFileImage } from "../pages/ResourcePage/ResourceMedia";
import { VideoPoster } from "./VideoPoster";
import { type ResourceMediaKind } from "../domain/mediaKind";

// 卡片预览区分支（视频封面/音频占位/图片缩略/文本摘要），从资源卡抽出
// 供三页共用（资源库 / 剪切板 / 快捷输入）。纯 view 驱动、无业务副作用。

/** 窄结构接口：RecordView 天然满足；快捷输入卡片用短语字段构造等价对象。 */
export interface CardVisualData {
  kind: ResourceMediaKind;
  /** 原始类型（link 折叠进 text，样式区分靠它）。 */
  recordType: "text" | "image" | "link" | "file";
  title: string;
  summary: string;
  /** 原始载荷：路径型记录的本地路径（resourcePath 缺省时兜底）。 */
  content: string;
  /** 文本预览取材路径（守卫规则 19：文本预览必须消费该判定字段）。 */
  textPreviewPath: string | null;
  /** 文本文件预览数据源变体：resource=资源文本命令（默认），quickInput=
   *  快捷输入受管副本命令（短语文件不在资源库记录体系里）。 */
  textPreviewVariant?: "resource" | "quickInput";
  resourcePath: string | null;
  /** 资源文件版本（修改毫秒）：媒体 URL/缓存键随覆盖保存失效。 */
  mediaVersion: string | null;
  /** 版本缺省时的缓存键兜底（记录/短语的落库时间）。 */
  createdAt: string;
}

interface CardVisualProps {
  view: CardVisualData;
  /** 搜索命中高亮词（可选：非搜索视图传 undefined 即无高亮）。 */
  search?: string;
  typeLabel: (kind: ResourceMediaKind) => string;
}

export function CardVisual({ view, search, typeLabel }: CardVisualProps) {
  const kind = view.kind;
  const summary = view.summary;
  const resourcePath = view.resourcePath ?? view.content;

  if (kind === "video") {
    return (
      <div className={`resource-card-visual resource-card-${kind}`}>
        <VideoPoster
          path={resourcePath}
          version={view.mediaVersion ?? undefined}
          fallbackLabel={typeLabel(kind)}
          iconClassName="resource-card-visual-icon"
        />
        <span className="resource-card-play">{Icons.play}</span>
      </div>
    );
  }

  if (kind === "audio") {
    return (
      <div className={`resource-card-visual resource-card-${kind}`}>
        <span className="resource-card-visual-icon">{Icons.audio}</span>
        <span>{typeLabel(kind)}</span>
      </div>
    );
  }

  if (kind === "image") {
    return (
      <ResourceFileImage
        path={resourcePath}
        alt={view.title}
        className="resource-card-file-image"
        version={view.mediaVersion ?? undefined}
      />
    );
  }

  if (kind === "file") {
    return (
      <div className={`resource-card-visual resource-card-${kind}`}>
        {Icons.file}
        <span>{typeLabel(kind)}</span>
      </div>
    );
  }

  if (view.textPreviewPath) {
    return (
      <div className="resource-card-text-preview">
        <InlineTextFilePreview
          {...(view.textPreviewVariant === "quickInput"
            ? { path: view.textPreviewPath }
            : {
                resourcePath: view.textPreviewPath,
                resourceVersion: view.mediaVersion ?? view.createdAt,
              })}
          search={search}
        />
      </div>
    );
  }

  return (
    <div className={`resource-card-text-preview${view.recordType === "link" ? " is-link" : ""}`}>
      <HighlightText text={summary || " "} search={search} />
    </div>
  );
}
