// 径向菜单启动预载：主题/语言/UI 缩放偏好装载、三域数据预取与跨窗口
// 偏好变更事件订阅。自 index.tsx 拆出（2026-11-14，架构守卫规则 27 行数
// 上限）；主题偏好 ref 与分组/tab ref 由 index 注入（show 事件与 tab 切换
// 共享同一份实况）。

import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useClipboardStore } from "../../stores/clipboardStore";
import { usePhraseStore } from "../../stores/phraseStore";
import {
  applyThemeAttribute,
  onSystemThemeChange,
  parseThemePreference,
  resolveTheme,
  type ThemePreference,
} from "../../utils/theme";
import i18n from "../../i18n";
import { loadPasteLeftClickSetting } from "./radialShared";

export function useRadialBootstrap({
  themePrefRef,
  loadResourceGroups,
  activeTabRef,
  resourceGroupRef,
}: {
  themePrefRef: { current: ThemePreference };
  loadResourceGroups: () => Promise<void>;
  activeTabRef: { current: string };
  resourceGroupRef: { current: string | null };
}) {
  // 径向菜单 UI 缩放比（设置项，默认 1）。CSS 侧通过 --radial-ui-scale
  // 对整窗 zoom，窗口尺寸与物理换算在这里同步乘同一系数。
  const uiScaleRef = useRef(1);

  const applyUiScale = useCallback((scale: number) => {
    const next = Math.min(2, Math.max(0.5, Number.isFinite(scale) ? scale : 1));
    uiScaleRef.current = next;
    document.documentElement.style.setProperty("--radial-ui-scale", String(next));
  }, []);

  useEffect(() => {
    // Initial theme load（偏好可为 "system"，本地解析后再应用）
    invoke<string>("get_setting", { key: "theme" }).then((theme) => {
      themePrefRef.current = parseThemePreference(theme);
      applyThemeAttribute(resolveTheme(themePrefRef.current));
    }).catch(() => {});

    // 系统深浅色切换时按当前偏好重解析（跟随系统模式即时生效）
    const offSystemTheme = onSystemThemeChange(() => {
      applyThemeAttribute(resolveTheme(themePrefRef.current));
    });

    // Initial language load
    invoke<string>("get_setting", { key: "language" }).then((lang) => {
      if (lang && lang !== i18n.language) {
        i18n.changeLanguage(lang);
      }
    }).catch(() => {});

    // Initial radial UI scale load (kept in sync afterwards via events)
    invoke<string>("get_setting", { key: "radial_menu_scale" }).then((raw) => {
      const percent = Number.parseFloat(raw);
      if (Number.isFinite(percent)) applyUiScale(percent / 100);
    }).catch(() => {});

    // Pre-load data so it's ready when the menu first shows
    loadPasteLeftClickSetting();
    useClipboardStore.getState().init();
    usePhraseStore.getState().init();
    void loadResourceGroups();

    // Listen for theme changes from the main window
    let unlistenTheme: UnlistenFn | undefined;
    listen<{ theme: string }>("theme-changed", (e) => {
      themePrefRef.current = parseThemePreference(e.payload.theme);
      applyThemeAttribute(resolveTheme(themePrefRef.current));
    }).then((fn) => { unlistenTheme = fn; });

    // Listen for language changes from the main window
    let unlistenLang: UnlistenFn | undefined;
    listen<{ language: string }>("language-changed", (e) => {
      if (e.payload.language !== i18n.language) {
        i18n.changeLanguage(e.payload.language);
      }
    }).then((fn) => { unlistenLang = fn; });

    let unlistenResourceGroups: UnlistenFn | undefined;
    listen("resource-groups-changed", () => {
      void loadResourceGroups();
      if (activeTabRef.current === "resources") {
        void useClipboardStore.getState().loadRecords(
          false,
          "resources",
          resourceGroupRef.current,
        );
      }
    }).then((fn) => { unlistenResourceGroups = fn; });

    return () => {
      offSystemTheme();
      if (unlistenTheme) unlistenTheme();
      if (unlistenLang) unlistenLang();
      if (unlistenResourceGroups) unlistenResourceGroups();
    };
  }, [activeTabRef, applyUiScale, loadResourceGroups, resourceGroupRef, themePrefRef]);

  return { applyUiScale };
}
