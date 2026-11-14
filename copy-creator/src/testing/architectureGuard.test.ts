// 架构守卫测试：把「领域规则必须全局共享」的约束固化为 CI 断言。
// 规则编号以本文件的守卫规则清单为准；约束说明见 src/domain/README.md。
// 允许清单显式列出——新增例外必须修改本测试（= 强制过评审）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// 生成物媒体清单（规则 1 的命中判定基准，与 config/media-types.json 同源）。
import {
  IMAGE_EXTENSIONS as IMAGE_EXTENSIONS_LIST,
  VIDEO_EXTENSIONS as VIDEO_EXTENSIONS_LIST,
  AUDIO_EXTENSIONS as AUDIO_EXTENSIONS_LIST,
} from "../domain/mediaTypes.generated";

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
    // 数组形态也在射程内（此前只认 new Set([ 形态，画布 exts.ts 的数组
    // 字面量曾从缝隙里重建第二份扩展名知识）：数组内 ≥2 个元素命中生成
    // 物媒体扩展名即判手写清单——阈值与媒体域限定避免误伤普通字符串
    // 数组（["int","ext","both"]、["voice","bgm","sfx"] 等不含媒体扩展）。
    // TEXT 扩展名不参与命中（"ts"/"js" 类短码与普通数组碰撞面太大）。
    const knownMediaExts = new Set([
      ...IMAGE_EXTENSIONS_LIST,
      ...VIDEO_EXTENSIONS_LIST,
      ...AUDIO_EXTENSIONS_LIST,
    ]);
    const offenders = allSources
      .filter((file) => !toPosix(file).includes("domain/mediaTypes.generated.ts"))
      .filter((file) => !toPosix(file).includes("domain/mediaKind.ts")) // DECODABLE 豁免
      .filter((file) => !toPosix(file).includes("pages/CanvasPage/nodes/exts.ts")) // WebView 播放能力白名单豁免
      .flatMap((file) => {
        const source = sourceOf(file);
        return Array.from(
          source.matchAll(/\[\s*("[a-z0-9]{1,8}"(?:\s*,\s*"[a-z0-9]{1,8}")+)\s*,?\s*\]/g),
        ).filter((m) => {
          const items = Array.from(m[1].matchAll(/"([a-z0-9]{1,8})"/g), (x) => x[1]);
          return items.filter((ext) => knownMediaExts.has(ext)).length >= 2;
        }).map(() => toPosix(file.replace(frontRoot, "")));
      });
    expect(
      offenders,
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
    expect(offenders, "视频/音频渲染必须复用 VideoPoster/ResourceMediaPlayer/FileMediaVisual/MediaPlayback").toEqual([
      "/components/MediaPlayback.tsx",
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
    // 递归收集：db/、ai/ 等子目录的域模块同样受约束（此前只扫顶层，
    // 子目录完全在守卫之外；豁免引用的 db.rs 顶层不存在——真身是
    // db/mod.rs 的 .tmp 临时后缀——该豁免分支从未生效过）。
    const rustFiles: string[] = [];
    const walkRs = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walkRs(full);
        } else if (entry.endsWith(".rs")) {
          rustFiles.push(full);
        }
      }
    };
    walkRs(rustRoot);
    const offenders = rustFiles
      .filter((file) => !file.endsWith("media_kind.rs") && !file.endsWith("media_types_generated.rs"))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        // .tmp 是应用内部临时后缀（§5.2 规则 8 豁免清单），非媒体扩展名
        return Array.from(source.matchAll(/ends_with\("(\.[a-z][a-z0-9]*)"/gi))
          .filter((m) => m[1].toLowerCase() !== ".tmp")
          .map(() => toPosix(file.replace(repoRoot, "")));
      });
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

  it("规则 11：主窗口详情复用资源库详情页（record 形态隐藏资源特有件）", () => {
    // 用户定案（2026-11-14）：主窗口纯展示预览、粘贴只在径向菜单，点击
    // 卡片进入资源库同款详情视图——组件本体复用（ResourceDetailPage 的
    // record 形态），资源特有件（备注/重命名/版本记录/标注/文件内联编辑）
    // 必须经 hideResourceOps 收敛，禁止复制一份详情页。
    const detail = readSource("pages/ResourcePage/ResourceDetailPage.tsx");
    expect(
      detail,
      "编辑目标形态分派：资源形态编辑文件，record 形态经 onSaveContent 编辑记录正文（双击进编辑，无弹窗）",
    ).toMatch(/const contentEditable = !record\.has_images\s*&& fullTextContent !== null[\s\S]*&& \(hideResourceOps\s*\? onSaveContent !== undefined && recordTextEditable\(record\)\s*: Boolean\(textEditPath\)\)/);
    expect(
      detail,
      "record 形态必须隐藏备注编辑块",
    ).toContain('{!hideResourceOps && (');
    expect(
      detail,
      "record 形态必须隐藏文本标注与版本记录",
    ).toContain("&& !hideResourceOps;");
    for (const page of ["pages/ClipboardPage/index.tsx", "pages/PhrasePage/index.tsx"]) {
      expect(
        readSource(page),
        `${page} 详情必须复用 ResourceDetailPage（record 形态），禁止私有详情实现`,
      ).toContain("hideResourceOps");
    }
    for (const cardFile of ["pages/ClipboardPage/ClipboardCard.tsx", "pages/PhrasePage/PhraseList.tsx"]) {
      expect(
        readSource(cardFile),
        `${cardFile} 卡片内不得再有展开体系残留（is-media-expanded/useExpandReveal）`,
      ).not.toMatch(/useExpandReveal|is-media-expanded/);
    }
  });

  it("规则 12：卡内展开体系退役——展开揭示 hook 零残留", () => {
    // 展开体系随卡片化整体退役（useExpandReveal hook 已删除）：若未来
    // 重新引入可展开列表，必须恢复「揭示滚动集中共享 hook」的约束并
    // 复活本规则，禁止手写 scrollTop 定位（WebKitGTK smooth 失效教训）。
    const offenders = allSources.filter((file) => sourceOf(file).includes("useExpandReveal"));
    expect(
      offenders,
      "useExpandReveal 已随卡内展开退役，全仓零残留（复活前先恢复共享 hook）",
    ).toEqual([]);
  });

  it("规则 13：密集网格卡片图片一律 256px 缩略图管线，横幅仅剩径向菜单消费", () => {
    // 图片曾因进入方式不同（图片数据 vs 图片文件）呈现缩略图/全宽横幅
    // 两副面孔。卡片化后剪切板/快捷输入/资源三页都是密集网格，卡片图
    // 一律走 ResourceFileImage 缩略图管线（LRU + inView 懒加载）；全宽
    // 横幅（原图直出）仅剩径向菜单条目一个消费方，固化在 FileMediaVisual。
    expect(
      readSource("components/FileMediaPreview.tsx"),
      "FileMediaVisual 必须保留图片横幅分支（径向菜单图片条目统一全宽横幅）",
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
      readSource("components/CardVisual.tsx"),
      "三页共用卡片预览的图片分支必须走 ResourceFileImage 缩略图管线",
    ).toContain("<ResourceFileImage");
    expect(
      readSource("components/CardVisual.tsx"),
      "卡片图片必须携带文件版本（mediaVersion），覆盖保存后 WebView 不再命中旧缓存",
    ).toContain("version={view.mediaVersion ?? undefined}");
  });

  it("规则 14：卡片点击一律查看内容，粘贴不得挂在卡片根元素", () => {
    // 历史教训（保留）：点击冒泡到根元素的粘贴动作会写入剪贴板、失焦
    // 隐藏窗口并按「最近使用」重排（用户实测卡片「跑到最上面」）。
    // 卡片化后卡片根的点击语义只有一个：打开内容查看弹窗（onOpenView），
    // 粘贴只能出现在查看弹窗操作行与 ⋯菜单里。
    for (const cardFile of [
      "pages/ClipboardPage/ClipboardCard.tsx",
      "pages/PhrasePage/PhraseList.tsx",
    ]) {
      const source = readSource(cardFile);
      expect(
        source,
        `${cardFile} 卡片根点击必须调用 onOpenView（查看内容）`,
      ).toContain("onOpenView(");
      expect(
        source,
        `${cardFile} 禁止在卡片根元素直接触发粘贴（写入剪切板 + 失焦隐藏 + 重排三重副作用）`,
      ).not.toMatch(/onClick=\{[^}]*onPaste(Normal)?\(view\)/);
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
    // hover 底色同属共享机制：曾漏掉导致星标 hover 无底色反馈而预览
    // 按钮有。
    expect(
      css,
      "径向动作按钮的 hover 底色必须定义在共享基类上",
    ).toMatch(/\.radial-menu-item \.radial-menu-item-action:hover\s*\{[^}]*background:\s*var\(--chip-hover-bg\)/);
    const radialMenu = readSource("components/RadialMenu/index.tsx");
    // 动作区唯一出口是 RadialItemAction 组件（基类挂载 + 冒泡拦截不可
    // 遗漏）：动作区块内禁止裸 <button>，两个既有按钮必须经组件渲染。
    const actionsStart = radialMenu.indexOf('className="radial-menu-item-actions"');
    const actionsBlock = radialMenu.slice(
      actionsStart,
      radialMenu.indexOf("</div>", actionsStart),
    );
    expect(
      actionsBlock,
      "径向动作区必须存在",
    ).not.toBe("");
    expect(
      actionsBlock.includes("<button"),
      "径向动作区禁止裸写 <button>——一律经 RadialItemAction 渲染（基类挂载与冒泡拦截不可遗漏）",
    ).toBe(false);
    expect(
      (actionsBlock.match(/<RadialItemAction/g) ?? []).length,
      "动作区按钮必须经 RadialItemAction 渲染",
    ).toBeGreaterThanOrEqual(2);
    expect(
      radialMenu.includes("radial-menu-item-action radial-menu-item-pin"),
      "星标基类必须由组件出口统一挂载，调用点只传修饰类",
    ).toBe(false);
  });

  it("规则 18：卡片动作收敛进「⋯」菜单——卡片根禁止 hover 动作按钮组回潮", () => {
    // 卡片化定案（2026-11-14）：剪切板/快捷输入卡片对齐资源卡范式，操作
    // 全部收进右上「⋯」菜单（CardActionMenu portal）与右键菜单，原列表
    // 形态的 hover 显隐动作按钮组（card-toggle-text-btn/card-pin-btn/
    // card-edit-btn/card-delete-btn）退役。card-*-btn 类仅剩分组管理
    // 对话框行内按钮一个消费方（ManageGroupsDialog）。
    for (const cardFile of ["pages/ClipboardPage/ClipboardCard.tsx", "pages/PhrasePage/PhraseList.tsx"]) {
      const source = readSource(cardFile);
      expect(
        source,
        `${cardFile} 必须经共享 CardMoreTrigger 渲染「⋯」菜单按钮（实现收口在 CardShell）`,
      ).toContain("<CardMoreTrigger");
      expect(
        source,
        `${cardFile} 菜单必须经共享 CardActionMenu 渲染（portal 定位，防卡片 transform 裁剪）`,
      ).toContain("<CardActionMenu");
      expect(
        (source.match(/className="card-[a-z-]+-btn"/g) ?? []),
        `${cardFile} 卡片根禁止回潮 hover 动作按钮组（操作收敛进菜单）`,
      ).toEqual([]);
    }
  });

  it("规则 19：资源文本预览必须消费 textPreviewPath 判定字段，禁止按 type 自行判定", () => {
    // 回归锚点：详情页编辑保存会把记录 type 从 file 转为 text（content 存
    // 全文、resource_path 不变）。资源卡与径向条目曾各自以 type === "file"
    // 判定是否读文件预览，编辑过的 .txt 由此退化为 180 字摘要。取材判定
    // 唯一来源是 domain/records 的 resourceTextPreviewPath（经 RecordView
    // 的 textPreviewPath 暴露），消费方只允许读该字段。
    const card = readSource("components/CardVisual.tsx");
    expect(
      card.includes("view.textPreviewPath"),
      "三页共用卡片预览的文本分支必须消费 view.textPreviewPath 判定字段",
    ).toBe(true);
    expect(
      card.includes('view.recordType === "file" && view.resourcePath'),
      "卡片预览禁止以 recordType === \"file\" 自行判定文本预览取材（编辑后 type 已是 text）",
    ).toBe(false);
    expect(
      readSource("pages/ResourcePage/ResourceCard.tsx"),
      "资源卡必须经共享 CardVisual 渲染预览分支（禁止私有文本预览副本）",
    ).toContain("<CardVisual");
    const radialItem = readSource("components/RadialMenu/ResourceItemVisual.tsx");
    expect(
      radialItem.includes("item.textPreviewPath"),
      "径向条目文本预览分支必须消费 item.textPreviewPath 判定字段",
    ).toBe(true);
    expect(
      radialItem.includes('item.type === "file" && item.resourcePath'),
      "径向条目禁止以 type === \"file\" 自行判定文本预览取材",
    ).toBe(false);
    // 取材同源约束：详情页的正文展示、编辑底稿与编辑目标，径向菜单的预览
    // 面板与文件拖出，都不得按 record type 分叉——编辑过的记录 type 已是
    // text，按 type 判定必然取到过期副本或丢失文件语义。
    const detail = readSource("pages/ResourcePage/ResourceDetailPage.tsx");
    expect(
      detail.includes("resourceTextPreviewPath"),
      "详情页文本展示与编辑目标必须经 domain resourceTextPreviewPath 取材",
    ).toBe(true);
    const radialContainer = readSource("components/RadialMenu/index.tsx");
    expect(
      radialContainer.includes("item.textPreviewPath"),
      "径向菜单预览面板与文件拖出必须消费 textPreviewPath 判定字段",
    ).toBe(true);
    expect(
      radialContainer.includes("TEXT_EXTENSIONS.has"),
      "径向菜单禁止在容器内按扩展名自行判定文本取材（判定收口在 domain）",
    ).toBe(false);
  });

  it("规则 20：后端保存错误结构知识唯一源——界面禁止散落匹配错误文案", () => {
    // 回归锚点：保存资源重名时后端返回「已存在同名文件：xxx」，新建窗口
    // 曾把它吞成「保存失败，请重试」，用户重试永远失败。可行动错误（重名/
    // 分组失效/命名非法）必须经共享解析器转译后提示；错误文案的结构知识
    // 只允许存在于 utils/resourceSaveError.ts，防止各界面复制粘贴 startsWith。
    const parser = readSource("utils/resourceSaveError.ts");
    expect(
      parser.includes("已存在同名文件") && parser.includes("资源分组不存在"),
      "保存错误解析器必须维护后端错误文案契约（与 src-tauri 测试锁定文案一致）",
    ).toBe(true);
    const offenders = allSources
      .filter((file) => !toPosix(file).endsWith("/utils/resourceSaveError.ts"))
      .filter((file) => /已存在同名文件|资源分组不存在/.test(sourceOf(file)));
    expect(
      offenders.map(toPosix),
      "保存错误文案匹配只允许出现在 utils/resourceSaveError.ts，界面一律 import parseResourceSaveError",
    ).toEqual([]);
    const createDialog = readSource("components/ClipboardCreateDialog/index.tsx");
    expect(
      createDialog.includes("parseResourceSaveError"),
      "新建窗口保存失败必须经共享解析器区分可行动错误，禁止一律回退泛化「请重试」",
    ).toBe(true);
  });

  it("规则 21：列表滚动停留位置必须抗后台整窗替换（滚动锚点）", () => {
    // 回归锚点：径向窗口常驻，「记住浏览位置」依赖列表 DOM 不重建；但
    // records 会被后台事件整窗替换——资源「全部」视图按最近使用排序，
    // 任意窗口粘贴/收藏都会把条目搬到列表顶部，资源目录增删会在视口
    // 上方插拔行，WebKitGTK 无 scroll anchoring，停留内容随之位移，曾
    // 表现为资源区滚动位置偶发重置。捕获/恢复逻辑唯一来源
    // utils/scrollAnchor.ts，径向列表必须消费；主窗口资源页同类保护
    // （pendingScrollTopRef 像素兜底）不得移除。
    const anchorUtil = readSource("utils/scrollAnchor.ts");
    expect(
      anchorUtil.includes("captureListScrollAnchor")
        && anchorUtil.includes("applyListScrollAnchor"),
      "滚动锚点捕获/恢复逻辑必须集中在 utils/scrollAnchor.ts",
    ).toBe(true);
    const radial = readSource("components/RadialMenu/index.tsx");
    expect(
      radial.includes("applyListScrollAnchor") && radial.includes("captureListScrollAnchor"),
      "径向列表必须在 items 更新后恢复同视图滚动停留位置（后台重排不得顶走视口）",
    ).toBe(true);
    const resourcePage = readSource("pages/ResourcePage.tsx");
    expect(
      resourcePage.includes("pendingScrollTopRef"),
      "主窗口资源页的滚动位置保持机制不得移除",
    ).toBe(true);
  });

  it("规则 22：设置页静态说明必须用行尾 InfoTip，禁止可见 hint 元素回归", () => {
    // 回归锚点：设置页随功能增长不断堆积可见长注释（settings-row-hint /
    // settings-storage-hint），纵向噪声膨胀后统一收进行尾 InfoTip 悬停
    // 气泡（components/ui/InfoTip.tsx）。此后设置组件里「整段内容
    // 恰为一条 *Hint 文案」的静态 hint 元素一律禁止；操作反馈（进度、
    // 重启提示）、动作流内警告与安装命令等可操作/动态信息不受限。
    const settingsDir = join(frontRoot, "components/settings");
    const offenders: string[] = [];
    for (const entry of readdirSync(settingsDir)) {
      if (!entry.endsWith(".tsx")) continue;
      const source = readFileSync(join(settingsDir, entry), "utf8");
      const matches =
        source.match(
          /settings-(?:row|storage)-hint"[^>]*>\{t\("settings\.[A-Za-z]+Hint"\)\}/g,
        ) ?? [];
      offenders.push(...matches.map(() => `${entry}: ${matches.length} 处`));
    }
    expect(
      offenders,
      '设置页静态说明必须改为行尾 <InfoTip text={t("…Hint")} />（悬停展示），不得新增可见 hint 元素',
    ).toEqual([]);
  });

  it("规则 23：缺失文件的追溯入口必须同时存在于列表卡片与详情页，判定一律读 resourceMissing", () => {
    // 「A 界面有、B 界面没有」防回退：缺失记录的手动追溯出口曾只在列表
    // 规划，详情页断头（点开详情后无路可走）。两个入口必须共存，且都以
    // RecordView/记录的 resourceMissing 事实字段为显隐与复制置灰依据，
    // 禁止在叶子内自行 stat 或另立判定。
    const card = readSource("pages/ResourcePage/ResourceCard.tsx");
    expect(
      card.includes("onTrace"),
      "资源卡片必须提供 onTrace 追溯入口（缺失记录的菜单项）",
    ).toBe(true);
    expect(
      card.includes("view.resourceMissing && onTrace"),
      "卡片追溯入口必须以 view.resourceMissing 为显隐条件",
    ).toBe(true);
    expect(
      card.includes("disabled={view.resourceMissing}"),
      "卡片「复制」必须随缺失置灰（文件不在，复制必然失败）",
    ).toBe(true);
    const detail = readSource("pages/ResourcePage/ResourceDetailPage.tsx");
    expect(
      detail.includes("onTrace"),
      "详情页必须提供 onTrace 追溯入口（缺失记录断头回退防线）",
    ).toBe(true);
    expect(
      detail.includes("record.resource_missing && onTrace"),
      "详情页追溯入口必须以 resource_missing 为显隐条件",
    ).toBe(true);
    expect(
      detail.includes("disabled={Boolean(record.resource_missing)}"),
      "详情页「复制」必须随缺失置灰",
    ).toBe(true);
  });

  it("规则 24：CSS 生成内容（字面量 content）不得与 JSX 文本重复渲染", () => {
    // 事故锚点：警示圆点的「!」由 ::before 绘制，JSX 又写了文本节点，
    // 两个符号叠渲染、第二个被挤出 16px 圆框换行悬挂（用户实测）。
    // 本规则静态扫描全部样式表的字面量 content（"" 装饰与 attr() 机制
    // 不在此列），禁止对应类名的 JSX 开标签后紧跟同字面量文本。
    const offenders: string[] = [];
    const stylesDir = join(frontRoot, "styles");
    const cssLiteralContents: Array<{ cls: string; literal: string; cssFile: string }> = [];
    // 递归收集：canvas.css/project.css 拆成同名子目录后仍全覆盖。
    const walkCss = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walkCss(full);
        } else if (entry.endsWith(".css")) {
          const css = readFileSync(full, "utf8");
          const rule = /\.([a-zA-Z0-9_-]+)(?:::before|::after)[^{]*\{[^}]*content:\s*"([^"]+)"/g;
          for (const match of css.matchAll(rule)) {
            cssLiteralContents.push({
              cls: match[1],
              literal: match[2],
              cssFile: toPosix(full).replace(toPosix(stylesDir) + "/", ""),
            });
          }
        }
      }
    };
    walkCss(stylesDir);
    expect(
      cssLiteralContents.length,
      "下方断言依赖字面量 content 清单；删除生成内容时请同步清理本规则",
    ).toBeGreaterThan(0);

    for (const { cls, literal, cssFile } of cssLiteralContents) {
      for (const source of allSources) {
        const text = sourceOf(source);
        const pattern = new RegExp(
          `className="[^"]*\\b${cls}\\b[^"]*"[^>]*>\\s*${literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        );
        if (pattern.test(text)) {
          offenders.push(`${toPosix(source)}: 类 .${cls} 的 "${literal}" 已由 ${cssFile} ::before/::after 生成`);
        }
      }
    }
    expect(
      offenders,
      "CSS ::before/::after 已生成该符号，JSX 不得再写同字面量文本（重复渲染且溢出容器）",
    ).toEqual([]);
  });

  it("规则 25：设置页控件必须走 ui/ 基准——禁止原生 select/checkbox 开关与退役控件类回归", () => {
    // 2026-11 控件统一：开关/分段/下拉/按钮/滑杆/提示收敛到 components/ui
    // 与 styles/ui.css（基准规则见其 README）。此前设置域并存 3 种开关、
    // 2 种下拉、4 套分段与 10+ 种按钮类（历史映射见 ui/README.md），此
    // 规则锁定它们不再回来：新控件只能复用基准组件与 ui-* 类。
    const settingsDir = join(frontRoot, "components/settings");
    const targets = [
      join(frontRoot, "components/SettingsContent.tsx"),
      ...readdirSync(settingsDir)
        .filter((entry) => entry.endsWith(".tsx"))
        .map((entry) => join(settingsDir, entry)),
    ];
    // canvas-slider 为前缀的布局类（-row/-cap/-mid/-val）仍在使用：
    // 否定前瞻只拦裸的滑杆控件类，不误伤布局类。
    const retiredPatterns: [RegExp, string][] = [
      [/<select[\s>]/, "原生 <select>（应换 IosSelect）"],
      [/type="checkbox"/, "原生 checkbox 开关（应换 Toggle）"],
      [
        /\b(?:toggle-switch|toggle-thumb|canvas-switch|canvas-pills|canvas-pill|lang-toggle|settings-btn-soft|settings-btn-danger|settings-btn-raised|settings-storage-btn|shortcut-record-btn|radial-scale-reset|radial-scale-slider|settings-shortcut-error|canvas-form-error|canvas-row-sub|canvas-sec-note|settings-info-tip)\b/,
        "退役控件类",
      ],
      [/canvas-slider(?![-\w])/, "退役滑杆类 canvas-slider（应换 .ui-slider）"],
    ];
    const offenders: string[] = [];
    for (const file of targets) {
      const source = readFileSync(file, "utf8");
      for (const [pattern, label] of retiredPatterns) {
        if (pattern.test(source)) {
          offenders.push(`${toPosix(file)}: ${label}`);
        }
      }
    }
    expect(
      offenders,
      "设置页控件必须复用 ui/ 基准组件（Toggle/Segmented/IosSelect）与 ui-* 类，禁止原生 select/checkbox 开关与退役类名回归",
    ).toEqual([]);
  });

  it("规则 26：确认弹窗文案两段式——主句单句问号，补充细节拆 *Hint 键走 hint 小字", () => {
    // 事故锚点：资源删除确认「确定将此资源移入回收站吗？保留 30 天，可随时
    // 恢复。」在 300px 弹窗里折行（用户 2026-11-01 定案：主句一行，补充说明
    // 降级 ConfirmDialog 的 hint 10px 小字，约定见 components/ui/README.md
    // 「确认弹窗」）。本规则扫中英两个语言包：键名含 confirm/prompt（Hint
    // 键除外）的文案，问号不得与句号/分号/换行同串——混排即主句+补充未拆。
    const offenders: string[] = [];
    for (const locale of ["zh-CN.json", "en.json"]) {
      const flatten = (obj: unknown, path: string, out: [string, string][]): [string, string][] => {
        if (obj && typeof obj === "object") {
          for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
            if (typeof value === "string") out.push([path + key, value]);
            else flatten(value, `${path}${key}.`, out);
          }
        }
        return out;
      };
      const entries = flatten(JSON.parse(readSource(join("i18n", locale))), "", []);
      for (const [key, value] of entries) {
        if (/hint/i.test(key) || !/(confirm|prompt)/i.test(key)) continue;
        const hasQuestion = /[?？]/.test(value);
        // 中文以全角句读为句界（file.txt 这类半角缩写不误伤）；英文句界 =
        // 句点/分号后跟大写句首，或句读收尾（"e.g. file" 小写续写不算）。
        const hasSentenceBreak = locale === "zh-CN.json"
          ? /[。；]/.test(value)
          : /[.;]\s+[A-Z]/.test(value) || /[.;]\s*$/.test(value);
        if (hasQuestion && hasSentenceBreak) {
          offenders.push(`i18n/${locale} ${key} = ${value}`);
        }
      }
    }
    expect(
      offenders,
      "确认弹窗主句必须是单句问句：补充细节拆到同名 *ConfirmHint 键，经 ConfirmDialog 的 hint 小字展示（components/ui/README.md「确认弹窗」）",
    ).toEqual([]);
  });

  it("规则 27：画布域源文件行数上限 1000（防大文件回潮）", () => {
    // 画布域全套：页面组合层、节点基座、引擎 hooks、渲染 layers、样式
    // 切片与测试。上限 1000 为硬上限（目标 700-800）；新增例外必须修改
    // 本清单（= 强制过评审）。
    // 路径相对 frontRoot（= src/）：walk 用 join(frontRoot, dir) 解析。
    const limits: Array<[string, number]> = [
      ["pages/CanvasPage", 1000],
      ["styles/canvas", 1000],
      ["styles/project", 1000],
      ["dev/mock", 1000],
      ["dev/tauriMock.ts", 1000],
    ];
    const offenders: string[] = [];
    const checkFile = (rel: string, abs: string, limit: number) => {
      const isStyle = rel.endsWith(".css");
      const isTest = rel.endsWith(".test.ts") || rel.endsWith(".test.tsx");
      if (!rel.endsWith(".ts") && !rel.endsWith(".tsx") && !isStyle) return;
      if (isTest) return;
      const lines = readFileSync(abs, "utf8").split("\n").length;
      if (lines > limit) offenders.push(`${rel} = ${lines} 行`);
    };
    const walk = (dir: string, limit: number) => {
      const full = join(frontRoot, dir);
      // dir 允许直接指到文件（如 dev/tauriMock.ts）：此前对文件 readdirSync
      // 抛 ENOTDIR 被 catch 静默吞掉，limits 里的文件条目永不生效（空转，
      // tauriMock.ts 曾超限而测试全绿）。
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        return; // 路径不存在（如前端仓单独检出）
      }
      if (!stat.isDirectory()) {
        checkFile(dir, full, limit);
        return;
      }
      let entries: string[];
      try {
        entries = readdirSync(full);
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = `${dir}/${entry}`;
        const abs = join(frontRoot, rel);
        if (statSync(abs).isDirectory()) {
          walk(rel, limit);
          continue;
        }
        checkFile(rel, abs, limit);
      }
    };
    for (const [dir, limit] of limits) walk(dir, limit);
    // Rust 画布域：ai/ 与 db/canvas/ 目录下全部 .rs（含未来新增子模块）。
    for (const dir of ["src-tauri/src/ai", "src-tauri/src/db/canvas"]) {
      let files: string[] = [];
      try {
        files = readdirSync(join(repoRoot, "copy-creator", dir))
          .filter((name) => name.endsWith(".rs"))
          .map((name) => `${dir}/${name}`);
      } catch {
        // 前端仓单独检出时跳过。
      }
      for (const rel of files) {
        const lines = readFileSync(join(repoRoot, "copy-creator", rel), "utf8").split("\n").length;
        if (lines > 1000) offenders.push(`${rel} = ${lines} 行`);
      }
    }
    expect(offenders, "画布域文件不得超过 1000 行（拆分目标 700-800）：超限文件继续按既有模式拆 engine/layers 子模块").toEqual([]);
  });

  it("规则 28：命令面三方对齐——前端 invoke 与 mock case 必须落在 lib.rs 注册清单内", () => {
    // 回归锚点：project_set_episode_props 实现与前端调用俱全却漏在
    // generate_handler! 清单外，真实环境 unknown command 被 catch 吞成
    // console.error 静默失效（mock 有实现，开发态测不出）。注册清单是
    // 命令面的唯一事实源：前端 invoke 字面量与 tauriMock case 都必须
    // 落在其中，改名漂移（如 get_stash_images→get_stash_record_images）
    // 在哪一侧发生都当场红。反向（注册但前端未用=死命令）属清理策略，
    // 不在本规则。
    const libRs = readFileSync(join(repoRoot, "copy-creator", "src-tauri", "src", "lib.rs"), "utf8");
    const start = libRs.indexOf("generate_handler!");
    const end = libRs.indexOf("])", start);
    expect(start, "lib.rs 应包含 generate_handler! 注册清单").toBeGreaterThan(-1);
    const block = libRs.slice(start, end);
    // 条目形如 `db::project_set_episode_output,` 或裸 `toggle_always_on_top,`
    // ——取逗号前的末段标识符（标识符首字符后可含数字，如 get_image_base64）。
    const registered = new Set(
      Array.from(block.matchAll(/([a-z_][a-z0-9_]*)\s*,/g), (m) => m[1]),
    );
    expect(registered.size, "generate_handler! 清单应解析出命令集合").toBeGreaterThan(150);

    const missing = (name: string, file: string) =>
      `invoke("${name}") 未注册 @ ${toPosix(file.replace(frontRoot, ""))}`;
    const invokeOffenders: string[] = [];
    for (const file of allSources) {
      const source = sourceOf(file);
      // invoke 支持泛型（invoke<string>(...)），命令名必须是字符串字面量。
      for (const m of source.matchAll(/invoke(?:<[^>(]*>)?\(\s*"([a-z0-9_]+)"/g)) {
        if (!registered.has(m[1])) invokeOffenders.push(missing(m[1], file));
      }
    }
    expect(invokeOffenders, "前端 invoke 了未注册命令（真实环境 unknown command）").toEqual([]);

    const mockSource = readSource("dev/tauriMock.ts");
    const mockOffenders = Array.from(mockSource.matchAll(/case "([a-z0-9_]+)"/g))
      .filter((m) => !registered.has(m[1]))
      .map((m) => `mock case "${m[1]}" 未注册（后端不存在或已改名，浏览器模式静默走兜底）`);
    expect(mockOffenders, "tauriMock 覆盖了不存在的命令").toEqual([]);
  });

  it("规则 29：domain 层禁止依赖 stores——依赖方向必须自上而下", () => {
    // 回归锚点：projectView.ts 曾 import type projectStore 的
    // ProjectEpisodeStatus（2026-11-14 归位：类型上移 domain，store 反向
    // 取）。domain 是被 stores/pages/components 消费的唯一事实源，反向
    // 依赖会让领域规则跟着数据层漂移；import type 同拦（类型依赖也是
    // 依赖，且正是实际发生过的形态）。
    const offenders = allSources
      .filter((file) => toPosix(file).includes("/domain/"))
      .filter((file) => /from\s+"[^"]*\/stores\/[^"]*"/.test(sourceOf(file)))
      .map((file) => toPosix(file.replace(frontRoot, "")));
    expect(
      offenders,
      "domain 不得 import stores（依赖方向自上而下）：类型上移 domain，store 反向 import",
    ).toEqual([]);
  });
});
