import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const { useClipboardStore } = await import("./clipboardStore");

const records = [
  {
    id: "clip-1",
    type: "text" as const,
    content: "first",
    source_app: "",
    created_at: "2026-07-30T00:00:00Z",
  },
  {
    id: "clip-2",
    type: "image" as const,
    content: "images/second.png",
    source_app: "",
    created_at: "2026-07-30T00:00:01Z",
  },
];

describe("clipboardStore deletion", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    useClipboardStore.setState({
      records,
      thumbnailCache: { "clip-2": "thumbnail" },
      imageCache: { "clip-2": "image" },
    });
  });

  it("deletes selected records in one backend call and clears their caches", async () => {
    await useClipboardStore.getState().deleteRecords(["clip-2"]);

    expect(invokeMock).toHaveBeenCalledWith("delete_clipboard_records", {
      ids: ["clip-2"],
    });
    expect(useClipboardStore.getState().records.map((record) => record.id)).toEqual(["clip-1"]);
    expect(useClipboardStore.getState().thumbnailCache).toEqual({});
    expect(useClipboardStore.getState().imageCache).toEqual({});
  });

  it("routes single deletion through the batch command", async () => {
    await useClipboardStore.getState().deleteRecord("clip-1");

    expect(invokeMock).toHaveBeenCalledWith("delete_clipboard_records", {
      ids: ["clip-1"],
    });
  });
});
