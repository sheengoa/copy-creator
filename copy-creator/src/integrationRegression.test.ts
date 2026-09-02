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

  it("classifies and enriches manually created clipboard records", () => {
    const clipboardSource = readSource("../src-tauri/src/clipboard.rs");
    const createBlock = clipboardSource.slice(
      clipboardSource.indexOf("pub fn create_clipboard_record"),
      clipboardSource.indexOf("fn make_text_event_content"),
    );

    expect(createBlock).toContain("classify_text_record(&content)");
    expect(createBlock).toContain("api_key_metadata(&app, &id, record_type, &content)");
    expect(createBlock).toContain("\"type\": record_type");
  });

  it("updates stash records and moves them to the top without changing creation time", () => {
    const dbSource = readSource("../src-tauri/src/db.rs");
    const updateBlock = dbSource.slice(
      dbSource.indexOf("pub fn update_clipboard_record"),
      dbSource.indexOf("pub fn delete_all_clipboard_records"),
    );
    const libSource = readSource("../src-tauri/src/lib.rs");

    expect(updateBlock).toContain("resource_group_name_exists(&conn, &group_name)");
    expect(updateBlock).not.toContain('group_name != "暂存" && group_name != "stash"');
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

  it("supports resource groups for resource records", () => {
    const dbSource = readSource("../src-tauri/src/db.rs");
    const clipboardSource = readSource("../src-tauri/src/clipboard.rs");
    const pageSource = readSource("./pages/ClipboardPage/index.tsx");
    const componentSource = readSource("./components/ClipboardCreateDialog/index.tsx");
    const groupChipsSource = readSource("./pages/PhrasePage/GroupChips.tsx");
    const manageGroupsSource = readSource("./pages/PhrasePage/ManageGroupsDialog.tsx");

    expect(dbSource).toContain("CREATE TABLE IF NOT EXISTS resource_groups");
    expect(dbSource).toContain("pub fn create_resource_group");
    expect(dbSource).toContain("pub fn update_resource_group");
    expect(dbSource).toContain("pub fn delete_resource_group");
    expect(clipboardSource).toContain("group_name: Option<String>");
    expect(clipboardSource).toContain("target_group_name");
    expect(pageSource).toContain("useResourceGroupStore");
    expect(pageSource).toContain("selectedGroupId={selectedResourceGroupId}");
    expect(pageSource).toContain("onAddGroup={openNewResourceGroup}");
    expect(groupChipsSource).not.toContain("onAddGroup");
    expect(manageGroupsSource).toContain("onAddGroup");
    expect(componentSource).toContain('category: "resources"');
    expect(componentSource).toContain("clipboard-create-resource-group-section");
    expect(componentSource).toContain("visibleStashRecords");
    expect(componentSource).toContain("record.group_name === groupName");
    expect(componentSource).not.toContain("clipboard-create-resource-group-select");
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
    expect(clipboardPage).toContain("const clipboardRecords = records.filter((r) => !r.group_name)");
    expect(clipboardPage).toContain(".filter((record) => !record.group_name)");
    expect(clipboardPage).toContain('if (category === "stash") return []');
    expect(clipboardPage).toContain('resourcesOnly ? "resources.confirmDeleteSelected" : "clipboard.confirmDeleteSelected"');
    expect(clipboardPage).toContain("setDeletingSelected(true)");
    expect(clipboardPage).toContain("busy={selectingAll || deletingSelected}");
    expect(clipboardPage).toContain('busyLabel={deletingSelected ? t("common.deleting") : t("common.loading")}');
    expect(batchBar).toContain("batch-selection-spinner");
    expect(batchBar).toContain("disabled={selectedCount === 0 || busy}");
    expect(libSource).toContain("db::delete_clipboard_records");
    expect(libSource).toContain("db::delete_phrases");
  });

  it("keeps stash records under the resources navigation", () => {
    const appSource = readSource("./App.tsx");
    const clipboardPage = readSource("./pages/ClipboardPage/index.tsx");
    const radialMenu = readSource("./components/RadialMenu/index.tsx");
    const resourcePage = readSource("./pages/ResourcePage.tsx");

    expect(appSource).toContain('titleKey: "tabs.resources"');
    expect(appSource).toContain('{ panelType: "resources" }');
    expect(clipboardPage).not.toContain('{ key: "stash", label: t("clipboard.stash") }');
    expect(resourcePage).toContain("<ClipboardPage resourcesOnly />");
    expect(radialMenu).toContain('["clipboard", "phrases", "resources"]');
    expect(radialMenu).toContain('useClipboardStore.getState().loadRecords(false, "resources")');
    expect(radialMenu).toContain('useClipboardStore.getState().setCategory("resources")');
    expect(radialMenu).toContain('clipboardCategory === "resources"');
    expect(radialMenu).toContain('.filter((r) => Boolean(r.group_name))');
    expect(clipboardPage).toContain('hasMore && (resourcesOnly || filtered.length > 0)');
    expect(clipboardPage).toContain('resourcesOnly && hasMore');
  });

  it("keeps resource group operation errors visible and preserves failed dialog state", () => {
    const pageSource = readSource("./pages/ClipboardPage/index.tsx");
    const storeSource = readSource("./stores/resourceGroupStore.ts");
    const groupDialogSource = readSource("./pages/PhrasePage/GroupDialog.tsx");
    const manageGroupsSource = readSource("./pages/PhrasePage/ManageGroupsDialog.tsx");

    expect(storeSource).toContain("error: string | null");
    expect(storeSource).toContain("clearError: () => void");
    expect(storeSource).toContain("error: null");
    expect(storeSource).toContain("return false;");
    expect(pageSource).toContain("if (!group) return;");
    expect(pageSource).toContain("if (!updated) return;");
    expect(pageSource).toContain("error={resourceGroupError}");
    expect(groupDialogSource).toContain('role="alert"');
    expect(manageGroupsSource).toContain('role="alert"');
  });

  it("uses the shared window-level panel instead of in-card previews", () => {
    const pageSource = readSource("./pages/ClipboardPage/index.tsx");
    const cardSource = readSource("./pages/ClipboardPage/ClipboardCard.tsx");
    const radialMenu = readSource("./components/RadialMenu/index.tsx");
    const previewLoader = readSource("./utils/contentPreview.ts");
    const clipboardStyles = readSource("./styles/clipboard.css");
    const persistWindowSize = readSource("./hooks/usePersistWindowSize.ts");

    expect(pageSource).toContain('<ContentPreviewPanel');
    expect(radialMenu).toContain('<ContentPreviewPanel');
    expect(previewLoader).toContain("loadClipboardPreviewSegments");
    expect(pageSource).toContain("appWindow.outerSize()");
    expect(pageSource).toContain("calculatePreviewExpansion");
    expect(pageSource).toContain("--main-content-preview-main-width");
    expect(pageSource).toContain("mainContentPreviewState");
    expect(pageSource).toContain("previewRestoringRef");
    expect(pageSource).toContain("finishMainPreviewRestore");
    expect(pageSource).toContain("useLayoutEffect");
    expect(pageSource).toContain('addEventListener("pointerleave"');
    expect(pageSource).toContain('addEventListener("pointerout"');
    expect(pageSource).toContain('addEventListener("mouseout"');
    expect(pageSource).toContain("visibilitychange");
    expect(pageSource).toContain("relatedTarget.closest(\".clipboard-card\")");
    expect(pageSource).toContain("main-window-content-preview");
    expect(clipboardStyles).toContain(':root[data-main-content-preview="right"] .app-container');
    expect(clipboardStyles).toContain(':root[data-main-content-preview="left"] .app-container');
    expect(clipboardStyles).toContain('data-main-content-preview-state="restoring"');
    expect(clipboardStyles).toContain(':root[data-main-content-preview-state="restoring"] .main-window-content-preview');
    expect(clipboardStyles).not.toContain(".clipboard-content-preview");
    expect(persistWindowSize).toContain('hasAttribute("data-main-content-preview")');
    expect(cardSource).not.toContain("textExpanded");
    expect(cardSource).not.toContain("card-toggle-text-btn");
    expect(cardSource).toContain("onMouseLeave={onPreviewLeave}");
    expect(pageSource).not.toContain("thumb-hover-overlay");
    expect(clipboardStyles).not.toContain(".thumb-hover-overlay");
    expect(clipboardStyles).not.toContain(".image-preview-overlay");
    expect(clipboardStyles).not.toContain(".image-preview-backdrop");
    expect(clipboardStyles).not.toContain(".image-preview-img");
    expect(clipboardStyles).not.toContain(".card-toggle-text-btn");
  });

  it("starts Linux file drags from the top-level GTK window", () => {
    const dragSource = readSource("../src-tauri/src/radial_drag.rs");
    const libSource = readSource("../src-tauri/src/lib.rs");
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
    expect(radialMenu).not.toContain("scrollTop");
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
    expect(listenerBlock).toContain("disposed");
    expect(listenerBlock).not.toContain("await loadPasteLeftClickSetting()");
    expect(listenerBlock).toContain("void loadPasteLeftClickSetting()");
    expect(listenerBlock.indexOf("visibleRef.current = true;")).toBeLessThan(
      listenerBlock.indexOf("void loadPasteLeftClickSetting();"),
    );
    expect(radialMenu).toContain(
      "if (!dragActiveRef.current && !pending) return;",
    );
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
    expect(pageSource).toContain("const togglePreview = useCallback");
    expect(pageSource).toContain("onPreviewToggle={togglePreview}");
    expect(pageSource).not.toContain("schedulePreview");
    expect(cardSource).toContain("aria-expanded={previewOpen}");
    expect(cardSource).toContain('className="notititle clipboard-card-footer"');
    expect(cardSource.lastIndexOf('className="clipboard-preview-trigger"')).toBeGreaterThan(
      cardSource.indexOf('className="notititle clipboard-card-footer"'),
    );
    const mainPreviewExpandBlock = pageSource.slice(
      pageSource.indexOf("const expandPreviewWindow"),
      pageSource.indexOf("const showPreview"),
    );
    expect(mainPreviewExpandBlock).toContain("if (windowRestoreRef.current) await windowRestoreRef.current;");
    expect(mainPreviewExpandBlock).toContain("if (previewRestoringRef.current)");
    expect(mainPreviewExpandBlock).not.toContain("await appWindow.setSize(innerSize);");
    expect(previewPanel).toContain("draggable={false}");
    expect(radialStyles).toContain("cursor: default");
    expect(radialStyles).toContain("touch-action: none");
    expect(radialStyles).toContain("overscroll-behavior: contain");
    expect(radialStyles).toContain("align-self: stretch");
    expect(radialStyles).toContain("width: 100%");
    expect(radialStyles).not.toContain("cursor: grab;");
    expect(radialStyles).toContain("cursor: grabbing");
    expect(radialStyles).toContain(".radial-menu-preview-trigger");
    expect(radialStyles).toContain("bottom: 8px");
    expect(radialStyles).not.toContain("top: 8px;\n  right: 8px;");
    expect(radialStyles).toContain("padding-right: 48px");
    expect(radialStyles).toContain("prefers-reduced-motion: reduce");
    expect(radialStyles).toContain(".radial-menu-popup.drag-session .content-preview-panel");
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
