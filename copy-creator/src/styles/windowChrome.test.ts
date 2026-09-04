/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function readStyle(name: string) {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function getRule(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

describe("standalone window chrome", () => {
  it("keeps radial menu corners clean on transparent windows", () => {
    const popupRule = getRule(readStyle("radial-menu.css"), ".radial-menu-popup");
    const libSource = readSource("../../src-tauri/src/lib.rs");
    const radialWindowBlock = libSource.slice(
      libSource.indexOf('"radial-menu"'),
      libSource.indexOf("Radial menu popup window created"),
    );

    expect(popupRule).not.toContain("0 20px 60px");
    expect(radialWindowBlock).toContain(".transparent(true)");
  });

  it("matches clipboard create window background with the main panel tone", () => {
    const dialogRule = getRule(readStyle("clipboard.css"), ".clipboard-create-dialog");

    expect(dialogRule).toContain("background: var(--panel-bg)");
    expect(dialogRule).toContain("border-radius: var(--window-radius)");
    expect(dialogRule).toContain("clip-path: inset(0 round var(--window-radius))");
  });

  it("uses wider clipboard create action buttons", () => {
    const footerRule = getRule(readStyle("clipboard.css"), ".clipboard-create-footer");
    const buttonRule = getRule(readStyle("clipboard.css"), ".clipboard-create-actions .dialog-btn");
    const saveButtonRule = getRule(readStyle("clipboard.css"), ".clipboard-create-actions .dialog-btn.save");

    expect(footerRule).toContain("justify-content: flex-end");
    expect(buttonRule).toContain("min-width: 112px");
    expect(saveButtonRule).toContain("min-width: 132px");
  });

  it("loads existing records for the injected destination mode", () => {
    const css = readStyle("clipboard.css");
    const componentSource = readSource("../components/ClipboardCreateDialog/index.tsx");

    expect(css).toContain(".clipboard-create-stash-picker");
    expect(componentSource).toContain('isResource ? "resources" : "temp"');
    expect(componentSource).toContain("isTempRecord");
    expect(componentSource).not.toContain("getResourceGroupName");
    expect(componentSource).toContain('aria-haspopup="listbox"');
    expect(componentSource).toContain("setDropdownOpen");
    expect(componentSource).not.toContain('listen("clipboard-update"');
    expect(componentSource).not.toContain('listen("clipboard-record-updated"');
    expect(css).toContain("bottom: calc(100% + 4px)");
    expect(css).toContain("white-space: nowrap");
    expect(componentSource).toContain('"save_stash_record"');
    expect(componentSource).toContain("<StashEditor");
  });

  it("keeps the clipboard create existing-records section standalone", () => {
    const css = readStyle("clipboard.css");
    const componentSource = readSource("../components/ClipboardCreateDialog/index.tsx");
    const stashRule = getRule(css, ".clipboard-create-stash-section");

    expect(componentSource).toContain('className="clipboard-create-stash-section"');
    expect(componentSource).not.toContain("clipboard-create-resource-fields");
    expect(componentSource).not.toContain("clipboard-create-resource-group-section");
    expect(stashRule).toContain("display: flex;");
    expect(stashRule).toContain("flex-direction: column;");
    expect(css).toContain("margin-top: 0;");
  });

  it("keeps native stash editor selection and two-sided image caret anchors", () => {
    const editorRule = getRule(readStyle("clipboard.css"), ".clipboard-create-editor");
    const componentSource = readSource("../components/ClipboardCreateDialog/StashEditor.tsx");
    const mouseDownBlock = componentSource.slice(
      componentSource.indexOf("const handleMouseDown"),
      componentSource.indexOf("const handleClick"),
    );

    expect(editorRule).toContain("user-select: text");
    expect(editorRule).toContain("-webkit-user-select: text");
    expect(mouseDownBlock).not.toContain("preventDefault");
    expect(componentSource).not.toContain("getLastContentRect");
    expect(componentSource).toContain("marker.before(createCaretAnchor())");
    expect(componentSource).toContain("marker.after(createCaretAnchor())");
    expect(componentSource).toContain("if (editor) removeOrphanCaretAnchors(editor)");
    expect(componentSource).toContain("node.deleteData(index, CARET_ANCHOR.length)");
    expect(componentSource).toContain("node.insertData(node.length, CARET_ANCHOR)");
    expect(componentSource).toContain('marker.textContent = `[Image #${index + 1}]`;');
    expect(componentSource).toContain('.replaceAll(CARET_ANCHOR, "")');
  });

  it("uses custom rounded chrome for the standalone clipboard window", () => {
    const componentSource = readSource("../components/ClipboardCreateDialog/index.tsx");
    const css = readStyle("clipboard.css");
    const libSource = readSource("../../src-tauri/src/lib.rs");
    const createWindowBlock = libSource.slice(
      libSource.indexOf('"clipboard-create"'),
      libSource.indexOf("Clipboard create popup window created"),
    );

    expect(createWindowBlock).toContain(".decorations(false)");
    expect(createWindowBlock).toContain(".transparent(true)");
    expect(createWindowBlock).toContain(".resizable(true)");
    expect(createWindowBlock).toContain(".min_inner_size(480.0, 380.0)");
    expect(componentSource).toContain('className="clipboard-create-header" data-tauri-drag-region');
    expect(componentSource).toContain('className="clipboard-create-close-btn"');
    expect(getRule(css, ".clipboard-create-header")).toContain("-webkit-app-region: drag");
    expect(getRule(css, ".clipboard-create-close-btn")).toContain("-webkit-app-region: no-drag");
    expect(componentSource).toContain("<WindowResizeHandles />");
    expect(componentSource).toContain('usePersistWindowSize("clipboard_create_width", "clipboard_create_height")');
    expect(componentSource).toContain("onCloseRequested");
  });

  it("shares resizable window handles across borderless windows", () => {
    const handlesSource = readSource("../components/WindowResizeHandles.tsx");
    const componentsCss = readStyle("components.css");

    expect(handlesSource).toContain("startResizeDragging");
    expect(handlesSource).toContain('data-resize-direction={direction}');
    for (const direction of ["North", "South", "West", "East", "NorthWest", "NorthEast", "SouthWest", "SouthEast"]) {
      expect(handlesSource).toContain(`direction: "${direction}"`);
    }
    expect(getRule(componentsCss, ".window-resize-handle")).toContain("-webkit-app-region: no-drag");
  });

  it("supports drag-resize and persists the main window size", () => {
    const appSource = readSource("../App.tsx");
    const persistHookSource = readSource("../hooks/usePersistWindowSize.ts");
    const libSource = readSource("../../src-tauri/src/lib.rs");

    expect(appSource).toContain("<WindowResizeHandles />");
    expect(appSource).toContain('usePersistWindowSize("main_window_width", "main_window_height")');

    // Frontend saves logical pixels via the shared debounce hook.
    expect(persistHookSource).toContain("onResized");
    expect(persistHookSource).toContain("set_settings_batch");

    // Backend restores the saved size on startup, clamped to the configured minimum.
    expect(libSource).toContain('"main_window_width"');
    expect(libSource).toContain('"main_window_height"');
    expect(libSource).toContain("restore main window size failed");
    expect(libSource).toContain("width.max(440.0)");
    expect(libSource).toContain("height.max(420.0)");
    expect(libSource).toContain("tauri::LogicalSize::new(width, height)");
  });

  it("does not auto-hide standalone clipboard create dialog on blur", () => {
    const componentSource = readSource("../components/ClipboardCreateDialog/index.tsx");

    expect(componentSource).not.toContain('addEventListener("blur"');
    expect(componentSource).not.toContain('removeEventListener("blur"');
  });
});
