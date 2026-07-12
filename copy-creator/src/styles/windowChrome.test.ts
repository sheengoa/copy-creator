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
  });

  it("uses wider clipboard create action buttons", () => {
    const footerRule = getRule(readStyle("clipboard.css"), ".clipboard-create-footer");
    const buttonRule = getRule(readStyle("clipboard.css"), ".clipboard-create-actions .dialog-btn");
    const saveButtonRule = getRule(readStyle("clipboard.css"), ".clipboard-create-actions .dialog-btn.save");

    expect(footerRule).toContain("justify-content: flex-end");
    expect(buttonRule).toContain("min-width: 112px");
    expect(saveButtonRule).toContain("min-width: 132px");
  });

  it("keeps standalone clipboard create dialog focused on text and actions", () => {
    const css = readStyle("clipboard.css");
    const componentSource = readSource("../components/ClipboardCreateDialog/index.tsx");

    expect(css).not.toContain(".clipboard-create-group-select");
    expect(componentSource).not.toContain("get_clipboard_groups");
    expect(componentSource).not.toContain("selectedGroupName");
    expect(componentSource).not.toContain("ClipboardGroup");
  });

  it("marks standalone clipboard create header as draggable", () => {
    const css = readStyle("clipboard.css");
    const componentSource = readSource("../components/ClipboardCreateDialog/index.tsx");
    const headerRule = getRule(css, ".clipboard-create-header");
    const closeButtonRule = getRule(css, ".clipboard-create-close-btn");

    expect(componentSource).toContain('data-tauri-drag-region');
    expect(headerRule).toContain("-webkit-app-region: drag");
    expect(closeButtonRule).toContain("-webkit-app-region: no-drag");
  });

  it("does not auto-hide standalone clipboard create dialog on blur", () => {
    const componentSource = readSource("../components/ClipboardCreateDialog/index.tsx");

    expect(componentSource).not.toContain('addEventListener("blur"');
    expect(componentSource).not.toContain('removeEventListener("blur"');
  });
});
