import { describe, expect, it } from "vitest";
import {
  computeResourceColumnCount,
  restoreInterleavedOrder,
  splitResourceColumns,
} from "./cardGrid";

describe("splitResourceColumns", () => {
  it("交错分配：第 i 项落第 i%count 列（双列按行阅读 = 时间序）", () => {
    const [c0, c1] = splitResourceColumns(["a", "b", "c", "d", "e"], 2);
    expect(c0).toEqual(["a", "c", "e"]);
    expect(c1).toEqual(["b", "d"]);
  });

  it("四列：DOM 序（列主序）为 1,5,2,6,3,7,4,8", () => {
    expect(splitResourceColumns([1, 2, 3, 4, 5, 6, 7, 8], 4).flat()).toEqual([
      1, 5, 2, 6, 3, 7, 4, 8,
    ]);
  });

  it("列数钳制：非法值回退 1 列、小数向下取整", () => {
    expect(splitResourceColumns(["a", "b"], 0)).toEqual([["a", "b"]]);
    expect(splitResourceColumns(["a", "b"], 1.6)).toEqual([["a", "b"]]);
    expect(splitResourceColumns(["a", "b"], 2.9)).toEqual([["a"], ["b"]]);
  });
});

describe("restoreInterleavedOrder", () => {
  const logical = ["a", "b", "c", "d", "e"];

  // 语义不变量：还原后的逻辑序重新分列展平 = 拖拽后的 DOM 序。
  // （5 项 2 列的槽位映射：L0→槽0、L1→槽3、L2→槽1、L3→槽4、L4→槽2。）
  function expectRoundTrip(basis: string[], dom: string[], count: number) {
    const result = restoreInterleavedOrder(basis, dom, count);
    expect(splitResourceColumns(result, count).flat()).toEqual(dom);
    return result;
  }

  it("DOM 序未变 → 逻辑序原样返回（拖拽无位移不提交）", () => {
    const dom = splitResourceColumns(logical, 2).flat();
    expect(restoreInterleavedOrder(logical, dom, 2)).toEqual(logical);
  });

  it("同列内相邻交换（DOM 槽位 0↔2）：a 移到列 0 末行", () => {
    // domBefore = [a,c,e,b,d]；交换槽 0/2 → [e,c,a,b,d]
    const dom = ["e", "c", "a", "b", "d"];
    // 槽0=e→L0、槽2=a→L4、其余不动 → [e,b,c,d,a]
    expect(expectRoundTrip(logical, dom, 2)).toEqual(["e", "b", "c", "d", "a"]);
  });

  it("跨列交换（DOM 槽位 0↔1，两列首项对调）：逻辑序 a↔c", () => {
    const dom = ["c", "a", "e", "b", "d"];
    expect(expectRoundTrip(logical, dom, 2)).toEqual(["c", "b", "a", "d", "e"]);
  });

  it("拖到末尾：a 移到 DOM 末位，逻辑序正确还原", () => {
    // domBefore = [a,c,e,b,d]；把 a 拖到末尾 → [c,e,b,d,a]
    const dom = ["c", "e", "b", "d", "a"];
    expect(expectRoundTrip(logical, dom, 2)).toEqual(["c", "d", "e", "a", "b"]);
  });

  it("四列跨列拖拽：槽 1↔2（列 0 末项与列 1 首项对调）→ 逻辑序 2↔5", () => {
    const logical8 = ["1", "2", "3", "4", "5", "6", "7", "8"];
    // domBefore(4 列) = [1,5,2,6,3,7,4,8]；交换槽 1/2 → [1,2,5,6,3,7,4,8]
    const dom = ["1", "2", "5", "6", "3", "7", "4", "8"];
    expect(expectRoundTrip(logical8, dom, 4)).toEqual(["1", "5", "3", "4", "2", "6", "7", "8"]);
  });

  it("domAfter 缺尾（拖拽中被裁剪的渲染序）：缺失槽位的逻辑项保持原位", () => {
    const dom = ["c", "a"];
    // a 的原 DOM 槽 0 → domAfter[0]=c；b 槽 3 超界 → 保持 b；c 槽 1 → domAfter[1]=a
    expect(restoreInterleavedOrder(logical, dom, 2)).toEqual(["c", "b", "a", "d", "e"]);
  });

  it("恒等性质：任意列数下，DOM 序 = 分列展平序时结果恒等于逻辑序", () => {
    for (let count = 2; count <= 5; count++) {
      const logical12 = Array.from({ length: 12 }, (_, i) => `id-${i}`);
      expect(restoreInterleavedOrder(logical12, splitResourceColumns(logical12, count).flat(), count)).toEqual(logical12);
    }
  });
});

describe("computeResourceColumnCount", () => {
  it("窄宽降单列、按最小列宽增长、上限 5 列；非法宽度回退 2", () => {
    expect(computeResourceColumnCount(100, 300)).toBe(1);
    // (940+10)/(300+10) → 3 列
    expect(computeResourceColumnCount(940, 300)).toBe(3);
    expect(computeResourceColumnCount(5000, 300)).toBe(5);
    expect(computeResourceColumnCount(0, 300)).toBe(2);
    expect(computeResourceColumnCount(Number.NaN, 300)).toBe(2);
  });
});
