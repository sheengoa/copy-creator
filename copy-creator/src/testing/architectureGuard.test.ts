// 架构守卫测试：把「领域规则必须全局共享」的约束固化为 CI 断言。
// 规则编号以本文件的守卫规则清单为准；约束说明见 src/domain/README.md。
// 允许清单显式列出——新增例外必须修改本测试（= 强制过评审）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

  it("规则 2：convertFileSrc 全仓禁止（asset 协议已停用，媒体走回环服务）", () => {
    const offenders = allSources
      .filter((file) => sourceOf(file).includes("convertFileSrc"))
            .map((file) => toPosix(file.replace(frontRoot, "")));
    expect(offenders, "asset 协议已在 tauri.conf.json 停用，媒体地址必须走 domain/mediaUrl 的回环媒体服务（见 domain/README.md）").toEqual([]);
  });

  it("规则 3：<video>/<audio> JSX 仅出现在共享媒体组件", () => {
    const offenders = allSources
      .filter((file) => file.endsWith(".tsx"))
      .filter((file) => /<video|<audio/.test(sourceOf(file)))
      .map((file) => toPosix(file.replace(frontRoot, "")))
      .sort();
    expect(offenders, "视频/音频渲染必须复用 VideoPoster/ResourceMediaPlayer/FileMediaVisual").toEqual([
      "/components/VideoPoster.tsx",
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

  it("规则 9：resource-groups-changed 在 src 内恰好三处监听", () => {
    const listeners = allSources.filter((file) =>
      sourceOf(file).includes('listen("resource-groups-changed"'),
    );
    expect(listeners.length, "新增列表应复用既有刷新监听（见 domain/README.md）").toBe(3);
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

  it("规则 16：记录类别过滤判定唯一来源——recordMatchesCategory 仅在 domain/records.ts", () => {
    // 回归锚点：收藏（favorites）上线时主窗口内联过滤改了，store 与
    // 径向菜单的两份内联副本漏改，径向菜单既无收藏入口也无收藏视图。
    // 判定收进 domain 后，任何新增类别只允许改 domain 一处。
    expect(
      readSource("domain/records.ts"),
      "recordMatchesCategory 必须定义在 domain/records.ts",
    ).toContain("export function recordMatchesCategory");
    const definitionFiles = allSources
      .filter((file) => !toPosix(file).includes("domain/records.ts"))
      .filter((file) => /function recordMatchesCategory|function matchesResourceGroup/.test(sourceOf(file)))
      .map((file) => toPosix(file.replace(frontRoot, "")));
    expect(
      definitionFiles,
      "类别/分组匹配判定不得在 domain 之外重写（见 domain/README.md）",
    ).toEqual([]);
    // 消费方必须经 domain 判定，不得内联「type === 类别」过滤副本。
    for (const consumer of [
      "pages/ClipboardPage/index.tsx",
      "components/RadialMenu/index.tsx",
      "stores/clipboardStore.ts",
    ]) {
      expect(
        readSource(consumer),
        `${consumer} 必须消费 domain 的 recordMatchesCategory`,
      ).toContain("recordMatchesCategory");
    }
    const inlineFilters = allSources
      .filter((file) => !toPosix(file).includes("domain/"))
      .filter((file) => /\.(type|category)\s*===\s*(category|clipboardCategory)\b/.test(sourceOf(file)))
      .map((file) => toPosix(file.replace(frontRoot, "")));
    expect(
      inlineFilters,
      "禁止内联「type === 类别」过滤副本——一律走 domain/records 的 recordMatchesCategory",
    ).toEqual([]);
    // 类别 chips 键序唯一来源：两处类别行都从 RECORD_CATEGORY_KEYS 映射。
    expect(readSource("pages/ClipboardPage/index.tsx"), "主窗口类别行应从 RECORD_CATEGORY_KEYS 映射").toContain("RECORD_CATEGORY_KEYS.map");
    expect(readSource("components/RadialMenu/index.tsx"), "径向菜单类别行应从 RECORD_CATEGORY_KEYS 映射").toContain("RECORD_CATEGORY_KEYS.map");
  });

  it("规则 17：径向条目动作按钮共享基类——按钮机制样式禁止复制", () => {
    // 回归锚点：收藏星标复制了预览按钮的 45 行机制样式却漏掉 svg 尺寸
    // 规则，首次渲染即巨型图标；随后又与预览按钮尺寸不一致。动作区
    // 按钮的盒子/显现/图标尺寸只允许在 .radial-menu-item-action 定义一次。
    const css = readSource("styles/radial-menu.css");
    expect(css, "共享基类 .radial-menu-item-action 必须存在").toContain(
      ".radial-menu-item-action",
    );
    const mechanismCopies = css.match(/transform: scale\(0\.78\)/g) ?? [];
    expect(
      mechanismCopies.length,
      "按钮显现机制（scale(0.78) 起点）只允许在共享基类定义一次",
    ).toBe(1);
    // 焦点环同属共享机制：随基类生效，不许某个按钮私有（曾漏掉导致
    // 星标没有 focus-visible 描边框而预览按钮有）。
    expect(
      css,
      "焦点环必须定义在共享基类上",
    ).toMatch(/\.radial-menu-item-action:focus-visible\s*\{/);
    expect(
      css,
      "焦点环不得再挂在单个按钮的修饰类上",
    ).not.toMatch(/\.radial-menu-(preview-trigger|item-pin):focus-visible/);
    const radialMenu = readSource("components/RadialMenu/index.tsx");
    expect(
      radialMenu,
      "预览按钮必须挂共享基类",
    ).toContain('className="radial-menu-item-action radial-menu-preview-trigger"');
    expect(
      radialMenu,
      "收藏星标必须挂共享基类",
    ).toContain("radial-menu-item-action radial-menu-item-pin");
  });
});
