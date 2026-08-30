import { invoke } from "@tauri-apps/api/core";
import type { ClipboardRecord } from "../types";
import { useClipboardStore } from "../stores/clipboardStore";
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

  const [content, imagePaths] = await Promise.all([
    useClipboardStore.getState().getRecordContent(record),
    record.has_images
      ? invoke<string[]>("get_stash_record_images", { id: record.id })
      : Promise.resolve([]),
  ]);
  return buildRadialPreviewSegments(content, imagePaths);
}
