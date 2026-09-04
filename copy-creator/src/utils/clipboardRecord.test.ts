import { describe, expect, it } from "vitest";
import { isResourceRecord } from "./clipboardRecord";

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
});
