import type { ClipboardRecord } from "../types";

export const DEFAULT_RESOURCE_GROUP_NAME = "默认";

export function isResourceRecord(
  record: Pick<ClipboardRecord, "group_name" | "storage_mode">,
): boolean {
  return record.storage_mode === "resource";
}

export function getResourceGroupName(
  record: Pick<ClipboardRecord, "group_name">,
): string {
  return record.group_name?.trim() || DEFAULT_RESOURCE_GROUP_NAME;
}
