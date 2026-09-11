// 架构守卫测试：把「领域规则必须全局共享」的约束固化为 CI 断言。
// 规则编号对应 DOMAIN_ARCHITECTURE_PLAN.md §5.2；失败信息指向 domain/README.md。
// 允许清单显式列出——新增例外必须修改本测试（= 强制过评审）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(frontRoot, "..", "..");
const readSource = (relative: string): string =>
  readFileSync(join(frontRoot, relative), "utf8");

// 递归收集目录下的 .ts/.tsx 源文件（相对 frontRoot，跳过测试与 node_modules）。
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSources(full, out);
    } else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const allSources = collectSources(join(frontRoot, "."));
const sourceOf = (absolute: string) => readFileSync(absolute, "utf8");

describe("架构守卫：领域规则必须全局共享", () => {
  it("规则 1：扩展名集合定义仅存在于生成物与显式豁免（语言特有清单）", () => {
    const offenders = allSources
      .filter((file) => !file.includes("domain/mediaTypes.generated.ts"))
      .filter((file) => !file.includes("domain/mediaKind.ts")) // DECODABLE 豁免
            .filter((file) => {
        const source = sourceOf(file);
        // 手写扩展名集合模式：new Set([  后跟引号包裹的扩展名字面量
        return /new Set\(\[\s*"[a-z0-9]{2,5}"/.test(source.replace(/\n/g, " "));
      });
    expect(
      offenders.map((file) => file.replace(frontRoot, "")),
      "发现手写扩展名集合，请改用 domain/mediaKind.ts 的共享集合（见 domain/README.md）",
    ).toEqual([]);
  });

  it("规则 2：convertFileSrc 仅出现在 domain/mediaUrl.ts 与过渡豁免", () => {
    const offenders = allSources
      .filter((file) => sourceOf(file).includes("convertFileSrc"))
            .map((file) => file.replace(frontRoot, ""));
    expect(offenders, "媒体地址解析必须走 domain/mediaUrl（见 domain/README.md）").toEqual([
      "/domain/mediaUrl.ts",
    ]);
  });

  it("规则 3：<video>/<audio> JSX 仅出现在共享媒体组件", () => {
    const offenders = allSources
      .filter((file) => file.endsWith(".tsx"))
      .filter((file) => /<video|<audio/.test(sourceOf(file)))
      .map((file) => file.replace(frontRoot, ""))
      .sort();
    expect(offenders, "视频/音频渲染必须复用 ResourceMediaPlayer/FileMediaVisual").toEqual([
      "/components/FileMediaPreview.tsx",
      "/pages/ResourcePage/ResourceMedia.tsx",
    ]);
  });

  it("规则 4：已切换的列表容器必须消费 domain", () => {
    // ResourcePage/ResourceDetailPage 的同款断言随阶段 2c 一并启用。
    for (const container of ["pages/ClipboardPage/index.tsx", "components/RadialMenu/index.tsx"]) {
      expect(readSource(container), `${container} 应 import domain`).toContain(
        'from "../../domain/',
      );
    }
  });

  it("规则 5：记录预览加载仅在 domain/preview.ts，旧入口零残留", () => {
    expect(readSource("domain/preview.ts")).toContain("export async function loadRecordPreviewSegments");
    const offenders = allSources
      .filter((file) => sourceOf(file).includes("loadClipboardPreviewSegments"))
                  .map((file) => file.replace(frontRoot, ""));
    expect(offenders, "旧预览入口已删除（见 domain/README.md）").toEqual([]);
  });

  it("规则 6：recordView 组装-only——不得新增业务判定", () => {
    const source = readSource("domain/recordView.ts");
    expect(source).not.toMatch(/record\.type\s*===/);
    expect(source).not.toMatch(/endsWith\(|startsWith\(/);
    expect(source).not.toMatch(/\.png"|\.jpg"|\.mp4"|\.mkv"/);
  });

  it("规则 7：生成物与 config/media-types.json 保持同步", () => {
    expect(() =>
      execSync("node scripts/generate-media-types.mjs --check", { cwd: repoRoot, stdio: "pipe" }),
    ).not.toThrow();
  });

  it("规则 8：Rust 扩展名判定仅存在于 media_kind.rs 与生成物", () => {
    const rustRoot = join(repoRoot, "copy-creator", "src-tauri", "src");
    const offenders = readdirSync(rustRoot)
      .filter((entry) => entry.endsWith(".rs"))
      .filter((entry) => !["media_kind.rs", "media_types_generated.rs"].includes(entry))
      .filter((entry) =>
        /ends_with\("\.[a-z]/i.test(readFileSync(join(rustRoot, entry), "utf8")))
      // .tmp 是应用内部临时后缀（§5.2 规则 8 豁免清单），非媒体扩展名
      .filter((entry) => !(entry === "db.rs" && !/ends_with\("\.(?!tmp")[a-z]/i.test(readFileSync(join(rustRoot, entry), "utf8"))));
    expect(
      offenders,
      "Rust 扩展名判定必须走 media_kind.rs（清单来自生成物，见 domain/README.md）",
    ).toEqual([]);
  });

  it("规则 9：resource-groups-changed 在 src 内恰好两处监听", () => {
    const listeners = allSources.filter((file) =>
      sourceOf(file).includes('listen("resource-groups-changed"'),
    );
    expect(listeners.length, "新增列表应复用既有刷新监听（见 domain/README.md）").toBe(2);
  });
});
