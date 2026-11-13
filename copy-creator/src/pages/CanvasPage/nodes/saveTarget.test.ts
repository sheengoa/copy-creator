import { describe, expect, it } from "vitest";
import {
  flattenResourceGroups,
  groupAncestors,
  isGroupRowVisible,
  saveBaseNameOf,
  savedFingerprintAfter,
  saveDirFileNameOf,
  saveFingerprintOf,
  searchGroupRows,
} from "./saveTarget";

// 保存目标详情纯逻辑（2026-11-10 用户定案）：基名留空=产物原名；单张
// 直接用，多张按 -1/-2 展开；指定路径目标前端拼名；指纹含目标详情，
// 详情变更即重存；分组树拍平首行固定未分组、子级带深度。
// 2026-11-14 用户定案（原型 specs/原型-保存目标面板.html）：折叠树默认
// 只列顶级分组、搜索平铺命中带父路径、保存成功清名指纹按空名对齐。

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

  it("空详情指纹与改版前 join 格式逐字一致（存量节点升级零重存）", () => {
    const paths = ["cache/gen/u1-0.png", "cache/gen/u1-1.png"];
    expect(saveFingerprintOf(paths, "", "")).toBe(paths.join("\n"));
    // 任一详情非空即走新格式（设详情仍触发重存）
    expect(saveFingerprintOf(paths, "", "截图")).not.toBe(paths.join("\n"));
    expect(saveFingerprintOf(paths, "方案图", "")).not.toBe(paths.join("\n"));
  });
});

describe("flattenResourceGroups", () => {
  it("首行固定未分组，分组取末级段名，子级深度递增，hasChildren 随子级", () => {
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
      { path: "", label: "", count: 3, depth: 0, hasChildren: true },
      { path: "方案图", label: "方案图", count: 8, depth: 0, hasChildren: true },
      { path: "方案图/定稿", label: "定稿", count: 2, depth: 1, hasChildren: false },
      { path: "参考素材", label: "参考素材", count: 5, depth: 0, hasChildren: false },
    ]);
  });
});

describe("isGroupRowVisible（折叠树可见性）", () => {
  const expanded = new Set(["素材库"]);
  it("未分组行与顶级分组恒可见", () => {
    expect(isGroupRowVisible("", expanded)).toBe(true);
    expect(isGroupRowVisible("素材库", expanded)).toBe(true);
    expect(isGroupRowVisible("客户项目", expanded)).toBe(true);
  });

  it("子级要求祖先段全部已展开：未展开链路不渲染，展开链路可见", () => {
    expect(isGroupRowVisible("素材库/人像", expanded)).toBe(true);
    expect(isGroupRowVisible("素材库/人像/商务", expanded)).toBe(false);
    expect(isGroupRowVisible("客户项目/律所A", expanded)).toBe(false);
  });
});

describe("groupAncestors（记忆链路展开）", () => {
  it("多级路径产出全部祖先段，顶级分组与未分组无祖先", () => {
    expect(groupAncestors("素材库/人像/商务")).toEqual(["素材库", "素材库/人像"]);
    expect(groupAncestors("方案图")).toEqual([]);
    expect(groupAncestors("")).toEqual([]);
  });
});

describe("searchGroupRows（搜索平铺命中）", () => {
  const rows = flattenResourceGroups([
    {
      name: "",
      path: "",
      count: 3,
      children: [
        {
          name: "素材库",
          path: "素材库",
          count: 20,
          children: [
            { name: "人像", path: "素材库/人像", count: 12, children: [
              { name: "商务", path: "素材库/人像/商务", count: 9, children: [] },
            ] },
            { name: "风景", path: "素材库/风景", count: 8, children: [] },
          ],
        },
        { name: "参考素材", path: "参考素材", count: 5, children: [] },
      ],
    },
  ]);

  it("末级段名命中：平铺返回树序，带父路径与计数（仅匹配末级段名）", () => {
    expect(searchGroupRows(rows, "商务")).toEqual([
      { path: "素材库/人像/商务", name: "商务", parent: "素材库/人像", count: 9 },
    ]);
    expect(searchGroupRows(rows, "人像")).toEqual([
      { path: "素材库/人像", name: "人像", parent: "素材库", count: 12 },
    ]);
  });

  it("不区分大小写；顶级分组命中父路径为空（显示层补库根）；子串命中各段名", () => {
    expect(searchGroupRows(rows, "素材")).toEqual([
      { path: "素材库", name: "素材库", parent: "", count: 20 },
      { path: "参考素材", name: "参考素材", parent: "", count: 5 },
    ]);
  });

  it("未分组行与空查询不参与搜索；无命中返回空", () => {
    expect(searchGroupRows(rows, "未分组")).toEqual([]);
    expect(searchGroupRows(rows, "")).toEqual([]);
    expect(searchGroupRows(rows, "不存在")).toEqual([]);
  });
});

describe("savedFingerprintAfter（保存成功清名后的指纹对齐）", () => {
  it("等于按空名计算的指纹：管线下一拍不再冗余重存", () => {
    const paths = ["a.png", "b.png"];
    expect(savedFingerprintAfter(paths, "方案图")).toBe(saveFingerprintOf(paths, "方案图", ""));
    expect(savedFingerprintAfter(paths, "")).toBe(saveFingerprintOf(paths, "", ""));
    // 双空走 join 格式兼容约定
    expect(savedFingerprintAfter(paths, "")).toBe(paths.join("\n"));
    // 与保存时（带名）指纹不同：清名本身不靠它触发重存（落库即对齐）
    expect(savedFingerprintAfter(paths, "方案图")).not.toBe(saveFingerprintOf(paths, "方案图", "旧名"));
  });
});
