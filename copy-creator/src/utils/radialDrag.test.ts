import { describe, expect, it } from "vitest";
import {
  getClipboardRadialDragKind,
  getPhraseRadialDragKind,
} from "./radialDrag";

describe("radial file drag support", () => {
  it("uses native file dragging for images, files, and image-bearing resources", () => {
    expect(getClipboardRadialDragKind("image")).toBe("files");
    expect(getClipboardRadialDragKind("file")).toBe("files");
    expect(getClipboardRadialDragKind("text", true)).toBe("files");
  });

  it("does not enable dragging for text, links, or text phrases", () => {
    expect(getClipboardRadialDragKind("text")).toBe("none");
    expect(getClipboardRadialDragKind("link")).toBe("none");
    expect(getPhraseRadialDragKind("text")).toBe("none");
    expect(getPhraseRadialDragKind("file")).toBe("files");
  });
});
