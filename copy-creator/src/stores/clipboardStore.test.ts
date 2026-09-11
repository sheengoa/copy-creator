import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const { matchesResourceGroup, useClipboardStore } = await import("./clipboardStore");

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("clipboardStore resource group matching", () => {
  it("matches a selected folder and all of its descendants", () => {
    const record = {
      resource_folder: "References/archive/deep",
      resource_group: "References",
    };

    expect(matchesResourceGroup(record, "References")).toBe(true);
    expect(matchesResourceGroup(record, "References/archive")).toBe(true);
    expect(matchesResourceGroup(record, "References/other")).toBe(false);
    expect(matchesResourceGroup(record, "References/archive/deeper")).toBe(false);
  });

  it("keeps all and ungrouped selections mutually distinct", () => {
    expect(matchesResourceGroup({ resource_folder: "" }, null)).toBe(true);
    expect(matchesResourceGroup({ resource_folder: "" }, "")).toBe(true);
    expect(matchesResourceGroup({ resource_folder: "References" }, "")).toBe(false);
    expect(matchesResourceGroup({ resource_group: "References" }, "References")).toBe(true);
  });
});

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

  it("does not let an older load restore a deleted record", async () => {
    const olderLoad = deferred<typeof records>();
    invokeMock
      .mockImplementationOnce(() => olderLoad.promise)
      .mockResolvedValueOnce(undefined);
    useClipboardStore.setState({ loading: false });

    const load = useClipboardStore.getState().loadRecords(false, "all");
    await useClipboardStore.getState().deleteRecords(["clip-2"]);
    olderLoad.resolve(records);
    await load;

    expect(useClipboardStore.getState().records.map((record) => record.id)).toEqual(["clip-1"]);
    expect(useClipboardStore.getState().loading).toBe(false);
  });
});

describe("clipboardStore stash image paste routing", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  const stashRecord = {
    id: "stash-1",
    type: "text" as const,
    content: "说明\n[Image #1]",
    source_app: "",
    created_at: "2026-08-04T00:00:00Z",
    group_name: "暂存",
    has_images: true,
  };

  it("routes normal paste through the ordered stash command", async () => {
    await useClipboardStore.getState().pasteRecord(stashRecord);

    expect(invokeMock).toHaveBeenCalledWith("paste_stash_record", {
      id: "stash-1",
      terminal: false,
    });
  });

  it("keeps terminal mode for text segments in an ordered stash", async () => {
    await useClipboardStore.getState().pasteRecordTerminal(stashRecord);

    expect(invokeMock).toHaveBeenCalledWith("paste_stash_record", {
      id: "stash-1",
      terminal: true,
    });
  });

  it("records usage time after a successful paste", async () => {
    await useClipboardStore.getState().pasteRecord(stashRecord);

    expect(invokeMock).toHaveBeenCalledWith("touch_clipboard_usage", {
      ids: ["stash-1"],
    });
  });

  it("records usage time for plain text pastes", async () => {
    await useClipboardStore.getState().pasteRecord({
      id: "clip-1",
      type: "text",
      content: "first",
      source_app: "",
      created_at: "2026-07-30T00:00:00Z",
    });

    expect(invokeMock).toHaveBeenCalledWith("touch_clipboard_usage", {
      ids: ["clip-1"],
    });
  });

  it("does not record usage when the paste command fails", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "paste_text") return Promise.reject(new Error("boom"));
      return Promise.resolve(undefined);
    });

    await useClipboardStore.getState().pasteRecord({
      id: "clip-1",
      type: "text",
      content: "first",
      source_app: "",
      created_at: "2026-07-30T00:00:00Z",
    });

    expect(invokeMock).not.toHaveBeenCalledWith("touch_clipboard_usage", {
      ids: ["clip-1"],
    });
  });

  it("pastes file-backed text resources by content instead of file", async () => {
    const textFileRecord = {
      id: "res-1",
      type: "file" as const,
      content: "/lib/copy-creator-notes.txt",
      source_app: "",
      created_at: "2026-09-01T00:00:00Z",
      storage_mode: "resource" as const,
      resource_path: "/lib/copy-creator-notes.txt",
      resource_kind: "text" as const,
      group_name: "",
    };

    await useClipboardStore.getState().pasteRecord(textFileRecord);

    expect(invokeMock).toHaveBeenCalledWith("paste_text_file", {
      path: "/lib/copy-creator-notes.txt",
      terminal: false,
    });
    expect(invokeMock).not.toHaveBeenCalledWith("paste_file", {
      path: "/lib/copy-creator-notes.txt",
    });
    expect(invokeMock).toHaveBeenCalledWith("touch_clipboard_usage", { ids: ["res-1"] });
  });

  it("keeps terminal mode when pasting file-backed text resources", async () => {
    await useClipboardStore.getState().pasteRecordTerminal({
      id: "res-2",
      type: "file",
      content: "/lib/notes.md",
      source_app: "",
      created_at: "2026-09-01T00:00:00Z",
      storage_mode: "resource",
      resource_path: "/lib/notes.md",
      resource_kind: "text",
      group_name: "",
    });

    expect(invokeMock).toHaveBeenCalledWith("paste_text_file", {
      path: "/lib/notes.md",
      terminal: true,
    });
  });

  it("falls back to file paste when content reading fails", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "paste_text_file") return Promise.reject(new Error("too large"));
      return Promise.resolve(undefined);
    });

    const result = await useClipboardStore.getState().pasteRecord({
      id: "res-3",
      type: "file",
      content: "/lib/notes.txt",
      source_app: "",
      created_at: "2026-09-01T00:00:00Z",
      storage_mode: "resource",
      resource_path: "/lib/notes.txt",
      resource_kind: "text",
      group_name: "",
    });

    expect(result).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("paste_file", { path: "/lib/notes.txt" });
    expect(invokeMock).toHaveBeenCalledWith("touch_clipboard_usage", { ids: ["res-3"] });
  });

  it("pastes non-text resource files as files", async () => {
    await useClipboardStore.getState().pasteRecord({
      id: "res-4",
      type: "file",
      content: "/lib/movie.mp4",
      source_app: "",
      created_at: "2026-09-01T00:00:00Z",
      storage_mode: "resource",
      resource_path: "/lib/movie.mp4",
      resource_kind: "video",
      group_name: "",
    });

    expect(invokeMock).toHaveBeenCalledWith("paste_file", { path: "/lib/movie.mp4" });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "paste_text_file",
      expect.anything(),
    );
  });
});

describe("clipboardStore full record loading", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useClipboardStore.setState({
      records: [],
      search: "",
      category: "all",
      loading: false,
      hasMore: true,
    });
  });

  it("loads every page before returning records", async () => {
    const makeRecord = (id: string) => ({
      id,
      type: "text" as const,
      content: id,
      source_app: "",
      created_at: "2026-08-01T00:00:00Z",
    });
    const firstPage = Array.from({ length: 120 }, (_, index) => makeRecord(`clip-${index + 1}`));
    const secondPage = [makeRecord("clip-121")];
    invokeMock.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);

    const loaded = await useClipboardStore.getState().loadAllRecords("all");

    expect(loaded).toHaveLength(121);
    expect(useClipboardStore.getState().records).toHaveLength(121);
    expect(useClipboardStore.getState().hasMore).toBe(false);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_clipboard_records", {
      search: undefined,
      limit: 120,
      offset: 0,
      category: undefined,
      sortBy: "recent",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_clipboard_records", {
      search: undefined,
      limit: 120,
      offset: 120,
      category: undefined,
      sortBy: "recent",
    });
  });

  it("keeps the selected resource group for refresh and pagination", async () => {
    const resourceRecord = {
      id: "resource-1",
      type: "text" as const,
      content: "resource",
      source_app: "",
      created_at: "2026-08-01T00:00:00Z",
      storage_mode: "resource" as const,
      resource_group: "References",
    };
    useClipboardStore.setState({
      records: [resourceRecord],
      category: "resources",
      resourceGroup: "References",
    });
    invokeMock.mockResolvedValue([resourceRecord]);

    await useClipboardStore.getState().loadRecords(true, "resources");

    expect(invokeMock).toHaveBeenCalledWith("get_clipboard_records", {
      search: undefined,
      limit: 120,
      offset: 1,
      category: "resources",
      resourceGroup: "References",
    });
  });

  it("uses the selected resource group for full selection loading", async () => {
    const resourceRecord = {
      id: "resource-1",
      type: "text" as const,
      content: "resource",
      source_app: "",
      created_at: "2026-08-01T00:00:00Z",
      storage_mode: "resource" as const,
      resource_group: "References",
    };
    useClipboardStore.setState({
      category: "resources",
      resourceGroup: "References",
    });
    invokeMock.mockResolvedValue([resourceRecord]);

    await useClipboardStore.getState().loadAllRecords("resources");

    expect(invokeMock).toHaveBeenCalledWith("get_clipboard_records", {
      search: undefined,
      limit: 120,
      offset: 0,
      category: "resources",
      resourceGroup: "References",
    });
  });

  it("keeps resource group views stable on paste regardless of sort mode", async () => {
    const makeRecord = (id: string) => ({
      id,
      type: "text" as const,
      content: id,
      source_app: "",
      created_at: "2026-08-01T00:00:00Z",
      storage_mode: "resource" as const,
      resource_group: "References",
    });
    const first = makeRecord("res-a");
    const second = makeRecord("res-b");
    useClipboardStore.setState({
      records: [first, second],
      category: "resources",
      resourceGroup: "References",
    });

    await useClipboardStore.getState().pasteRecord(second);

    // 分组浏览按时间排序，粘贴不改变顺序。
    expect(useClipboardStore.getState().records.map((r) => r.id)).toEqual(["res-a", "res-b"]);
  });

  it("applies the content sort preference only to the all-views", async () => {
    const makeRecord = (id: string) => ({
      id,
      type: "text" as const,
      content: id,
      source_app: "",
      created_at: "2026-08-01T00:00:00Z",
    });
    invokeMock.mockResolvedValue([makeRecord("clip-1")]);

    // 剪切板「全部」（含类型筛选）：带排序偏好。
    await useClipboardStore.getState().loadRecords(false, "all");
    expect(invokeMock).toHaveBeenLastCalledWith("get_clipboard_records", {
      search: undefined,
      limit: 120,
      offset: 0,
      category: undefined,
      sortBy: "recent",
    });

    // 资源「全部分组」：带排序偏好。
    await useClipboardStore.getState().loadRecords(false, "resources", null);
    expect(invokeMock).toHaveBeenLastCalledWith("get_clipboard_records", {
      search: undefined,
      limit: 120,
      offset: 0,
      category: "resources",
      sortBy: "recent",
    });

    // 资源分组浏览（含未分组）：回到时间排序，不带偏好。
    await useClipboardStore.getState().loadRecords(false, "resources", "References");
    expect(invokeMock).toHaveBeenLastCalledWith("get_clipboard_records", {
      search: undefined,
      limit: 120,
      offset: 0,
      category: "resources",
      resourceGroup: "References",
    });
    await useClipboardStore.getState().loadRecords(false, "resources", "");
    expect(invokeMock).toHaveBeenLastCalledWith("get_clipboard_records", {
      search: undefined,
      limit: 120,
      offset: 0,
      category: "resources",
      resourceGroup: "",
    });
  });

  it("sends an empty resource group when loading ungrouped resources", async () => {
    useClipboardStore.setState({
      category: "resources",
      resourceGroup: "",
    });
    invokeMock.mockResolvedValue([]);

    await useClipboardStore.getState().loadRecords(false, "resources");

    expect(invokeMock).toHaveBeenCalledWith("get_clipboard_records", {
      search: undefined,
      limit: 120,
      offset: 0,
      category: "resources",
      resourceGroup: "",
    });
  });

  it("ignores an older normal load when a newer load finishes first", async () => {
    const older = deferred<typeof records>();
    const newer = deferred<typeof records>();
    invokeMock
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    const olderLoad = useClipboardStore.getState().loadRecords(false, "all");
    const newerLoad = useClipboardStore.getState().loadRecords(false, "all");

    newer.resolve([records[1]]);
    await newerLoad;
    older.resolve([records[0]]);
    await olderLoad;

    expect(useClipboardStore.getState().records).toEqual([records[1]]);
    expect(useClipboardStore.getState().loading).toBe(false);
    expect(useClipboardStore.getState().loadError).toBeNull();
  });

  it("does not let an older append replace a newer result", async () => {
    const olderAppend = deferred<typeof records>();
    const newerReplace = deferred<typeof records>();
    useClipboardStore.setState({ records: [records[0]] });
    invokeMock
      .mockImplementationOnce(() => olderAppend.promise)
      .mockImplementationOnce(() => newerReplace.promise);

    const appendLoad = useClipboardStore.getState().loadRecords(true, "all");
    const replaceLoad = useClipboardStore.getState().loadRecords(false, "all");

    newerReplace.resolve([records[1]]);
    await replaceLoad;
    olderAppend.resolve([records[0]]);
    await appendLoad;

    expect(useClipboardStore.getState().records).toEqual([records[1]]);
    expect(useClipboardStore.getState().loading).toBe(false);
  });

  it("cancels an older full load when a newer page load starts", async () => {
    const olderFullLoad = deferred<typeof records>();
    const newerPageLoad = deferred<typeof records>();
    invokeMock
      .mockImplementationOnce(() => olderFullLoad.promise)
      .mockImplementationOnce(() => newerPageLoad.promise);

    const fullLoad = useClipboardStore.getState().loadAllRecords("all");
    const pageLoad = useClipboardStore.getState().loadRecords(false, "all");

    newerPageLoad.resolve([records[1]]);
    await pageLoad;
    olderFullLoad.resolve([records[0]]);
    await fullLoad;

    expect(useClipboardStore.getState().records).toEqual([records[1]]);
    expect(useClipboardStore.getState().loading).toBe(false);
  });
});
