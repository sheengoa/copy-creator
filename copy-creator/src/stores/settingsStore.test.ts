import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, emitMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  emitMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: emitMock,
  listen: vi.fn(),
}));

import { parseMaxRecords, useSettingsStore } from "./settingsStore";

describe("settingsStore 主题与隐私设置 wiring", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    emitMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    emitMock.mockResolvedValue(undefined);
    useSettingsStore.setState({
      themeMode: "light",
      resolvedTheme: "light",
      clipboardPaused: false,
      clipboardMaxRecords: 0,
      clipboardExclusions: "",
      autoHideOnBlur: false,
      findReplaceHistory: [],
    });
  });

  it("setThemeMode 持久化并广播原始偏好，system 解析为亮色", async () => {
    await useSettingsStore.getState().setThemeMode("system");

    expect(invokeMock).toHaveBeenCalledWith("set_setting", { key: "theme", value: "system" });
    expect(emitMock).toHaveBeenCalledWith("theme-changed", { theme: "system" });
    const state = useSettingsStore.getState();
    expect(state.themeMode).toBe("system");
    // 测试环境无 matchMedia，system 解析为亮色（theme.test.ts 已钉住解析语义）。
    expect(state.resolvedTheme).toBe("light");
  });

  it("toggleTheme 从当前解析值取反色落为显式偏好", async () => {
    useSettingsStore.setState({ themeMode: "light", resolvedTheme: "light" });
    await useSettingsStore.getState().toggleTheme();

    expect(invokeMock).toHaveBeenCalledWith("set_setting", { key: "theme", value: "dark" });
    expect(useSettingsStore.getState().resolvedTheme).toBe("dark");
  });

  it("setClipboardPaused 持久化并广播暂停事件（payload 与托盘侧一致）", async () => {
    await useClipboardPausedToggle(true);

    expect(invokeMock).toHaveBeenCalledWith("set_setting", {
      key: "clipboard_paused",
      value: "1",
    });
    expect(emitMock).toHaveBeenCalledWith("clipboard-pause-changed", { paused: true });
  });

  it("setClipboardMaxRecords 持久化为字符串档位", async () => {
    await useSettingsStore.getState().setClipboardMaxRecords(2000);

    expect(invokeMock).toHaveBeenCalledWith("set_setting", {
      key: "clipboard_max_records",
      value: "2000",
    });
  });

  it("setAutoHideOnBlur 以 1/0 持久化", async () => {
    await useSettingsStore.getState().setAutoHideOnBlur(true);

    expect(invokeMock).toHaveBeenCalledWith("set_setting", {
      key: "auto_hide_on_blur",
      value: "1",
    });
  });

  it("setFindReplaceHistory 函数式更新并持久化广播", async () => {
    useSettingsStore.setState({
      findReplaceHistory: [{ query: "a", replacement: "", replaced: false }],
    });

    await useSettingsStore.getState().setFindReplaceHistory((prev) =>
      prev.map((item) =>
        item.query === "a" ? { query: "a", replacement: "A", replaced: true } : item,
      ),
    );

    const entries = [{ query: "a", replacement: "A", replaced: true }];
    expect(useSettingsStore.getState().findReplaceHistory).toEqual(entries);
    expect(invokeMock).toHaveBeenCalledWith("set_setting", {
      key: "find_replace_history",
      value: JSON.stringify(entries),
    });
    expect(emitMock).toHaveBeenCalledWith("find-replace-history-changed", { entries });
  });

  it("setFindReplaceHistory 同引用视为无变化，跳过写库与广播", async () => {
    const entries = [{ query: "a", replacement: "", replaced: false }];
    useSettingsStore.setState({ findReplaceHistory: entries });

    await useSettingsStore.getState().setFindReplaceHistory((prev) => prev);

    expect(invokeMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().findReplaceHistory).toBe(entries);
  });

  it("doLoadSettings 解析 find_replace_history 存储串", async () => {
    const entries = [{ query: "x", replacement: "y", replaced: true }];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_all_settings") {
        return Promise.resolve({ find_replace_history: JSON.stringify(entries) });
      }
      if (cmd === "is_autostart_enabled") return Promise.resolve(false);
      return Promise.resolve(undefined);
    });

    await useSettingsStore.getState().doLoadSettings();

    expect(useSettingsStore.getState().findReplaceHistory).toEqual(entries);
  });

  it("doLoadSettings 对畸形的 find_replace_history 存储串回退空历史", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_all_settings") {
        return Promise.resolve({ find_replace_history: "{oops" });
      }
      if (cmd === "is_autostart_enabled") return Promise.resolve(false);
      return Promise.resolve(undefined);
    });

    await useSettingsStore.getState().doLoadSettings();

    expect(useSettingsStore.getState().findReplaceHistory).toEqual([]);
  });
});

async function useClipboardPausedToggle(enabled: boolean) {
  await useSettingsStore.getState().setClipboardPaused(enabled);
}

describe("parseMaxRecords", () => {
  it("非法/缺失/非正数一律不限（0）", () => {
    expect(parseMaxRecords(undefined)).toBe(0);
    expect(parseMaxRecords("")).toBe(0);
    expect(parseMaxRecords("abc")).toBe(0);
    expect(parseMaxRecords("-5")).toBe(0);
  });

  it("合法档位原样保留", () => {
    expect(parseMaxRecords("500")).toBe(500);
    expect(parseMaxRecords("10000")).toBe(10000);
  });
});
