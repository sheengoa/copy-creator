import { invoke } from "@tauri-apps/api/core";
import type { ClipboardRecord } from "../types";
import { useClipboardStore } from "../stores/clipboardStore";
import {
  TEXT_EXTENSIONS,
  fileMediaKindFromPath,
  getResourceExtension,
} from "../pages/ResourcePage/resourceUtils";
import {
  buildRadialPreviewSegments,
  type RadialPreviewSegment,
} from "./radialPreview";

export async function loadClipboardPreviewSegments(
  record: ClipboardRecord,
): Promise<RadialPreviewSegment[]> {
  if (record.type === "image") {
    return [{ type: "image", path: record.content }];
  }

  // 文件记录：图片/视频/音频按媒体预览（径向菜单预览面板、资源详情页共用
  // 此判定，与主窗口展开预览的媒体视觉同一份扩展名规则）；常见文本格式读取
  // 内容预览；其余格式回退为路径展示。
  if (record.type === "file") {
    const mediaKind = fileMediaKindFromPath(record.content);
    if (mediaKind) {
      return [{ type: mediaKind, path: record.content }];
    }
    if (TEXT_EXTENSIONS.has(getResourceExtension(record.content))) {
      try {
        const text = await invoke<string>("read_clipboard_text_preview", {
          id: record.id,
        });
        return [{ type: "text", content: text }];
      } catch {
        // 读取失败（文件已移动/删除等）时回退为路径展示。
      }
    }
    return [{ type: "text", content: record.content }];
  }

  const [content, imagePaths] = await Promise.all([
    useClipboardStore.getState().getRecordContent(record),
    record.has_images
      ? invoke<string[]>("get_stash_record_images", { id: record.id })
      : Promise.resolve([]),
  ]);
  return buildRadialPreviewSegments(content, imagePaths);
}
