// 径向条目的映射与资源组操作的纯函数集合：无 hooks、无组件状态，
// 依赖经参数注入（翻译函数 t、预览缓存 Map），便于独立复用与测试。
import { invoke } from "@tauri-apps/api/core";
import type { TFunction } from "i18next";
import { useClipboardStore } from "../../stores/clipboardStore";
import { usePhraseStore, isImageFilePath } from "../../stores/phraseStore";
import {
  getClipboardRadialDragKind,
  getPhraseRadialDragKind,
} from "../../utils/radialDrag";
import { formatRelativeTime } from "../../utils/formatTime";
import { fileNameFromPath } from "../../domain/fileName";
import { fileMediaKindFromPath, inferResourceMediaKind, TEXT_EXTENSIONS, getResourceExtension } from "../../domain/mediaKind";
import { readResourceTextPreview, readTextFileContent } from "../../domain/mediaAssets";
import {
  getResourcePath,
  getResourceSummary,
  isFileBackedTextResource,
  isResourceRecord,
  recordUsageTime,
} from "../../domain/records";
import {
  isContentPreviewAvailable,
  loadRecordPreviewSegments,
  type RadialPreviewSegment,
} from "../../domain/preview";
import { buildRecordView } from "../../domain/recordView";
import type { ClipboardRecord, Phrase } from "../../types";
import type { RadialItem } from "./types";
import { flog } from "./types";

// 三类来源统一映射为 RadialItem，「最近使用」复用同一套渲染、预览与拖出机制。
export function recordToRadialItem(r: ClipboardRecord, t: TFunction): RadialItem {
  if (isResourceRecord(r)) {
    const item = buildRecordView(r);
    const resourceKind = item.kind;
    const resourcePath = item.resourcePath ?? r.content;
    const resourceTitle = item.title;
    const resourceSummary = r.type === "file"
      ? undefined
      : getResourceSummary(r);
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
      dragPath: r.drag_path || (r.type === "file" ? resourcePath : undefined),
      isResource: true,
      resourceKind,
      resourcePath,
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
  };
}

export function phraseToRadialItem(p: Phrase): RadialItem {
  return {
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
  };
}

// 「全部」视图：跨分组聚合，条目带来源分组标签与相对使用时间，
// 未使用过的短语以分隔线垫底（后端已按此顺序返回，这里只做展示映射）。
export const allViewUsedAtLabel = (p: Phrase, t: TFunction): string =>
  p.last_used_at ? formatRelativeTime(p.last_used_at) : t("phrases.neverUsed");

export const phraseSourceLabel = (p: Phrase, t: TFunction): string =>
  p.group_name ? `${t("tabs.phrases")} · ${p.group_name}` : t("tabs.phrases");

export function buildAllPhraseItems(list: Phrase[], t: TFunction): RadialItem[] {
  const toItem = (p: Phrase): RadialItem => ({
    ...phraseToRadialItem(p),
    usedAtLabel: allViewUsedAtLabel(p, t),
    sourceLabel: phraseSourceLabel(p, t),
  });
  // 未使用过的短语按「分组顺序 + 组内手动顺序」垫底（不加分隔线，
  // 与剪切板 / 资源「全部」视图形态统一）。
  const used = list.filter((p) => (p.last_used_at ?? "") !== "");
  const unused = list.filter((p) => (p.last_used_at ?? "") === "");
  return [...used.map(toItem), ...unused.map(toItem)];
}

// 「全部」视图条目形态全区一致：相对使用时间 + 来源标签
// （快捷输入 · 分组 / 资源 · 分组；剪切板无分组概念不显示标签）。
export const usageTimeLabel = (r: ClipboardRecord): string =>
  formatRelativeTime(recordUsageTime(r.last_used_at, r.created_at));

// 加载条目预览 segments：缓存命中直接返回；资源/剪切板/短语三类来源
// 分别装配（domain 判定为主，文件文本回退为路径展示）。
export async function loadRadialPreviewSegments(
  item: RadialItem,
  cache: Map<string, RadialPreviewSegment[]>,
): Promise<RadialPreviewSegment[]> {
  const cached = cache.get(item.id);
  if (cached) return cached;

  const record = useClipboardStore.getState().records.find((entry) => entry.id === item.id);
  let segments: RadialPreviewSegment[];
  if (record) {
    if (isResourceRecord(record)) {
      const kind = inferResourceMediaKind(record);
      const resourcePath = getResourcePath(record);
      if (kind === "image") {
        segments = [{ type: "image", path: resourcePath }];
      } else if (kind === "video" || kind === "audio") {
        segments = [{ type: kind, path: resourcePath }];
      } else if (
        record.type === "file"
        && TEXT_EXTENSIONS.has(getResourceExtension(resourcePath))
      ) {
        // 文本文件按扩展名判定读取实际内容，不依赖 resource_kind；
        // 读取失败时回退为路径展示。
        try {
          const text = await readResourceTextPreview(resourcePath);
          segments = [{ type: "text", content: text }];
        } catch {
          segments = [{ type: "text", content: resourcePath }];
        }
      } else {
        const content = kind === "text"
          ? await useClipboardStore.getState().getRecordContent(record)
          : item.resourceTitle || item.content;
        segments = [{ type: "text", content }];
      }
    } else {
      segments = await loadRecordPreviewSegments({
        id: record.id,
        recordType: record.type,
        content: record.content,
        contentTruncated: Boolean(record.content_truncated),
        hasImages: Boolean(record.has_images),
      });
    }
  } else {
    const phrase = usePhraseStore.getState().phrases.find((entry) => entry.id === item.id);
    if (phrase && phrase.input_type === "file" && isImageFilePath(phrase.content)) {
      segments = [{ type: "image", path: phrase.content }];
    } else if (phrase && phrase.input_type === "file") {
      // 文件短语：常见文本格式读取内容预览，与主窗口一致。
      try {
        const text = await invoke<string>("read_quick_input_text_preview", {
          path: phrase.content,
        });
        segments = [{ type: "text", content: text }];
      } catch {
        segments = [{ type: "text", content: phrase.content }];
      }
    } else {
      segments = [{ type: "text", content: phrase?.content ?? item.content }];
    }
  }
  cache.set(item.id, segments);
  return segments;
}

// 整组粘贴（方案 A）：分组内全部为文本时合并为一段文本粘贴，
// 否则把分组内全部文件按文件列表一次写入剪切板再模拟 Ctrl+V。
// groupPath 为 null 时作用于 fallbackGroup（当前选中的分组）。
export async function pasteResourceGroup(
  groupPath: string | null,
  fallbackGroup: string | null,
  resetState: () => void,
): Promise<void> {
  const store = useClipboardStore.getState();
  const allRecords = await store.loadAllRecords(
    "resources",
    groupPath ?? fallbackGroup,
    { silent: true },
  );
  const records = (allRecords ?? []).filter((record) => isResourceRecord(record));
  flog(`paste-group path=${groupPath ?? fallbackGroup} records=${records.length}`);
  if (records.length > 0) {
    const allText = records.every((record) => inferResourceMediaKind(record) === "text");
    try {
      // 文件承载的文本资源（如自动发现的 .txt）的 content 是文件路径，
      // 合并前需读取文件真实内容；任一读取失败则整组回退为文件列表粘贴。
      const parts: string[] = [];
      let allTextContentReady = allText;
      if (allText) {
        for (const record of records) {
          if (isFileBackedTextResource(record)) {
            try {
              parts.push(
                await readTextFileContent(getResourcePath(record)),
              );
            } catch (error) {
              console.error("Failed to read text resource for group paste:", error);
              allTextContentReady = false;
              break;
            }
          } else {
            parts.push(await store.getRecordContent(record));
          }
        }
      }
      if (allTextContentReady) {
        await invoke("paste_text", { text: parts.join("\n") });
      } else {
        const paths = records
          .map((record) => record.resource_path)
          .filter((path): path is string => Boolean(path));
        if (paths.length === 0) throw new Error("分组内没有可粘贴的文件");
        await invoke("paste_files", { paths });
      }
      // 整组粘贴成功后全组计入「最近使用」，与单条粘贴的记录口径一致。
      void invoke("touch_clipboard_usage", {
        ids: records.map((record) => record.id),
      }).catch((error) => {
        console.error("Failed to record group usage:", error);
      });
    } catch (error) {
      console.error("Failed to paste resource group:", error);
    }
  }
  resetState();
  void invoke("hide_radial_menu");
}
