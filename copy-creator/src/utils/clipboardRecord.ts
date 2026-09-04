import type { ClipboardRecord } from "../types";

export function isResourceRecord(
  record: Pick<ClipboardRecord, "group_name" | "storage_mode">,
): boolean {
  return record.storage_mode === "resource";
}
