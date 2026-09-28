// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyThemeAttribute,
  onSystemThemeChange,
  parseThemePreference,
  resolveTheme,
  systemPrefersDark,
} from "./theme";

// jsdom 未实现 matchMedia，用可编程桩替代：返回值由测试用例控制。
let systemDark = false;
const listeners = new Set<(e: { matches: boolean }) => void>();

const stubMatchMedia = () => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("dark") ? systemDark : !systemDark,
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
        listeners.add(cb);
      },
      removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
        listeners.delete(cb);
      },
    }),
  });
};

afterEach(() => {
  systemDark = false;
  listeners.clear();
  vi.restoreAllMocks();
});

describe("parseThemePreference", () => {
  it("识别三种合法偏好", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
  });

  it("未知/缺失值回落 light（兼容旧库里的任意残留）", () => {
    expect(parseThemePreference("whatever")).toBe("light");
    expect(parseThemePreference(undefined)).toBe("light");
    expect(parseThemePreference(null)).toBe("light");
  });
});

describe("resolveTheme", () => {
  it("显式偏好不依赖系统值", () => {
    stubMatchMedia();
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("system 按系统深浅色解析", () => {
    stubMatchMedia();
    systemDark = true;
    expect(resolveTheme("system")).toBe("dark");
    systemDark = false;
    expect(resolveTheme("system")).toBe("light");
  });
});

describe("systemPrefersDark / onSystemThemeChange", () => {
  it("读取当前系统值并在变化时回调，退订后不再回调", () => {
    stubMatchMedia();
    systemDark = false;
    expect(systemPrefersDark()).toBe(false);

    const cb = vi.fn();
    const off = onSystemThemeChange(cb);
    expect(cb).not.toHaveBeenCalled();

    systemDark = true;
    for (const cb2 of listeners) cb2({ matches: true });
    expect(cb).toHaveBeenCalledWith(true);

    off();
    for (const cb2 of listeners) cb2({ matches: false });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("applyThemeAttribute", () => {
  it("写入 documentElement 的 data-theme", () => {
    applyThemeAttribute("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyThemeAttribute("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
