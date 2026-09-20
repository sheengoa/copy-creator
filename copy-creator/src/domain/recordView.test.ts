import { describe, expect, it } from "vitest";
import { buildRecordView } from "./recordView";
import type { ClipboardRecord } from "../types";

const baseRecord: ClipboardRecord = {
  id: "r1",
  type: "text",
  content: "内容",
  source_app: "",
  created_at: "2026-09-18T00:00:00Z",
};

describe("buildRecordView pinned", () => {
  it("passes the backend pinned flag through as a fact field", () => {
    expect(buildRecordView({ ...baseRecord, pinned: true }).pinned).toBe(true);
  });

  it("defaults to false when the record carries no pinned flag", () => {
    expect(buildRecordView(baseRecord).pinned).toBe(false);
    expect(buildRecordView({ ...baseRecord, pinned: false }).pinned).toBe(false);
  });
});

describe("buildRecordView textPreviewPath", () => {
  const fileResource = {
    ...baseRecord,
    type: "file" as const,
    storage_mode: "resource" as const,
    content: "C:/库/分镜提词/厂里传疯了.txt",
    resource_path: "C:/库/分镜提词/厂里传疯了.txt",
  };

  it("exposes the backing text file path as a judgment field", () => {
    expect(buildRecordView(fileResource).textPreviewPath).toBe("C:/库/分镜提词/厂里传疯了.txt");
  });

  it("stays populated for records demoted to text by detail-page editing", () => {
    const edited = {
      ...fileResource,
      type: "text" as const,
      content: "编辑后的全文内容",
      resource_path: "C:/库/分镜提词/工厂都传疯了.txt",
    };
    expect(buildRecordView(edited).textPreviewPath).toBe("C:/库/分镜提词/工厂都传疯了.txt");
  });

  it("is null for plain text resources without a backing file", () => {
    expect(buildRecordView(baseRecord).textPreviewPath).toBeNull();
    expect(
      buildRecordView({ ...baseRecord, storage_mode: "resource" as const }).textPreviewPath,
    ).toBeNull();
  });
});
