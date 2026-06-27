import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const { usePhraseStore } = await import("./phraseStore");

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
});
