/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function readStyle(name: string) {
  return readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8");
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
    const css = readStyle("radial-menu.css");
    const popupRule = getRule(css, ".radial-menu-popup");
    const mainRule = getRule(css, ".radial-menu-main");
    const overlayRule = getRule(css, ".radial-menu-overlay");
    const libSource = readSource("../../src-tauri/src/lib.rs");
    const radialWindowBlock = libSource.slice(
      libSource.indexOf('"radial-menu"'),
      libSource.indexOf("Radial menu popup window created"),
    );

    expect(popupRule).not.toContain("0 20px 60px");
    expect(radialWindowBlock).toContain(".transparent(true)");
    // 透明窗口的阴影必须落在窗口内预留的透明边距里，不能被边界裁剪。
    // popup 是透明容器（可见面板 + 预留扩展条带），背景/阴影/圆角挂在
    // 可见的 .radial-menu-main 上。
    expect(popupRule).not.toContain("background: #FFFFFF");
    expect(mainRule).toContain("box-shadow: var(--window-shadow)");
    expect(mainRule).toContain("border-radius: var(--window-radius)");
    expect(overlayRule).toContain("padding: var(--window-shadow-margin)");
    expect(radialWindowBlock).toContain("2.0 * WINDOW_SHADOW_MARGIN");
  });

  it("matches clipboard create window background with the main panel tone", () => {
    const dialogRule = getRule(readStyle("clipboard.css"), ".clipboard-create-dialog");

    expect(dialogRule).toContain("background: var(--panel-bg)");
    expect(dialogRule).toContain("border-radius: var(--window-radius)");
    // 阴影画在窗口内预留的透明边距中（width/height 扣除边距），无需 clip-path。
    expect(dialogRule).not.toContain("clip-path");
    expect(dialogRule).toContain("box-shadow: var(--window-shadow)");
    expect(dialogRule).toContain("margin: var(--window-shadow-margin)");
  });

  it("uses wider clipboard create action buttons", () => {
    const barRule = getRule(readStyle("clipboard.css"), ".clipboard-create-action-bar");
    const buttonRule = getRule(readStyle("clipboard.css"), ".clipboard-create-actions .dialog-btn");
    const saveButtonRule = getRule(readStyle("clipboard.css"), ".clipboard-create-actions .dialog-btn.save");

    expect(barRule).toContain("border-top: 1px solid var(--card-border)");
    expect(buttonRule).toContain("min-width: 112px");
    // 保底宽经变量读取：紧凑档只需覆盖变量，与基础规则无特异性竞争
    expect(saveButtonRule).toContain("min-width: var(--create-save-min-width, 132px)");
  });

  it("keeps the create action bar overlap-free at minimum width", () => {
    const css = readStyle("clipboard.css");

    // 底部动作条以对话框为尺寸容器，窄窗口下切换紧凑排布。
    expect(getRule(css, ".clipboard-create-dialog")).toContain("container-type: inline-size");
    expect(css).toContain("@container (max-width: 599px)");
    // chip 保底宽度=「图标+展开符」的精确值（68/60）：任何宽度下字形都不得
    // 溢出 chip 边界与相邻元素互压，也不得切出半个字的残影。已有内容 chip
    // 的选择器以 :not 排除目标分组 chip（二者类名重叠），互斥后不依赖源码顺序。
    expect(
      getRule(
        css,
        ".clipboard-create-bar-left .clipboard-create-stash-picker:not(.clipboard-create-group-picker)",
      ),
    ).toContain("min-width: 68px");
    expect(getRule(css, ".clipboard-create-bar-left .clipboard-create-group-picker")).toContain("min-width: 60px");
    // 紧凑档经 --create-save-min-width 变量压掉基础 132px 保底宽：若漏掉，
    // 最小宽度下动作区超宽、左侧 chips 被「取消」盖住。
    expect(css).toMatch(/\.clipboard-create-actions\s*\{[^}]*--create-save-min-width: 0;/);
    expect(css).toMatch(/\.dialog-btn\.save\s*\{[^}]*padding: 8px 22px;/);
    // 英文分段控件更宽，极窄时允许 chip 在左侧组内换行兜底；换行判定用假想尺寸
    // （flex-basis 受 max-width 钳制），须把 chips 钳到保底宽度，否则按 max-content
    // 判定会让中文也过早换行。
    expect(css).toMatch(/\.clipboard-create-bar-left\s*\{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(
      /\.clipboard-create-bar-left \.clipboard-create-stash-picker:not\(\.clipboard-create-group-picker\)\s*\{[^}]*flex-basis: 68px;/,
    );
    expect(css).toMatch(
      /\.clipboard-create-bar-left \.clipboard-create-group-picker\s*\{[^}]*flex-basis: 60px;/,
    );
  });

  it("loads existing records for the injected destination mode", () => {
    const css = readStyle("clipboard.css");
    const componentSource = readSource("../components/ClipboardCreateDialog/index.tsx");

    expect(css).toContain(".clipboard-create-stash-picker");
    expect(css).toContain(".clipboard-create-dest-seg");
    expect(css).toContain(".clipboard-create-chip-trigger");
    expect(componentSource).toContain('category: isResource ? "resources" : "all"');
    expect(componentSource).toContain("handleDestChange");
    expect(componentSource).toContain('t("resources.destinationClipboard")');
    expect(componentSource).not.toContain("isTempRecord");
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

  it("keeps resource selection beside the resource heading", () => {
    const pageSource = readSource("../pages/ResourcePage.tsx");
    const resourceCss = readStyle("resource.css");

    expect(pageSource).not.toContain('className="resource-mode-row"');
    expect(pageSource).toContain('className="resource-list-heading-actions"');
    expect(pageSource).not.toContain('t("resources.reorderHint")');
    expect(pageSource).toContain(
      'className="phrase-add-btn selection-mode-btn resource-selection-button"',
    );
    expect(pageSource.indexOf("resource-selection-button")).toBeGreaterThan(
      pageSource.indexOf("resource-list-heading-actions"),
    );
    expect(resourceCss).toContain(".resource-list-heading-main > span");
    expect(resourceCss).not.toContain(".resource-list-heading span");
    expect(resourceCss).not.toContain(".resource-reorder-hint");
    // 工具栏次级按钮与新建按钮同为 36px，与搜索框等高对齐；
    // getRule 只能提取组内末位选择器，settings 键成员关系用选择器行断言。
    expect(resourceCss).toMatch(/\.resource-settings-button,\s*\.resource-trash-button\s*\{/);
    expect(getRule(resourceCss, ".resource-trash-button")).toContain("min-height: 36px");
  });

  it("keeps the clipboard create action bar standalone", () => {
    const css = readStyle("clipboard.css");
    const componentSource = readSource("../components/ClipboardCreateDialog/index.tsx");
    const barRule = getRule(css, ".clipboard-create-action-bar");

    expect(componentSource).toContain('className="clipboard-create-action-bar"');
    expect(componentSource).not.toContain("clipboard-create-resource-fields");
    expect(componentSource).not.toContain("clipboard-create-resource-group-section");
    expect(barRule).toContain("display: flex;");
    expect(barRule).toContain("align-items: center;");
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
    expect(createWindowBlock).toContain("480.0 + 2.0 * WINDOW_SHADOW_MARGIN");
    expect(createWindowBlock).toContain("380.0 + 2.0 * WINDOW_SHADOW_MARGIN");
    expect(componentSource).toContain('className="clipboard-create-header" data-tauri-drag-region');
    // 关闭键复用无边框窗口共享的 .window-close-btn 幽灵钮，不再自备样式。
    expect(componentSource).toContain('className="window-close-btn"');
    expect(componentSource).not.toContain("clipboard-create-close-btn");
    expect(css).not.toContain("clipboard-create-close-btn");
    expect(getRule(css, ".clipboard-create-header")).toContain("-webkit-app-region: drag");
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
    expect(libSource).toContain("width.max(440.0 + 2.0 * WINDOW_SHADOW_MARGIN)");
    expect(libSource).toContain("height.max(420.0 + 2.0 * WINDOW_SHADOW_MARGIN)");
    expect(libSource).toContain("tauri::LogicalSize::new(width, height)");
  });

  it("does not auto-hide standalone clipboard create dialog on blur", () => {
    const componentSource = readSource("../components/ClipboardCreateDialog/index.tsx");

    expect(componentSource).not.toContain('addEventListener("blur"');
    expect(componentSource).not.toContain('removeEventListener("blur"');
  });

  it("gives resizable borderless windows minimize and maximize controls", () => {
    const controlSource = readSource("../components/WindowControlButtons.tsx");
    const appSource = readSource("../App.tsx");
    const dialogSource = readSource("../components/ClipboardCreateDialog/index.tsx");
    const componentsCss = readStyle("components.css");
    const persistHookSource = readSource("../hooks/usePersistWindowSize.ts");
    const capabilities = JSON.parse(
      readFileSync(new URL("../../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
    ) as { permissions: string[] };

    expect(appSource).toContain("<WindowControlButtons />");
    expect(dialogSource).toContain("<WindowControlButtons />");
    // 头部为 space-between，控制按钮必须与关闭键同容器，否则被分散排布。
    expect(appSource).toContain('className="window-header-actions"');
    expect(dialogSource).toContain('className="window-header-actions"');
    expect(appSource.indexOf("window-header-actions")).toBeLessThan(
      appSource.indexOf("window-close-btn"),
    );
    expect(getRule(componentsCss, ".window-header-actions")).toContain("display: flex;");
    expect(controlSource).toContain("minimize()");
    expect(controlSource).toContain("toggleMaximize()");
    // 共享规则以分组选择器书写，getRule 只能提取组内末位选择器
    // （.window-min-btn → .window-max-btn → .window-close-btn 的末位）。
    expect(getRule(componentsCss, ".window-close-btn")).toContain(
      "-webkit-app-region: no-drag",
    );
    // 最小化/最大化/关闭三键共用同一组幽灵钮规则；主窗口头部不得再
    // 覆盖成关闭键圆形实底（否则与新建窗口三键外观不一致）。
    expect(componentsCss).toMatch(
      /\.window-min-btn,\s*\.window-max-btn,\s*\.window-close-btn\s*\{/,
    );
    expect(getRule(readStyle("layout.css"), ".panel-window-header")).not.toContain(
      "--window-btn-",
    );
    // 最大化尺寸是临时态，不能被持久化成下次启动的常规尺寸。
    expect(persistHookSource).toContain("isMaximized");
    expect(capabilities.permissions).toContain("core:window:allow-toggle-maximize");
    expect(capabilities.permissions).toContain("core:window:allow-is-maximized");
  });

  it("collapses shadow-margin chrome while the window is maximized", () => {
    const hookSource = readSource("../hooks/useWindowMaximized.ts");
    const appSource = readSource("../App.tsx");
    const dialogSource = readSource("../components/ClipboardCreateDialog/index.tsx");
    const componentsCss = readStyle("components.css");

    expect(hookSource).toContain("onResized");
    expect(hookSource).toContain("isMaximized");
    expect(appSource).toContain("useWindowMaximized");
    expect(dialogSource).toContain("useWindowMaximized");
    // 边距/圆角/阴影全部派生自三个窗口变量，最大化收零即铺满屏幕。
    expect(appSource).toContain("app-container${maximized");
    expect(dialogSource).toContain("clipboard-create-dialog${maximized");
    const maximizedRule = getRule(componentsCss, ".maximized");
    expect(maximizedRule).toContain("--window-shadow-margin: 0px");
    expect(maximizedRule).toContain("--window-radius: 0px");
    expect(maximizedRule).toContain("--window-shadow: none");
    expect(getRule(componentsCss, ".maximized .window-resize-handle")).toContain(
      "display: none",
    );
  });
});
