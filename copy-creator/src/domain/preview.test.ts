import { describe, expect, it } from "vitest";
import {
  buildRadialPreviewSegments,
  isContentPreviewAvailable,
  splitTextChunks,
  STASH_IMAGE_PLACEHOLDER,
  TEXT_DETAIL_CHUNK_CHARS,
} from "./preview";

describe("isContentPreviewAvailable", () => {
  it("makes every supported content type expandable", () => {
    expect(isContentPreviewAvailable({ type: "text" }, false)).toBe(true);
    expect(isContentPreviewAvailable({ type: "image" }, false)).toBe(true);
    expect(isContentPreviewAvailable({ type: "link" }, false)).toBe(true);
    expect(isContentPreviewAvailable({ type: "file" }, false)).toBe(true);
    expect(isContentPreviewAvailable({ type: "phrase" }, false)).toBe(true);
  });

  it("keeps image attachments and clipped content expandable", () => {
    expect(isContentPreviewAvailable({ type: "unknown", hasImages: true }, false)).toBe(true);
    expect(isContentPreviewAvailable({ type: "unknown" }, true)).toBe(true);
    expect(isContentPreviewAvailable({ type: "unknown" }, false)).toBe(false);
  });
});

describe("buildRadialPreviewSegments", () => {
  it("keeps text and object-placeholder images in document order", () => {
    expect(buildRadialPreviewSegments(
      `开头${STASH_IMAGE_PLACEHOLDER}中间${STASH_IMAGE_PLACEHOLDER}结尾`,
      ["first.png", "second.png"],
    )).toEqual([
      { type: "text", content: "开头" },
      { type: "image", path: "first.png" },
      { type: "text", content: "中间" },
      { type: "image", path: "second.png" },
      { type: "text", content: "结尾" },
    ]);
  });

  it("supports legacy numbered image markers", () => {
    expect(buildRadialPreviewSegments(
      "开头[Image #1]结尾",
      ["first.png"],
    )).toEqual([
      { type: "text", content: "开头" },
      { type: "image", path: "first.png" },
      { type: "text", content: "结尾" },
    ]);
  });

  it("returns one text segment for ordinary content", () => {
    expect(buildRadialPreviewSegments("普通文本", [])).toEqual([
      { type: "text", content: "普通文本" },
    ]);
  });
});

describe("splitTextChunks", () => {
  it("returns a single chunk for short content", () => {
    expect(splitTextChunks("普通文本")).toEqual(["普通文本"]);
    expect(splitTextChunks("a".repeat(TEXT_DETAIL_CHUNK_CHARS))).toEqual([
      "a".repeat(TEXT_DETAIL_CHUNK_CHARS),
    ]);
  });

  it("splits long content into ordered chunks that reassemble losslessly", () => {
    const content = `${"汉".repeat(180_000)}tail`;
    const chunks = splitTextChunks(content);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(content);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(TEXT_DETAIL_CHUNK_CHARS);
    }
  });

  it("never splits a surrogate pair across chunk boundaries", () => {
    // 代理对恰好骑在切分边界上：块尾不得以高代理结尾，块首不得以低代理开头。
    const content = `a`.repeat(TEXT_DETAIL_CHUNK_CHARS - 1) + "😀" + "b".repeat(50);
    const chunks = splitTextChunks(content);
    expect(chunks.length).toBe(2);
    expect(chunks.join("")).toBe(content);
    for (const chunk of chunks) {
      expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(chunk)).toBe(false);
    }
  });
});
