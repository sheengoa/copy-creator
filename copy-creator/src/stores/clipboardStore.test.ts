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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

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
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_clipboard_records", {
      search: undefined,
      limit: 120,
      offset: 120,
      category: undefined,
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
