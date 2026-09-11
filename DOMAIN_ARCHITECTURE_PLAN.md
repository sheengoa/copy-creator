# Copy Creator 领域层架构方案（杜绝功能逻辑局部实现）

状态：已定稿，作为执行基线（v6 + 复审通过：独立审查 pass-with-notes，8 条 notes 已全部清零——见 §10）
制定日期：2026-09-12
前置条件：并行的功能优化进程收尾提交后执行；执行前需 rebase 并重跑 §8 审计对齐最新代码

---

## 1. 问题定义与证据

近期反复出现同一类缺陷：**同一条领域规则在三处界面各写各的，或只在其中一处存在**。实例：

| 缺陷 | 分裂点 |
|:---|:---|
| 径向菜单点击视频只显示路径文本 | `ContentPreviewPanel` 早已支持视频播放器，但数据层 `loadClipboardPreviewSegments` 的文件分支只处理图片/文本，视频落到"路径文本"兜底 |
| 主窗口视频卡片没有展开预览按钮 | `ClipboardCard` 的 `canPreviewFile` 只认文本扩展名，与预览数据层各判各的 |
| 复制图片文件被静默丢弃（>3MB） | `clipboard.rs` 采集端局部策略，导入失败既不降级也不报错 |
| 复制的文件路径带 `\r` 导致粘贴/拖出/导入全坏 | arboard 解析缺陷 + 采集入口无统一清洗 |
| 媒体视觉（封面帧）只加了个别界面 | `FileMediaVisual` 上线时只接了 2 处，径向菜单资源 tab 仍是图标占位 |

**扩展名集合现存三份独立定义**（已漂移风险最高的点）：
- TS：`src/pages/ResourcePage/resourceUtils.ts`（IMAGE/VIDEO/AUDIO/TEXT/DECODABLE_IMAGE_EXTENSIONS）
- Rust：`src-tauri/src/clipboard.rs`（`is_previewable_image_file` / `is_image_file`）
- Rust：`src-tauri/src/db.rs`（`is_resource_image_extension` / `is_resource_video_extension` / `is_resource_audio_extension`，供 `resource_media_kind_for_path`）

**根因**（不是纪律问题，是架构问题）：
1. 领域规则（"这条记录是什么、能做什么"）没有归属地，散落在 UI 组件里，谁用谁写一份；
2. 共享函数是"可选项"而非"唯一通道"，绕过它编译器不报错；
3. 没有任何强制机制，靠人（和 AI 执行者）记住——已证明拦不住。

## 2. 目标架构

```
┌─────────────────────────────────────────────────────┐
│ UI 层（三个独立 React root：主窗口 App / 径向菜单 /   │
│ 新建窗口 ClipboardCreateDialog）                      │
│ 只做布局与交互，零领域判断                            │
└──────────────┬──────────────────────────────────────┘
               │ 只能消费（eslint + 架构测试强制）
┌──────────────▼──────────────────────────────────────┐
│ 视图模型层  domain/recordView.ts                     │
│ 只组装：调用 domain 判定函数 → RecordView            │
│ （契约：不得新增业务判定，见 §3.7）                   │
├─────────────────────────────────────────────────────┤
│ 领域层（全项目唯一事实源）                            │
│  mediaKind.ts   记录/文件是什么类型（判定函数；扩展名  │
│                 集合引用生成物，见 §5.3）              │
│  records.ts     记录语义（资源记录/文件承载文本/       │
│                 expandable 等能力判定纯函数）          │
│  preview.ts     预览 segments 怎么生成                │
│  mediaUrl.ts    本地路径 → 可显示/可播放 URL 唯一出口  │
│  fileName.ts    文件名/扩展名/重命名规则               │
│  groups.ts      资源分组树规则                        │
├─────────────────────────────────────────────────────┤
│ 单一配置  config/media-types.json                     │
│  共享扩展名清单唯一源 → 生成器产出 TS/Rust 两份代码    │
├─────────────────────────────────────────────────────┤
│ 后端  src-tauri/src/media_kind.rs                    │
│  Rust 侧类型判定唯一模块（清单引用生成物）             │
└─────────────────────────────────────────────────────┘
```

核心原则：
- **规则只有一个家**：每条领域规则恰好定义在 domain（TS）或 media_kind.rs（Rust）的一处；
- **边界画死在类型系统里**：叶子展示组件的 props 合同是 `RecordView` 而非 `ClipboardRecord`（§3.10）——组件拿不到原始记录，领域判定在编译期不可表达；事实字段允许渲染分支（样式/布局），残余的非法判定模式（扩展名推断等）由守卫扫描兜底（§5.2 规则 10）；
- **依赖方向单向**：domain 禁止 import stores/UI（数据操作在 domain 内直接封装或经容器注入）；叶子组件禁止 import stores（数据只从 props 进）——依赖只能"UI → domain"，禁止反向与跳跃（§5.2 规则 12）；
- **显示差异用展示参数表达**：窗口间的显示差异（如径向菜单窄屏下正文截断 300 字）必须是渲染层参数，不得实现为不同的领域规则——一条规则 + N 组参数，而不是 N 条规则。`displayName` 收口时径向的截断改为渲染参数；
- **旧的门必须焊死**：旧共享函数不留 re-export（编译器逼出所有调用点），eslint 禁止 UI 层使用领域出口（`convertFileSrc`、媒体类 `invoke`）；
- **事实与能力分层**：后端下发"存储事实"（`resource_kind` 等），前端 domain 判定"UI 能力"（能否预览、怎么显示、怎么粘贴）——两层职责不混；
- **漂移会被 CI 抓住**：守卫测试跑在**每次 push/PR** 上（§5.4），不是只挂在发布构建上；扩展名清单由单一配置生成，一致性由构造保证；
- **守卫是活的**：每次出现"这有那没有"缺陷，必须把根因规则收进 domain 并在守卫测试补一条对应模式（§3.9 闭环流程）。

## 3. 领域层模块设计

### 3.1 domain/mediaKind.ts（类型判定）
从 `resourceUtils.ts` 迁入：`ResourceMediaKind`/`ResourceTypeFilter` 类型、`getResourceExtension`、`inferResourceMediaKind`、`fileMediaKindFromPath`、`matchesResourceType`。
从 `utils/inlinePreview.ts` 迁入判定部分：`hasInlineTextPreviewExtension` → 更名 `isTextPreviewableFile`（渲染相关的 `shouldShowInlineTextToggle` 并入 domain/records.ts 的能力判定）。
**扩展名集合不在本文件手写**：由 §5.3 的单一配置生成（`mediaTypes.generated.ts`），本文件引用生成物构建 Set 与判定函数。语言特有清单（如 TS 的 `DECODABLE_IMAGE_EXTENSIONS` 浏览器解码能力）不属共享配置，留在本文件并注释说明归属。

### 3.2 domain/records.ts（记录语义）
迁入 `isResourceRecord`、`isFileBackedTextResource`（实测位于 `src/utils/clipboardRecord.ts`，v5 引用有误已修正），以及 **v6 补全归属**的三个共享判定：`getResourceTitle`（文件名/正文首行/占位符的标题规则，含截断）、`getResourcePath`（记录本地路径解析）、`getResourceSummary`（摘要展示规则）——三者现散在 resourceUtils.ts 且被资源页与 clipboardStore 双侧消费，是真正的领域判定，对应 RecordView 的 `title`/`resourcePath`。`matchesResourceType` 归 §3.1 mediaKind（类型判定谓词），此处不重复收。

### 3.3 domain/mediaUrl.ts（URL 解析唯一出口）
迁入 `resolveAbsoluteResourcePath`、`resolveResourceAssetUrl`、`resolveResourceMediaUrl` 及其私有依赖（`isAbsoluteLocalPath`、`stripWindowsPathPrefix`、storage path / media server 缓存与对应 `invoke`）。全项目所有媒体地址必须经此模块，`convertFileSrc` 不允许出现在其他任何文件。

### 3.4 domain/preview.ts（预览 segments）
迁入 `utils/contentPreview.ts` 全部（签名升级为 `loadRecordPreviewSegments(view)`）与 `utils/radialPreview.ts` 中的 `buildRadialPreviewSegments`、`RadialPreviewSegment` 类型、`isContentPreviewAvailable`；`radialPreview.ts` 保留窗口几何计算（UI 层职责）。
**去 store 化**：现实现内部依赖 `useClipboardStore.getState().getRecordContent()`——domain import UI 状态层是分层倒置。已核实其实现（`getFullContent`，clipboardStore.ts:227）仅两行直通：非截断记录直接返回 content，截断记录 invoke `get_clipboard_record_content`，**无缓存语义**——可安全下沉，直接封装于 `domain/preview.ts`，切断对 store 的依赖；domain 全域禁止 import `stores/*`（§5.2 规则 12）。

### 3.5 domain/fileName.ts（文件名规则）
合并 `utils/fileName.ts` 的 `fileNameFromPath` 与 resourceUtils 的 `getResourceFileName`（当前是两套 basename 实现，属重复实现）；同时迁入 `splitResourceFileName`、`hasCustomResourceFileName`、`isResourceTitleRenameable`。

### 3.6 domain/groups.ts（分组树）
迁入 `flattenResourceFolders`、`flattenResourceFolderPaths`、`findResourceFolder`、`isResourceFolderPath`、`formatResourceFolderPath`、`getResourceFolderSiblings`、`reorderResourceFolderSiblings`、`getResourceFolderRoot`（径向菜单同样消费，是共享领域而非资源页私有）。

### 3.7 domain/recordView.ts（视图模型，新增核心）

**判定封闭契约**（v6 升级，修正 v3"数据封闭"的设计缺陷）：

RecordView 字段分两组，封闭的对象是**判定**而非**数据**：
- **事实字段**（记录的原始事实，透传供展示与操作传参）：叶子可读，但只允许做**渲染分支**（样式/布局，如 `recordType === "link"` 加样式类），禁止做**领域判定**（扩展名推断、媒体类型判定、能力推断——这些必须读判定字段）；
- **判定字段**（领域规则的结果）：叶子只读不猜，"这条记录是什么/能做什么"一律以判定字段为准。

守卫扫描的正是非法判定模式（扩展名字面量、`endsWith/startsWith` 推断、对判定字段的重新推导），条件渲染不在禁止之列。此契约由三窗口叶子组件的字段级需求盘点定稿（v6，见 §10）：事实字段以源码实测为准，新增事实字段须在 PR 说明消费方。

```ts
export type ExpandPreviewKind = "video" | "audio" | "image" | "text" | null;
export type PasteStrategy = "text" | "file" | "stash";

export interface RecordView {
  // —— 事实字段（透传：展示与操作传参；禁止派生领域判定）——
  id: string;
  recordType: ClipboardRecord["type"];  // 原始类型（含 link——kind 将 link 折叠进 text，样式区分靠它）
  createdAt: string;
  content: string;                      // 原始载荷（文本正文/路径/图片相对路径）
  contentTruncated: boolean;            // 后端截断标记
  hasImages: boolean;                   // 暂存图文记录的图片附件标记
  sourceApp: string;                    // 来源应用（资源卡来源行）
  useCount: number;                     // 使用次数（次数徽标）
  // —— 判定字段（domain 规则结果，叶子只读不猜）——
  kind: ResourceMediaKind;              // 统一内容类型（text/image/video/audio/file；link 折叠为 text）
  fileMediaKind: "video" | "audio" | "image" | null;  // file 记录的媒体细分
  isResource: boolean;
  isFileBackedText: boolean;
  expandable: boolean;                  // 能否展开/预览
  expandPreview: ExpandPreviewKind;     // 展开后渲染什么
  pasteStrategy: PasteStrategy;         // 粘贴路由描述（执行仍在 clipboardStore.pasteRecord）
  dragPath: string | null;              // 拖出路径
  resourcePath: string | null;          // 预览/播放用的本地路径
  displayName: string;                  // 条目显示文本（三窗口统一规则）
  displayTruncated: boolean;            // displayName 是否被截断（渲染参数所致，区别于 contentTruncated）
  title: string;                        // 标题（资源标题或文件名）
  // —— API Key 场景（isApiKey 为 true 时有值）——
  apiKey?: {
    preview: string;
    guessedService: string | null;
    label: ApiKeyLabel | null;
    userMarked: boolean;                // 用户已标记（右键"取消标记"菜单的依据）
  };
}

export function buildRecordView(
  record: ClipboardRecord,
  options?: { displayNameTruncateAt?: number },  // 渲染参数经容器注入（如径向菜单 300 字截断）
): RecordView;
```

preview 函数签名同步升级：`loadClipboardPreviewSegments(record)` → `loadRecordPreviewSegments(view)`——其所需 type/content/hasImages/id 均为 view 的事实字段，**v3-v5 的白名单缺口由此解除**（独立审查发现的架构级缺陷）。

### 3.8 resourceUtils.ts 收缩
仅保留资源页专属展示辅助：`formatResourceFileSize`、`formatResourceDuration`、`formatResourceBitrate`、`computeResourceColumnCount`、`splitResourceColumns`、`FlattenedResourceFolder` 等 UI 工具。**不 re-export domain 的任何符号**——这是编译器强制的核心。

### 3.9 domain/README.md（防膨胀的归属决策表 + 守卫闭环流程）
domain 按职责拆分（3.1–3.7 七个模块），防"大泥球"的机制是**新规则归属决策表**，随 README 提交：
- 判定"某内容是什么类型/能做什么" → `mediaKind.ts` / `records.ts`
- 判定"预览长什么样" → `preview.ts`；"地址怎么解析" → `mediaUrl.ts`；"文件名怎么处理" → `fileName.ts`；"分组怎么组织" → `groups.ts`
- UI 布局与交互永远不进 domain；recordView 只组装（§3.7 契约）
- 拆分触发条件：单一文件出现第二个不相关主题、或超过约 400 行时必须拆出新模块
- 稳定 API 原则：对外只暴露领域函数与类型；辅助函数不导出（TS 已保证未导出符号不可 import）。当前 7 模块规模不引入 barrel/internal 封装机制（过度工程）；升级路径：若未来出现跨主题混杂，再引入 `internal/` 目录约定并配 eslint 禁止深导入规则。

**守卫教学式报错**：架构测试失败信息必须直接指出"该把逻辑放哪、参见 domain/README.md 哪一节"——守卫不只是拦截，更是对后续执行者（人与 AI）的教育。

**缺陷 → 守卫闭环**：今后每次出现"功能在某界面有、另一界面没有"或"重复实现"类缺陷，修复时必须：① 把根因规则收进 domain；② 若守卫清单尚不能拦住该模式，在 `architectureGuard.test.ts` 补一条对应断言。该流程写入 domain/README.md，使守卫清单随缺陷持续生长，而不是一次性交付物。

### 3.10 UI 合同：容器/叶子分层（props 收 RecordView）

UI 分成两层，边界由 TypeScript 强制：

- **容器层**（`ClipboardPage/index.tsx`、`ResourcePage.tsx`、`RadialMenu/index.tsx` 的列表组装处）：持有 `ClipboardRecord[]`，调用 `buildRecordView` 生成 view 数组，向下传递；同时承载 store 动作回调（`onDelete(id)`、`onPaste(view)` 等以 id/view 为参数）。
- **准容器层**（`ResourceDetailPage.tsx`、`ImageThumb.tsx`）：承载编辑能力（重命名、备注、分组移动等数据操作）或数据访问（缩略图缓存），允许访问 stores；其**视觉与类型判定**仍一律走 view/domain，不得自行判定（v5 修正：v3 误将 ResourceDetailPage 列入叶子——编辑操作经 props 逐层透传会把容器签名撑爆，归类准容器是能力与纯度的正确平衡；v6 补列 ImageThumb）。
- **叶子层**（`ClipboardCard.tsx`、`ResourceCard.tsx`、径向条目渲染）：**props 只收 `RecordView`（记录条目）**；判定一律读判定字段，基于事实字段做渲染分支（样式/布局）合法；不得 import `ClipboardRecord` 类型、`stores/*`，不得调用 `buildRecordView`、`invoke`——由架构测试断言（§5.2 规则 10）。**2b 须将径向菜单的条目渲染从 `RadialMenu/index.tsx`（2000+ 行容器）抽为独立叶子文件**（如 `RadialRecordItem.tsx`）——否则规则 10 对径向要么空转、要么立即红（独立审查发现的落地缺口）。
- **径向菜单条目为联合类型**（v5 修正，v6 补第三变体）：短语不纳入 view（§9），故 `type RadialItem = RecordRadialItem | PhraseRadialItem | DividerRadialItem`——前者 `RecordView & { sourceLabel?: string; resourceSummary?: string }`（resourceSummary 由容器调 domain/records.ts 计算后并入），短语条目维持现有结构（`imagePath` 等字段），分隔条（"未使用分区"，现有 `isDivider` 伪条目）为第三变体；`usedAtLabel`/`useCount`/`dragKind`/`dragSource` 等现有字段并入 RecordRadialItem（useCount 等已入事实字段）。

三窗口落到 view 后只剩纯投影：
- 主窗口 `ClipboardCard`：显示 `view.displayName`，展开按钮 `view.expandable`，展开内容按 `view.expandPreview` 分发到 `ResourceMediaPlayer` / `InlineImagePreview` / `InlineTextFilePreview`；
- 径向菜单：`RadialItem` 字段全部来自 view，`previewAvailable` = `view.expandable`，媒体视觉走 `FileMediaVisual`；
- 资源页 `ResourceCard` / `ResourceDetailPage`：`view.kind` / `view.fileMediaKind` 驱动视觉与详情。

**数据获取同步收编**（两步走，见 §5.1）：叶子与容器层现存的直接 `invoke`（预览、缩略图、打开文件等）全部收进 stores 动作或 domain 模块；收编完成后 eslint 将 `invoke` 禁令从"命令清单"升级为"目录级"（仅 `stores/`、`domain/` 可用）。

**叶子层禁 import stores**（v4 补，堵白名单封闭的最大绕过通道）：`useClipboardStore` 等是全局可达的——叶子组件若能 `useClipboardStore((s) => s.records)`，就能绕过 props 合同直接拿原始记录，RecordView 封闭形同虚设。因此叶子层文件禁止 import 任何 `stores/*`（数据一律从 props 进、动作一律经容器回调出），列入 §5.2 规则 10 扫描清单。现 ClipboardCard 内的 `getRecordContent`/`loadRecords` 等调用在 2a 子提交中上移到容器。

**性能约定**：容器以 `useMemo(() => records.map(buildRecordView), [records])` 构建视图数组，view 引用稳定性依赖 zustand 不可变更新的引用纪律（现有 store 已满足）——避免 props 合同切换后 view 新引用导致整列表 memo 失效、拖拽/缩略图全量重渲染。

## 4. Rust 侧收口

新增 `src-tauri/src/media_kind.rs`：
- `pub enum MediaKind { Image, Video, Audio, Text, File }` + `pub fn media_kind_for_path(path: &Path) -> MediaKind`；
- 图/视/音/文扩展名常量引用生成物（`media_types.generated.rs`，含 `IMPORTABLE_IMAGE_EXTENSIONS`——`is_image_file` 的后继，Rust 侧消费位置）；`is_probably_text_file` 迁入；
- `is_previewable_image_extension`（jpg/jpeg/png 预览导入子集，引用生成物 `PREVIEWABLE_IMAGE_EXTENSIONS`，属业务策略，随迁）与 `IMAGE_PREVIEW_MAX_BYTES`。

改造：
- `clipboard.rs`：删除 `is_previewable_image_file`/`is_image_file`，分别改引 `media_kind::is_previewable_image_extension` 与 `IMPORTABLE_IMAGE_EXTENSIONS`（行为严格等价：导入集语义不变，仅集合定义来源收口）；
- `db.rs`：删除 `is_resource_*_extension`，`resource_media_kind_for_path` 变为 `media_kind::media_kind_for_path` 的字符串映射薄层（对外 JSON 字段名不变）；
- 现有单测随迁，`sanitize_clipboard_file_paths` 等清洗逻辑保持并补断言。

## 5. 强制守卫（"彻底杜绝"的机制保证）

### 5.1 ESLint（编辑器即时标红）
在 `eslint.config.js`：
1. `no-restricted-imports`：`@tauri-apps/api/core` 的 `convertFileSrc` 具名禁用；`src/domain/**` override 豁免；
2. `no-restricted-syntax`：UI 源码禁用媒体/预览/存储类 `invoke` 命令（`read_clipboard_text_preview`、`read_resource_text_preview`、`read_text_file_content`、`get_image_thumbnail`、`get_resource_file_thumbnail`、`get_media_server_origin`、`get_storage_path`、`open_resource_file`），esquery 按 `CallExpression[callee.name='invoke'][arguments.0.value=/…/]` 匹配；`src/domain/**` 豁免；
3. `invoke` 收编两步走（§3.10）：本期完成媒体/预览/存储命令收编后，下一步把 UI 层剩余 `invoke`（如窗口控制以外的数据操作）收进 stores 动作，随后将禁令升级为目录级——仅 `stores/`、`domain/` 允许 `invoke`，`components/`、`pages/` 全禁。

### 5.2 vitest 架构守卫测试（`src/architectureGuard.test.ts`）
静态扫描源码，断言（允许清单显式列出，新增例外必须改测试 = 强制过一遍评审；失败信息教学式，指向 domain/README.md 对应章节）：
1. 扩展名集合定义仅存在于生成物（`mediaTypes.generated.ts`）——手写源码出现 `new Set([…'.png'…])` 模式即红；**豁免清单**：语言特有集合（现仅 `DECODABLE_IMAGE_EXTENSIONS`，与 image crate 解码能力绑定的解码集）显式豁免并标注归属注释；新增语言特有集合须同步更新此豁免清单（= 强制过评审）。
2. `convertFileSrc` 仅出现在 `domain/mediaUrl.ts`；
3. `<video`/`<audio` JSX 仅出现在 `ResourceMedia.tsx`、`FileMediaPreview.tsx`；
4. 列表容器必须 `import` 自 `domain/*`（ClipboardPage/index、ResourcePage、RadialMenu 等）；
5. `loadRecordPreviewSegments` 仅在 `domain/preview.ts` 定义；
6. **recordView 组装-only 契约**（§3.7）：扫描 `recordView.ts`，出现扩展名字面量、`record.type === "…"` 比较、对记录字段的 `endsWith/startsWith/includes` 即红；
7. **生成物新鲜度校验**：运行 `scripts/generate-media-types.mjs` 与仓库内生成物 diff，非空即红（改了 `config/media-types.json` 不重新生成，测试当场抓住）；
8. Rust 扩展名 `ends_with(".…")` 判定仅存在于 `media_kind.rs` 与生成物（`.tmp` 等应用内部后缀列入豁免清单）；
9. 事件覆盖：`resource-groups-changed` 在 src 内**恰好两处**监听（不锁具体文件名——将来抽共享 hook 不误报；出现第三处即红，提示应复用既有监听）；
10. **叶子组件 UI 合同**（§3.10）：叶子文件（`ClipboardCard.tsx`、`ResourceCard.tsx`、及 2b 从 RadialMenu/index.tsx 抽出的径向条目渲染文件）不得 import `ClipboardRecord` 类型、不得 import 任何 `stores/*`、不得调用 `buildRecordView`、不得 `invoke`；判定一律读判定字段（扫描扩展名字面量与 `endsWith` 推断），基于事实字段的渲染分支合法；`ResourceDetailPage.tsx` 与 `ImageThumb.tsx` 为准容器（分别有编辑操作与缩略图缓存数据访问），仅断言其不含扩展名字面量与本地媒体判定；
11. **旧出口零残留**：迁移删除的符号（`inferResourceMediaKind` 等）在 `resourceUtils.ts`/`utils/` 老位置的定义与 re-export 均为空——防止后续有人"顺手"加回；
12. **依赖方向单向**（§2）：`src/domain/**` 不得 import `stores/*` 与组件层；**"叶子文件"集合 = 规则 10 点名基线 ∪ 动态判定（组件文件的 props 类型声明含 `RecordView`，按声明粒度识别并排除容器文件——如定义 `RecordRadialItem` 类型的 `RadialMenu/index.tsx` 是容器不是叶子）**——既不全量扫描 components/** 误伤合理用 store 的二级组件，也不只靠点名清单被绕过。

### 5.3 单一配置 + 代码生成（TS/Rust 清单由构造保证一致）
跨语言的扩展名清单靠人工维护必然漂移，架构测试"事后比对"只能兜底。最优做法是**单一配置源 + 代码生成**：
- 唯一源：`config/media-types.json`，只含**共享语义清单**：`image`、`video`、`audio`、`text`、`previewableImage`（jpg/jpeg/png 预览导入子集）与 `importableImage`（png/jpg/jpeg/gif/bmp/webp/ico，剪贴板导入为图片记录的完整集，v6 裁决，见 §6 阶段 1）——共六组；
- 生成器：`scripts/generate-media-types.mjs`（Node，一次运行产出两份）：
  - `src/domain/mediaTypes.generated.ts`：导出各清单 `readonly string[]` 与 kind 联合类型；
  - `src-tauri/src/media_types.generated.rs`：导出 `pub const IMAGE_EXTENSIONS: &[&str] = &["png", …];` 等；
- **生成物提交进仓库**：TS/Rust 消费方 import/include 普通文件，不引入 build.rs、不依赖构建顺序，保持可 grep 可调试；
- 手写层（`domain/mediaKind.ts` / `media_kind.rs`）只写**逻辑**（判定函数、规则），清单一律引用生成物；
- **生成器严格校验配置**：未知字段、空清单、重复扩展名、非法字符一律报错退出——防止拼写错误被静默忽略生成空集合；
- **生成物消费联结有测试锁定**：Rust 侧 `media_kind` 单测遍历生成清单逐项断言 `media_kind_for_path` 返回值，保证"生成物 → 判定函数"的联结不因重构断裂；
- 语言特有清单不入共享配置（TS 浏览器解码集合、Rust 应用内部后缀），在各自代码中注释归属并受 §5.2 规则 1/8 约束；
- 新鲜度由 §5.2 规则 7 强制：本地或 CI 跑 `pnpm test` 时，改配置未重新生成立即失败。

### 5.4 CI 接入测试（守卫生效的前提）
已核实：当前 `build.yml` **只在推送 `v*` 标签时触发且不跑任何测试**——若只把测试挂上去，守卫在全部日常开发中形同虚设（v3 方案在此处有漏洞）。v4 修正为**独立 CI 工作流 + 发布构建双保险**：
- 新建 `.github/workflows/ci.yml`：`push`（main）与 `pull_request` 触发，执行 `pnpm lint`、`pnpm test`（含 12 条架构守卫）、`cargo test`（Linux 侧，配 cargo/pnpm 缓存），目标 10 分钟内完成；
- `build.yml`（发布构建）保留并加同样的测试步骤作为发布前最后防线；
- 没有这一步，本方案全部机制（编译器强制除外）都只是"建议"。

## 6. 执行阶段划分（每阶段独立可验证、独立提交）

| 阶段 | 内容 | 验证 | 提交 |
|:--|:---|:---|:---|
| 0 | 同步另一进程成果，rebase，重跑 §8 审计核对调用点清单 | tsc/cargo check 绿 | — |
| 1 | 新建 `config/media-types.json` + 生成器 + 生成物；新建 `domain/` 七模块与 `README.md`（纯新增，存量不动）。**清单合并决策规则**：先对现存清单做逐项 diff 输出差异报告，以"服务用途最广的现行值"合并；**config 含六组清单**：image/video/audio/text/previewableImage + `importableImage`（v6 新增裁决：clipboard.rs 的 `is_image_file` 7 项集合 png/jpg/jpeg/gif/bmp/webp/ico 是"剪贴板导入为图片记录"的独立语义，与可显示 13 项、可解码 6 项构成三个真实语义集，进共享配置而非语言特有豁免）。语义冲突项逐项列出待用户确认，**已知最尖锐案例**：`ts` 扩展名 Rust 视频清单与文本清单都含（判定顺序 image→video→audio→text 使 .ts 在 Rust 判 video），TS 侧 `ts` 仅在 TEXT_EXTENSIONS 判 text——同一文件跨语言行为不一致（活漂移），且改动任一侧都会改变资源区现网行为，必须用户裁决 | 全量测试绿 + 差异报告 | `重构：沉淀领域层与媒体类型单一配置` |
| 2a | 主窗口切换：ClipboardPage 容器/卡片改收 RecordView，删旧出口引用；**上移清单明确到符号**：`getRecordContent`/`loadRecords`/`invoke("set_user_api_key")`（ApiKeyLabelPanel 链路）等全部 store/invoke 调用上移容器；**同窗口的短语页一并收编**（PhrasePage 3 处 `convertFileSrc` → domain/mediaUrl、PhraseList 的 `get_image_thumbnail` → stores）——否则阶段 4 eslint 生效即红，且短语页不在任何阶段的排期缺口（独立审查发现） | pnpm test + build | `重构：主窗口切换到领域层视图模型` |
| 2b | 径向菜单切换：**从 RadialMenu/index.tsx 抽出径向条目渲染叶子文件**，RadialItem 改为 RecordView 三变体联合类型，预览/视觉/显示文本走 view（`displayNameTruncateAt` 渲染参数经容器注入） | 同上 | `重构：径向菜单切换到领域层视图模型` |
| 2c | 资源页切换：ResourceCard/ResourceDetailPage 改收 view（详情页为准容器）；`ImageThumb` 归准容器（缩略图缓存）；UI 层剩余直接 invoke 收编 stores——含 `SettingsContent.tsx` 的 `get_storage_path` 调用（改走 domain/mediaUrl，settings 面板仅此一处数据型 invoke） | pnpm test + build + lint | `重构：资源页切换到领域层视图模型` |
| 3 | Rust `media_kind.rs` 收口（清单引用生成物 + 遍历单测） | cargo test | `重构：Rust 媒体类型判定收口` |
| 4 | eslint 规则 + 架构守卫测试（§5.2 全部 12 条）+ `ci.yml`（push/PR 测试）+ build.yml 测试步骤（§5.4） | pnpm test（含守卫） | `工程：架构守卫强制领域层共享` |

行为等价原则：阶段 1–3 为**严格等价迁移**，不夹带任何行为修改；`displayName`/`expandable` 等聚合规则对各窗口现有实现先做映射表（随提交附在测试注释里），发现规则间矛盾时单独提出、单独决策。阶段 2 拆分为 2a/2b/2c 三个独立子提交——每个子提交独立可验证、可单独 revert，避免千行文件的巨型 diff 一次落地。

**既有源码断言随迁**：`integrationRegression.test.ts` 含约 369 条 `toContain` 源码结构断言（如断言某文件包含 `useBackToTop`），其中涉及被迁移符号的断言目标必须随各子提交同步更新——迁移后测试红首先排查"断言目标过时"，其次才是真回归。

## 7. 风险与回滚

**威胁模型声明**（v4）：本方案的全部机制针对的是**无意分裂与图省事的局部实现**——这已覆盖历史上全部实际缺陷。它不防"刻意对抗架构"：TS 结构类型意味着理论上可以自定义结构兼容接口绕过 props 合同；任何静态机制都防不了恶意规避。防线到此为止是诚实的设计，把机制做到"防恶意"级别（私有字段、运行时冻结、代码所有权）的成本远超收益。

- **改动面大**（预计 20+ 文件，含三个千行级文件；props 合同改造是工作量最大单项）：迁移为主、机械替换，编译器兜底；117 前端测试 + 89 Rust 测试为安全网；props 合同切换的 UI 行为回归无法全靠单测覆盖，每个子提交后按"主窗口 / 径向菜单 / 资源页"分窗口人工验收（列表渲染、预览、粘贴、拖出四项冒烟）；
- **与并行功能优化冲突**：阶段 0 重新审计即为此设计；`domain/` 为全新目录，冲突面最小；props 类型切换与并行功能改动可能触碰同一文件，执行前确认另一进程已收尾；
- **回滚**：六个独立提交（1/2a/2b/2c/3/4），任一提交可单独 revert；
- **守卫误报**：允许清单显式化，误报通过修改清单（评审后）而非放宽规则解决。

## 8. 执行前审计快照（2026-09-11，供阶段 0 比对）

- TS 媒体判定引用 12 文件；`convertFileSrc`/URL 解析 8 文件；`<video>/<audio>` 渲染仅 `FileMediaPreview.tsx`、`ResourceMedia.tsx`（已收敛良好）；
- UI 层直接 invoke 预览/媒体命令 8 文件（InlinePreview、RadialMenu、PhraseList、ResourceDetailPage、ResourceMedia、resourceUtils、clipboardStore、contentPreview）；
- Rust 扩展名判定：`clipboard.rs:52/60`（图片两套）、`db.rs:567`（`resource_media_kind_for_path` + `is_resource_*_extension`）。

## 9. 明确不做（本期范围外）

- 短语（Phrase）体系纳入 RecordView：现分裂点少（仅图像文件短语判定一处），二期处理；
- **新建窗口（ClipboardCreateDialog）不在 props 合同范围内**：它是"写路径"（创建/编辑），其领域规则（图片 placeholder 解析、内容校验）已在 Rust 侧收口（`parse_stash_segments`、`validate_stash_content`）；RecordView 是"读路径"的展示模型，两者边界清晰，无需强行统一；
- 粘贴策略入视图模型执行层：`clipboardStore.pasteRecord` 已是共享路由，view 只携带 `pasteStrategy` 描述供 UI 决策，执行不进 view；
- 全量后端 API 包装层：窗口/设置类 `invoke` 数量多、无分裂史，保留直调（守卫清单只锁媒体/预览/存储类；`SettingsContent` 的 `get_storage_path` 除外——它是媒体 URL 链路的数据依赖，随 2c 收编，见 §6）；
- domain 的 barrel/internal 完全封装机制：当前 7 模块规模下属过度工程，升级路径见 §3.9。

## 10. 评审记录

### v2 变更（2026-09-12，吸收三点评审意见）

1. **recordView 边界**（§3.7、§5.2 规则 6）：v1 把 `expandable`/`expandPreview` 聚合规则写在 buildRecordView 内，规则与组装混层，存在演变为第二事实源的实在风险。v2 将能力判定下沉为 `domain/records.ts` 纯函数，recordView 确立"组装-only"契约并由架构测试模式扫描强制。完全静态证明"无业务判断"不可行，防典型漂移（扩展名字面量、type 字符串比较、前缀/后缀判定）是务实目标。
2. **跨语言清单代码生成**（§5.3、§5.2 规则 7）：v1 依赖架构测试"事后比对"两侧源码。v2 升级为 `config/media-types.json` 单一配置 + 生成器产出 TS/Rust 两份代码，一致性由构造保证；生成物提交仓库（不引入 build.rs、不动构建顺序），架构测试降级为生成物新鲜度校验。语言特有清单不入共享配置。
3. **domain 防膨胀**（§3.9）：采纳"只暴露稳定公共 API、内部不外泄"原则；当前规模以归属决策表 + 拆分触发条件落地，barrel/internal 机制列为升级路径而非本期内容。

另补充 v1 缺失的强制力基础：已核实 CI（build.yml）只构建不测试，所有守卫若不入 CI 仅等于"建议"。§5.4 新增 CI 测试步骤为方案组成部分。

### v3 变更（2026-09-12，极致推演）

推演方法：对 v2 逐层拷问"守卫是否可绕过、边界是否画到类型系统、有没有更优替代架构被漏掉"，产生四项实质升级与一项新发现：

1. **props 合同升级为编译器强制**（新增 §3.10、§5.2 规则 10）：v2 只要求"三窗口消费 view"，但组件 props 仍收 `ClipboardRecord`，绕过 view 直接摸字段在类型上完全可行——守卫只是"事后扫描"。v3 将叶子展示组件 props 合同改为 `RecordView`（白名单封闭，不暴露 record 原体），"绕过领域层"从违规变成**不可表达**。这是全方案从"约束行为"到"消除可能性"的关键跃迁。
2. **新发现分裂点：条目显示文本**（§3.7 `displayName`）：主窗口与径向菜单各有一套"显示什么文本"的三元分支（图片占位/文件名/正文/API Key 预览），收口为 `displayName` + `displayTruncated`。
3. **能力模型补全**（§3.7）：`pasteStrategy`（粘贴路由描述，执行仍在 store）、`dragPath`、API Key 字段组进 view；preview 函数签名改为收 view。
4. **迁移拆分与风险对应升级**（§6 阶段 2a/2b/2c、§7）：props 合同改造是工作量最大单项，按窗口拆三个子提交，各配人工冒烟清单（渲染/预览/粘贴/拖出）。
5. **守卫元层面**（§3.9）：守卫报错教学化（失败信息直接指出正确归属）；确立"缺陷 → 守卫"闭环流程，守卫清单随缺陷持续生长而非一次性交付。

关于策略常量（大小上限、预览字符数等）是否入 `media-types.json`：推演后**明确不入**——核实这些常量均只单侧使用（Rust 或 TS 其一），不存在跨语言漂移问题；把它们塞进共享配置是无收益的形式主义。共享配置只装"真跨语言双份"的事实清单。

### v4 变更（2026-09-12，证伪式推演：专找会被绕过、会空转、会反噬的点）

推演方法转向：不再找"还能加什么"，而是逐条攻击 v3——每条守卫问"怎么绕过"，每层边界问"方向有没有反"，每个机制问"它实际会不会运行"。发现三处真漏洞、一处方法论缺口，全部落实：

1. **CI 空转漏洞（本轮最重要发现）**：v3 把测试挂进 `build.yml`，而它只在推 `v*` 标签时触发——**全部日常开发不经过任何 CI 测试，12 条守卫在两次发版之间是死文字**。v4 改为独立 `ci.yml`（push/PR 触发，lint + 测试 + 守卫，10 分钟目标）+ 发布构建保留测试步骤双保险（§5.4）。
2. **RecordView 白名单的绕过通道**：`useClipboardStore` 全局可达，叶子组件可以直接拿原始 records，props 合同被架空。补"叶子层禁 import stores"（§3.10、§5.2 规则 10），并把现 ClipboardCard 内的 store 调用上移容器列入 2a 子提交。
3. **domain→store 分层倒置**：v2/v3 的 `domain/preview.ts` 仍依赖 `useClipboardStore.getState()`。确立"依赖方向单向"核心原则（§2）：domain 禁 import stores（预览内容读取直接封装 invoke），新增 §5.2 规则 12 断言。
4. **显示差异的方法论缺口**：`displayName` 收口必然面对"径向截断 300 字 vs 主窗口全显"这类窗口间差异。补核心原则：**显示差异用展示参数表达，不得实现为不同领域规则**——一条规则 + N 组参数，否则统一 displayName 本身就会制造新的分裂（§2）。

另做四处边界声明：威胁模型（§7，机制防无意分裂、不防刻意对抗，防恶意级别成本远超收益）；性能约定（§3.10，view 构建容器级 useMemo，防 props 合同切换引发整列表重渲染）；写路径声明（§9，新建窗口领域规则已在 Rust 收口，不强行套 RecordView）；守卫预算（守卫必须"模式可静态扫描"，拒绝需要语义分析的不可靠守卫）。

**收敛性判断**：v1→v2 修复的是"机制选型"（事后比对→代码生成、纪律→CI），v3 修复的是"边界强度"（工具约束→类型系统），v4 修复的是"运行与绕过"（CI 空转、store 旁路）——发现的层级从架构决策降到流程与声明，边际收益已明显收敛，且本轮出现第一个被证明"不该做"的增强方向（防恶意机制）。判断 v4 为本方案在当前代码库规模下的不动点：继续推演的产出将是复杂度净增而防御力不增（详见 §11 拒绝项）。

### v5 变更（2026-09-12，执行预演：按六个提交把方案走一遍）

推演角度：设计评审（v2）、攻击推演（v3-v4）之外最后未用的一个——**执行 dry-run**：以执行者身份按 §6 逐提交走查，找方案的自相矛盾、未经证实的断言与会让执行者卡壳的决策空白。发现并修正五项：

1. **RadialItem 定义自相矛盾**：v3 写 `RadialItem = RecordView & {…}`，但短语条目不纳入 view（§9）就没有 RecordView 基座——执行者会在这里卡死或擅自破坏"短语不纳入"的边界。改为记录/短语两类条目的联合类型。
2. **ResourceDetailPage 误列为叶子**：详情页承载重命名、备注、分组移动等大量编辑操作，强制叶子化会把容器回调签名撑爆。新增"准容器层"归类：允许 stores、视觉判定仍必须走 view/domain，守卫规则 10 同步调整。
3. **未经证实的断言被证实**：v4 断言 `getRecordContent` "无缓存语义"当时未验证——本轮核实（clipboardStore.ts:215，两行直通实现）成立，文档改为写实引用。
4. **清单合并决策空白**：三份现存清单内容确有差异（TS `IMAGE_EXTENSIONS` 含 svg/avif/heic/tif 等 13 项），合并到单一配置时"选哪个值"无规则可依，执行者会擅自决定。阶段 1 补合并决策规则与用户确认点。
5. **369 条既有源码断言的迁移冲击**：`integrationRegression.test.ts` 的 `toContain` 结构断言会随迁移批量变红，方案此前未提——执行者会陷入"破坏还是断言过时"的排查困境。补入行为等价原则。

**收敛性判断（修正 v4）**：v4 曾判断已到不动点，v5 的产出证明该判断下早了——执行预演维度确有剩余产出。v5 后判定真正收敛的依据：三个推演角度（语义设计、对抗攻击、时序执行）均已穷尽，且本轮发现层级已降至"联合类型写法、组件归类、测试断言随迁"这类执行细节——架构级、机制级、流程级的改进空间已为零。后续任何"再推演"的需求，正确的响应是进入执行（§6），在真实代码上让编译器与守卫暴露纸面推演无法发现的问题。

### v6 变更（2026-09-12，外部执行者独立审查：实证检验推演收敛性）

v5 宣称"纸面推演已收敛"后，以**无历史包袱的独立执行者视角**（subagent 通读方案 + 对照源码逐项抽查）做实证检验，结果推翻了该判断：发现 **2 项架构级缺陷**、3 条守卫按字面会误报或空转、至少 6 个会让执行者做出方案声明"待用户确认"级决策的空白。核心教训：**自我推演存在确认偏误——"我没有再找到问题"不等于"问题不存在"，独立视角的字段级核查是必要的验证环节。**全部修订：

1. **契约升级：判定封闭取代数据封闭**（§3.7，架构级）：独立审查证明 v3 的白名单（数据封闭）覆盖不了叶子的真实字段需求——实测 ClipboardCard 使用 12 个事实字段、ResourceCard 使用 7 个，且 §3.7 "content/hasImages 均已在 view 上"的断言与白名单定义直接矛盾。v6 将 RecordView 明确为**事实字段（透传，允许渲染分支）+ 判定字段（叶子只读不猜）**两组：封闭的对象是"判定"而非"数据"，"这条记录是什么/能做什么"必须读判定字段，事实字段上的条件样式分支合法。preview 签名矛盾随之解除。
2. **守卫条款三方冲突解除**（§5.2 规则 1/§3.1/§5.3，架构级）：规则 1 与"DECODABLE 语言特有清单手写保留"互相堵死——守卫第一天就红，教会执行者"改测试放过它"，恰好摧毁例外评审机制。v6 规则 1 增设显式豁免清单；`is_image_file` 7 项集合裁决为第三个共享语义集 `importableImage`（可显示/可解码/可导入三集并存）进配置，而非语言特有豁免。
3. **守卫落地性修正**（§5.2 规则 9/10/12）：规则 9 改"恰好两处监听"（抽 hook 不误报）；规则 10 补 ImageThumb 归准容器、径向条目叶子文件抽取要求（不抽则规则 10 对径向空转）；规则 12 定义叶子文件集合判定标准（点名基线 ∪ props 含 RecordView 动态判定），避免全量扫描误伤或点名清单被绕过。
4. **执行决策空白补全**：`ts` 扩展名双归属（Rust video/text 皆含、判定顺序导致跨语言活漂移，改动任一侧改变现网行为）列为阶段 1 差异报告的头号待确认项；`getResourceTitle/Path/Summary` 指定归属 records.ts；`set_user_api_key` 上移、短语页收编排入 2a；径向叶子文件抽取与 `isDivider` 第三变体编入 2b；`displayTruncated` 语义定义（渲染参数截断标记，区别于后端 `contentTruncated`）与 `displayNameTruncateAt` 注入点确定。
5. **引用漂移修正**：`isResourceRecord` 实测在 `src/utils/clipboardRecord.ts`（非 resourceUtils）；`getFullContent` 实测行号 227。

**方法的最终结论**：五轮自我推演 + 一轮独立实证审查，后者一次性发现了前者宣称"为零"的架构级问题。对这类方案的完备性检验，独立视角的字段级核查不是可选项。v6 修订全部为文档级，架构主体（单一配置+生成物、依赖单向、CI 双保险、六提交迁移）经独立核对与代码库事实一致，结论升级为可交付执行。

### v6 复审（同日，同一独立审查者 re-review）

v6 送回原审查者复审：上轮 5 大项修订清单**逐项核实全部落实**，2 项架构级缺陷与 3 条守卫误报/空转问题全部闭合，v6 新增事实断言抽查全部准确。结论 **pass-with-notes**（8 条 notes，均不影响可执行性）。全部 8 条 notes 已当场清零（`importableImage` 同步 §5.3/§4、SettingsContent 的 `get_storage_path` 收编排入 2c 并对齐 §9、§2 措辞匹配判定封闭契约、`matchesResourceType` 单归属、行号修正、规则 12 粒度细化、`resourceSummary` 承载写明、准容器补列 ImageThumb）。**方案定稿为执行基线，无遗留评审意见。**

### 执行记录（2026-09-12，阶段 0–4 已落地）

- 阶段 0 重审计：§8 快照与最新代码匹配，新功能（排序偏好/use_count）未引入新分裂。
- 阶段 1–4 已按 §6 提交：f2455de（领域层+配置）/07ce720（主窗口+短语页）/ff6de77（径向映射与预览）/cc2f0dc（Rust 收口）/b8bb0db（资源页+旧出口全删）/5a839da（守卫 9 条严格生效）。
- ts 归属裁决：video（自主裁决，翻转方式见 config/media-types.json 首部注释）。
- eslint 分层规则上线（UI 层待收编 6 处暂降 warn，清单见 lint 输出）；ci.yml 已建（push/PR 跑 lint+测试+守卫）。
- 剩余加固项：径向条目叶子文件抽取、UI 层 6 处 invoke 收编后恢复 error、ci.yml 首次运行观察。

## 11. 落选备选与理由（证明是最优，而非没想过）

- **TanStack Query 等数据层框架统一重写**：zustand 已覆盖本项目数据流且工作良好；重写范围远超"杜绝分裂"的目标，风险收益比不成立。落选。
- **domain 独立 package（monorepo + package.json exports 强制公共 API）**：对单应用仓库是重炮；`domain/` 目录约定 + eslint 豁免机制已能表达同等边界，且不引入工作区构建复杂度。落选（列入 §3.9 升级路径的同级备选）。
- **Rust 直接下发完整"能力视图"（前端零判定）**：能力判定依赖前端运行时状态（截断、窗口上下文、用户设置），后端只应供"存储事实"（`resource_kind`）。现方案即"事实/能力分层"的正确形态。落选，边界声明见 §2 核心原则。
- **build.rs 编译期生成 Rust 清单**：生成物提交仓库的方案同样由测试强制新鲜度，且无构建顺序耦合、可 grep 可调试。落选。
- **media-types.json 配 JSON Schema + 编辑器提示**：生成器启动时的严格校验（§5.3）已拦截全部非法配置，编辑期提示属锦上添花。落选（v4）。
- **MediaKind 枚举由配置生成**：枚举与 `as_str` 映射是**逻辑**而非数据；手写 + 单测遍历生成清单逐项断言（§5.3）已锁死联结。落选（v4）。
- **eslint-plugin-import 的 boundary 规则做分层约束**：原生 `no-restricted-imports` patterns 已完整表达"domain 禁 stores、叶子禁 stores/invoke"（§5.2 规则 10/12），不为此引入新插件依赖。落选（v4）。
- **为"防恶意绕过"加运行时机制（Object.freeze、私有字段、代码所有权）**：威胁模型声明其超出目标（§7）。落选（v4）。
