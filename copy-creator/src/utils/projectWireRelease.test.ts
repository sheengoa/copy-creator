import { describe, expect, it } from "vitest";
import { resolveWireRelease } from "./projectWireRelease";

const base = {
  cancelled: false,
  moved: true,
  hasTarget: false,
  landedOnCanvasItem: false,
  insideViewport: true,
};

describe("resolveWireRelease", () => {
  it("提交兼容端口，不打开节点搜索框", () => {
    expect(resolveWireRelease({ ...base, hasTarget: true })).toBe("commit");
  });

  it("空白松手才打开节点搜索框", () => {
    expect(resolveWireRelease(base)).toBe("picker");
    expect(resolveWireRelease({ ...base, landedOnCanvasItem: true })).toBe("cancel");
    expect(resolveWireRelease({ ...base, insideViewport: false })).toBe("cancel");
  });

  it("系统取消和未形成拖拽都不提交", () => {
    expect(resolveWireRelease({ ...base, cancelled: true })).toBe("cancel");
    expect(resolveWireRelease({ ...base, moved: false })).toBe("cancel");
  });
});
