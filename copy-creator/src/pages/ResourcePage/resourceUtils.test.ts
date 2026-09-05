import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipboardRecord } from "../../types";

const { convertFileSrcMock, invokeMock } = vi.hoisted(() => ({
  convertFileSrcMock: vi.fn((path: string) => `asset://${path}`),
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: convertFileSrcMock,
  invoke: invokeMock,
}));

import {
  formatResourceFileSize,
  getResourceFileName,
  getResourceTitle,
  inferResourceMediaKind,
  resolveResourceAssetUrl,
  splitResourceColumns,
} from "./resourceUtils";

function record(type: ClipboardRecord["type"], content: string): Pick<ClipboardRecord, "type" | "content"> {
  return { type, content };
}

describe("resourceUtils", () => {
  beforeEach(() => {
    convertFileSrcMock.mockClear();
    invokeMock.mockReset();
  });

  it("infers media kinds from record types and file extensions", () => {
    expect(inferResourceMediaKind(record("text", "说明"))).toBe("text");
    expect(inferResourceMediaKind(record("image", "/tmp/image.png"))).toBe("image");
    expect(inferResourceMediaKind(record("file", "/tmp/movie.MP4"))).toBe("video");
    expect(inferResourceMediaKind(record("file", "/tmp/voice.ogg"))).toBe("audio");
    expect(inferResourceMediaKind(record("file", "/tmp/report.pdf"))).toBe("file");
    expect(inferResourceMediaKind({
      type: "file",
      content: "/tmp/README.custom",
      resource_kind: "text",
    })).toBe("text");
    expect(inferResourceMediaKind(record("file", "/tmp/README.md"))).toBe("text");
  });

  it("decodes local file names without changing unknown path values", () => {
    expect(getResourceFileName("file:///tmp/report%20final.pdf")).toBe("report final.pdf");
    expect(getResourceFileName("/tmp/报告.pdf")).toBe("报告.pdf");
    expect(getResourceFileName("")).toBe("");
  });

  it("uses the external resource file name for text resource titles", () => {
    expect(getResourceTitle({
      type: "file",
      content: "/tmp/README.md",
      resource_kind: "text",
      resource_path: "/tmp/README.md",
    })).toBe("README.md");
  });

  it("formats resource file sizes without unstable decimal noise", () => {
    expect(formatResourceFileSize(0)).toBe("0 B");
    expect(formatResourceFileSize(1024)).toBe("1 KB");
    expect(formatResourceFileSize(1024 * 1024 + 512 * 1024)).toBe("1.5 MB");
    expect(formatResourceFileSize(undefined)).toBe("");
  });

  it("normalizes Windows file URLs before converting them to asset URLs", async () => {
    await resolveResourceAssetUrl("file:///C:/Media/report%20final.png");

    expect(convertFileSrcMock).toHaveBeenCalledWith("C:/Media/report final.png");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("allows storage path resolution to retry after a failed request", async () => {
    invokeMock
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce("/tmp/resources");

    await expect(resolveResourceAssetUrl("notes.txt")).rejects.toThrow("temporary failure");
    await expect(resolveResourceAssetUrl("notes.txt")).resolves.toBe(
      "asset:///tmp/resources/notes.txt",
    );
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("interleaves records across columns so rows read in list order", () => {
    const records = ["a", "b", "c", "d", "e"].map((id) => record("text", id));

    expect(splitResourceColumns(records as ClipboardRecord[], 2).map((column) => (
      column.map((item) => item.content)
    ))).toEqual([
      ["a", "c", "e"],
      ["b", "d"],
    ]);
  });
});
