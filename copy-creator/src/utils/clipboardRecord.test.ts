import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESOURCE_GROUP_NAME,
  TEMP_STASH_GROUP_NAME,
  getResourceGroupName,
  isResourceRecord,
  isTempRecord,
} from "./clipboardRecord";

describe("isResourceRecord", () => {
  it("recognizes records stored in the resource library", () => {
    expect(isResourceRecord({ group_name: "项目资料", storage_mode: "resource" })).toBe(true);
    expect(isResourceRecord({ group_name: "", storage_mode: "resource" })).toBe(true);
  });

  it("never treats database records as resources, even with a group name", () => {
    expect(isResourceRecord({ group_name: "旧资源", storage_mode: "database" })).toBe(false);
    expect(isResourceRecord({ group_name: "", storage_mode: "database" })).toBe(false);
    expect(isResourceRecord({ group_name: "  ", storage_mode: undefined })).toBe(false);
  });

  it("recognizes manually stashed records by the temp marker only", () => {
    expect(isTempRecord({ group_name: TEMP_STASH_GROUP_NAME, storage_mode: "database" })).toBe(true);
    expect(isTempRecord({ group_name: "stash", storage_mode: "database" })).toBe(false);
    expect(isTempRecord({ group_name: "", storage_mode: "database" })).toBe(false);
    expect(isTempRecord({ group_name: TEMP_STASH_GROUP_NAME, storage_mode: "resource" })).toBe(false);
  });

  it("falls back to the default resource group name for records without a group", () => {
    expect(getResourceGroupName({ group_name: "" })).toBe(DEFAULT_RESOURCE_GROUP_NAME);
    expect(getResourceGroupName({ group_name: "  " })).toBe(DEFAULT_RESOURCE_GROUP_NAME);
    expect(getResourceGroupName({ group_name: "项目资料" })).toBe("项目资料");
  });
});
