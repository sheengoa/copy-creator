// 径向菜单条目映射：三类来源（剪藏记录 / 资源记录 / 快捷输入短语）统一
// 映射为 RadialItem，「最近使用」复用同一套渲染、预览与拖出机制。纯函数
// 模块（2026-11-14 自 index.tsx 拆出，架构守卫规则 27 行数上限）——无
// hook、无副作用；index 以 useMemo 包裹保持原缓存行为。

import type { TFunction } from "i18next";
import { isContentPreviewAvailable } from "../../domain/preview";
import { buildRecordView } from "../../domain/recordView";
import { isResourceRecord, recordMatchesCategory, recordUsageTime, resourceGroupLeafLabel, resourceMediaVersion } from "../../domain/records";
import { getClipboardRadialDragKind, getPhraseRadialDragKind } from "../../utils/radialDrag";
import { fileMediaKindFromPath } from "../../domain/mediaKind";
import { fileNameFromPath } from "../../domain/fileName";
import { formatRelativeTime } from "../../utils/formatTime";
import { isImageFilePath, ALL_PHRASES_GROUP_ID } from "../../stores/phraseStore";
import { MAX_ITEMS, PHRASES_ALL_LIMIT, type RadialItem } from "./radialShared";
import type { RecordLocaleText } from "../../domain/records";
import type { ClipboardRecord, Phrase } from "../../types";
import type { ClipType } from "../../stores/clipboardStore";

/** 剪藏/资源列表按类型筛选（收藏语义在 recordMatchesCategory 内）。 */
export function filterRecordsByCategory(
  records: ClipboardRecord[],
  clipboardCategory: ClipType,
): ClipboardRecord[] {
  return records.filter((r) => recordMatchesCategory(r, clipboardCategory));
}

/** 三类来源统一映射为条目列表（activeTab 决定来源与展示形态）。 */
export function buildRadialItems({
  activeTab,
  records,
  filteredRecords,
  resourceGroup,
  phrases,
  phraseGroupId,
  recordLocale,
  t,
}: {
  activeTab: string;
  records: ClipboardRecord[];
  /** 剪藏 tab 的类型筛选结果（filterRecordsByCategory 的产物）。 */
  filteredRecords: ClipboardRecord[];
  resourceGroup: string | null;
  phrases: Phrase[];
  phraseGroupId: string | null;
  recordLocale: RecordLocaleText;
  t: TFunction;
}): RadialItem[] {
  const recordToRadialItem = (r: ClipboardRecord): RadialItem => {
    if (isResourceRecord(r)) {
      const item = buildRecordView(r, { locale: recordLocale });
      const resourceKind = item.kind;
      const resourcePath = item.resourcePath ?? r.content;
      const resourceTitle = item.title;
      // 有文件承载的文本资源预览读文件全文（含编辑后 type 转为 text 的记录），
      // 摘要只用于无文件承载的纯文本资源。
      const resourceSummary = item.textPreviewPath ? undefined : item.summary;
      return {
        id: r.id,
        content: resourceTitle,
        type: r.type,
        createdAt: r.created_at,
        contentTruncated: r.content_truncated,
        previewAvailable: resourceKind === "image"
          || resourceKind === "text"
          || resourceKind === "video"
          || resourceKind === "audio",
        dragKind: getClipboardRadialDragKind(r.type, r.has_images),
        dragSource: "clipboard",
        // 文件承载的文本资源（含编辑后 type 为 text 的记录）拖出其 backing 文件。
        dragPath: r.drag_path || item.textPreviewPath || (r.type === "file" ? resourcePath : undefined),
        isResource: true,
        resourceKind,
        resourcePath,
        textPreviewPath: item.textPreviewPath ?? undefined,
        resourceVersion: resourceMediaVersion(r),
        resourceTitle,
        resourceSummary,
        useCount: r.use_count,
      };
    }
    return {
      id: r.id,
      content: r.type === "image"
        ? `[${t("clipboard.image")}]`
        : r.type === "file"
          ? fileNameFromPath(r.content)
          : r.is_api_key
            ? r.key_preview || r.content
            : r.content,
      type: r.type,
      filePath: r.type === "file" ? r.content : undefined,
      fileMediaKind: r.type === "file" ? fileMediaKindFromPath(r.content) : undefined,
      createdAt: r.created_at,
      contentTruncated: r.content_truncated,
      previewAvailable: isContentPreviewAvailable({
        type: r.type,
        contentTruncated: r.content_truncated,
        hasImages: r.has_images,
      }, r.content.length > 300),
      dragKind: getClipboardRadialDragKind(r.type, r.has_images),
      dragSource: "clipboard",
      dragPath: r.drag_path,
      useCount: r.use_count,
      pinned: Boolean(r.pinned),
    };
  };

  const phraseToRadialItem = (p: Phrase): RadialItem => ({
    id: p.id,
    content: p.input_type === "file"
      ? fileNameFromPath(p.source_path || p.content)
      : p.content,
    type: p.input_type === "file" ? "file" : "phrase",
    imagePath:
      p.input_type === "file" && isImageFilePath(p.content) ? p.content : undefined,
    title: p.title,
    previewAvailable: isContentPreviewAvailable({
      type: p.input_type,
    }, p.content.length > 300),
    dragKind: getPhraseRadialDragKind(p.input_type),
    dragSource: "phrase",
    dragPath: p.input_type === "file" ? p.content : undefined,
    useCount: p.use_count,
  });

  // 「全部」视图：跨分组聚合，条目带来源分组标签与相对使用时间，
  // 未使用过的短语以分隔线垫底（后端已按此顺序返回，这里只做展示映射）。
  const allViewUsedAtLabel = (p: Phrase): string =>
    p.last_used_at ? formatRelativeTime(p.last_used_at) : t("phrases.neverUsed");
  const phraseSourceLabel = (p: Phrase): string =>
    p.group_name ? `${t("tabs.phrases")} · ${p.group_name}` : t("tabs.phrases");

  const buildAllPhraseItems = (list: Phrase[]): RadialItem[] => {
    const toItem = (p: Phrase): RadialItem => ({
      ...phraseToRadialItem(p),
      usedAtLabel: allViewUsedAtLabel(p),
      sourceLabel: phraseSourceLabel(p),
    });
    // 未使用过的短语按「分组顺序 + 组内手动顺序」垫底（不加分隔线，
    // 与剪切板 / 资源「全部」视图形态统一）。
    const used = list.filter((p) => (p.last_used_at ?? "") !== "");
    const unused = list.filter((p) => (p.last_used_at ?? "") === "");
    return [...used.map(toItem), ...unused.map(toItem)];
  };

  // 「全部」视图条目形态全区一致：相对使用时间 + 来源标签
  // （快捷输入 · 分组 / 资源 · 分组；剪切板无分组概念不显示标签）。
  const usageTimeLabel = (r: ClipboardRecord): string =>
    formatRelativeTime(recordUsageTime(r.last_used_at, r.created_at));

  return activeTab === "clipboard"
    ? filteredRecords.slice(0, MAX_ITEMS).map((r) => ({
        ...recordToRadialItem(r),
        usedAtLabel: usageTimeLabel(r),
      }))
    : activeTab === "resources"
      ? records
          .filter((r) => isResourceRecord(r))
          .slice(0, MAX_ITEMS)
          .map((r) => {
            const item = recordToRadialItem(r);
            if (resourceGroup !== null) {
              // 分组浏览保持原样：不带使用时间标签、来源标签与次数徽标。
              return { ...item, useCount: undefined };
            }
            const leaf = resourceGroupLeafLabel(r.resource_group);
            return {
              ...item,
              usedAtLabel: usageTimeLabel(r),
              sourceLabel: leaf
                ? `${t("tabs.resources")} · ${leaf}`
                : t("tabs.resources"),
            };
          })
      : activeTab === "phrases"
        ? phraseGroupId === ALL_PHRASES_GROUP_ID
          ? buildAllPhraseItems(phrases).slice(0, PHRASES_ALL_LIMIT)
          : phrases.map(phraseToRadialItem)
        : [];
}
