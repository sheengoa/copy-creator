import { describe, expect, it } from "vitest";
import {
  buildRadialPreviewSegments,
  calculatePreviewExpansion,
  calculateRadialExpansion,
  shouldScheduleContentPreview,
  STASH_IMAGE_PLACEHOLDER,
} from "./radialPreview";

describe("calculateRadialExpansion", () => {
  it("expands to the right when enough work-area space remains", () => {
    expect(calculateRadialExpansion({
      windowX: 200,
      workAreaX: 0,
      workAreaWidth: 1920,
      scaleFactor: 1,
    })).toEqual({ direction: "right", previewWidth: 440, windowX: 200 });
  });

  it("expands left and keeps the original menu position stable near the right edge", () => {
    expect(calculateRadialExpansion({
      windowX: 1500,
      workAreaX: 0,
      workAreaWidth: 1920,
      scaleFactor: 1,
    })).toEqual({ direction: "left", previewWidth: 440, windowX: 1060 });
  });

  it("uses the remaining space on a constrained work area", () => {
    expect(calculateRadialExpansion({
      windowX: 50,
      workAreaX: 0,
      workAreaWidth: 600,
      scaleFactor: 1,
    })).toEqual({ direction: "right", previewWidth: 130, windowX: 50 });
  });
});

describe("calculatePreviewExpansion", () => {
  it("uses the current main-window width when expanding to the right", () => {
    expect(calculatePreviewExpansion({
      windowX: 770,
      windowWidth: 627,
      workAreaX: 0,
      workAreaWidth: 2560,
      scaleFactor: 1,
    })).toEqual({
      direction: "right",
      previewWidth: 440,
      previewPhysicalWidth: 440,
      windowX: 770,
    });
  });

  it("expands left without moving the original main-window area", () => {
    expect(calculatePreviewExpansion({
      windowX: 1400,
      windowWidth: 500,
      workAreaX: 0,
      workAreaWidth: 1920,
      scaleFactor: 1,
    })).toEqual({
      direction: "left",
      previewWidth: 440,
      previewPhysicalWidth: 440,
      windowX: 960,
    });
  });

  it("keeps physical and logical preview widths aligned on scaled displays", () => {
    expect(calculatePreviewExpansion({
      windowX: 200,
      windowWidth: 1000,
      workAreaX: 0,
      workAreaWidth: 3840,
      scaleFactor: 2,
    })).toEqual({
      direction: "right",
      previewWidth: 440,
      previewPhysicalWidth: 880,
      windowX: 200,
    });
  });
});

describe("shouldScheduleContentPreview", () => {
  it("always previews images and image-bearing resources", () => {
    expect(shouldScheduleContentPreview({ type: "image" }, false)).toBe(true);
    expect(shouldScheduleContentPreview({ type: "text", hasImages: true }, false)).toBe(true);
  });

  it("previews clipped or backend-truncated content but not files", () => {
    expect(shouldScheduleContentPreview({ type: "text" }, true)).toBe(true);
    expect(shouldScheduleContentPreview({ type: "link", contentTruncated: true }, false)).toBe(true);
    expect(shouldScheduleContentPreview({ type: "file" }, true)).toBe(false);
    expect(shouldScheduleContentPreview({ type: "text" }, false)).toBe(false);
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
