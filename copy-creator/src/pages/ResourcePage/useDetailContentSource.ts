// 详情页正文取材子系统：按记录形态分派加载——视频/音频走媒体 URL
// 解析（带 mediaVersion 防旧缓存）；文本资源优先整读全文（64 MB 上限
// 内整读、前端分块虚拟渲染），超上限或读取失败回退 1 MB 截断预览，
// 预览也失败才是真错误；其余形态走分段预览（图片/混合内容）。
// 自 ResourceDetailPage.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）。
// 记录、资源路径、媒体版本、外部文本路径与手动刷新键经 params 注入。

import { useEffect, useMemo, useState } from "react";
import {
  readResourceTextDetail,
  readResourceTextPreview,
  type ResourceTextPreview,
} from "../../domain/mediaAssets";
import { loadRecordPreviewSegments, type RadialPreviewSegment } from "../../domain/preview";
import { resolveResourceMediaUrl } from "../../domain/mediaUrl";
import type { ClipboardRecord } from "../../types";
import type { ResourceMediaKind } from "../../domain/mediaKind";

export function useDetailContentSource({
  kind,
  record,
  resourcePath,
  mediaVersion,
  externalTextPath,
  textReloadKey,
}: {
  kind: ResourceMediaKind;
  record: ClipboardRecord;
  resourcePath: string;
  mediaVersion: string | undefined;
  externalTextPath: string | null;
  textReloadKey: number;
}) {
  const [segments, setSegments] = useState<RadialPreviewSegment[] | null>(null);
  const [textContent, setTextContent] = useState<ResourceTextPreview | null>(null);
  const [errorReason, setErrorReason] = useState<string | null>(null);
  const [mediaSource, setMediaSource] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fail = (reason: unknown) => {
      if (!cancelled) setErrorReason(typeof reason === "string" ? reason : "");
    };
    setSegments(null);
    setTextContent(null);
    setErrorReason(null);
    setMediaSource(null);
    if (kind === "video" || kind === "audio" || kind === "file" || kind === "image") {
      if (kind === "video" || kind === "audio") {
        resolveResourceMediaUrl(resourcePath, mediaVersion)
          .then((url) => {
            if (!cancelled) setMediaSource(url);
          })
          .catch(fail);
      }
      return () => {
        cancelled = true;
      };
    }

    if (externalTextPath) {
      // 详情页优先全文（64 MB 上限内整读，前端分块虚拟渲染）；超上限
      // 或读取失败回退 1 MB 截断预览，预览也失败才是真错误（文件缺失、
      // 非文本、非 UTF-8），由 fail 透传原因。
      readResourceTextDetail(externalTextPath)
        .then((preview) => {
          if (!cancelled) setTextContent(preview);
        })
        .catch(() => {
          readResourceTextPreview(externalTextPath)
            .then((preview) => {
              if (!cancelled) setTextContent(preview);
            })
            .catch(fail);
        });
      return () => {
        cancelled = true;
      };
    }

    loadRecordPreviewSegments({
      id: record.id,
      recordType: record.type,
      content: record.content,
      contentTruncated: Boolean(record.content_truncated),
      hasImages: Boolean(record.has_images),
    })
      .then((next: RadialPreviewSegment[]) => {
        if (!cancelled) setSegments(next);
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [externalTextPath, kind, mediaVersion, record, resourcePath, textReloadKey]);

  // 编辑态全文：有文件承载用取材全文；无文件承载的纯文本资源把分段
  // 文本拼合（分段是唯一事实来源）。
  const fullTextContent = useMemo(() => {
    if (externalTextPath) return textContent?.content ?? null;
    if (!segments) return null;
    return segments
      .filter((segment): segment is Extract<RadialPreviewSegment, { type: "text" }> =>
        segment.type === "text")
      .map((segment) => segment.content)
      .join("\n");
  }, [externalTextPath, segments, textContent]);

  return {
    segments,
    textContent,
    errorReason,
    mediaSource,
    fullTextContent,
  };
}
