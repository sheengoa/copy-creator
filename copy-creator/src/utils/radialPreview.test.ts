import { describe, expect, it } from "vitest";
import {
  buildRadialPreviewSegments,
  calculateRadialExpansion,
  STASH_IMAGE_PLACEHOLDER,
} from "./radialPreview";

describe("calculateRadialExpansion", () => {
  it("expands to the right when enough work-area space remains", () => {
    expect(calculateRadialExpansion({
      windowX: 200,
      workAreaX: 0,
      workAreaWidth: 1920,
      scaleFactor: 1,
    })).toEqual({ direction: "right", previewWidth: 400, windowX: 200 });
  });

  it("expands left and keeps the original menu position stable near the right edge", () => {
    expect(calculateRadialExpansion({
      windowX: 1500,
      workAreaX: 0,
      workAreaWidth: 1920,
      scaleFactor: 1,
    })).toEqual({ direction: "left", previewWidth: 400, windowX: 1100 });
  });

  it("uses the remaining space on a constrained work area", () => {
    expect(calculateRadialExpansion({
      windowX: 50,
      workAreaX: 0,
      workAreaWidth: 600,
      scaleFactor: 1,
    })).toEqual({ direction: "right", previewWidth: 250, windowX: 50 });
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
