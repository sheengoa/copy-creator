import { describe, expect, it } from "vitest";
import {
  assetKindLabelKey,
  characterAvatarInitial,
  characterAvatarPaletteIndex,
  characterSubtitle,
  episodeHasDoneMark,
  episodeNumberLabel,
  episodeStatusKey,
  joinLibraryPath,
  projectFileDisplayName,
  relativeLibraryPath,
  scriptFileLabel,
} from "./projectView";

describe("projectView 领域规则", () => {
  it("集状态映射 i18n 键，未知状态回退 none", () => {
    expect(episodeStatusKey("storyboard")).toBe("project.status.storyboard");
    expect(episodeStatusKey("unknown")).toBe("project.status.none");
  });

  it("已完成状态用勾选图标表达，不显示状态词", () => {
    expect(episodeHasDoneMark("done")).toBe(true);
    expect(episodeHasDoneMark("storyboard")).toBe(false);
  });

  it("集号两位补零", () => {
    expect(episodeNumberLabel(1)).toBe("01");
    expect(episodeNumberLabel(12)).toBe("12");
  });

  it("文件显示名：显式名优先，回退路径末段", () => {
    expect(projectFileDisplayName("S1-01", "第 2 集/分镜/S1-01.png")).toBe("S1-01");
    expect(projectFileDisplayName("", "第 2 集/分镜/S1-01.png")).toBe("S1-01.png");
    expect(projectFileDisplayName("", "")).toBe("");
  });

  it("剧本文件名取路径末段，空路径为空", () => {
    expect(scriptFileLabel("剧/02_灶王令失踪.md")).toBe("02_灶王令失踪.md");
    expect(scriptFileLabel("")).toBe("");
  });

  it("角色头像兜底字取首字符（多字节安全）", () => {
    expect(characterAvatarInitial("陆离")).toBe("陆");
    expect(characterAvatarInitial("Ada")).toBe("A");
    expect(characterAvatarInitial("")).toBe("?");
  });

  it("角色副文案拼接并省略空段", () => {
    expect(characterSubtitle("掌柜", "全局角色")).toBe("掌柜 · 全局角色");
    expect(characterSubtitle("掌柜", "")).toBe("掌柜");
    expect(characterSubtitle("", "")).toBe("");
  });

  it("头像配色索引稳定且在调色板范围内", () => {
    expect(characterAvatarPaletteIndex("陆离")).toBe(characterAvatarPaletteIndex("陆离"));
    for (const name of ["陆离", "阿椒", "貔貅", "Ada", "Zeta"]) {
      expect(characterAvatarPaletteIndex(name)).toBeLessThan(5);
    }
  });

  it("库根拼接归一斜杠与空值", () => {
    expect(joinLibraryPath("F:/lib", "剧/02.md")).toBe("F:/lib/剧/02.md");
    expect(joinLibraryPath("F:\\lib\\", "\\剧/02.md")).toBe("F:\\lib/剧/02.md");
    expect(joinLibraryPath("", "剧/02.md")).toBe("剧/02.md");
    expect(joinLibraryPath("F:/lib", "")).toBe("F:/lib");
  });

  it("绝对路径换算相对库根：库内归一、库外拒绝", () => {
    expect(relativeLibraryPath("F:/lib", "F:/lib/剧/02.md")).toBe("剧/02.md");
    // Windows 反斜杠与尾部斜杠的库根都要归一后比较。
    expect(relativeLibraryPath("F:/lib/", String.raw`F:\lib\剧\02.md`)).toBe("剧/02.md");
    expect(relativeLibraryPath("F:/lib", "F:/other/x.png")).toBe("");
    expect(relativeLibraryPath("", "F:/lib/x.png")).toBe("");
    // 与 joinLibraryPath 往返一致。
    expect(relativeLibraryPath("F:/lib", joinLibraryPath("F:/lib", "剧/02.md"))).toBe("剧/02.md");
  });

  it("素材类型键未知回退 file", () => {
    expect(assetKindLabelKey("image")).toBe("project.asset.kind.image");
    expect(assetKindLabelKey("prompt")).toBe("project.asset.kind.prompt");
    expect(assetKindLabelKey("weird")).toBe("project.asset.kind.file");
  });
});
