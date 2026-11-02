import { describe, expect, it } from "vitest";
import type { CanvasNodeType } from "../../../stores/canvasStore";
import { MENU_TYPE_ORDER, NODE_DEFS } from "./registry";

// 注册完整性守卫：NODE_DEFS 的 Record 形状由 typecheck 保证，但菜单展示
// 顺序表 MENU_TYPE_ORDER 是普通数组——漏项/重复只会静默丢菜单条目或
// 丢派生表（尺寸/端口/着色）条目，这里机械兜底。
describe("nodes/registry", () => {
  it("MENU_TYPE_ORDER 恰好覆盖全部注册类型且不重复", () => {
    const keys = Object.keys(NODE_DEFS) as CanvasNodeType[];
    expect(new Set(MENU_TYPE_ORDER).size).toBe(MENU_TYPE_ORDER.length);
    expect([...MENU_TYPE_ORDER].sort()).toEqual([...keys].sort());
  });

  it("派生表形状完整（recordOf 覆盖每个类型）", () => {
    for (const type of Object.keys(NODE_DEFS) as CanvasNodeType[]) {
      expect(NODE_DEFS[type].ports, type).toBeDefined();
      expect(NODE_DEFS[type].size, type).toBeDefined();
      expect(NODE_DEFS[type].minSize, type).toBeDefined();
      expect(NODE_DEFS[type].fallbackSize, type).toBeDefined();
      expect(NODE_DEFS[type].accent, type).toBeTruthy();
    }
  });
});
