import type { ClipboardRecord } from "../types";

export const DEFAULT_RESOURCE_GROUP_NAME = "暂存";

export function isResourceRecord(
  record: Pick<ClipboardRecord, "group_name" | "storage_mode">,
): boolean {
  return record.storage_mode === "resource" || Boolean(record.group_name?.trim());
}

export function getResourceGroupName(
  record: Pick<ClipboardRecord, "group_name">,
): string {
  return record.group_name?.trim() || DEFAULT_RESOURCE_GROUP_NAME;
}
