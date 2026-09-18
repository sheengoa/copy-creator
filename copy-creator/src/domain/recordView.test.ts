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
