/// <reference types="node" />

// i18n 键完整性守卫：i18next 缺键不报错（渲染原始键名），测试与构建
// 都不会失败，只能靠源码文本断言兜住。负向断言里出现的键字符串都在
// *.test.ts 内，扫描时排除测试文件，避免把"已移除功能"的键当使用键。
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const zhCN = JSON.parse(readFileSync(path.join(srcDir, "i18n/zh-CN.json"), "utf8")) as unknown;
const en = JSON.parse(readFileSync(path.join(srcDir, "i18n/en.json"), "utf8")) as unknown;

function flatten(value: unknown, prefix = ""): string[] {
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      flatten(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
}

// 英文复数键（key_one/key_other）对 t(key, { count }) 是合法存在形式。
function hasKey(keys: Set<string>, key: string): boolean {
  return keys.has(key) || keys.has(`${key}_one`) || keys.has(`${key}_other`);
}

function stripPluralSuffix(key: string): string {
  return key.replace(/_(one|two|few|many|other|zero)$/, "");
}

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return collectSourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const usedKeys = new Set<string>();
for (const file of collectSourceFiles(srcDir)) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/[^a-zA-Z0-9_.]t\(\s*(?:"([^"]+)"|'([^']+)')/g)) {
    usedKeys.add(match[1] ?? match[2]);
  }
}

describe("i18n 键完整性守卫", () => {
  const zhKeys = new Set(flatten(zhCN));
  const enKeys = new Set(flatten(en));

  it("运行代码静态使用的 t() 键在 zh-CN 与 en 中都存在", () => {
    const missingZh = [...usedKeys].filter((key) => !hasKey(zhKeys, key));
    const missingEn = [...usedKeys].filter((key) => !hasKey(enKeys, key));
    expect(usedKeys.size, "扫描应覆盖到调用点（正则失效时守卫为空转）").toBeGreaterThan(100);
    expect(missingZh, "缺键会在界面裸显键名").toEqual([]);
    expect(missingEn).toEqual([]);
  });

  it("zh-CN 与 en 键集一致（仅允许英文复数后缀差异）", () => {
    const zhSet = new Set([...zhKeys].map(stripPluralSuffix));
    const enSet = new Set([...enKeys].map(stripPluralSuffix));
    const onlyZh = [...zhSet].filter((key) => !enSet.has(key));
    const onlyEn = [...enSet].filter((key) => !zhSet.has(key));
    expect(onlyZh).toEqual([]);
    expect(onlyEn).toEqual([]);
  });
});
