import type { ClipboardRecord } from "../types";

export const DEFAULT_RESOURCE_GROUP_NAME = "默认";
export const TEMP_STASH_GROUP_NAME = "临时";

export function isResourceRecord(
  record: Pick<ClipboardRecord, "group_name" | "storage_mode">,
): boolean {
  return record.storage_mode === "resource";
}

export function isTempRecord(
  record: Pick<ClipboardRecord, "group_name" | "storage_mode">,
): boolean {
  return record.storage_mode !== "resource" && record.group_name === TEMP_STASH_GROUP_NAME;
}

export function getResourceGroupName(
  record: Pick<ClipboardRecord, "group_name">,
): string {
  return record.group_name?.trim() || DEFAULT_RESOURCE_GROUP_NAME;
}
