import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const { usePhraseStore, ALL_PHRASES_GROUP_ID } = await import("./phraseStore");

const basePhrase = {
  id: "phrase-1",
  group_id: "group-1",
  title: "Example",
  sort_order: 0,
  created_at: "2026-06-27T00:00:00Z",
  updated_at: "2026-06-27T00:00:00Z",
};

describe("phraseStore paste routing", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    usePhraseStore.setState({ phrases: [] });
  });

  it("pastes text phrases with the text paste command", async () => {
    await usePhraseStore.getState().pastePhrase({
      ...basePhrase,
      content: "hello",
      input_type: "text",
      source_path: "",
      file_size: 0,
    });

    expect(invokeMock).toHaveBeenCalledWith("paste_text", { text: "hello" });
    expect(invokeMock).toHaveBeenCalledWith("touch_phrase_usage", {
      id: "phrase-1",
    });
  });

  it("records usage time for terminal pastes and skips failures", async () => {
    await usePhraseStore.getState().pastePhraseTerminal({
      ...basePhrase,
      content: "pwd",
      input_type: "text",
      source_path: "",
      file_size: 0,
    });
    expect(invokeMock).toHaveBeenCalledWith("touch_phrase_usage", {
      id: "phrase-1",
    });

    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "paste_text") return Promise.reject(new Error("boom"));
      return Promise.resolve(undefined);
    });
    await usePhraseStore.getState().pastePhrase({
      ...basePhrase,
      content: "hello",
      input_type: "text",
      source_path: "",
      file_size: 0,
    });
    expect(invokeMock).not.toHaveBeenCalledWith("touch_phrase_usage", {
      id: "phrase-1",
    });
  });

  it("pastes file phrases with the file paste command", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_storage_path") return "/stored";
      return undefined;
    });

    await usePhraseStore.getState().pastePhrase({
      ...basePhrase,
      content: "quick-input-files/example.md",
      input_type: "file",
      source_path: "/home/ao/example.md",
      file_size: 12,
    });

    expect(invokeMock).toHaveBeenCalledWith("paste_file", {
      path: "/stored/quick-input-files/example.md",
    });
  });

  it("keeps terminal override for text phrases", async () => {
    await usePhraseStore.getState().pastePhraseTerminal({
      ...basePhrase,
      content: "pwd",
      input_type: "text",
      source_path: "",
      file_size: 0,
    });

    expect(invokeMock).toHaveBeenCalledWith("paste_text_terminal", { text: "pwd" });
  });

  it("uses file paste for terminal override on file phrases", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_storage_path") return "/stored";
      return undefined;
    });

    await usePhraseStore.getState().pastePhraseTerminal({
      ...basePhrase,
      content: "quick-input-files/example.md",
      input_type: "file",
      source_path: "/home/ao/example.md",
      file_size: 12,
    });

    expect(invokeMock).toHaveBeenCalledWith("paste_file", {
      path: "/stored/quick-input-files/example.md",
    });
  });

  it("pastes image file phrases as bitmap content", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_storage_path") return "/stored";
      return undefined;
    });

    await usePhraseStore.getState().pastePhrase({
      ...basePhrase,
      content: "quick-input-files/photo.PNG",
      input_type: "file",
      source_path: "/home/ao/photo.PNG",
      file_size: 2048,
    });

    expect(invokeMock).toHaveBeenCalledWith("paste_image_file", {
      path: "/stored/quick-input-files/photo.PNG",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("paste_file", expect.anything());
  });

  it("pastes image file phrases via bitmap in terminal mode too", async () => {
    invokeMock.mockResolvedValue("/home/ao/pic.jpeg");

    await usePhraseStore.getState().pastePhraseTerminal({
      ...basePhrase,
      content: "/home/ao/pic.jpeg",
      input_type: "file",
      source_path: "/home/ao/pic.jpeg",
      file_size: 2048,
    });

    expect(invokeMock).toHaveBeenCalledWith("paste_image_file", { path: "/home/ao/pic.jpeg" });
  });

  it("deletes selected quick inputs in one backend call", async () => {
    const first = {
      ...basePhrase,
      content: "first",
      input_type: "text" as const,
      source_path: "",
      file_size: 0,
    };
    const second = { ...first, id: "phrase-2", content: "second" };
    usePhraseStore.setState({ phrases: [first, second] });

    await usePhraseStore.getState().deletePhrases(["phrase-1"]);

    expect(invokeMock).toHaveBeenCalledWith("delete_phrases", {
      ids: ["phrase-1"],
    });
    expect(usePhraseStore.getState().phrases.map((phrase) => phrase.id)).toEqual(["phrase-2"]);
  });

  it("routes single quick input deletion through the batch command", async () => {
    await usePhraseStore.getState().deletePhrase("phrase-1");

    expect(invokeMock).toHaveBeenCalledWith("delete_phrases", {
      ids: ["phrase-1"],
    });
  });
});

describe("phraseStore all-phrases view", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    usePhraseStore.setState({ phrases: [], selectedGroupId: null, groups: [] });
  });

  const textPhrase = (id: string) => ({
    ...basePhrase,
    id,
    content: id,
    input_type: "text" as const,
    source_path: "",
    file_size: 0,
  });

  it("loads cross-group phrases via get_all_phrases for the all view", async () => {
    const allPhrases = [
      { ...textPhrase("phrase-1"), group_name: "客服话术", last_used_at: "2026-09-11T00:00:00Z" },
    ];
    invokeMock.mockResolvedValueOnce(allPhrases);

    await usePhraseStore.getState().loadPhrases(ALL_PHRASES_GROUP_ID);

    expect(invokeMock).toHaveBeenCalledWith("get_all_phrases", {});
    expect(usePhraseStore.getState().phrases).toEqual(allPhrases);
    expect(usePhraseStore.getState().selectedGroupId).toBe(ALL_PHRASES_GROUP_ID);
  });

  it("defaults group loading to the all view when nothing is selected", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_phrase_groups") {
        return [{ id: "group-1", name: "客服话术" }];
      }
      return [];
    });

    await usePhraseStore.getState().loadGroups();

    expect(invokeMock).toHaveBeenCalledWith("get_all_phrases", {});
    expect(usePhraseStore.getState().selectedGroupId).toBe(ALL_PHRASES_GROUP_ID);
  });

  it("moves a pasted phrase to the front only in the all view", async () => {
    const first = textPhrase("a");
    const second = textPhrase("b");

    usePhraseStore.setState({ phrases: [first, second], selectedGroupId: ALL_PHRASES_GROUP_ID });
    await usePhraseStore.getState().pastePhrase(second);
    expect(usePhraseStore.getState().phrases.map((p) => p.id)).toEqual(["b", "a"]);

    // 分组视图按手动排序，粘贴不改变顺序。
    usePhraseStore.setState({ phrases: [first, second], selectedGroupId: "group-1" });
    await usePhraseStore.getState().pastePhrase(second);
    expect(usePhraseStore.getState().phrases.map((p) => p.id)).toEqual(["a", "b"]);
  });
});
