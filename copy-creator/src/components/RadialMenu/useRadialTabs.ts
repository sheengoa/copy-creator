// 径向菜单 tab / 分类 / 分组切换子系统：激活装载、跨重启记忆恢复与
// 持久化。自 index.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）；
// 状态与 ref（tab/分类/分组三轴 + 「用户已手动切换」标记）由 index 注入，
// 预览收口经 collapsePreview、分组下拉经 closeResourceGroupMenu、分组
// 重载经 loadResourceGroups 注入。

import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useClipboardStore, type ClipType } from "../../stores/clipboardStore";
import { usePhraseStore, ALL_PHRASES_GROUP_ID } from "../../stores/phraseStore";
import { RADIAL_LAST_TAB_SETTING, RADIAL_TAB_KEYS, type TabKey } from "./radialShared";

export function useRadialTabs({
  collapsePreview,
  closeResourceGroupMenu,
  loadResourceGroups,
  setActiveTab,
  activeTabRef,
  setClipboardCategory,
  clipboardCategoryRef,
  setResourceGroup,
  resourceGroupRef,
  resourceGroupTouchedRef,
  tabTouchedRef,
  setSelectedItemId,
  selectedItemIdRef,
  setSelectedItemIds,
  selectedItemIdsRef,
  shiftSelectionPointerItemIdRef,
  shiftToggleItemIdRef,
  shiftClickSelectionModeRef,
  setPhraseGroupId,
  phraseGroupIdRef,
}: {
  collapsePreview: (animated?: boolean) => void;
  closeResourceGroupMenu: () => void;
  loadResourceGroups: () => Promise<void>;
  setActiveTab: (tab: TabKey) => void;
  activeTabRef: { current: TabKey };
  setClipboardCategory: (category: ClipType) => void;
  clipboardCategoryRef: { current: ClipType };
  setResourceGroup: (group: string | null) => void;
  resourceGroupRef: { current: string | null };
  resourceGroupTouchedRef: { current: boolean };
  tabTouchedRef: { current: boolean };
  setSelectedItemId: (id: string | null) => void;
  selectedItemIdRef: { current: string | null };
  setSelectedItemIds: (ids: string[]) => void;
  selectedItemIdsRef: { current: string[] };
  shiftSelectionPointerItemIdRef: { current: string | null };
  shiftToggleItemIdRef: { current: string | null };
  shiftClickSelectionModeRef: { current: boolean };
  setPhraseGroupId: (id: string | null) => void;
  phraseGroupIdRef: { current: string | null };
}) {
  const applyResourceGroupSwitch = useCallback((nextGroup: string | null) => {
    collapsePreview();
    closeResourceGroupMenu();
    resourceGroupTouchedRef.current = true;
    setResourceGroup(nextGroup);
    resourceGroupRef.current = nextGroup;
    useClipboardStore.getState().setResourceGroup(nextGroup);
    useClipboardStore.getState().loadRecords(false, "resources", nextGroup);
    setSelectedItemId(null);
    selectedItemIdRef.current = null;
    setSelectedItemIds([]);
    selectedItemIdsRef.current = [];
    shiftSelectionPointerItemIdRef.current = null;
    shiftToggleItemIdRef.current = null;
    shiftClickSelectionModeRef.current = false;
    // 分组浏览位置跨重启记忆。null（"全部"视图）与 ""（未分组）语义不同，
    // 设置表只存字符串，故以 JSON 编码区分三种状态。
    void invoke("set_setting", {
      key: "radial_resource_group",
      value: JSON.stringify(nextGroup),
    }).catch((error) => console.error("Failed to persist radial resource group:", error));
  }, [closeResourceGroupMenu, collapsePreview, resourceGroupTouchedRef, resourceGroupRef, selectedItemIdRef, selectedItemIdsRef, setResourceGroup, setSelectedItemId, setSelectedItemIds, shiftClickSelectionModeRef, shiftSelectionPointerItemIdRef, shiftToggleItemIdRef]);

  // 恢复上次资源分组浏览位置：打开菜单时从设置读取（跨重启记忆），
  // 仅同步内存状态，列表加载推迟到真正切到资源 tab 时进行。
  // 无记录或读取失败时保持当前内存值（本次运行内的上次位置或默认"全部"）。
  const restoreResourceGroup = useCallback(async () => {
    try {
      const saved = await invoke<string>("get_setting", { key: "radial_resource_group" });
      // 等待期间用户已手动切换过分组：尊重用户选择，不用记忆值覆盖。
      if (resourceGroupTouchedRef.current) return;
      const parsed: unknown = JSON.parse(saved);
      const next = typeof parsed === "string" ? parsed : null;
      setResourceGroup(next);
      resourceGroupRef.current = next;
      // 用户在读取返回前已切到资源 tab：补同步 store 并按恢复值重载，
      // 避免组件状态与列表内容不一致。
      if (activeTabRef.current === "resources") {
        useClipboardStore.getState().setResourceGroup(next);
        useClipboardStore.getState().loadRecords(false, "resources", next);
      }
    } catch {
      // 尚无记录或解析失败属正常情况，保持现状即可。
    }
  }, [activeTabRef, resourceGroupRef, resourceGroupTouchedRef, setResourceGroup]);

  // 激活一个 tab 并保证对应数据就绪：手动切换与打开菜单恢复记忆共用。
  // 快捷输入每次激活都回到「全部」并重载，保证最近使用排序新鲜。
  const activateTab = useCallback((key: string) => {
    collapsePreview();
    const tab = key as TabKey;
    setActiveTab(tab);
    activeTabRef.current = tab;
    setSelectedItemId(null);
    selectedItemIdRef.current = null;
    setSelectedItemIds([]);
    selectedItemIdsRef.current = [];
    shiftClickSelectionModeRef.current = false;
    if (tab === "clipboard") {
      setClipboardCategory("all");
      clipboardCategoryRef.current = "all";
      useClipboardStore.getState().setCategory("all");
      useClipboardStore.getState().loadRecords(false, "all");
    } else if (tab === "resources") {
      // 回到资源 tab 时恢复记忆的分组浏览位置（打开菜单时已由
      // restoreResourceGroup 填充，这里直接沿用内存值）。
      const remembered = resourceGroupRef.current;
      setClipboardCategory("resources");
      clipboardCategoryRef.current = "resources";
      closeResourceGroupMenu();
      useClipboardStore.getState().setCategory("resources");
      useClipboardStore.getState().setResourceGroup(remembered);
      useClipboardStore.getState().loadRecords(false, "resources", remembered);
      void loadResourceGroups();
    } else if (tab === "phrases") {
      setPhraseGroupId(ALL_PHRASES_GROUP_ID);
      phraseGroupIdRef.current = ALL_PHRASES_GROUP_ID;
      usePhraseStore.getState().loadPhrases(ALL_PHRASES_GROUP_ID);
    }
  }, [activeTabRef, clipboardCategoryRef, closeResourceGroupMenu, collapsePreview, loadResourceGroups, phraseGroupIdRef, resourceGroupRef, setActiveTab, setClipboardCategory, setPhraseGroupId, selectedItemIdsRef, selectedItemIdRef, setSelectedItemId, setSelectedItemIds, shiftClickSelectionModeRef]);

  const handleTabSwitch = useCallback((key: string) => {
    activateTab(key);
    // 手动切换即记住该模式：下次打开菜单（含跨重启）恢复到这里。
    tabTouchedRef.current = true;
    void invoke("set_setting", {
      key: RADIAL_LAST_TAB_SETTING,
      value: key,
    }).catch((error) => console.error("Failed to persist radial last tab:", error));
  }, [activateTab, tabTouchedRef]);

  // 恢复记住的上次 tab：打开菜单时从设置读取（跨重启记忆）。
  // 无记忆或值非法（含已移除的「recent」）时保持当前 tab（首次使用为「快捷输入」）；
  // 返回前用户已手动切换 tab 时尊重用户选择。
  const restoreLastTab = useCallback(async () => {
    try {
      const saved = await invoke<string>("get_setting", { key: RADIAL_LAST_TAB_SETTING });
      if (tabTouchedRef.current) return;
      if ((RADIAL_TAB_KEYS as string[]).includes(saved)) {
        activateTab(saved);
      }
    } catch {
      // 尚无记录属正常情况（首次使用），保持初始「最近」。
    }
  }, [activateTab, tabTouchedRef]);

  const handleTabClick = useCallback((e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    handleTabSwitch(key);
  }, [handleTabSwitch]);

  const applyCategorySwitch = useCallback((key: string) => {
    collapsePreview();
    if (activeTabRef.current === "clipboard") {
      setClipboardCategory(key as ClipType);
      clipboardCategoryRef.current = key as ClipType;
      useClipboardStore.getState().setCategory(key as ClipType);
      useClipboardStore.getState().loadRecords(false, key as ClipType);
    } else if (activeTabRef.current === "phrases") {
      setPhraseGroupId(key);
      phraseGroupIdRef.current = key;
      usePhraseStore.getState().loadPhrases(key);
    }
    setSelectedItemId(null);
    selectedItemIdRef.current = null;
    setSelectedItemIds([]);
    selectedItemIdsRef.current = [];
    shiftToggleItemIdRef.current = null;
    shiftClickSelectionModeRef.current = false;
  }, [activeTabRef, clipboardCategoryRef, collapsePreview, phraseGroupIdRef, selectedItemIdRef, selectedItemIdsRef, setClipboardCategory, setPhraseGroupId, setSelectedItemId, setSelectedItemIds, shiftClickSelectionModeRef, shiftToggleItemIdRef]);

  const handleCategoryClick = useCallback((e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    applyCategorySwitch(key);
  }, [applyCategorySwitch]);

  return {
    applyResourceGroupSwitch,
    restoreResourceGroup,
    activateTab,
    handleTabSwitch,
    restoreLastTab,
    handleTabClick,
    applyCategorySwitch,
    handleCategoryClick,
  };
}
