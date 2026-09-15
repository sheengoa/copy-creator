/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function readSource(path: string) {
  // Windows 检出（autocrlf）下源码为 CRLF，统一归一为 LF 再断言。
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

// db 模块已按业务域拆分为多个文件；守卫断言统一读拼接源。
// 切片断言的起止标记位于同一域文件内，拼接序保持「共享 → 各业务域」。
const DB_SOURCE_FILES = [
  "mod.rs",
  "apikeys.rs",
  "clipboard.rs",
  "media.rs",
  "migrate.rs",
  "phrase.rs",
  "resource.rs",
  "settings.rs",
] as const;
const readDbSource = () =>
  DB_SOURCE_FILES.map((file) => readSource(`../../src-tauri/src/db/${file}`)).join("\n");

// shortcut 模块已按窗口域拆分（shortcut / radial_window /
// clipboard_create_window / win_hook）；守卫断言统一读拼接源。
const SHORTCUT_SOURCE_FILES = [
  "shortcut.rs",
  "radial_window.rs",
  "clipboard_create_window.rs",
  "win_hook.rs",
] as const;
const readShortcutSource = () =>
  SHORTCUT_SOURCE_FILES.map((file) => readSource(`../../src-tauri/src/${file}`)).join("\n");

describe("integration regressions", () => {
  it("does not re-show hidden windows from delayed raise paths", () => {
    const libSource = readSource("../../src-tauri/src/lib.rs");
    const delayedMainBlock = libSource.slice(
      libSource.indexOf("Duration::from_millis(250)"),
      libSource.indexOf("main window not found (delayed startup)"),
    );
    expect(delayedMainBlock).not.toContain(".show()");
    expect(delayedMainBlock).toContain("is_visible()");

    const shortcutSource = readShortcutSource();
    expect(shortcutSource).not.toContain("refresh_always_on_top_if_visible");
    expect(shortcutSource).not.toContain("Duration::from_millis(60)");
    expect(shortcutSource).toContain("raise_always_on_top(&radial);");
    expect(shortcutSource).toContain("if window.is_visible().unwrap_or(false)");
    expect(shortcutSource).toContain("window.set_always_on_top(true)");
  });

  it("does not animate the radial popup during native window mapping", () => {
    const radialStyles = readSource("../styles/radial-menu.css");

    expect(radialStyles).toContain(".radial-menu-overlay.radial-menu-hidden");
    expect(radialStyles).not.toContain("radial-menu-hidden .radial-menu-popup");
    expect(radialStyles).not.toContain("animation: radialMenuIn");
    expect(radialStyles).not.toContain("@keyframes radialMenuIn");
  });

  it("keeps a visible radial menu above the clipboard create dialog", () => {
    const shortcutSource = readShortcutSource();
    const libSource = readSource("../../src-tauri/src/lib.rs");
    const createBlock = shortcutSource.slice(
      shortcutSource.indexOf("pub fn show_clipboard_create"),
      shortcutSource.indexOf("#[tauri::command]", shortcutSource.indexOf("pub fn show_clipboard_create")),
    );

    expect(shortcutSource).toContain("pub(crate) fn has_visible_popup_window(app: &AppHandle)");
    expect(shortcutSource).toContain("pub(crate) fn raise_visible_popup_windows(app: &AppHandle)");
    // 层级约定：弹窗激活顺序必须"先编辑窗口、后径向菜单"，保证径向菜单在最上。
    const popupRaiseBlock = shortcutSource.slice(
      shortcutSource.indexOf("pub(crate) fn raise_visible_popup_windows"),
      shortcutSource.indexOf("pub fn show_radial_menu"),
    );
    expect(popupRaiseBlock.indexOf("raise_always_on_top(&create)")).toBeLessThan(
      popupRaiseBlock.indexOf("raise_always_on_top(&radial)"),
    );
    // Linux 常驻模型下径向窗口 is_visible 恒为 true，抬升前必须查显示
    // 状态标志（否则会把停泊在屏幕外的窗口抬升并抢焦点）；标志读写统一
    // 走 radial_window 的收敛入口（A3）。
    expect(shortcutSource).toContain("let radial_shown = radial_menu_shown();");
    expect(createBlock).toContain("raise_visible_popup_windows(app);");
    expect(libSource).toContain("shortcut::has_visible_popup_window(app)");
    expect(libSource).toContain("shortcut::raise_visible_popup_windows(&app_handle)");
  });

  it("uses the shared main-window show path for Linux IPC", () => {
    const ipcSource = readSource("../../src-tauri/src/ipc.rs");

    expect(ipcSource).toContain('crate::show_main_window(app, "ipc", false);');
    expect(ipcSource).not.toContain("static SHOWING");
    expect(ipcSource).not.toContain("set_always_on_top(true)");
  });

  it("uses the same six-line card folding for quick input and clipboard cards", () => {
    const phraseSource = readSource("../pages/PhrasePage/PhraseList.tsx");
    const clipboardSource = readSource("../pages/ClipboardPage/ClipboardCard.tsx");
    const phraseStyles = readSource("../styles/phrases.css");
    const clipboardStyles = readSource("../styles/clipboard.css");
    const recordsDomain = readSource("../domain/records.ts");

    expect(phraseSource).toContain('className="card-toggle-text-btn"');
    expect(phraseSource).toContain("e.stopPropagation()");
    expect(phraseSource).toContain('t(isTextExpanded ? "phrases.collapseText" : "phrases.expandText")');
    expect(phraseSource).toContain("Icons.expand");
    expect(phraseSource).toContain("Icons.collapse");
    expect(phraseStyles).toContain(".phrase-card-body.is-toggleable");
    expect(phraseStyles).toContain(".phrase-card-body.is-collapsed");
    expect(phraseStyles).toContain(".phrase-card-body.is-expanded");
    expect(phraseStyles).toContain("white-space: pre-wrap");
    expect(phraseStyles).toContain(".phrase-card-actions > .card-toggle-text-btn");
    expect(clipboardSource).toContain('className="card-toggle-text-btn"');
    // 折叠判定收口 domain/records.ts，卡片只读视图模型的判定字段。
    expect(clipboardSource).toContain("view.expandable");
    expect(clipboardSource).toContain('view.recordType === "file"');
    expect(clipboardSource).toContain("view.expandPreview");
    expect(recordsDomain).toContain("shouldShowInlineTextToggle");
    expect(recordsDomain).toContain("INLINE_PREVIEW_MAX_LINES = 6");
    expect(clipboardStyles).toContain(".clipboard-card-body.is-collapsed");
    expect(clipboardStyles).toContain("calc(1.5em * 6)");
  });

  it("sizes the quick input editor dialog relative to the main window", () => {
    const dialogSource = readSource("../pages/PhrasePage/PhraseDialog.tsx");
    const componentsStyles = readSource("../styles/components.css");

    expect(dialogSource).toContain('className="dialog-content large phrase-dialog-content"');
    expect(componentsStyles).toContain(".dialog-content.large.phrase-dialog-content");
    expect(componentsStyles).toContain("width: clamp(360px, 72vw, 720px);");
    expect(componentsStyles).toContain("max-width: calc(100vw - 32px);");
    expect(componentsStyles).toContain("max-height: calc(100vh - 32px);");
  });

  it("keeps migrated clipboard schema compatible with current record fields", () => {
    const dbSource = readDbSource();
    // 迁移路径必须经由 migrate_storage_data → ensure_schema：迁移库与
    // 主库共用同一 schema 源（含全部列与索引），禁止再出现各自的
    // CREATE TABLE 副本——曾经的副本缺 4 列，迁移后列表命令直接报错。
    const migrateBlock = dbSource.slice(
      dbSource.indexOf("fn migrate_storage"),
      dbSource.indexOf("fn migrate_storage_data"),
    );
    expect(migrateBlock).toContain("migrate_storage_data(");

    const ensureBlock = dbSource.slice(
      dbSource.indexOf("fn ensure_schema"),
      dbSource.indexOf("fn sanitize_file_record_contents"),
    );
    expect(ensureBlock).toContain("sort_order REAL");
    expect(ensureBlock).toContain("group_name TEXT DEFAULT ''");
    expect(ensureBlock).toContain("idx_clipboard_sort_order");
  });

  it("classifies manually saved content through the shared stash path", () => {
    const clipboardSource = readSource("../../src-tauri/src/clipboard.rs");
    const saveStart = clipboardSource.indexOf("pub fn save_stash_record");
    const saveBlock = clipboardSource.slice(
      saveStart,
      clipboardSource.indexOf("#[tauri::command]", saveStart),
    );

    expect(saveBlock).toContain("classify_text_record(&content)");
    expect(saveBlock).toContain('"type": record_type');
  });

  it("updates stash records and moves them to the top without changing creation time", () => {
    const dbSource = readDbSource();
    const updateBlock = dbSource.slice(
      dbSource.indexOf("pub fn update_clipboard_record"),
      dbSource.indexOf("pub fn delete_all_clipboard_records"),
    );
    const libSource = readSource("../../src-tauri/src/lib.rs");

    expect(updateBlock).toContain("SELECT storage_mode FROM clipboard_records");
    expect(updateBlock).toContain("is_resource_record(&storage_mode)");
    expect(updateBlock).not.toContain("group_name");
    expect(updateBlock).toContain("SET type = ?1, content = ?2, sort_order = ?3 WHERE id = ?4");
    expect(updateBlock).not.toContain("created_at =");
    expect(updateBlock).toContain("timestamp_millis");
    expect(updateBlock).toContain('emit("clipboard-record-updated"');
    expect(libSource).toContain("db::update_clipboard_record");
  });

  it("keeps standalone clipboard create language in sync", () => {
    const componentSource = readSource("../components/ClipboardCreateDialog/index.tsx");

    expect(componentSource).toContain('get_setting", { key: "language"');
    expect(componentSource).toContain("i18n.changeLanguage");
  });

  it("supports resource groups through library subfolders", () => {
    const dbSource = readDbSource();
    const clipboardSource = readSource("../../src-tauri/src/clipboard.rs");
    const pageSource = readSource("../pages/ResourcePage.tsx");
    const groupChipsSource = readSource("../pages/ResourcePage/ResourceGroupChips.tsx");
    const componentSource = readSource("../components/ClipboardCreateDialog/index.tsx");

    expect(dbSource).toContain("DROP TABLE IF EXISTS resource_groups");
    expect(dbSource).toContain("pub fn get_resource_groups");
    expect(dbSource).toContain("pub fn create_resource_group");
    expect(dbSource).toContain("pub fn update_resource_group");
    expect(dbSource).toContain("pub fn delete_resource_group");
    expect(dbSource).toContain("pub fn open_resource_group");
    expect(dbSource).toContain("resource_group_for_path");
    expect(dbSource).toContain("normalize_resource_group_name");
    expect(dbSource).toContain("WHERE group_name IN ('stash', '暂存', '默认', '临时')");
    expect(clipboardSource).toContain("target_group_name");
    expect(clipboardSource).toContain("resource_group_path");
    expect(clipboardSource).toContain("render_resource_markdown");
    expect(clipboardSource).toContain('emit("resource-groups-changed"');
    expect(dbSource).toContain('emit("resource-groups-changed"');
    expect(pageSource).not.toContain("ResourceMode");
    expect(pageSource).not.toContain("handleSwitchMode");
    expect(pageSource).not.toContain("isTempRecord");
    expect(pageSource).not.toContain("resource-mode-tab");
    expect(pageSource).toContain('storageMode: "resource"');
    expect(pageSource).toContain("get_resource_groups");
    // 分组栏（含拖拽排序与子分组菜单）内聚在 ResourceGroupChips 中。
    expect(pageSource).toContain("<ResourceGroupChips");
    expect(groupChipsSource).toContain("resource-group-section");
    expect(groupChipsSource).toContain("resource-group-scroll");
    expect(groupChipsSource).toContain("horizontalListSortingStrategy");
    expect(pageSource).toContain('listen("resource-groups-changed"');
    expect(pageSource).toContain("resourceGroup");
    expect(pageSource).not.toContain("useResourceGroupStore");
    expect(pageSource).not.toContain("<GroupChips");
    expect(componentSource).toContain('category: isResource ? "resources" : "all"');
    expect(componentSource).toContain("resourceGroup: groupName");
    expect(componentSource).toContain("groupName: resourceGroupName");
    expect(componentSource).not.toContain("clipboard-create-storage-toggle");
    expect(componentSource).not.toContain("clipboard-create-resource-group-section");
    expect(componentSource).toContain("stashRecords");
  });

  it("propagates external library changes and usage updates to the frontend", () => {
    const watchSource = readSource("../../src-tauri/src/resource_watch.rs");
    const dbSource = readDbSource();
    const clipboardPageSource = readSource("../pages/ClipboardPage/index.tsx");
    const pageSource = readSource("../pages/ResourcePage.tsx");

    // 目录监听必须把删除/内容修改也转发进防抖汇聚（不只是新建/改名），
    // 否则文件管理器里删除内容后界面永远不会刷新（修复前的根因）。
    // 删除进一步经 Vanished 信号按路径移除记录（文件不在，记录不留）。
    expect(watchSource).toContain("WatchSignal::Changed");
    expect(watchSource).toContain("WatchSignal::Vanished");
    expect(watchSource).toContain("EventKind::Remove(_)");
    expect(watchSource).toContain("EventKind::Modify(_)");
    expect(watchSource).toContain("EventKind::Access(_)");

    // 使用（粘贴/整组粘贴/拖出）写入使用时间后必须发事件，主窗口与径向
    // 菜单才能实时刷新徽标与「最近使用」排序；无实际变更不发。
    const touchStart = dbSource.indexOf("pub(crate) fn touch_clipboard_usage_internal");
    const touchBlock = dbSource.slice(touchStart, dbSource.indexOf("pub(crate) fn", touchStart + 10));
    expect(touchBlock).toContain("emit_usage_updated(app,");
    const groupTouchStart = dbSource.indexOf("pub(crate) fn touch_resource_group_usage_internal");
    const groupTouchBlock = dbSource.slice(
      groupTouchStart,
      dbSource.indexOf("pub fn touch_clipboard_usage", groupTouchStart),
    );
    expect(groupTouchBlock).toContain("emit_usage_updated(app,");

    // 主窗口从隐藏恢复显示时兜底重载当前视图：WebKitGTK 上 hide/show
    // 不触发 visibilitychange（实测），重载必须挂后端 main-window-shown
    // 广播；后端在 show_main_window（全部显示路径的汇聚点）发射该事件。
    expect(clipboardPageSource).toContain("useRefreshOnShow");
    expect(pageSource).toContain("useRefreshOnShow");
    const hookSource = readSource("../hooks/useRefreshOnShow.ts");
    expect(hookSource).toContain('listen("main-window-shown"');
    const libSource = readSource("../../src-tauri/src/lib.rs");
    expect(libSource).toContain('emit("main-window-shown"');

    // 兜底自愈：resource-groups-changed 是单次事件，被 WebView 丢弃时
    // 列表停留旧数据且无重试。资源页挂载期间必须定时拉取库修订号对账
    // （事件为主路径，轮询只补漏）；后端在监听冲刷与启动对账时自增。
    expect(pageSource).toContain("get_resource_library_revision");
    expect(dbSource).toContain("fn get_resource_library_revision");
    expect(dbSource).toContain("bump_resource_library_revision");
    expect(watchSource).toContain("bump_resource_library_revision");

    // 两页视图状态必须按页隔离：剪切板页与资源页曾共用 clipboardStore
    // 的 records/category，而两页永久保挂载，任何一方后台发起的加载都会
    // 经「加载代数最后者赢」覆盖对方正在显示的列表（切区/恢复显示后恒
    // 空白的根因）。资源页及其详情页必须使用独立 useResourceStore，
    // 不得回退到共享的 clipboardStore。
    expect(pageSource).toContain("useResourceStore");
    expect(pageSource).not.toContain("useClipboardStore");
    const detailSource = readSource("../pages/ResourcePage/ResourceDetailPage.tsx");
    expect(detailSource).toContain("useResourceStore");

    // 三个常挂页面的窗口恢复显示刷新必须齐全：短语页虽独占 phraseStore，
    // 但隐藏期间的增删改只能靠事件感知，事件丢失时同样需要兜底重载。
    const phrasePageSource = readSource("../pages/PhrasePage/index.tsx");
    expect(phrasePageSource).toContain("useRefreshOnShow");

    // 径向菜单弹出/展开/收起动效：窗口几何恒定（防 X11 闪烁）的前提
    // 下，动效全部在 web 层完成——弹出入场、预览滑入、收起滑出三段
    // 缺一不可，防止动效被静默删除后菜单变回"生硬瞬现"。
    const radialCssSource = readSource("../styles/radial-menu.css");
    expect(radialCssSource).toContain("radial-preview-in");
    expect(radialCssSource).toContain("radial-preview-out");
    expect(radialCssSource).toContain("preview-closing");
    expect(radialCssSource).toContain("radial-main-in");
    const radialMenuSource = readSource("../components/RadialMenu/index.tsx");
    expect(radialMenuSource).toContain("previewClosing");
    expect(radialMenuSource).toContain("collapsePreview(false)");

    // 快捷键二次按键收起：X11 grab 抢焦点触发 blur 自隐藏会与后端
    // 快捷键处理竞态（自隐藏抢先 → 后端误判未显示 → 重新弹出），
    // 自隐藏必须延迟一拍并在收到后端 hide/show 事件或焦点回归时取消。
    expect(radialMenuSource).toContain("blurHideTimerRef");
    expect(radialMenuSource).toContain("cancelPendingBlurHide");

    // 弹出/回收的可见动效全部由 web 层承担：窗管对"面板+条带"大矩形
    // 的 map/unmap 动画中心落在隐形条带里（逐帧实测：可见内容朝条带
    // 方向飞入/收回），且对映射窗口的移屏外请求会钳制回工作区（实测
    // (-20000,-20000) 被落成 (0,-32)，肉眼可见"另一个菜单"闪现左上角）。
    // 因此 Linux 侧窗口常驻映射，显示/隐藏只切换 web 内容可见性 +
    // 输入区域 + 焦点归还（park），几何从不改变。焦点判定/归还有两个
    // 实测陷阱：WebKitGTK 焦点悬在 input-only 子窗口（按顶层 xid 比较
    // 永不匹配）、_NET_ACTIVE_WINDOW 对非托管子窗口静默失效（prev 必须
    // 上溯到托管顶层）。
    expect(radialCssSource).toContain("radial-menu-closing");
    expect(radialCssSource).toContain("radial-main-out");
    expect(radialCssSource).toContain(".radial-menu-hidden .radial-menu-main");
    const radialMenuGtk = readShortcutSource();
    expect(radialMenuGtk).toContain("fn park_radial_window");
    expect(radialMenuGtk).toContain("RADIAL_MENU_SHOWN");
    expect(radialMenuGtk).toContain("x11_focus_toplevel_xid");
    expect(radialMenuGtk).toContain("x11_activate_window");
    expect(radialMenuGtk).toContain("is_active()");
    // 前端不得直接 unmap 径向窗口：一律走后端 hide_radial_menu 停泊。
    expect(radialMenuSource).toContain('invoke("hide_radial_menu")');
    expect(radialMenuSource).not.toContain("getCurrentWindow().hide()");
    // 启动即映射并清空输入区域（常驻模型的前置条件）。
    const libRsSource = readSource("../../src-tauri/src/lib.rs");
    expect(libRsSource).toContain("clear_radial_input");
    expect(libRsSource).toContain("shortcut::hide_radial_menu");
  });

  it("passes clipboard search into cards for highlighting", () => {
    const pageSource = readSource("../pages/ClipboardPage/index.tsx");

    expect(pageSource).toContain("search={search}");
  });

  it("keeps clipboard deletion on the shared cleanup path", () => {
    const dbSource = readDbSource();
    const deleteBlock = dbSource.slice(
      dbSource.indexOf("fn delete_clipboard_records_internal"),
      dbSource.indexOf("pub fn get_phrase_groups"),
    );

    expect(deleteBlock).toContain("DELETE FROM api_key_labels");
    expect(deleteBlock).toContain("SELECT COUNT(*) > 0 FROM clipboard_records");
    expect(deleteBlock).toContain("remove_file");
  });

  it("uses shared batch selection controls on both list pages", () => {
    const clipboardPage = readSource("../pages/ClipboardPage/index.tsx");
    const phrasePage = readSource("../pages/PhrasePage/index.tsx");
    const batchBar = readSource("../components/BatchSelectionBar.tsx");
    const libSource = readSource("../../src-tauri/src/lib.rs");

    expect(clipboardPage).toContain("<BatchSelectionBar");
    expect(phrasePage).toContain("<BatchSelectionBar");
    expect(clipboardPage).toContain("loadAllRecords");
    expect(clipboardPage).toContain("selectIds(allVisibleRecordIds)");
    expect(clipboardPage).toContain("const clipboardRecords = records.filter((r) => !isResourceRecord(r))");
    expect(clipboardPage).toContain(".filter((record) => !isResourceRecord(record))");
    expect(clipboardPage).not.toContain('if (category === "temp") return []');
    expect(clipboardPage).toContain('"clipboard.confirmDeleteSelected"');
    expect(clipboardPage).not.toContain("resourcesOnly");
    expect(clipboardPage).toContain("setDeletingSelected(true)");
    expect(clipboardPage).toContain("busy={selectingAll || deletingSelected}");
    expect(clipboardPage).toContain('busyLabel={deletingSelected ? t("common.deleting") : t("common.loading")}');
    expect(batchBar).toContain("batch-selection-spinner");
    expect(batchBar).toContain("disabled={selectedCount === 0 || busy}");
    expect(libSource).toContain("db::delete_clipboard_records");
    expect(libSource).toContain("db::delete_phrases");
  });

  it("keeps the resource library independent from clipboard history", () => {
    const appSource = readSource("../App.tsx");
    const clipboardPage = readSource("../pages/ClipboardPage/index.tsx");
    const radialMenu = readSource("../components/RadialMenu/index.tsx");
    const resourcePage = readSource("../pages/ResourcePage.tsx");

    expect(appSource).toContain('titleKey: "tabs.resources"');
    expect(appSource).toContain('{ panelType: "resources" }');
    expect(clipboardPage).not.toContain('{ key: "stash", label: t("clipboard.stash") }');
    expect(clipboardPage).not.toContain("resourcesOnly");
    expect(clipboardPage).not.toContain("useResourceGroupStore");
    expect(resourcePage).toContain("resource-library-page");
    expect(resourcePage).not.toContain("resource-mode-tab");
    expect(resourcePage).toContain("<ResourceCard");
    expect(resourcePage).not.toContain("ResourceQuickPreview");
    expect(resourcePage).toContain("<ResourceDetailPage");
    expect(resourcePage).toContain('loadRecords(false, "resources", resourceGroup)');
    expect(resourcePage).toContain('loadRecords(false, "resources", null)');
    const confirmDialogIndex = resourcePage.lastIndexOf("{confirmDialog}");
    expect(confirmDialogIndex).toBeGreaterThan(
      resourcePage.indexOf("{resourceGroupManageOpen &&"),
    );
    expect(confirmDialogIndex).toBeGreaterThan(
      resourcePage.indexOf("{resourceGroupDialog &&"),
    );
    expect(radialMenu).toContain("RADIAL_TAB_KEYS");
    // 快捷输入为默认 tab：「最近」tab 已移除，无记忆（首次使用）时
    // 打开菜单落在快捷输入「全部」（跨分组、按最近使用排序）。
    expect(radialMenu).toContain('useState<TabKey>("phrases")');
    expect(radialMenu).toContain("useState<string | null>(ALL_PHRASES_GROUP_ID)");
    // tab 用图标表达，名称经 aria-label / title 提示。
    expect(radialMenu).toContain("NAV_TAB_ICONS[tab]");
    expect(radialMenu).toContain('aria-label={t(`tabs.${tab}`)}');
    // 「记住上次模式」：手动切换即持久化，打开菜单恢复；用户先一步
    // 手动切换时，异步返回的记忆 tab 不得覆盖用户选择。
    expect(radialMenu).toContain('key: RADIAL_LAST_TAB_SETTING');
    expect(radialMenu).toContain("restoreLastTab");
    expect(radialMenu).toContain("if (tabTouchedRef.current) return;");
    // 快捷输入 tab 激活即回到「全部」并重载（聚合查询 get_all_phrases）。
    expect(radialMenu).toContain("buildAllPhraseItems");
    expect(radialMenu).toContain("loadPhrases(ALL_PHRASES_GROUP_ID)");
    // 资源 tab 依据记忆的分组位置加载（跨重启持久化），不再强制重置为"全部"。
    expect(radialMenu).toContain('useClipboardStore.getState().loadRecords(false, "resources", remembered)');
    expect(radialMenu).not.toContain('loadRecords(false, "resources", null)');
    expect(radialMenu).toContain('invoke("set_setting", {');
    expect(radialMenu).toContain('key: "radial_resource_group"');
    // 恢复期间用户已手动切换过分组时，记忆值不得覆盖用户选择。
    expect(radialMenu).toContain("resourceGroupTouchedRef.current = false");
    expect(radialMenu).toContain("if (resourceGroupTouchedRef.current) return;");
    expect(radialMenu).toContain('useClipboardStore.getState().setCategory("resources")');
    expect(radialMenu).toContain('clipboardCategory === "resources"');
    expect(radialMenu).toContain(".filter((r) => isResourceRecord(r))");
    expect(radialMenu).toContain("isContentPreviewAvailable");
    expect(radialMenu).not.toContain("previewAvailable: true");
  });

  it("keeps resource detail flow and batch selection aligned with current records", () => {
    const pageSource = readSource("../pages/ResourcePage.tsx");
    const cardSource = readSource("../pages/ResourcePage/ResourceCard.tsx");
    const detailPageSource = readSource("../pages/ResourcePage/ResourceDetailPage.tsx");
    const config = JSON.parse(readSource("../../src-tauri/tauri.conf.json")) as {
      app: { security: { csp: string; assetProtocol: { enable: boolean } } };
      bundle: { targets: string[]; resources: Record<string, string> };
    };
    const detailLoaderBlock = detailPageSource.slice(
      detailPageSource.indexOf("useEffect(() =>"),
      detailPageSource.indexOf("const title"),
    );

    expect(pageSource).toContain("const selectAllRequestRef = useRef(0);");
    expect(pageSource).toContain("if (selectingAll) return;");
    expect(pageSource).toContain("request !== selectAllRequestRef.current");
    expect(pageSource).toContain("cancelResourceSelection();");
    expect(pageSource).toContain("busy={selectingAll || deletingSelected}");
    expect(pageSource).toContain("{confirmDialog}");
    expect(cardSource).toContain("onOpenDetail");
    expect(cardSource).not.toContain("onTogglePreview");
    expect(detailLoaderBlock).toContain('|| kind === "image"');
    expect(detailPageSource).toContain("<ResourceImage");
    expect(detailPageSource).toContain("getResourcePath");
    const mediaSource = readSource("../pages/ResourcePage/ResourceMedia.tsx");
    const resourceStyles = readSource("../styles/resource.css");
    expect(mediaSource).toContain('openResourceFile(path)');
    expect(mediaSource).toContain('errorName !== "AbortError"');
    expect(mediaSource).toContain("if (failed || mediaFailed)");
    expect(mediaSource).toContain("onLoadedMetadata");
    expect(mediaSource).toContain("onCanPlay");
    expect(mediaSource).toContain("onPlay");
    expect(mediaSource).toContain("onError");
    expect(mediaSource).toContain("event.currentTarget !== mediaRef.current");
    expect(mediaSource).toContain("onMediaMetadata");
    expect(mediaSource).toContain("onMetadata");
    expect(mediaSource).toContain("resolveResourceMediaUrl");
    // 媒体 URL 必须携带文件版本（mediaVersion）：地址只由路径决定时，
    // 覆盖保存的文件会命中 WebView 旧缓存，预览停留在旧图。
    expect(detailPageSource).toContain("resolveResourceMediaUrl(resourcePath, mediaVersion)");
    expect(detailPageSource).toContain("set_resource_note");
    expect(detailPageSource).toContain("resource-note-input");
    expect(detailPageSource).toContain("metaResolution");
    expect(pageSource).toContain("computeResourceColumnCount");
    // 管理分组对话框的拖拽虚影必须 portal 到 body：对话框的
    // backdrop-filter/transform 会把 fixed 虚影的包含块劫持到对话框上。
    expect(pageSource).toContain("activeGroupRow && createPortal(");
    // 「回到顶部」统一走共享模块（剪贴板/快捷输入/资源/径向菜单共用）。
    expect(pageSource).toContain("useBackToTop");
    expect(readSource("../hooks/useBackToTop.ts")).toContain("export function useBackToTop");
    // 分组栏滚轮横滚收敛到共享 hook（剪切板/快捷输入/资源/径向菜单共用），
    // 行为由 useHorizontalWheelScroll.test.ts 真实验证。
    const groupChipsSource = readSource("../pages/ResourcePage/ResourceGroupChips.tsx");
    expect(groupChipsSource).toContain("useHorizontalWheelScroll");
    expect(readSource("../hooks/useHorizontalWheelScroll.ts")).toContain(
      "export function useHorizontalWheelScroll",
    );
    const libSource = readSource("../../src-tauri/src/lib.rs");
    const mediaServerSource = readSource("../../src-tauri/src/media_server.rs");
    const dbSource = readDbSource();
    expect(libSource).toContain("media_server::spawn");
    expect(mediaServerSource).toContain("Accept-Ranges: bytes");
    expect(mediaServerSource).toContain("get_media_server_origin");
    expect(dbSource).toContain("ADD COLUMN resource_note TEXT DEFAULT ''");
    expect(dbSource).toContain("fn set_resource_note");
    // resource-media-* 预览样式已随跨窗口共享迁移到 components.css。
    const sharedStyles = readSource("../styles/components.css");
    expect(sharedStyles).toContain(".resource-detail-stage-audio .resource-media-player");
    expect(sharedStyles).toContain("height: 40px");
    // CSP 收紧（E7）：不再放行任意 https 外联；asset 协议已停用，
    // 媒体一律经本机 media server（127.0.0.1）或 data/blob URL 加载。
    expect(config.app.security.csp).not.toContain("https:");
    expect(config.app.security.csp).toContain("media-src 'self' data: blob: http://127.0.0.1:*");
    expect(config.app.security.assetProtocol.enable).toBe(false);
    // ctl 脚本随安装包分发（F1 收尾）。
    expect(config.bundle.resources).toEqual({ "../scripts/copy-creator-ctl": "copy-creator-ctl" });
    // 发布产物与 GitHub Releases 四件套一致（E8）。
    expect(config.bundle.targets).toEqual(["appimage", "deb", "nsis", "msi"]);
    // asset 协议已停用（E7），img-src 只放行自身、内联数据与本机 media server。
    expect(config.app.security.csp).toContain("img-src 'self' data: blob: http://127.0.0.1:*");
    expect(config.app.security.csp).not.toContain("media-src *");
  });

  it("renders resource list card images from backend thumbnails", () => {
    const mediaSource = readSource("../pages/ResourcePage/ResourceMedia.tsx");
    const cardSource = readSource("../pages/ResourcePage/ResourceCard.tsx");
    const radialSource = readSource("../components/RadialMenu/index.tsx")
      + readSource("../components/RadialMenu/ResourceItemVisual.tsx")
      // 径向图片条目的横幅经共享 FileMediaVisual 渲染（内含 ResourceFileImage 缩略图管线）。
      + readSource("../components/FileMediaPreview.tsx");
    const radialStyles = readSource("../styles/radial-menu.css");
    const resourceStyles = readSource("../styles/resource.css");
    const libSource = readSource("../../src-tauri/src/lib.rs");
    const dbSource = readDbSource();

    // 密集网格卡片必须走缩略图：原图直出会在滚动时全尺寸解码造成卡顿。
    // 全宽横幅（剪切板/径向，经 FileMediaVisual）可视数量少，直接流式
    // 原图保证清晰度，不生成任何缩略图文件；详情页保持 ResourceImage 原图。
    expect(cardSource).toContain("<ResourceFileImage");
    expect(radialSource).toContain("<ResourceImage");
    expect(mediaSource).toContain('getResourceFileThumbnail(path, 256)');
    expect(mediaSource).toContain('loading="lazy"');
    expect(mediaSource).toContain('decoding="async"');
    // 回退原图必须携带版本：URL 随覆盖保存变化，WebView 不再命中旧缓存。
    expect(mediaSource).toContain(
      "return <ResourceImage path={path} alt={alt} className={className} version={version} />;",
    );
    expect(libSource).toContain("db::get_resource_file_thumbnail");
    // 缩略图解码必须在线程池执行（async 命令 + spawn_blocking），
    // 同步命令在主线程解码大图会冻结 UI。
    expect(dbSource).toContain("pub async fn get_resource_file_thumbnail");
    expect(dbSource).toContain("spawn_blocking");
    expect(dbSource).toContain('join("resource-thumbs")');
    // 屏幕外卡片跳过渲染，配合图片懒加载保持长列表滚动流畅。
    expect(radialStyles).toContain("content-visibility: auto");
    expect(resourceStyles).toContain("content-visibility: auto");
  });

  it("keeps resource-library storage separate from the app database", () => {
    const dbSource = readDbSource();
    const clipboardSource = readSource("../../src-tauri/src/clipboard.rs");
    const resourcePage = readSource("../pages/ResourcePage.tsx");
    const createDialog = readSource("../components/ClipboardCreateDialog/index.tsx");
    const pruneBlock = dbSource.slice(
      dbSource.indexOf("pub fn prune_old_records"),
      dbSource.indexOf("pub fn get_clipboard_records"),
    );

    expect(dbSource).toContain("resource_library_path");
    expect(dbSource).toContain("pub fn get_resource_library_path");
    // 切库后的全量对账含整库扫描，必须 async + spawn_blocking 离开主线程。
    expect(dbSource).toContain("pub async fn set_resource_library_path");
    expect(dbSource).toContain("pub async fn select_resource_library_folder");
    expect(dbSource).toContain("paths_overlap(&path, &storage_path)");
    expect(pruneBlock).toContain("COALESCE(storage_mode, 'database') = 'resource'");
    expect(pruneBlock).not.toContain("TRIM(COALESCE(group_name, '')) <> ''");
    expect(pruneBlock).not.toContain("resource_files");
    expect(dbSource).toContain("WHERE NOT ({RESOURCE_RECORD_CONDITION})");
    expect(dbSource).toContain("type = ?1 AND NOT ({RESOURCE_RECORD_CONDITION})");
    expect(dbSource).toContain("is_resource_record(&storage_mode)");
    expect(clipboardSource).toContain("let extension = if images.is_empty()");
    expect(clipboardSource).toContain('"txt"');
    expect(clipboardSource).toContain('"md"');
    expect(clipboardSource).toContain(".copy-creator/attachments/");
    expect(resourcePage).toContain('get_resource_library_path"');
    expect(resourcePage).toContain('select_resource_library_folder"');
    expect(resourcePage).toContain('set_resource_library_path"');
    expect(resourcePage).toContain('storageMode: "resource"');
    expect(createDialog).toContain("storageMode");
    expect(createDialog).toContain("handleDestChange");
    expect(createDialog).toContain('t("resources.storageLocation")');
    expect(createDialog).not.toContain("clipboard-create-storage-toggle");
  });

  it("keeps the resource area single-mode without a mode switch", () => {
    const pageSource = readSource("../pages/ResourcePage.tsx");

    expect(pageSource).not.toContain("handleSwitchMode");
    expect(pageSource).not.toContain("ResourceMode");
    expect(pageSource).not.toContain("setExpandedRecordId");
    expect(pageSource).toContain("cancelResourceSelection();");
  });

  // 径向菜单左向扩展的窗口闪烁修复。实机采集帧证据表明：X11 上对窗口
  // 做 resize/move 时，合成器必然绘出一帧"旧内容按左上锚定 + 新区域未
  // 绘制"（原子的 gdk move_resize 也无法避免），因此展开/收起必须完全
  // 不触碰窗口几何——条带在窗口打开时一次性预留，展开只挂载面板并扩放
  // 输入区域（XShape），收起反向；条带收起时点击穿透，不吞下层点击。
  it("expands the radial preview without any window geometry change", () => {
    const radialStyles = readSource("../styles/radial-menu.css");
    const radialMenu = readSource("../components/RadialMenu/index.tsx");
    const shortcutSource = readShortcutSource();
    const libSource = readSource("../../src-tauri/src/lib.rs");

    // 前端展开/收起路径不得再出现任何窗口几何操作。
    const previewFlow = radialMenu.slice(
      radialMenu.indexOf("const invalidatePreviewRequest = useCallback"),
      radialMenu.indexOf("const loadPreviewSegments = useCallback"),
    );
    expect(previewFlow).not.toContain("setSize");
    expect(previewFlow).not.toContain("setPosition");
    expect(previewFlow).toContain('invoke("set_radial_hit_area", { expanded: true })');
    expect(previewFlow).toContain('invoke("set_radial_hit_area", { expanded: false })');
    expect(radialMenu).not.toContain("set_radial_window_bounds");
    // 条带方向与宽度来自后端事件，不再由前端查询显示器计算。
    expect(radialMenu).toContain("previewSideRef.current");
    expect(radialMenu).toContain("previewWidthRef.current");
    expect(radialMenu).not.toContain("currentMonitor()");

    // 可见面板的背景/阴影在 main 上；popup 自身透明承载预留条带。
    const popupBlock = radialStyles.slice(
      radialStyles.indexOf(".radial-menu-popup {"),
      radialStyles.indexOf("/* --- Nav Tabs"),
    );
    expect(popupBlock).toContain(".radial-menu-main {");
    expect(popupBlock).toContain("margin-left: auto");
    // 预览面板绝对定位且不参与 flex 排版（挂载/卸载不移动主面板）。
    const previewBlock = radialStyles.slice(
      radialStyles.indexOf(".radial-menu-preview {"),
      radialStyles.indexOf("[data-theme=\"dark\"] .content-preview-panel"),
    );
    expect(previewBlock).toContain("position: absolute");
    expect(previewBlock).not.toContain("order: -1");
    // 收起态条带无元素绘制，必须靠 overlay 的近零 alpha 填充强制清屏，
    // 否则 WebKit 缓冲区残留展开面板圆角/阴影的旧像素（残影）。
    const overlayBlock = radialStyles.slice(
      radialStyles.indexOf(".radial-menu-overlay {"),
      radialStyles.indexOf(".radial-menu-overlay.radial-menu-hidden"),
    );
    expect(overlayBlock).toContain("rgba(0, 0, 0, 0.004)");
    expect(radialStyles).toContain("background: rgba(255, 255, 255, 0.004)");

    // 收起态四角必须全圆（用户可见回归）：拼接侧直角只允许出现在
    // 展开态（preview-open），否则收起面板条带侧露出方角。
    const stripLeftMain = radialStyles.slice(
      radialStyles.indexOf(".radial-menu-popup.strip-left .radial-menu-main {"),
      radialStyles.indexOf("}", radialStyles.indexOf(".radial-menu-popup.strip-left .radial-menu-main {")),
    );
    expect(stripLeftMain).toContain("margin-left: auto");
    expect(stripLeftMain).not.toContain("border-radius: 0");
    expect(radialStyles).toContain(
      ".radial-menu-popup.preview-open.strip-left .radial-menu-main {\n  border-radius: 0 var(--window-radius) var(--window-radius) 0;\n}",
    );

    // 后端在打开窗口时一次性预留条带并重置输入区域；命令已注册。
    expect(shortcutSource).toContain("static RADIAL_STRIP");
    expect(shortcutSource).toContain("apply_radial_input_shape(&radial, false)");
    expect(shortcutSource).toContain("pub fn set_radial_hit_area");
    expect(shortcutSource).toContain("input_shape_combine_region");
    expect(shortcutSource).toContain('"previewSide": preview_side');
    expect(libSource).toContain("shortcut::set_radial_hit_area,");
  });

  it("keeps the content panel for radial menu and uses inline previews on the main page", () => {
    const pageSource = readSource("../pages/ClipboardPage/index.tsx");
    const cardSource = readSource("../pages/ClipboardPage/ClipboardCard.tsx");
    const radialMenu = readSource("../components/RadialMenu/index.tsx");
    const previewPanel = readSource("../components/ContentPreviewPanel.tsx");
    const previewLoader = readSource("../domain/preview.ts");
    const clipboardStyles = readSource("../styles/clipboard.css");
    const persistWindowSize = readSource("../hooks/usePersistWindowSize.ts");
    const inlinePreview = readSource("../components/InlinePreview.tsx");
    const dbSource = readDbSource();
    const libSource = readSource("../../src-tauri/src/lib.rs");

    expect(radialMenu).toContain('<ContentPreviewPanel');
    expect(previewLoader).toContain("loadRecordPreviewSegments");
    expect(pageSource).not.toContain("<ContentPreviewPanel");
    expect(pageSource).not.toContain("getCurrentWindow");
    expect(pageSource).not.toContain("calculatePreviewExpansion");
    expect(previewPanel).toContain("onClose?: () => void;");
    expect(previewPanel).toContain("content-preview-close");
    expect(previewPanel).not.toContain("onDelete");
    expect(cardSource).toContain("ClipboardExpandedPreview");
    expect(cardSource).toContain("InlineImagePreview");
    expect(cardSource).toContain("InlineTextFilePreview");
    expect(cardSource).toContain("view.expandPreview");
    expect(clipboardStyles).not.toContain(".main-window-content-preview");
    expect(persistWindowSize).not.toContain("data-main-content-preview");
    expect(readSource('../domain/mediaAssets.ts')).toContain('read_quick_input_text_preview');
    expect(inlinePreview).toContain('readClipboardTextPreviewById');
    expect(inlinePreview).toContain("resolveResourceAssetUrl");
    expect(dbSource).toContain("read_quick_input_text_preview");
    expect(dbSource).toContain("read_clipboard_text_preview");
    // 后端文本预览与资源区共用同一份扩展名白名单（md 等常见格式均可预览）。
    expect(dbSource).toContain("fn is_text_preview_extension(path: &Path) -> bool {\n    crate::media_kind::is_text_extension(path)\n}");
    expect(dbSource).not.toContain("仅支持预览 JSON、TXT 和 TOML 文件");
    expect(libSource).toContain("db::read_quick_input_text_preview");
  });

  it("starts Linux file drags from the top-level GTK window", () => {
    const dragSource = readSource("../../src-tauri/src/radial_drag.rs");
    const libSource = readSource("../../src-tauri/src/lib.rs");
    const shortcutSource = readShortcutSource();
    const radialMenu = readSource("../components/RadialMenu/index.tsx");
    const pageSource = readSource("../pages/ClipboardPage/index.tsx");
    const cardSource = readSource("../pages/ClipboardPage/ClipboardCard.tsx");
    const previewPanel = readSource("../components/ContentPreviewPanel.tsx");
    const radialStyles = readSource("../styles/radial-menu.css");
    const radialDrag = readSource("../utils/radialDrag.ts");
    const pointerDownBlock = radialMenu.slice(
      radialMenu.indexOf("const handleItemPointerDown"),
      radialMenu.indexOf("const handleItemPointerMove"),
    );
    const pointerMoveBlock = radialMenu.slice(
      radialMenu.indexOf("const handleItemPointerMove"),
      radialMenu.indexOf("const handleItemPointerUp"),
    );
    const pointerUpBlock = radialMenu.slice(
      radialMenu.indexOf("const handleItemPointerUp"),
      radialMenu.indexOf("const handleRadialDragStarted"),
    );
    const listenerBlock = radialMenu.slice(
      radialMenu.indexOf("const setup = async () =>"),
      radialMenu.indexOf("// Mouse move: update hover state"),
    );
    const blurBlock = radialMenu.slice(
      radialMenu.indexOf("const handleBlur"),
      radialMenu.indexOf('document.addEventListener("mousemove"'),
    );
    expect(dragSource).toContain("install_linux_drag_source");
    expect(dragSource).toContain("gtk_window()");
    expect(dragSource).toContain("connect_drag_end");
    expect(dragSource).toContain("connect_drag_begin");
    expect(dragSource).not.toContain("drag_source_set(");
    expect(dragSource).not.toContain("connect_motion_notify_event");
    expect(dragSource).not.toContain("with_webview");
    expect(dragSource).toContain("connect_event_after");
    expect(dragSource).toContain("LINUX_POINTER_STATE");
    expect(dragSource).toContain("begin_linux_drag_session");
    expect(dragSource).toContain("seed_linux_pointer_press");
    expect(dragSource).toContain("LinuxDragToken");
    expect(dragSource).toContain("TargetList::new(&[])");
    expect(dragSource).toContain("target_list.add_uri_targets(0)");
    expect(dragSource).not.toContain("TargetEntry::new");
    expect(dragSource).not.toContain("drag_source_set_target_list");
    expect(dragSource).toContain("gio::File::for_path");
    expect(dragSource).toContain("data.set_uris");
    expect(dragSource).toContain("gdk::DragAction::COPY");
    expect(dragSource).toContain("drag_begin_with_coordinates");
    expect(dragSource).toContain("claim_linux_drag");
    expect(dragSource).toContain("pub async fn start_radial_file_drag");
    expect(dragSource).toContain("run_on_main_thread");
    expect(dragSource).toContain("tokio::sync::oneshot::channel");
    expect(dragSource).toContain("GTK main-thread drag arm returned");
    expect(dragSource).toContain(
      "drag_begin_with_coordinates(&target_list, gdk::DragAction::COPY, 1, drag_event, -1, -1)",
    );
    expect(dragSource).toContain('"radial-drag-started"');
    expect(dragSource).not.toContain("text/plain");
    expect(dragSource).toContain("screen_x: Option<f64>");
    expect(dragSource).toContain("device_pixel_ratio: Option<f64>");
    expect(dragSource).toContain("cancel_linux_drag(session_id)");
    const cancelCommandBlock = dragSource.slice(
      dragSource.indexOf("pub async fn cancel_radial_file_drag"),
      dragSource.indexOf("pub async fn start_radial_file_drag"),
    );
    expect(cancelCommandBlock).not.toContain("run_on_main_thread");
    expect(radialMenu).not.toContain("getTextDragData");
    expect(radialMenu).not.toContain("onDragStart");
    expect(radialMenu).not.toContain("onDragEnd");
    expect(radialMenu).not.toContain('draggable={item.dragKind === "text"}');
    expect(radialMenu).not.toContain("getRadialDragTarget");
    expect(radialMenu).toContain("handleItemPointerDown");
    expect(radialMenu).toContain("handleItemPointerMove");
    expect(radialMenu).toContain("document.addEventListener(\"pointerdown\"");
    expect(radialMenu).toContain("document.addEventListener(\"pointermove\"");
    expect(radialMenu).toContain("document.addEventListener(\"pointerup\"");
    expect(radialMenu).not.toContain("const handleWheel");
    expect(radialMenu).not.toContain('document.addEventListener("wheel"');
    // 禁止劫持滚动导致闪烁：不允许直接赋值 scrollTop；读取（回顶按钮可见性）不受限
    expect(radialMenu).not.toContain(".scrollTop =");
    expect(radialMenu).toContain("e.preventDefault();");
    expect(pointerMoveBlock.indexOf("e.preventDefault();")).toBeLessThan(
      pointerMoveBlock.indexOf("if (pending.nativeStarted) return;"),
    );
    expect(radialMenu).toContain("dismissPreviewForDrag");
    expect(radialMenu).toContain("startRadialFileDrag");
    expect(radialMenu).toContain("nativeStarted");
    expect(pointerMoveBlock).toContain("startRadialFileDrag(crossed)");
    expect(pointerDownBlock).not.toContain("start_radial_file_drag");
    expect(pointerDownBlock).toContain("sessionId:");
    expect(pointerDownBlock).toContain("startScreenX:");
    expect(pointerDownBlock).toContain("startScreenY:");
    expect(pointerDownBlock).toContain("devicePixelRatio:");
    expect(radialMenu).toContain("screenX: next.startScreenX");
    expect(radialMenu).toContain("screenY: next.startScreenY");
    expect(radialMenu).not.toContain("pendingReleaseTimerRef");
    expect(pointerUpBlock).not.toContain("setTimeout");
    expect(pointerMoveBlock).toContain("dragActiveRef.current = true");
    expect(radialMenu).toContain("markRadialDragStarted");
    expect(radialMenu).not.toContain("markRadialDragStarted(current)");
    expect(listenerBlock).toContain("Promise.all");
    expect(listenerBlock).toContain('"radial-drag-started"');
    expect(listenerBlock).toContain('"radial-drag-finished"');
    expect(listenerBlock).toContain("unlisteners = [unShow, unHide, unDragStarted, unDragFinished, unScaleChanged]");
    expect(listenerBlock).toContain("disposed");
    expect(listenerBlock).not.toContain("await loadPasteLeftClickSetting()");
    expect(listenerBlock).toContain("void loadPasteLeftClickSetting()");
    expect(listenerBlock.indexOf("visibleRef.current = true;")).toBeLessThan(
      listenerBlock.indexOf("void loadPasteLeftClickSetting();"),
    );
    expect(blurBlock).toContain("&& previewRef.current");
    expect(blurBlock).toContain("return;");
    expect(blurBlock).toContain("resetState();");
    expect(radialMenu).not.toContain("syncDragCandidate");
    expect(radialMenu).not.toContain("radial-menu-drag-surface");
    expect(radialMenu).not.toContain("(e.buttons & 1)");
    expect(radialMenu).not.toContain("setPointerCapture");
    expect(radialMenu).not.toContain("releasePointerCapture");
    expect(radialMenu).toContain("if (dragActiveRef.current || nativeDragRef.current)");
    expect(radialMenu).toContain("data-radial-drag-source={item.dragSource}");
    expect(radialMenu).toContain("data-radial-drag-path={item.dragPath}");
    expect(radialMenu).toContain('className={`radial-menu-preview${previewClosing ? " preview-closing" : ""}`}');
    expect(radialMenu).toContain("previewAvailable");
    expect(radialMenu).toContain("data-radial-preview-trigger");
    expect(radialMenu).toContain('closest("[data-radial-preview-trigger]")');
    expect(radialMenu).toContain("{preview && (");
    expect(radialMenu).toContain("const togglePreview = useCallback");
    expect(radialMenu).toContain("aria-expanded={preview?.itemId === item.id}");
    expect(radialMenu).not.toContain("schedulePreview");
    expect(radialMenu).not.toContain("onMouseEnter={(e) =>");
    // 预览展开/收起不再触碰窗口几何（几何固定是防闪烁方案的前提）。
    expect(radialMenu).not.toContain("windowRestoreRef");
    expect(radialMenu).toContain("onMouseLeave={handlePreviewLeave}");
    const armDragCatchBlock = radialMenu.slice(
      radialMenu.indexOf("const armRadialFileDrag"),
      radialMenu.indexOf("const finishPendingPointerDrag"),
    );
    expect(armDragCatchBlock).toContain("if (current.thresholdCrossed)");
    expect(armDragCatchBlock).toContain("collapsePreview();");
    const radialItemBlock = radialMenu.slice(
      radialMenu.indexOf('data-radial-item-id={item.id}'),
      radialMenu.indexOf("onClick={(e) => {", radialMenu.indexOf('data-radial-item-id={item.id}')),
    );
    expect(radialItemBlock).not.toContain("onMouseLeave");
    expect(pageSource).not.toContain("ContentPreviewPanel");
    expect(pageSource).not.toContain("onPreviewToggle");
    expect(pageSource).not.toContain("schedulePreview");
    expect(cardSource).toContain("aria-expanded={expanded}");
    expect(cardSource).toContain('className="card-toggle-text-btn"');
    expect(cardSource).toContain('className="notititle clipboard-card-footer"');
    expect(cardSource.lastIndexOf('className="card-toggle-text-btn"')).toBeGreaterThan(
      cardSource.indexOf('className="notititle clipboard-card-footer"'),
    );
    expect(previewPanel).toContain("draggable={false}");
    expect(radialStyles).toContain("cursor: default");
    expect(radialStyles).toContain("touch-action: none");
    expect(radialStyles).toContain("overscroll-behavior: contain");
    expect(radialStyles).toContain("align-self: stretch");
    expect(radialStyles).toContain("width: 100%");
    expect(radialStyles).not.toContain("cursor: grab;");
    expect(radialStyles).toContain("cursor: grabbing");
    expect(radialStyles).toContain(".radial-menu-preview-trigger");
    // 禁止预览按钮回退为绝对定位 bottom: 8px 的旧方案；锚定行首避免误伤 margin-bottom
    expect(radialStyles).not.toMatch(/^\s*bottom: 8px;/m);
    expect(radialStyles).not.toContain("padding-right: 48px");
    expect(radialStyles).toContain(".radial-menu-item-footer");
    expect(radialStyles).toContain("prefers-reduced-motion: reduce");
    expect(radialStyles).toContain(".radial-menu-popup.drag-session .content-preview-panel");
    expect(radialMenu).toContain('listen("radial-menu-hide", () => {');
    expect(shortcutSource).toContain('app.emit("radial-menu-hide", ())');
    expect(radialDrag).not.toContain('RadialDragKind = "text"');
    expect(libSource).toContain("start_radial_file_drag");
    expect(libSource).toContain("install_radial_file_drag_source");
    expect(libSource).not.toContain("prepare_radial_file_drag");
    expect(libSource).not.toContain("clear_radial_file_drag");
    expect(libSource).not.toContain("reset_radial_drag_candidate");
    expect(libSource).not.toContain("initialize_linux_drag");
    expect(libSource).toContain("cancel_radial_file_drag");
  });
});
