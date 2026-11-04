import { describe, expect, it } from "vitest";
import { formatSizeDisplay, sizePresetItemsFor } from "./genParams";

// 尺寸清单按模型分流 + 取值展示翻转（2026-11-04 原型定案）的纯函数用例。
const t = (k: string) => k;

describe("sizePresetItemsFor", () => {
  it("gpt-image 清单只含官方支持项且存显式像素", () => {
    const items = sizePresetItemsFor("gpt-image-2", t);
    expect(items.map((i) => i.value)).toEqual(["auto", "1024x1024", "1536x1024", "1024x1536"]);
  });

  it("gemini 清单全比例：1K 存比例串、2K 存显式像素（无 quality 时比例固定落 1K）", () => {
    const items = sizePresetItemsFor("gemini-2.5-flash-image", t);
    expect(items).toHaveLength(10);
    expect(items.filter((i) => i.tier === "1K" && i.value !== "auto").every((i) => i.value.includes(":"))).toBe(true);
    expect(items.filter((i) => i.tier === "2K").every((i) => i.value.includes("x"))).toBe(true);
  });

  it("自定义/未知模型与 gemini 同用全量清单（原型定案）", () => {
    expect(sizePresetItemsFor("some-proxy-model", t)).toEqual(sizePresetItemsFor("gemini-2.5-flash-image", t));
  });

  it("模型名大小写不敏感", () => {
    expect(sizePresetItemsFor("GPT-Image-Preview", t)).toEqual(sizePresetItemsFor("gpt-image-1", t));
  });
});

describe("formatSizeDisplay", () => {
  const gemini = sizePresetItemsFor("gemini-2.5-flash-image", t);
  const gpt = sizePresetItemsFor("gpt-image-2", t);

  it("取值态翻转：比例为主、分辨率为弱化尾注", () => {
    expect(formatSizeDisplay("1024x1024", gpt)).toEqual({ main: "1:1", tail: "1024 × 1024" });
    expect(formatSizeDisplay("16:9", gemini)?.main).toBe("16:9");
    expect(formatSizeDisplay("16:9", gemini)?.tail).toContain("1536 × 864");
  });

  it("约前缀仅 gemini（approx）项携带", () => {
    expect(formatSizeDisplay("16:9", gemini)?.tail).toMatch(/^canvas\.genSizeApprox/);
    expect(formatSizeDisplay("1024x1024", gpt)?.tail).not.toContain("genSizeApprox");
  });

  it("旧混装清单像素存量在同清单内命中展示", () => {
    expect(formatSizeDisplay("768x1024", gemini)?.main).toBe("3:4");
    expect(formatSizeDisplay("2048x1152", gemini)?.tail).toBe("2048 × 1152");
  });

  it("旧像素值跨模型经 LEGACY 兜底仍以比例形态展示", () => {
    expect(formatSizeDisplay("1536x864", gpt)).toEqual({ main: "16:9", tail: "1536 × 864" });
    expect(formatSizeDisplay("1024x1024", gemini)?.main).toBe("1:1");
  });

  it("未命中预设的自定义值原样展示", () => {
    expect(formatSizeDisplay("999x999", gemini)).toEqual({ main: "999x999" });
  });

  it("auto 尾注为跟随模型提示", () => {
    expect(formatSizeDisplay("auto", gpt)).toEqual({ main: "auto", tail: "canvas.genSizeAutoHint" });
  });
});
