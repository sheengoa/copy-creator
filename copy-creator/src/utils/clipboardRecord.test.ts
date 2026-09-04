import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESOURCE_GROUP_NAME,
  getResourceGroupName,
  isResourceRecord,
} from "./clipboardRecord";

describe("isResourceRecord", () => {
  it("recognizes records stored in the resource library without a group name", () => {
    expect(isResourceRecord({ group_name: "", storage_mode: "resource" })).toBe(true);
  });

  it("recognizes legacy grouped records stored in the database", () => {
    expect(isResourceRecord({ group_name: "旧资源", storage_mode: "database" })).toBe(true);
  });

  it("ignores empty or whitespace-only database records", () => {
    expect(isResourceRecord({ group_name: "", storage_mode: "database" })).toBe(false);
    expect(isResourceRecord({ group_name: "  ", storage_mode: undefined })).toBe(false);
  });

  it("uses the default resource group for legacy records without a group", () => {
    expect(getResourceGroupName({ group_name: "" })).toBe(DEFAULT_RESOURCE_GROUP_NAME);
    expect(getResourceGroupName({ group_name: "  " })).toBe(DEFAULT_RESOURCE_GROUP_NAME);
    expect(getResourceGroupName({ group_name: "项目资料" })).toBe("项目资料");
  });
});
