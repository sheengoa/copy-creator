import { readClipboardTextPreviewById, readQuickInputTextPreview, readResourceTextPreview } from "../domain/mediaAssets";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HighlightText } from "./HighlightText";
import { Icons } from "./Icons";
import { resolveResourceAssetUrl } from "../domain/mediaUrl";

interface InlineImagePreviewProps {
  path: string;
  alt: string;
  className?: string;
  /** 提供时图片可点击，回调携带原始路径供调用方打开独立预览窗口。 */
  onZoom?: (path: string) => void;
}

export function InlineImagePreview({
  path,
  alt,
  className = "",
  onZoom,
}: InlineImagePreviewProps) {
  const { t } = useTranslation();
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc("");
    setFailed(false);
    resolveResourceAssetUrl(path)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (failed) {
    return (
      <div className={`inline-preview-fallback ${className}`} role="img" aria-label={t("resources.mediaUnavailable")}>
        {Icons.image}
        <span>{t("resources.mediaUnavailable")}</span>
      </div>
    );
  }
  if (!src) return <div className={`inline-preview-loading ${className}`} aria-hidden="true" />;
  return (
    <img
      className={`${className}${onZoom ? " is-zoomable" : ""}`.trim()}
      src={src}
      alt={alt}
      draggable={false}
      onClick={onZoom
        ? (event) => {
            // 阻止冒泡，避免触发列表卡片自身的点击行为。
            event.stopPropagation();
            onZoom(path);
          }
        : undefined}
      onError={() => setFailed(true)}
    />
  );
}

interface InlineTextFilePreviewProps {
  path?: string;
  recordId?: string;
  resourcePath?: string;
  resourceVersion?: string;
  search?: string;
}

const resourceTextPreviewCache = new Map<string, string>();
const resourceTextPreviewRequests = new Map<string, Promise<string>>();

function loadResourceTextPreview(path: string, version?: string): Promise<string> {
  const cacheKey = `${path}\u0000${version ?? ""}`;
  const cached = resourceTextPreviewCache.get(cacheKey);
  if (cached !== undefined) return Promise.resolve(cached);

  const pending = resourceTextPreviewRequests.get(cacheKey);
  if (pending) return pending;

  const request = readResourceTextPreview(path)
    .then((text) => {
      resourceTextPreviewCache.set(cacheKey, text);
      return text;
    })
    .finally(() => {
      resourceTextPreviewRequests.delete(cacheKey);
    });
  resourceTextPreviewRequests.set(cacheKey, request);
  return request;
}

export function InlineTextFilePreview({
  path,
  recordId,
  resourcePath,
  resourceVersion,
  search,
}: InlineTextFilePreviewProps) {
  const { t } = useTranslation();
  const [content, setContent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setFailed(false);
    const request = resourcePath
      ? loadResourceTextPreview(resourcePath, resourceVersion)
      : recordId
        ? readClipboardTextPreviewById(recordId)
        : readQuickInputTextPreview(path ?? "");
    request
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, recordId, resourcePath, resourceVersion]);

  if (failed) {
    return (
      <div className="inline-preview-error" role="alert">
        {t("resources.previewError")}
      </div>
    );
  }
  if (content === null) {
    return <div className="inline-preview-loading" aria-label={t("common.loading")} />;
  }
  return (
    <pre className="inline-text-file-preview">
      <HighlightText text={content} search={search} />
    </pre>
  );
}
