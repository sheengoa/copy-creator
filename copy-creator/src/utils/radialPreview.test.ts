import { describe, expect, it } from "vitest";
import {
  buildRadialPreviewSegments,
  calculatePreviewExpansion,
  calculateRadialExpansion,
  isContentPreviewAvailable,
  RADIAL_SHADOW_MARGIN,
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

  it("returns design-pixel preview width when the menu is UI-scaled", () => {
    // uiScale 只影响 CSS 缩放，预览面板的物理目标宽度不变；
    // 返回的设计像素 = 物理宽 / (scaleFactor × uiScale)。
    expect(calculateRadialExpansion({
      windowX: 200,
      workAreaX: 0,
      workAreaWidth: 3840,
      scaleFactor: 1,
      uiScale: 1.5,
    })).toEqual({ direction: "right", previewWidth: 293, windowX: 200 });
  });

  it("keeps expansion positions integral under f32 ui-scale artifacts (0.8)", () => {
    // 径向缩放 80% 的实际存储值是 f32(0.8)：阴影边距带出浮点残渣时，
    // 回写窗口原点必须保持整数，否则 PhysicalPosition(i32) 被拒绝，
    // 预览会静默无法展开（贴右缘场景的实测根因）。
    const uiScale = 0.800000011920929;
    const scaleFactor = 1;
    const marginPhysical = Math.round(RADIAL_SHADOW_MARGIN * scaleFactor * uiScale);
    const expansion = calculateRadialExpansion({
      windowX: 1369 + marginPhysical,
      workAreaX: 0,
      workAreaWidth: 1920,
      scaleFactor,
      uiScale,
    });
    // 贴右缘（右侧仅剩阴影边距的空间）时必须向左扩展。
    expect(expansion.direction).toBe("left");
    expect(expansion.previewWidth).toBe(549);
    expect(expansion.windowX - marginPhysical).toBe(929);
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

  it("divides UI scale out of the logical preview width on top of device scale", () => {
    expect(calculatePreviewExpansion({
      windowX: 200,
      windowWidth: 1000,
      workAreaX: 0,
      workAreaWidth: 3840,
      scaleFactor: 2,
      uiScale: 1.5,
    })).toEqual({
      direction: "right",
      previewWidth: 293,
      previewPhysicalWidth: 880,
      windowX: 200,
    });
  });
});

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
