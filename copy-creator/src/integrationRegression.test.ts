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
    const refreshBlock = shortcutSource.slice(
      shortcutSource.indexOf("fn refresh_always_on_top_if_visible"),
      shortcutSource.indexOf("pub fn show_radial_menu"),
    );
    expect(refreshBlock).toContain("is_visible()");
    expect(refreshBlock).not.toContain(".show()");

    const delayedRadialBlock = shortcutSource.slice(
      shortcutSource.indexOf("Duration::from_millis(60)"),
      shortcutSource.indexOf("[show_radial_menu] shown"),
    );
    expect(delayedRadialBlock).toContain("refresh_always_on_top_if_visible");
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

    expect(updateBlock).toContain('group_name != "暂存" && group_name != "stash"');
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
    const libSource = readSource("../src-tauri/src/lib.rs");

    expect(clipboardPage).toContain("<BatchSelectionBar");
    expect(phrasePage).toContain("<BatchSelectionBar");
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
    expect(radialMenu).toContain('useClipboardStore.getState().loadRecords(false, "stash")');
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
    expect(pageSource).toContain('addEventListener("pointerleave"');
    expect(pageSource).toContain('addEventListener("pointerout"');
    expect(pageSource).toContain('addEventListener("mouseout"');
    expect(pageSource).toContain("visibilitychange");
    expect(pageSource).toContain("relatedTarget.closest(\".clipboard-card\")");
    expect(pageSource).toContain("main-window-content-preview");
    expect(clipboardStyles).toContain(':root[data-main-content-preview="right"] .app-container');
    expect(clipboardStyles).toContain(':root[data-main-content-preview="left"] .app-container');
    expect(clipboardStyles).toContain('data-main-content-preview-state="restoring"');
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
});
