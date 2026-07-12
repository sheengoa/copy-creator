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

  it("keeps standalone clipboard create language in sync", () => {
    const componentSource = readSource("./components/ClipboardCreateDialog/index.tsx");

    expect(componentSource).toContain('get_setting", { key: "language"');
    expect(componentSource).toContain("i18n.changeLanguage");
  });

  it("passes clipboard search into cards for highlighting", () => {
    const pageSource = readSource("./pages/ClipboardPage/index.tsx");

    expect(pageSource).toContain("search={search}");
  });
});
