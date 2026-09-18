import { describe, expect, it } from "vitest";
import { isResourceRecord } from "./records";

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

// recordMatchesCategory：类别过滤的唯一实现（主窗口 / 径向菜单 / store
// 共用）。回归锚点：收藏上线时各窗口的内联副本漏改，径向菜单成为盲区。
import {
  matchesResourceGroup,
  recordMatchesCategory,
  RECORD_CATEGORY_KEYS,
} from "./records";

describe("recordMatchesCategory", () => {
  const record = (overrides: Partial<Record<string, unknown>>) =>
    ({
      id: "r1",
      type: "text",
      content: "hello",
      storage_mode: "database",
      pinned: false,
      ...overrides,
    }) as never as Parameters<typeof recordMatchesCategory>[0];

  it("matches non-resource records for type categories", () => {
    expect(recordMatchesCategory(record({}), "text")).toBe(true);
    expect(recordMatchesCategory(record({ type: "link" }), "text")).toBe(false);
  });

  it("favorites matches pinned non-resource records only", () => {
    expect(recordMatchesCategory(record({ pinned: true }), "favorites")).toBe(true);
    expect(recordMatchesCategory(record({ pinned: false }), "favorites")).toBe(false);
    expect(recordMatchesCategory(record({ pinned: true, storage_mode: "resource" }), "favorites")).toBe(false);
  });

  it("all excludes resources; resources matches by group", () => {
    expect(recordMatchesCategory(record({}), "all")).toBe(true);
    expect(recordMatchesCategory(record({ storage_mode: "resource" }), "all")).toBe(false);
    expect(
      recordMatchesCategory(record({ storage_mode: "resource", resource_folder: "组/子组" }), "resources", "组"),
    ).toBe(true);
    expect(
      recordMatchesCategory(record({ storage_mode: "resource", resource_folder: "其他" }), "resources", "组"),
    ).toBe(false);
    expect(
      recordMatchesCategory(record({ storage_mode: "resource" }), "resources", null),
    ).toBe(true);
  });

  it("exposes the canonical category key order shared by all surfaces", () => {
    expect([...RECORD_CATEGORY_KEYS]).toEqual(["all", "favorites", "text", "image", "link", "file"]);
  });
});

describe("matchesResourceGroup", () => {
  const record = (folder?: string) =>
    ({ resource_folder: folder, resource_group: folder }) as never as Parameters<typeof matchesResourceGroup>[0];

  it("null group matches everything; empty group matches ungrouped only", () => {
    expect(matchesResourceGroup(record("组"), null)).toBe(true);
    expect(matchesResourceGroup(record(""), "")).toBe(true);
    expect(matchesResourceGroup(record("组"), "")).toBe(false);
  });

  it("matches nested folders under the group", () => {
    expect(matchesResourceGroup(record("组/子组"), "组")).toBe(true);
    expect(matchesResourceGroup(record("组员"), "组")).toBe(false);
  });
});
