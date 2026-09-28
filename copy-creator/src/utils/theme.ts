// 主题偏好的解析与订阅。持久化值（settings 表 `theme` 键）可以为显式
// "light"/"dark" 或 "system"（跟随系统）。system 的解析在各窗口
// （主/径向/新建）的 webview 内本地完成：WebKitGTK/WebView2 的
// prefers-color-scheme 即系统深浅色，无需经 Rust 转发解析结果；
// 因此事件 payload（theme-changed / radial-menu-show 等）始终携带
// 原始偏好字符串，消费方 resolve 后再设 data-theme。

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const parseThemePreference = (raw: string | undefined | null): ThemePreference =>
  raw === "dark" ? "dark" : raw === "system" ? "system" : "light";

export const systemPrefersDark = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches;

export const resolveTheme = (pref: ThemePreference): ResolvedTheme =>
  pref === "dark" || (pref === "system" && systemPrefersDark()) ? "dark" : "light";

/** 把解析结果落到文档根节点，供全部窗口统一调用。 */
export const applyThemeAttribute = (theme: ResolvedTheme): void => {
  document.documentElement.setAttribute("data-theme", theme);
};

/**
 * 订阅系统深浅色变化；返回退订函数。旧 WebView 不支持时退订为空操作，
 * 调用方按最后一次 resolveTheme 结果保持静态。
 */
export const onSystemThemeChange = (cb: (dark: boolean) => void): (() => void) => {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = (e: MediaQueryListEvent) => cb(e.matches);
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
};
