import { describe, expect, it } from "vitest";
import { formatSizeDisplay, sizePresetItems } from "./genParams";

// 尺寸统一全量清单 + 取值展示翻转（2026-11-04 二轮定案）的纯函数用例。
const t = (k: string) => k;
const items = sizePresetItems(t);

describe("sizePresetItems", () => {
  it("全量清单：7 种比例 1K + 16:9/9:16 的 2K + auto，统一存显式像素", () => {
    expect(items).toHaveLength(10);
    const numeric = items.filter((i) => i.value !== "auto");
    expect(numeric.every((i) => i.value.includes("x"))).toBe(true);
    expect(items.filter((i) => i.tier === "1K")).toHaveLength(7);
    expect(items.filter((i) => i.tier === "2K").map((i) => i.value)).toEqual([
      "2048x1152",
      "1152x2048",
    ]);
  });

  it("比例串过渡存量经 legacyValues 命中同一条目", () => {
    const item = items.find((i) => i.legacyValues?.includes("16:9"));
    expect(item?.value).toBe("1536x864");
    expect(item?.tier).toBe("1K");
  });
});

describe("formatSizeDisplay", () => {
  it("取值态翻转：比例为主、分辨率为弱化尾注", () => {
    expect(formatSizeDisplay("1024x1024", items)).toEqual({ main: "1:1", tail: "1024 × 1024" });
    expect(formatSizeDisplay("2048x1152", items)).toEqual({ main: "16:9", tail: "2048 × 1152" });
  });

  it("auto 尾注为跟随模型提示", () => {
    expect(formatSizeDisplay("auto", items)).toEqual({ main: "auto", tail: "canvas.genSizeAutoHint" });
  });

  it("比例串过渡存量命中展示", () => {
    expect(formatSizeDisplay("16:9", items)).toEqual({ main: "16:9", tail: "1536 × 864" });
  });

  it("未命中预设的自定义值原样展示", () => {
    expect(formatSizeDisplay("999x999", items)).toEqual({ main: "999x999" });
  });
});
