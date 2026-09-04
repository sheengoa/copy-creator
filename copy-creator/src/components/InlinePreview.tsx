import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { HighlightText } from "./HighlightText";
import { Icons } from "./Icons";
import { resolveResourceAssetUrl } from "../pages/ResourcePage/resourceUtils";

interface InlineImagePreviewProps {
  path: string;
  alt: string;
  className?: string;
}

export function InlineImagePreview({
  path,
  alt,
  className = "",
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
      className={className}
      src={src}
      alt={alt}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

type InlineTextFilePreviewProps = (
  | { path: string; recordId?: never }
  | { path?: never; recordId: string }
) & {
  search?: string;
};

export function InlineTextFilePreview({
  path,
  recordId,
  search,
}: InlineTextFilePreviewProps) {
  const { t } = useTranslation();
  const [content, setContent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setFailed(false);
    const command = recordId
      ? "read_clipboard_text_preview"
      : "read_quick_input_text_preview";
    const args = recordId ? { id: recordId } : { path };
    invoke<string>(command, args)
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, recordId]);

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
