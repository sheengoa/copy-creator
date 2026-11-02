/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

/** 读 styles/ 下的单个样式文件。 */
function readStyle(name: string) {
  return readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8");
}

/** 递归收集目录（相对 styles/）下全部 .css 内容并拼接——canvas.css 等大
 *  文件拆成同名子目录后，隔离检测按目录聚合（类名集合不受切分影响）。 */
function readStyleDir(rel: string): string {
  const root = new URL(`../styles/${rel}/`, import.meta.url);
  let out = "";
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) out += readStyleDir(`${rel}/${entry.name}`);
    else if (entry.name.endsWith(".css")) out += readStyle(`${rel}/${entry.name}`);
  }
  return out;
}

/** styles/ 下所有全局样式文件（含子目录），返回相对 styles/ 的 posix 路径。 */
function allStyleFiles(): string[] {
  const walk = (rel: string): string[] => {
    const dir = new URL(`../styles/${rel}`, import.meta.url);
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(...walk(`${rel}${entry.name}/`));
      else if (entry.name.endsWith(".css")) out.push(`${rel}${entry.name}`);
    }
    return out;
  };
  return walk("");
}

/** 抽取 CSS 中行首类选择器名（与防冲突检测同口径，不含嵌套后代）。 */
function topLevelClassNames(css: string): Set<string> {
  return new Set(css.match(/^\.[a-z][a-z0-9-]*/gm) ?? []);
}

// 2026-11 事故防线：画布设置页空状态复用了无线画布页的 .canvas-empty，
// 而 canvas 样式的同名类带 position:absolute; inset:0（铺满画布区居中），
// 设置页空状态被劫持铺满全页、形成透明点击拦截层——进入画布分类后整个
// 设置页点不了，且空状态仅在渠道为空时渲染（mock 有种子数据，测试环境
// 从未触发）。此用例锁定：两份全局加载的样式不得再出现同名类。
describe("styles 全局类名隔离", () => {
  it("settings.css 与画布样式（canvas/）无同名类（canvas-empty 点击拦截事故防线）", () => {
    const settings = topLevelClassNames(readStyle("settings.css"));
    const canvas = topLevelClassNames(readStyleDir("canvas"));
    const shared = [...settings].filter((name) => canvas.has(name));
    expect(shared).toEqual([]);
  });

  it("ui.css 与其他全局样式文件无同名类（控件基准命名空间防线）", () => {
    // 2026-11 控件统一落位 styles/ui.css 后，基准类（ui-*）必须全仓唯一：
    // 任何全局样式与它同名都会按加载顺序静默覆盖基准样式。
    const ui = topLevelClassNames(readStyle("ui.css"));
    const others = allStyleFiles().filter((f) => f !== "ui.css");
    const shared = new Set<string>();
    for (const file of others) {
      for (const name of topLevelClassNames(readStyle(file))) {
        if (ui.has(name)) shared.add(name);
      }
    }
    expect(
      [...shared].sort(),
      "ui.css 基准类名必须全仓唯一，同名即被外层样式静默覆盖",
    ).toEqual([]);
  });
});
