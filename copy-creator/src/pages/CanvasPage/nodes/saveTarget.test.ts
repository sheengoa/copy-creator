import { describe, expect, it } from "vitest";
import { flattenResourceGroups, saveBaseNameOf, saveDirFileNameOf, saveFingerprintOf } from "./saveTarget";

// 保存目标详情纯逻辑（2026-11-10 用户定案）：基名留空=产物原名；单张
// 直接用，多张按 -1/-2 展开；指定路径目标前端拼名；指纹含目标详情，
// 详情变更即重存；分组树拍平首行固定未分组、子级带深度。

describe("saveBaseNameOf", () => {
  it("空基名返回空串（Rust 端留空沿用产物原名）", () => {
    expect(saveBaseNameOf("", 1, 0)).toBe("");
    expect(saveBaseNameOf("   ", 3, 1)).toBe("");
  });

  it("单张直接用基名", () => {
    expect(saveBaseNameOf("产品截图", 1, 0)).toBe("产品截图");
  });

  it("多张按 基名-序号 展开（index 从 0 起）", () => {
    expect(saveBaseNameOf("产品截图", 3, 0)).toBe("产品截图-1");
    expect(saveBaseNameOf("产品截图", 3, 1)).toBe("产品截图-2");
    expect(saveBaseNameOf("产品截图", 3, 2)).toBe("产品截图-3");
  });
});

describe("saveDirFileNameOf", () => {
  it("空基名沿用产物原名", () => {
    expect(saveDirFileNameOf("C:/cache/canvas-gen/u-0.png", "", 1, 0)).toBe("u-0.png");
  });

  it("单张用基名替换主干，扩展名取源", () => {
    expect(saveDirFileNameOf("C:/cache/canvas-gen/u-0.png", "成片", 1, 0)).toBe("成片.png");
    expect(saveDirFileNameOf("D:/x/clip.mp4", "宣传片", 1, 0)).toBe("宣传片.mp4");
  });

  it("无扩展名产物不凭空加点", () => {
    expect(saveDirFileNameOf("C:/cache/rawfile", "报告", 1, 0)).toBe("报告");
  });

  it("多张按 基名-序号.扩展名 展开", () => {
    expect(saveDirFileNameOf("C:/c/a.png", "截图", 2, 0)).toBe("截图-1.png");
    expect(saveDirFileNameOf("C:/c/a.png", "截图", 2, 1)).toBe("截图-2.png");
  });
});

describe("saveFingerprintOf", () => {
  it("产物不变但分组/基名变更时指纹变化（触发重存）", () => {
    const paths = ["a.png"];
    const base = saveFingerprintOf(paths, "方案图", "截图");
    expect(base).toBe(saveFingerprintOf(paths, "方案图", "截图"));
    expect(base).not.toBe(saveFingerprintOf(paths, "未分组", "截图"));
    expect(base).not.toBe(saveFingerprintOf(paths, "方案图", ""));
    expect(base).not.toBe(saveFingerprintOf(["b.png"], "方案图", "截图"));
  });
});

describe("flattenResourceGroups", () => {
  it("首行固定未分组，分组取末级段名，子级深度递增", () => {
    const rows = flattenResourceGroups([
      {
        name: "",
        path: "",
        count: 3,
        children: [
          {
            name: "方案图",
            path: "方案图",
            count: 8,
            children: [{ name: "定稿", path: "方案图/定稿", count: 2, children: [] }],
          },
          { name: "参考素材", path: "参考素材", count: 5, children: [] },
        ],
      },
    ]);
    expect(rows).toEqual([
      { path: "", label: "", count: 3, depth: 0 },
      { path: "方案图", label: "方案图", count: 8, depth: 0 },
      { path: "方案图/定稿", label: "定稿", count: 2, depth: 1 },
      { path: "参考素材", label: "参考素材", count: 5, depth: 0 },
    ]);
  });
});
