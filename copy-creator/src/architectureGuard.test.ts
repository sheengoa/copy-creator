// 架构守卫测试：把「领域规则必须全局共享」的约束固化为 CI 断言。
// 规则本体见 domain/README.md；失败信息同样指向它。
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
// Windows 检出的路径是反斜杠：豁免匹配与期望值比较统一转 POSIX。
const toPosix = (path: string) => path.replace(/\\/g, "/");

describe("架构守卫：领域规则必须全局共享", () => {
  it("规则 1：扩展名集合定义仅存在于生成物与显式豁免（语言特有清单）", () => {
    const offenders = allSources
      .filter((file) => !toPosix(file).includes("domain/mediaTypes.generated.ts"))
      .filter((file) => !toPosix(file).includes("domain/mediaKind.ts")) // DECODABLE 豁免
            .filter((file) => {
        const source = sourceOf(file);
        // 手写扩展名集合模式：new Set([  后跟引号包裹的扩展名字面量
        return /new Set\(\[\s*"[a-z0-9]{2,5}"/.test(source.replace(/\n/g, " "));
      });
    expect(
      offenders.map((file) => toPosix(file.replace(frontRoot, ""))),
      "发现手写扩展名集合，请改用 domain/mediaKind.ts 的共享集合（见 domain/README.md）",
    ).toEqual([]);
  });

  it("规则 2：convertFileSrc 仅出现在 domain/mediaUrl.ts 与过渡豁免", () => {
    const offenders = allSources
      .filter((file) => sourceOf(file).includes("convertFileSrc"))
            .map((file) => toPosix(file.replace(frontRoot, "")));
    expect(offenders, "媒体地址解析必须走 domain/mediaUrl（见 domain/README.md）").toEqual([
      "/domain/mediaUrl.ts",
    ]);
  });

  it("规则 3：<video>/<audio> JSX 仅出现在共享媒体组件", () => {
    const offenders = allSources
      .filter((file) => file.endsWith(".tsx"))
      .filter((file) => /<video|<audio/.test(sourceOf(file)))
      .map((file) => toPosix(file.replace(frontRoot, "")))
      .sort();
    expect(offenders, "视频/音频渲染必须复用 ResourceMediaPlayer/FileMediaVisual").toEqual([
      "/components/FileMediaPreview.tsx",
      "/pages/ResourcePage/ResourceMedia.tsx",
    ]);
  });

  it("规则 4：已切换的列表容器必须消费 domain", () => {
    // ResourcePage/ResourceDetailPage 的同款断言随阶段 2c 一并启用。
    for (const container of [
      "pages/ClipboardPage/index.tsx",
      "components/RadialMenu/index.tsx",
      "pages/ResourcePage.tsx",
    ]) {
      expect(readSource(container), `${container} 应 import domain`).toContain(
        '/domain/',
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

  it("规则 10：分组树折叠展平仅在 domain/groups.ts 定义", () => {
    expect(readSource("domain/groups.ts")).toContain(
      "export function flattenResourceFoldersVisible",
    );
    const offenders = allSources
      .filter((file) => !toPosix(file).includes("domain/groups.ts"))
      .filter((file) =>
        /function flattenResourceFoldersVisible|const walk = \(folders/.test(sourceOf(file)))
      .map((file) => toPosix(file.replace(frontRoot, "")));
    expect(
      offenders,
      "按折叠集合展平分组树必须复用 domain/groups.ts，禁止页面手写 walk（见 domain/README.md）",
    ).toEqual([]);
  });

  it("规则 11：主窗口展开媒体容器必须放开限高（防卡内滚动裁切回归）", () => {
    // 展开图/视频自身上限（480px/330px）曾高于容器滚动上限（320px），
    // 媒体被裁切、必须卡内滑动才能看全；剪切板与短语两份样式同规同源，缺一不可。
    for (const cssFile of ["styles/clipboard.css", "styles/phrases.css"]) {
      expect(
        readSource(cssFile),
        `${cssFile} 缺少 is-media-expanded 放开规则：展开媒体容器不得保留 320px 滚动上限`,
      ).toMatch(/\.is-expanded\.is-media-expanded\s*\{[^}]*max-height:\s*none[^}]*overflow-y:\s*visible/s);
    }
    expect(
      readSource("pages/ClipboardPage/ClipboardCard.tsx"),
      "剪切板卡片展开媒体（图片/视频）时必须输出 is-media-expanded（判定读 domain 字段 expandPreview）",
    ).toContain('view.expandPreview === "image" || view.expandPreview === "video"');
    expect(
      readSource("pages/PhrasePage/PhraseList.tsx"),
      "短语卡片展开图片时必须输出 is-media-expanded",
    ).toContain('isTextExpanded && imageFile ? " is-media-expanded"');
  });

  it("规则 12：卡内展开必须经共享 useExpandReveal 完整滚入可视区", () => {
    // 展开内容超出列表可视区时必须自动滚动展示完全；逻辑集中在共享 hook
    // （最小滚动 + 媒体异步加载后的高度校正），新增可展开列表同样必须复用。
    expect(
      readSource("hooks/useExpandReveal.ts"),
      "展开揭示必须集中在共享 hook：手动定位滚动容器并写 scrollTop（不依赖 scrollIntoView smooth，WebKitGTK 上不生效）",
    ).toContain("findScrollParent");
    for (const cardFile of [
      "pages/ClipboardPage/ClipboardCard.tsx",
      "pages/PhrasePage/PhraseList.tsx",
    ]) {
      expect(
        readSource(cardFile),
        `${cardFile} 展开时必须消费 useExpandReveal，禁止手写滚动或遗漏`,
      ).toContain("useExpandReveal");
    }
  });

  it("规则 13：图片列表态一律全宽媒体横幅，横幅原图直出不走缩略图管线", () => {
    // 同一张图片曾因进入方式不同（图片数据 vs 图片文件）呈现缩略图/全宽横幅
    // 两副面孔；统一为横幅形态并固化在共享组件 FileMediaVisual。
    // 横幅可视数量少，直接流式原图保证清晰度；256px 缩略图仅限密集网格卡片。
    expect(
      readSource("components/FileMediaPreview.tsx"),
      "FileMediaVisual 必须保留图片横幅分支（图片列表态统一全宽横幅，见组件注释）",
    ).toContain('kind === "image"');
    expect(
      readSource("components/FileMediaPreview.tsx"),
      "横幅必须原图直出（ResourceImage），不得回退 256px 缩略图管线导致拉伸模糊",
    ).toContain("<ResourceImage");
    expect(
      readSource("components/FileMediaPreview.tsx"),
      "横幅禁止使用小网格缩略图组件 ResourceFileImage",
    ).not.toContain("<ResourceFileImage");
    expect(
      readSource("pages/ClipboardPage/ClipboardCard.tsx"),
      "剪切板图片记录折叠态必须用 FileMediaVisual 横幅，不得回退 48×36 小缩略图",
    ).toContain("<FileMediaVisual path={view.content} />");
  });

  it("规则 14：可展开卡片展开态点击必须收起，不得落回粘贴", () => {
    // 展开内容是大面积点击热区，点击冒泡到根元素的粘贴动作会写入剪贴板、
    // 失焦隐藏窗口并按「最近使用」重排（用户实测卡片「跑到最上面」）。
    // 两处可展开卡片（剪切板/快捷输入）都必须在根元素拦截：展开态点击
    // 一律收起，且放行拖选文本结束的 click（selection 为 Range）。
    for (const cardFile of [
      "pages/ClipboardPage/ClipboardCard.tsx",
      "pages/PhrasePage/PhraseList.tsx",
    ]) {
      const source = readSource(cardFile);
      expect(
        source,
        `${cardFile} 根元素必须用 handleCardClick 统一处理点击（展开态收起/收起态粘贴）`,
      ).toContain("onClick={handleCardClick}");
      expect(
        source,
        `${cardFile} 展开态收起必须放行拖选文本（selection.type === "Range" 不收起）`,
      ).toContain('selection.type === "Range"');
    }
  });

  it("规则 15：预览 segments 与方向/宽度契约仅在 domain/preview.ts，utils 旧副本零残留", () => {
    expect(readSource("domain/preview.ts")).toContain("export function buildRadialPreviewSegments");
    const offenders = allSources
      .filter((file) => sourceOf(file).includes("utils/radialPreview"))
      .map((file) => toPosix(file.replace(frontRoot, "")));
    expect(
      offenders,
      "预览 segments 与展开方向/宽度契约必须从 domain/preview 导入（见 domain/README.md）",
    ).toEqual([]);
  });

  it("规则 16：共享记录视图的全局重载必须经 domain/viewOwnership 归属判定", () => {
    // 剪切板页与资源页常挂载且共用 clipboardStore，全局事件（窗口恢复显示、
    // resource-groups-changed、共享搜索词防抖）会同时唤醒两页回调；不设防的
    // 一方经加载代数「后写者赢」抢占视图，剪切板页把资源记录过滤后显示
    // 「暂无剪切板记录」（2026-09 空列表根因，此前五次修复均未建立归属
    // 规则而反复复发）。两页的全部全局重载路径必须逐点接入归属判定。
    expect(readSource("domain/viewOwnership.ts")).toContain(
      "export function mayReloadSharedRecordsView",
    );
    const redefiners = allSources
      .filter((file) => !toPosix(file).includes("domain/viewOwnership.ts"))
      .filter((file) => /function mayReloadSharedRecordsView/.test(sourceOf(file)))
      .map((file) => toPosix(file.replace(frontRoot, "")));
    expect(
      redefiners,
      "共享视图归属判定只能在 domain/viewOwnership 定义（见 domain/README.md）",
    ).toEqual([]);
    // 剪切板页两处：窗口恢复显示重申视图 + 共享搜索词防抖。
    const clipboardGuards = (
      readSource("pages/ClipboardPage/index.tsx").match(/mayReloadSharedRecordsView\(/g) ?? []
    ).length;
    expect(
      clipboardGuards,
      "ClipboardPage 的重申视图与搜索防抖重载必须经 mayReloadSharedRecordsView 归属判定",
    ).toBeGreaterThanOrEqual(2);
    // 资源页三处：resource-groups-changed 监听 + 窗口恢复显示兜底 + 共享搜索词防抖。
    const resourceGuards = (
      readSource("pages/ResourcePage.tsx").match(/mayReloadSharedRecordsView\(/g) ?? []
    ).length;
    expect(
      resourceGuards,
      "ResourcePage 的变更监听、恢复显示兜底与搜索防抖重载必须经 mayReloadSharedRecordsView 归属判定",
    ).toBeGreaterThanOrEqual(3);
  });
});
