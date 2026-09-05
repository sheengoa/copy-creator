/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("integration regressions", () => {
  it("does not re-show hidden windows from delayed raise paths", () => {
    const libSource = readSource("../src-tauri/src/lib.rs");
    const delayedMainBlock = libSource.slice(
      libSource.indexOf("Duration::from_millis(250)"),
      libSource.indexOf("main window not found (delayed startup)"),
    );
    expect(delayedMainBlock).not.toContain(".show()");
    expect(delayedMainBlock).toContain("is_visible()");

    const shortcutSource = readSource("../src-tauri/src/shortcut.rs");
    expect(shortcutSource).not.toContain("refresh_always_on_top_if_visible");
    expect(shortcutSource).not.toContain("Duration::from_millis(60)");
    expect(shortcutSource).toContain("raise_always_on_top(&radial);");
    expect(shortcutSource).toContain("if window.is_visible().unwrap_or(false)");
    expect(shortcutSource).toContain("window.set_always_on_top(true)");
  });

  it("does not animate the radial popup during native window mapping", () => {
    const radialStyles = readSource("./styles/radial-menu.css");

    expect(radialStyles).toContain(".radial-menu-overlay.radial-menu-hidden");
    expect(radialStyles).not.toContain("radial-menu-hidden .radial-menu-popup");
    expect(radialStyles).not.toContain("animation: radialMenuIn");
    expect(radialStyles).not.toContain("@keyframes radialMenuIn");
  });

  it("keeps a visible radial menu above the clipboard create dialog", () => {
    const shortcutSource = readSource("../src-tauri/src/shortcut.rs");
    const libSource = readSource("../src-tauri/src/lib.rs");
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
    expect(shortcutSource).toContain("if radial.is_visible().unwrap_or(false)");
    expect(createBlock).toContain("raise_visible_popup_windows(app);");
    expect(libSource).toContain("shortcut::has_visible_popup_window(app)");
    expect(libSource).toContain("shortcut::raise_visible_popup_windows(&app_handle)");
  });

  it("uses the shared main-window show path for Linux IPC", () => {
    const ipcSource = readSource("../src-tauri/src/ipc.rs");

    expect(ipcSource).toContain('crate::show_main_window(app, "ipc", false);');
    expect(ipcSource).not.toContain("static SHOWING");
    expect(ipcSource).not.toContain("set_always_on_top(true)");
  });

  it("uses the same six-line card folding for quick input and clipboard cards", () => {
    const phraseSource = readSource("./pages/PhrasePage/PhraseList.tsx");
    const clipboardSource = readSource("./pages/ClipboardPage/ClipboardCard.tsx");
    const phraseStyles = readSource("./styles/phrases.css");
    const clipboardStyles = readSource("./styles/clipboard.css");
    const inlinePreview = readSource("./utils/inlinePreview.ts");

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
    expect(clipboardSource).toContain("shouldShowInlineTextToggle");
    expect(clipboardSource).toContain('record.type === "file"');
    expect(clipboardSource).toContain("? canPreviewFile");
    expect(clipboardStyles).toContain(".clipboard-card-body.is-collapsed");
    expect(clipboardStyles).toContain("calc(1.5em * 6)");
    expect(inlinePreview).toContain("INLINE_PREVIEW_MAX_LINES = 6");
  });

  it("sizes the quick input editor dialog relative to the main window", () => {
    const dialogSource = readSource("./pages/PhrasePage/PhraseDialog.tsx");
    const componentsStyles = readSource("./styles/components.css");

    expect(dialogSource).toContain('className="dialog-content large phrase-dialog-content"');
    expect(componentsStyles).toContain(".dialog-content.large.phrase-dialog-content");
    expect(componentsStyles).toContain("width: clamp(360px, 72vw, 720px);");
    expect(componentsStyles).toContain("max-width: calc(100vw - 32px);");
    expect(componentsStyles).toContain("max-height: calc(100vh - 32px);");
  });

  it("keeps migrated clipboard schema compatible with current record fields", () => {
    const dbSource = readSource("../src-tauri/src/db.rs");
    const migrateBlock = dbSource.slice(
      dbSource.indexOf("fn migrate_storage"),
      dbSource.indexOf("CREATE TABLE IF NOT EXISTS phrase_groups", dbSource.indexOf("fn migrate_storage")),
    );

    expect(migrateBlock).toContain("sort_order REAL");
    expect(migrateBlock).toContain("group_name TEXT DEFAULT ''");
    expect(migrateBlock).toContain("idx_clipboard_sort_order");
  });

  it("classifies manually saved content through the shared stash path", () => {
    const clipboardSource = readSource("../src-tauri/src/clipboard.rs");
    const saveStart = clipboardSource.indexOf("pub fn save_stash_record");
    const saveBlock = clipboardSource.slice(
      saveStart,
      clipboardSource.indexOf("#[tauri::command]", saveStart),
    );

    expect(saveBlock).toContain("classify_text_record(&content)");
    expect(saveBlock).toContain('"type": record_type');
  });

  it("updates stash records and moves them to the top without changing creation time", () => {
    const dbSource = readSource("../src-tauri/src/db.rs");
    const updateBlock = dbSource.slice(
      dbSource.indexOf("pub fn update_clipboard_record"),
      dbSource.indexOf("pub fn delete_all_clipboard_records"),
    );
    const libSource = readSource("../src-tauri/src/lib.rs");

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
    const componentSource = readSource("./components/ClipboardCreateDialog/index.tsx");

    expect(componentSource).toContain('get_setting", { key: "language"');
    expect(componentSource).toContain("i18n.changeLanguage");
  });

  it("supports resource groups through library subfolders", () => {
    const dbSource = readSource("../src-tauri/src/db.rs");
    const clipboardSource = readSource("../src-tauri/src/clipboard.rs");
    const pageSource = readSource("./pages/ResourcePage.tsx");
    const componentSource = readSource("./components/ClipboardCreateDialog/index.tsx");

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
    expect(pageSource).toContain("resource-group-section");
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

  it("passes clipboard search into cards for highlighting", () => {
    const pageSource = readSource("./pages/ClipboardPage/index.tsx");

    expect(pageSource).toContain("search={search}");
  });

  it("keeps clipboard deletion on the shared cleanup path", () => {
    const dbSource = readSource("../src-tauri/src/db.rs");
    const deleteBlock = dbSource.slice(
      dbSource.indexOf("fn delete_clipboard_records_internal"),
      dbSource.indexOf("pub fn get_phrase_groups"),
    );

    expect(deleteBlock).toContain("DELETE FROM api_key_labels");
    expect(deleteBlock).toContain("SELECT COUNT(*) > 0 FROM clipboard_records");
    expect(deleteBlock).toContain("remove_file");
  });

  it("uses shared batch selection controls on both list pages", () => {
    const clipboardPage = readSource("./pages/ClipboardPage/index.tsx");
    const phrasePage = readSource("./pages/PhrasePage/index.tsx");
    const batchBar = readSource("./components/BatchSelectionBar.tsx");
    const libSource = readSource("../src-tauri/src/lib.rs");

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
    const appSource = readSource("./App.tsx");
    const clipboardPage = readSource("./pages/ClipboardPage/index.tsx");
    const radialMenu = readSource("./components/RadialMenu/index.tsx");
    const resourcePage = readSource("./pages/ResourcePage.tsx");

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
    expect(radialMenu).toContain('["clipboard", "phrases", "resources"]');
    expect(radialMenu).toContain('useClipboardStore.getState().loadRecords(false, "resources", null)');
    expect(radialMenu).toContain('useClipboardStore.getState().setCategory("resources")');
    expect(radialMenu).toContain('clipboardCategory === "resources"');
    expect(radialMenu).toContain(".filter((r) => isResourceRecord(r))");
    expect(radialMenu).toContain("isContentPreviewAvailable");
    expect(radialMenu).not.toContain("previewAvailable: true");
  });

  it("keeps resource detail flow and batch selection aligned with current records", () => {
    const pageSource = readSource("./pages/ResourcePage.tsx");
    const cardSource = readSource("./pages/ResourcePage/ResourceCard.tsx");
    const detailPageSource = readSource("./pages/ResourcePage/ResourceDetailPage.tsx");
    const config = JSON.parse(readSource("../src-tauri/tauri.conf.json")) as {
      app: { security: { csp: string } };
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
    expect(pageSource).toContain("record.resource_managed !== false");
    expect(pageSource).toContain("{confirmDialog}");
    expect(cardSource).toContain("onOpenDetail");
    expect(cardSource).not.toContain("onTogglePreview");
    expect(detailLoaderBlock).toContain('|| kind === "image"');
    expect(detailPageSource).toContain("<ResourceImage");
    expect(detailPageSource).toContain("getResourcePath");
    const mediaSource = readSource("./pages/ResourcePage/ResourceMedia.tsx");
    const resourceStyles = readSource("./styles/resource.css");
    expect(mediaSource).toContain('open_resource_file');
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
    expect(detailPageSource).toContain("resolveResourceMediaUrl(resourcePath)");
    expect(detailPageSource).toContain("set_resource_note");
    expect(detailPageSource).toContain("resource-note-input");
    expect(detailPageSource).toContain("metaResolution");
    expect(pageSource).toContain("computeResourceColumnCount");
    expect(pageSource).toContain("resource-back-to-top");
    expect(pageSource).toContain("resourceGroupScrollRef");
    const libSource = readSource("../src-tauri/src/lib.rs");
    const mediaServerSource = readSource("../src-tauri/src/media_server.rs");
    const dbSource = readSource("../src-tauri/src/db.rs");
    expect(libSource).toContain("media_server::spawn");
    expect(mediaServerSource).toContain("Accept-Ranges: bytes");
    expect(mediaServerSource).toContain("get_media_server_origin");
    expect(dbSource).toContain("ADD COLUMN resource_note TEXT DEFAULT ''");
    expect(dbSource).toContain("fn set_resource_note");
    expect(resourceStyles).toContain(".resource-detail-stage-audio .resource-media-player");
    expect(resourceStyles).toContain("height: 40px");
    expect(config.app.security.csp).toContain(
      "media-src 'self' asset: https://asset.localhost http://127.0.0.1:* data: blob:",
    );
    expect(config.app.security.csp).not.toContain("media-src *");
  });


  it("keeps resource-library storage separate from the app database", () => {
    const dbSource = readSource("../src-tauri/src/db.rs");
    const clipboardSource = readSource("../src-tauri/src/clipboard.rs");
    const resourcePage = readSource("./pages/ResourcePage.tsx");
    const createDialog = readSource("./components/ClipboardCreateDialog/index.tsx");
    const pruneBlock = dbSource.slice(
      dbSource.indexOf("pub fn prune_old_records"),
      dbSource.indexOf("// ---- Tauri Commands ----"),
    );

    expect(dbSource).toContain("resource_library_path");
    expect(dbSource).toContain("pub fn get_resource_library_path");
    expect(dbSource).toContain("pub fn set_resource_library_path");
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
    const pageSource = readSource("./pages/ResourcePage.tsx");

    expect(pageSource).not.toContain("handleSwitchMode");
    expect(pageSource).not.toContain("ResourceMode");
    expect(pageSource).not.toContain("setExpandedRecordId");
    expect(pageSource).toContain("cancelResourceSelection();");
  });

  it("keeps the content panel for radial menu and uses inline previews on the main page", () => {
    const pageSource = readSource("./pages/ClipboardPage/index.tsx");
    const cardSource = readSource("./pages/ClipboardPage/ClipboardCard.tsx");
    const radialMenu = readSource("./components/RadialMenu/index.tsx");
    const previewPanel = readSource("./components/ContentPreviewPanel.tsx");
    const previewLoader = readSource("./utils/contentPreview.ts");
    const clipboardStyles = readSource("./styles/clipboard.css");
    const persistWindowSize = readSource("./hooks/usePersistWindowSize.ts");
    const inlinePreview = readSource("./components/InlinePreview.tsx");
    const dbSource = readSource("../src-tauri/src/db.rs");
    const libSource = readSource("../src-tauri/src/lib.rs");

    expect(radialMenu).toContain('<ContentPreviewPanel');
    expect(previewLoader).toContain("loadClipboardPreviewSegments");
    expect(pageSource).not.toContain("<ContentPreviewPanel");
    expect(pageSource).not.toContain("getCurrentWindow");
    expect(pageSource).not.toContain("calculatePreviewExpansion");
    expect(previewPanel).toContain("onClose?: () => void;");
    expect(previewPanel).toContain("content-preview-close");
    expect(previewPanel).not.toContain("onDelete");
    expect(cardSource).toContain("ClipboardExpandedPreview");
    expect(cardSource).toContain("InlineImagePreview");
    expect(cardSource).toContain("InlineTextFilePreview");
    expect(cardSource).toContain("hasInlineTextPreviewExtension");
    expect(clipboardStyles).not.toContain(".main-window-content-preview");
    expect(persistWindowSize).not.toContain("data-main-content-preview");
    expect(inlinePreview).toContain('read_quick_input_text_preview');
    expect(inlinePreview).toContain('read_clipboard_text_preview');
    expect(inlinePreview).toContain("resolveResourceAssetUrl");
    expect(dbSource).toContain("read_quick_input_text_preview");
    expect(dbSource).toContain("read_clipboard_text_preview");
    expect(dbSource).toContain("仅支持预览 JSON、TXT 和 TOML 文件");
    expect(libSource).toContain("db::read_quick_input_text_preview");
  });

  it("starts Linux file drags from the top-level GTK window", () => {
    const dragSource = readSource("../src-tauri/src/radial_drag.rs");
    const libSource = readSource("../src-tauri/src/lib.rs");
    const shortcutSource = readSource("../src-tauri/src/shortcut.rs");
    const radialMenu = readSource("./components/RadialMenu/index.tsx");
    const pageSource = readSource("./pages/ClipboardPage/index.tsx");
    const cardSource = readSource("./pages/ClipboardPage/ClipboardCard.tsx");
    const previewPanel = readSource("./components/ContentPreviewPanel.tsx");
    const radialStyles = readSource("./styles/radial-menu.css");
    const radialDrag = readSource("./utils/radialDrag.ts");
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
    expect(listenerBlock).toContain("unlisteners = [unShow, unHide, unDragStarted, unDragFinished]");
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
    expect(radialMenu).toContain('className="radial-menu-preview"');
    expect(radialMenu).toContain("previewAvailable");
    expect(radialMenu).toContain("data-radial-preview-trigger");
    expect(radialMenu).toContain('closest("[data-radial-preview-trigger]")');
    expect(radialMenu).toContain("{preview && (");
    expect(radialMenu).toContain("const togglePreview = useCallback");
    expect(radialMenu).toContain("aria-expanded={preview?.itemId === item.id}");
    expect(radialMenu).not.toContain("schedulePreview");
    expect(radialMenu).not.toContain("onMouseEnter={(e) =>");
    expect(radialMenu).toContain("windowRestoreRef");
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
    expect(radialMenu).toContain('listen("radial-menu-hide", resetStateForNativeHide)');
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
