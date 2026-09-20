import { describe, expect, it } from "vitest";
import { isResourceRecord, resourceTextPreviewPath } from "./records";

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

// resourceTextPreviewPath：资源文本预览取材的唯一判定（资源卡 / 径向条目
// 共用）。回归锚点：详情页编辑保存会把记录 type 从 file 转为 text（content
// 存全文、resource_path 不变），消费方若以 type === "file" 自行判定，编辑过
// 的 .txt 卡片就只剩 180 字摘要——预览必须认 backing 文件而非 type。
describe("resourceTextPreviewPath", () => {
  const fileRecord = (overrides: Partial<Record<string, unknown>>) =>
    ({
      type: "file",
      content: "C:/库/分镜提词/厂里传疯了.txt",
      resource_path: "C:/库/分镜提词/厂里传疯了.txt",
      storage_mode: "resource",
      ...overrides,
    }) as never as Parameters<typeof resourceTextPreviewPath>[0];

  it("returns the backing path for file-backed text resources", () => {
    expect(resourceTextPreviewPath(fileRecord({}))).toBe("C:/库/分镜提词/厂里传疯了.txt");
    expect(resourceTextPreviewPath(fileRecord({ resource_path: "" }))).toBe(
      "C:/库/分镜提词/厂里传疯了.txt",
    );
  });

  it("still resolves edited records whose type was demoted to text", () => {
    const edited = fileRecord({
      type: "text",
      content: "参考图片1中的女工形象……".repeat(20),
      resource_path: "C:/库/分镜提词/工厂都传疯了.txt",
    });
    expect(resourceTextPreviewPath(edited)).toBe("C:/库/分镜提词/工厂都传疯了.txt");
  });

  it("returns null for plain text resources without a backing file", () => {
    expect(
      resourceTextPreviewPath(fileRecord({ type: "text", content: "正文", resource_path: "" })),
    ).toBeNull();
    expect(
      resourceTextPreviewPath(fileRecord({ type: "text", content: "正文", resource_path: undefined })),
    ).toBeNull();
  });

  it("returns null for non-text media files", () => {
    expect(
      resourceTextPreviewPath(fileRecord({ content: "C:/库/01.png", resource_path: "C:/库/01.png" })),
    ).toBeNull();
    expect(
      resourceTextPreviewPath(
        fileRecord({ content: "C:/库/01.mp4", resource_path: "C:/库/01.mp4" }),
      ),
    ).toBeNull();
  });

  it("returns null for non-resource records", () => {
    expect(resourceTextPreviewPath(fileRecord({ storage_mode: "database" }))).toBeNull();
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
