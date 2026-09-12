import { describe, expect, it } from "vitest";
import {
  buildRadialPreviewSegments,
  isContentPreviewAvailable,
  STASH_IMAGE_PLACEHOLDER,
} from "./radialPreview";

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
