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
  computeResourceColumnCount,
  findResourceFolder,
  flattenResourceFolders,
  formatResourceBitrate,
  formatResourceDuration,
  formatResourceFileSize,
  getResourceFolderRoot,
  getResourceFileName,
  getResourcePath,
  getResourceTitle,
  inferResourceMediaKind,
  isResourceFolderPath,
  resolveResourceAssetUrl,
  resolveResourceMediaUrl,
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

  it("prefers the resource path for file-backed records", () => {
    expect(getResourcePath({
      type: "file",
      content: "原始文件名.mp4",
      resource_path: "/tmp/resources/实际文件名.mp4",
    })).toBe("/tmp/resources/实际文件名.mp4");
    expect(getResourcePath({
      type: "file",
      content: "/tmp/resources/fallback.bin",
    })).toBe("/tmp/resources/fallback.bin");
    expect(getResourcePath({
      type: "text",
      content: "文本内容",
      resource_path: "/tmp/resources/内容.txt",
    })).toBe("文本内容");
    expect(getResourceTitle({
      type: "file",
      content: "旧标题.mp4",
      resource_path: "/tmp/resources/实际视频.mp4",
    }, "video")).toBe("实际视频.mp4");
  });

  it("formats resource file sizes without unstable decimal noise", () => {
    expect(formatResourceFileSize(0)).toBe("0 B");
    expect(formatResourceFileSize(1024)).toBe("1 KB");
    expect(formatResourceFileSize(1024 * 1024 + 512 * 1024)).toBe("1.5 MB");
    expect(formatResourceFileSize(undefined)).toBe("");
  });

  it("keeps at least two resource columns and grows with window width", () => {
    expect(computeResourceColumnCount(0)).toBe(2);
    expect(computeResourceColumnCount(440)).toBe(2);
    expect(computeResourceColumnCount(1326)).toBe(2);
    expect(computeResourceColumnCount(1420)).toBe(3);
    expect(computeResourceColumnCount(2400)).toBe(5);
    expect(computeResourceColumnCount(4000)).toBe(5);
  });

  it("formats media duration and average bitrate for the detail sidebar", () => {
    expect(formatResourceDuration(undefined)).toBe("");
    expect(formatResourceDuration(0)).toBe("");
    expect(formatResourceDuration(16.39)).toBe("0:16");
    expect(formatResourceDuration(61)).toBe("1:01");
    expect(formatResourceDuration(3723)).toBe("1:02:03");
    expect(formatResourceBitrate(undefined, 10)).toBe("");
    expect(formatResourceBitrate(2285985, 16.39)).toBe("1.1 Mbps");
    expect(formatResourceBitrate(60_000, 16)).toBe("30 kbps");
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

  it("routes local media previews through the loopback media server", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_media_server_origin") {
        return Promise.resolve({ origin: "http://127.0.0.1:18765", token: "secret" });
      }
      return Promise.resolve("/tmp/resources");
    });

    await expect(resolveResourceMediaUrl("/tmp/视频/a b.mp4")).resolves.toBe(
      "http://127.0.0.1:18765/media?token=secret&path=%2Ftmp%2F%E8%A7%86%E9%A2%91%2Fa%20b.mp4",
    );
    await expect(resolveResourceMediaUrl("https://example.com/remote.mp3")).resolves.toBe(
      "https://example.com/remote.mp3",
    );
    await expect(resolveResourceMediaUrl("")).rejects.toThrow("资源路径为空");
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

  it("flattens nested resource folders in display order", () => {
    const folders = [
      {
        name: "人物三视图",
        path: "人物三视图",
        count: 0,
        children: [
          {
            name: "放大后",
            path: "人物三视图/放大后",
            count: 0,
            children: [
              {
                name: "细节",
                path: "人物三视图/放大后/细节",
                count: 0,
                children: [],
              },
            ],
          },
        ],
      },
    ];

    expect(flattenResourceFolders(folders)).toEqual([
      { folder: folders[0], depth: 0 },
      { folder: folders[0].children[0], depth: 1 },
      { folder: folders[0].children[0].children[0], depth: 2 },
    ]);
    expect(findResourceFolder(folders, "人物三视图/放大后/细节")?.name).toBe("细节");
    expect(findResourceFolder(folders, "不存在")).toBeNull();
  });

  it("matches folder paths without confusing similarly named folders", () => {
    expect(isResourceFolderPath("人物三视图", "人物三视图")).toBe(true);
    expect(isResourceFolderPath("人物三视图/放大后", "人物三视图")).toBe(true);
    expect(isResourceFolderPath("人物三视图扩展", "人物三视图")).toBe(false);
    expect(getResourceFolderRoot("人物三视图/放大后/细节")).toBe("人物三视图");
    expect(getResourceFolderRoot("")).toBe("");
  });
});
