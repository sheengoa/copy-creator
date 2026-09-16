import { RadialImageBanner, ResourceItemVisual } from "./ResourceItemVisual";
import { useEffect, useRef, useState, useCallback, useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Icons } from "../Icons";
import { useClipboardStore, type ClipType } from "../../stores/clipboardStore";
import { usePhraseStore, ALL_PHRASES_GROUP_ID } from "../../stores/phraseStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { shouldUseTerminalPasteForMouseTrigger } from "../../utils/pasteMode";
import { type RadialDragSource } from "../../utils/radialDrag";
import { ContentPreviewPanel } from "../ContentPreviewPanel";
import { FileMediaVisual } from "../FileMediaPreview";
import { BackToTopButton } from "../BackToTop";
import { useBackToTop } from "../../hooks/useBackToTop";
import { RADIAL_PREVIEW_WIDTH, type RadialPreviewDirection, type RadialPreviewSegment } from "../../domain/preview";
import { isResourceRecord } from "../../domain/records";
import { formatTime } from "../../utils/formatTime";
import type { ResourceFolder } from "../../types";
import { findResourceFolder, flattenResourceFoldersVisible, formatResourceFolderPath, isResourceFolderPath } from "../../domain/groups";
import { resourceGroupLeafLabel } from "../../domain/records";
import { UsageCountBadge } from "../UsageCountBadge";
import { ResourceGroupMenu } from "./ResourceGroupMenu";
import {
  buildAllPhraseItems,
  loadRadialPreviewSegments,
  pasteResourceGroup,
  phraseToRadialItem,
  recordToRadialItem,
  usageTimeLabel,
} from "./radialItems";
import {
  IS_LINUX,
  MAX_ITEMS,
  NAV_TAB_ICONS,
  PHRASES_ALL_LIMIT,
  RADIAL_DRAG_THRESHOLD_PX,
  RADIAL_LAST_TAB_SETTING,
  RADIAL_TAB_KEYS,
  captureDragThumbnail,
  flog,
  loadPasteLeftClickSetting,
  type PendingNativeDrag,
  type PreviewLayout,
  type PreviewState,
  type RadialDragEvent,
  type RadialItem,
  type TabKey,
} from "./types";
import i18n from "../../i18n";

export default function RadialMenu() {
  const { t } = useTranslation();

  const [visible, setVisible] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("phrases");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [clipboardCategory, setClipboardCategory] = useState<ClipType>("all");
  const [resourceGroups, setResourceGroups] = useState<ResourceFolder[]>([]);
  const [resourceGroup, setResourceGroup] = useState<string | null>(null);
  const [resourceGroupMenuPath, setResourceGroupMenuPath] = useState<string | null>(null);
  const [resourceGroupMenuPosition, setResourceGroupMenuPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  // 资源分组下拉的子分组折叠状态：菜单存活期内记忆。
  const [collapsedGroupPaths, setCollapsedGroupPaths] = useState<string[]>([]);
  const [phraseGroupId, setPhraseGroupId] = useState<string | null>(ALL_PHRASES_GROUP_ID);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  // 收起动画播放中：预览保持挂载滑出，动画结束才真正卸载并恢复穿透。
  const [previewClosing, setPreviewClosing] = useState(false);
  // 菜单收起动画播放中（后端已发出 radial-menu-hide，窗口尚未停泊）。
  const [menuClosing, setMenuClosing] = useState(false);
  // 条带方向决定主面板贴窗口哪一侧（几何固定，会话内不变）：state 供
  // 渲染取类名，ref 供异步展开逻辑读取。
  const [previewSide, setPreviewSide] = useState<RadialPreviewDirection>("right");
  const [dragSessionItemId, setDragSessionItemId] = useState<string | null>(null);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);

  const visibleRef = useRef(false);
  const selectedItemIdRef = useRef<string | null>(null);
  const activeTabRef = useRef<TabKey>("phrases");
  const clipboardCategoryRef = useRef<ClipType>("all");
  const resourceGroupRef = useRef<string | null>(null);
  // 本次菜单会话内用户是否已手动切换过分组：防止打开菜单时的异步
  // 分组记忆恢复在返回后覆盖用户先一步的手动选择。
  const resourceGroupTouchedRef = useRef(false);
  // 同样用于「记住上次模式」恢复：打开菜单期间用户已手动切换 tab 时，
  // 异步返回的记忆 tab 不得覆盖用户选择。
  const tabTouchedRef = useRef(false);
  const resourceGroupMenuRef = useRef<HTMLDivElement>(null);
  const resourceGroupMenuAnchorRef = useRef<HTMLButtonElement>(null);
  const categoriesScrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const phraseGroupIdRef = useRef<string | null>(ALL_PHRASES_GROUP_ID);
  const previewRequestRef = useRef(0);
  const previewRef = useRef<PreviewState | null>(null);
  const previewCloseTimerRef = useRef<number | null>(null);
  const blurHideTimerRef = useRef<number | null>(null);
  // 扩展条带的方向与宽度：后端打开窗口时按光标所在显示器一次性决定
  // （预留好条带，展开期不再改动窗口几何），随 radial-menu-show 事件下发。
  const previewSideRef = useRef<RadialPreviewDirection>("right");
  const previewWidthRef = useRef(RADIAL_PREVIEW_WIDTH);
  const previewCacheRef = useRef(new Map<string, RadialPreviewSegment[]>());
  const dragActiveRef = useRef(false);
  const suppressClickRef = useRef(false);
  const nativeDragRef = useRef<PendingNativeDrag | null>(null);
  const dragSessionIdRef = useRef(0);
  const activeDragSessionIdRef = useRef<number | null>(null);
  const cancelledDragSessionsRef = useRef(new Set<number>());
  // 径向菜单 UI 缩放比（设置项，默认 1）。CSS 侧通过 --radial-ui-scale
  // 对整窗 zoom，窗口尺寸与物理换算在这里同步乘同一系数。
  const uiScaleRef = useRef(1);

  useEffect(() => { visibleRef.current = visible; }, [visible]);
  useEffect(() => { selectedItemIdRef.current = selectedItemId; }, [selectedItemId]);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { clipboardCategoryRef.current = clipboardCategory; }, [clipboardCategory]);
  useEffect(() => { resourceGroupRef.current = resourceGroup; }, [resourceGroup]);
  useEffect(() => { phraseGroupIdRef.current = phraseGroupId; }, [phraseGroupId]);
  useEffect(() => { previewRef.current = preview; }, [preview]);

  const applyUiScale = useCallback((scale: number) => {
    const next = Math.min(2, Math.max(0.5, Number.isFinite(scale) ? scale : 1));
    uiScaleRef.current = next;
    document.documentElement.style.setProperty("--radial-ui-scale", String(next));
  }, []);

  const loadResourceGroups = useCallback(async () => {
    try {
      const groups = await invoke<ResourceFolder[]>("get_resource_groups");
      setResourceGroups(groups);
    } catch (error) {
      console.error("Failed to load radial resource groups:", error);
    }
  }, []);

  // 快捷输入数据在挂载时由 phraseStore.init() 预取（默认「全部」视图）；
  // 每次切到该 tab / 打开菜单时由 activateTab 重新加载，保证使用记录新鲜。

  useEffect(() => {
    const el = categoriesScrollRef.current;
    if (!el) return;
    const handleCategoriesWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault();
        el.scrollLeft += event.deltaY;
      }
    };
    el.addEventListener("wheel", handleCategoriesWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleCategoriesWheel);
  }, [activeTab]);

  const resourceFolderGroups = resourceGroups.filter((group) => group.name !== "");
  const resourceGroupMenuFolder = resourceGroupMenuPath
    ? findResourceFolder(resourceFolderGroups, resourceGroupMenuPath)
    : null;
  // 折叠展平：根行（全部文件）不参与折叠，其下各行可收起后代。
  const collapsedGroupSet = useMemo(() => new Set(collapsedGroupPaths), [collapsedGroupPaths]);
  const resourceGroupMenuItems = resourceGroupMenuFolder
    ? [
        { folder: resourceGroupMenuFolder, depth: 0 },
        ...flattenResourceFoldersVisible(resourceGroupMenuFolder.children ?? [], collapsedGroupSet, 1),
      ]
    : [];

  const toggleResourceGroupCollapsed = useCallback((path: string) => {
    setCollapsedGroupPaths((current) => (
      current.includes(path)
        ? current.filter((path2) => path2 !== path)
        : [...current, path]
    ));
  }, []);

  const closeResourceGroupMenu = useCallback(() => {
    setResourceGroupMenuPath(null);
    setResourceGroupMenuPosition(null);
  }, []);

  const updateResourceGroupMenuPosition = useCallback(() => {
    const anchor = resourceGroupMenuAnchorRef.current;
    if (!anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = resourceGroupMenuRef.current?.getBoundingClientRect();
    const menuWidth = menuRect?.width ?? 220;
    const menuHeight = menuRect?.height ?? 0;
    const viewportPadding = 8;
    const left = Math.max(
      viewportPadding,
      Math.min(anchorRect.left, window.innerWidth - menuWidth - viewportPadding),
    );
    const top = anchorRect.bottom + 6 + menuHeight <= window.innerHeight - viewportPadding
      ? anchorRect.bottom + 6
      : Math.max(viewportPadding, anchorRect.top - menuHeight - 6);
    setResourceGroupMenuPosition({ left, top });
  }, []);

  useEffect(() => {
    if (!resourceGroupMenuPath) return;

    let frame: number | null = null;
    const schedulePositionUpdate = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        updateResourceGroupMenuPosition();
      });
    };
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (resourceGroupMenuRef.current?.contains(target)) return;
      if (resourceGroupMenuAnchorRef.current?.contains(target)) return;
      closeResourceGroupMenu();
    };

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("resize", schedulePositionUpdate);
    window.addEventListener("scroll", schedulePositionUpdate, true);
    schedulePositionUpdate();

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("resize", schedulePositionUpdate);
      window.removeEventListener("scroll", schedulePositionUpdate, true);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [closeResourceGroupMenu, resourceGroupMenuPath, resourceGroupMenuItems.length, updateResourceGroupMenuPosition]);

  const invalidatePreviewRequest = useCallback(() => {
    previewRequestRef.current += 1;
  }, []);

  // 展开/收起只做两件事：挂载/卸载预览面板 + 通知后端扩放输入区域。
  // 窗口几何自打开时按"面板 + 预留条带"分配后就固定不变——X11 上任何
  // resize/move 都会被合成器画出一帧"旧内容按左上锚定 + 新区域未绘制"
  // 的闪烁帧（实测帧证据），这是扩展闪烁的物理根源，必须整体绕开。
  // 收起因此也在 web 层做：预览滑出动画播放完毕才卸载并恢复条带穿透，
  // 动画期间输入区域保持展开（用户看到的预览仍可点击）。animated=false
  // 用于窗口隐藏等无需动效的路径，立即复位。
  const cancelPreviewClose = useCallback(() => {
    if (previewCloseTimerRef.current !== null) {
      window.clearTimeout(previewCloseTimerRef.current);
      previewCloseTimerRef.current = null;
    }
    setPreviewClosing(false);
  }, []);

  const collapsePreview = useCallback((animated = true) => {
    invalidatePreviewRequest();
    previewRef.current = null;
    cancelPreviewClose();
    if (!animated) {
      setPreview(null);
      void invoke("set_radial_hit_area", { expanded: false }).catch(() => {});
      return;
    }
    setPreviewClosing(true);
    previewCloseTimerRef.current = window.setTimeout(() => {
      previewCloseTimerRef.current = null;
      setPreviewClosing(false);
      setPreview(null);
      void invoke("set_radial_hit_area", { expanded: false }).catch(() => {});
    }, 160);
  }, [invalidatePreviewRequest, cancelPreviewClose]);

  const dismissPreviewForDrag = useCallback(() => {
    collapsePreview();
  }, [collapsePreview]);

  const cancelPendingNativeDrag = useCallback((pending: PendingNativeDrag | null) => {
    if (!pending || !pending.armRequested || pending.nativeStarted) return;
    cancelledDragSessionsRef.current.add(pending.sessionId);
    const cancelTask = invoke("cancel_radial_file_drag", {
      sessionId: pending.sessionId,
    });
    if (pending.armCompleted) {
      void cancelTask.then(
        () => cancelledDragSessionsRef.current.delete(pending.sessionId),
        () => cancelledDragSessionsRef.current.delete(pending.sessionId),
      );
    }
    else void cancelTask.catch(() => {});
  }, []);

  const expandPreviewWindow = useCallback(async (
    request: number,
    item: RadialItem,
  ): Promise<PreviewLayout | null> => {
    if (dragActiveRef.current || nativeDragRef.current) return null;
    if (request !== previewRequestRef.current) return null;
    if (previewRef.current) return previewRef.current.layout;
    // 收起动画尚在播放时重新展开：取消待执行的卸载，面板直接续用。
    cancelPreviewClose();
    // 条带方向与宽度由后端在打开窗口时一次性决定并随事件下发，
    // 前端不再查询显示器/计算窗口几何。
    const layout = { direction: previewSideRef.current, width: previewWidthRef.current };
    if (layout.width <= 0) return null;
    try {
      // 先扩输入区再挂载面板：面板出现的同一帧即可接收指针事件。
      await invoke("set_radial_hit_area", { expanded: true });
    } catch (error) {
      flog(`[preview] expand hit-area failed: ${String(error)}`);
    }
    if (
      request !== previewRequestRef.current
      || dragActiveRef.current
      || nativeDragRef.current
    ) {
      return null;
    }
    const loadingState = {
      itemId: item.id,
      segments: null,
      layout,
    };
    previewRef.current = loadingState;
    setPreview(loadingState);
    return layout;
  }, [cancelPreviewClose]);

  const loadPreviewSegments = useCallback(
    (item: RadialItem) => loadRadialPreviewSegments(item, previewCacheRef.current),
    [],
  );

  const showPreview = useCallback(async (item: RadialItem) => {
    if (dragActiveRef.current || nativeDragRef.current) return;
    const request = ++previewRequestRef.current;
    const layout = await expandPreviewWindow(request, item);
    if (
      !layout
      || request !== previewRequestRef.current
      || dragActiveRef.current
      || nativeDragRef.current
    ) return;
    try {
      const segments = await loadPreviewSegments(item);
      if (
        request !== previewRequestRef.current
        || dragActiveRef.current
        || nativeDragRef.current
      ) return;
      const loadedState = {
        itemId: item.id,
        segments,
        layout,
      };
      previewRef.current = loadedState;
      setPreview(loadedState);
    } catch {
      if (
        request !== previewRequestRef.current
        || dragActiveRef.current
        || nativeDragRef.current
      ) return;
      const failedState = {
        itemId: item.id,
        segments: [{ type: "text" as const, content: item.content }],
        layout,
      };
      previewRef.current = failedState;
      setPreview(failedState);
    }
  }, [expandPreviewWindow, loadPreviewSegments]);

  const togglePreview = useCallback((item: RadialItem) => {
    if (previewRef.current?.itemId === item.id) {
      collapsePreview();
      return;
    }
    void showPreview(item);
  }, [collapsePreview, showPreview]);

  const handlePreviewLeave = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (
      !previewRef.current
      || dragActiveRef.current
      || nativeDragRef.current
    ) return;

    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    collapsePreview();
  }, [collapsePreview]);

  useEffect(() => {
    // Initial theme load
    invoke<string>("get_setting", { key: "theme" }).then((theme) => {
      if (theme === "dark" || theme === "light") {
        document.documentElement.setAttribute("data-theme", theme);
      }
    }).catch(() => {});

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
      document.documentElement.setAttribute("data-theme", e.payload.theme);
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
      if (unlistenTheme) unlistenTheme();
      if (unlistenLang) unlistenLang();
      if (unlistenResourceGroups) unlistenResourceGroups();
    };
  }, [applyUiScale, loadResourceGroups]);

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
    // 分组浏览位置跨重启记忆。null（"全部"视图）与 ""（未分组）语义不同，
    // 设置表只存字符串，故以 JSON 编码区分三种状态。
    void invoke("set_setting", {
      key: "radial_resource_group",
      value: JSON.stringify(nextGroup),
    }).catch((error) => console.error("Failed to persist radial resource group:", error));
  }, [closeResourceGroupMenu, collapsePreview]);

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
  }, []);

  // 激活一个 tab 并保证对应数据就绪：手动切换与打开菜单恢复记忆共用。
  // 快捷输入每次激活都回到「全部」并重载，保证最近使用排序新鲜。
  const activateTab = useCallback((key: string) => {
    collapsePreview();
    const tab = key as TabKey;
    setActiveTab(tab);
    activeTabRef.current = tab;
    setSelectedItemId(null);
    selectedItemIdRef.current = null;
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
  }, [closeResourceGroupMenu, collapsePreview, loadResourceGroups]);

  const handleTabSwitch = useCallback((key: string) => {
    activateTab(key);
    // 手动切换即记住该模式：下次打开菜单（含跨重启）恢复到这里。
    tabTouchedRef.current = true;
    void invoke("set_setting", {
      key: RADIAL_LAST_TAB_SETTING,
      value: key,
    }).catch((error) => console.error("Failed to persist radial last tab:", error));
  }, [activateTab]);

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
  }, [activateTab]);

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
  }, [collapsePreview]);

  const handleCategoryClick = useCallback((e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    applyCategorySwitch(key);
  }, [applyCategorySwitch]);

  const resetState = useCallback((preserveClickSuppression = false) => {
    cancelPendingNativeDrag(nativeDragRef.current);
    collapsePreview(false);
    closeResourceGroupMenu();
    dragActiveRef.current = false;
    if (!preserveClickSuppression) suppressClickRef.current = false;
    visibleRef.current = false;
    setVisible(false);
    setSelectedItemId(null);
    selectedItemIdRef.current = null;
    setDragSessionItemId(null);
    setDraggingItemId(null);
    nativeDragRef.current = null;
    activeDragSessionIdRef.current = null;
  }, [cancelPendingNativeDrag, closeResourceGroupMenu, collapsePreview]);

  const resetStateForNativeHide = useCallback(() => {
    // 原生窗口已被后端隐藏，下次显示会重新定位并重置输入区域。
    resetState();
  }, [resetState]);

  const updateHoverFromPoint = useCallback((cssX: number, cssY: number) => {
    if (dragActiveRef.current || nativeDragRef.current) return;
    const el = document.elementFromPoint(cssX, cssY);
    if (!el) {
      selectedItemIdRef.current = null;
      setSelectedItemId(null);
      return;
    }
    if ((el as HTMLElement).closest("[data-content-preview]")) {
      return;
    }
    const itemEl = (el as HTMLElement).closest("[data-radial-item-id]");
    if (itemEl) {
      const id = itemEl.getAttribute("data-radial-item-id");
      selectedItemIdRef.current = id;
      setSelectedItemId(id);
    } else {
      selectedItemIdRef.current = null;
      setSelectedItemId(null);
    }
  }, []);

  const handleItemPaste = useCallback(async (itemId: string, terminal = false) => {
    // 先收起菜单再触发粘贴：后端的焦点沉降等待与窗口隐藏并行，
    // 点击到粘贴落地的延迟显著降低（原来串行等待粘贴命令返回后才隐藏）。
    resetState();
    void invoke("hide_radial_menu");
    const { records, pasteRecord, pasteRecordTerminal } = useClipboardStore.getState();
    const record = records.find((r) => r.id === itemId);
    if (record) {
      await (terminal ? pasteRecordTerminal(record) : pasteRecord(record));
    } else {
      const { phrases, pastePhrase, pastePhraseTerminal } = usePhraseStore.getState();
      const phrase = phrases.find((p) => p.id === itemId);
      if (phrase) {
        await (terminal ? pastePhraseTerminal(phrase) : pastePhrase(phrase));
      }
    }
  }, [resetState]);

  // 整组粘贴（方案 A）：文本组合并为一段，文件组按文件列表粘贴；
  // 逻辑本体在 radialItems.pasteResourceGroup，这里只接当前分组兜底值。
  const handlePasteGroup = useCallback((groupPath: string | null) => {
    void pasteResourceGroup(groupPath, resourceGroupRef.current, resetState);
  }, [resetState]);

  const markRadialDragStarted = useCallback((pending: PendingNativeDrag) => {
    if (pending.nativeStarted) return;
    dragActiveRef.current = true;
    nativeDragRef.current = {
      ...pending,
      thresholdCrossed: true,
      nativeStarted: true,
    };
    suppressClickRef.current = true;
    setDraggingItemId(pending.itemId);
  }, []);

  const startRadialFileDrag = useCallback((pending: PendingNativeDrag) => {
    if (
      !pending.thresholdCrossed
      || pending.startRequested
      || pending.nativeStarted
    ) return;

    const next = { ...pending, startRequested: true };
    nativeDragRef.current = next;
    // 先隐藏窗口再启动拖动：视觉即时反馈，同时释放 WebView2 的隐式
    // 鼠标捕获。此前要等后端解码完虚影才隐藏，期间界面毫无反应。
    // 停泊模型下后端不再 unmap 窗口（Linux），这里必须自行隐藏内容
    // （只翻 visible，不清拖拽会话状态——原生拖拽还在进行中）。
    visibleRef.current = false;
    setVisible(false);
    void invoke("hide_radial_menu");
    flog(`invoking start_radial_file_drag session=${next.sessionId} item=${next.itemId}`);
    void invoke("start_radial_file_drag", {
      source: next.dragSource,
      id: next.itemId,
      path: next.dragPath || null,
      sessionId: next.sessionId,
      dragImageBase64: captureDragThumbnail(next.itemId),
    }).catch((error) => {
      flog(`start_radial_file_drag rejected session=${next.sessionId}: ${error}`);
      const current = nativeDragRef.current;
      if (
        !current
        || current.pointerId !== next.pointerId
        || current.sessionId !== next.sessionId
      ) return;
      resetState(true);
      void invoke("hide_radial_menu");
      console.error("Failed to start radial file drag:", error);
    });
  }, [resetState]);

  const armRadialFileDrag = useCallback((pending: PendingNativeDrag) => {
    if (pending.armRequested || pending.nativeStarted) return;

    const next = { ...pending, armRequested: true };
    nativeDragRef.current = next;
    void invoke("arm_radial_file_drag", {
      source: next.dragSource,
      id: next.itemId,
      path: next.dragPath || null,
      sessionId: next.sessionId,
      screenX: next.startScreenX,
      screenY: next.startScreenY,
      devicePixelRatio: next.devicePixelRatio,
    }).then(() => {
      const wasCancelled = cancelledDragSessionsRef.current.delete(next.sessionId);
      if (wasCancelled) {
        void invoke("cancel_radial_file_drag", {
          sessionId: next.sessionId,
        }).catch(() => {});
        return;
      }

      const current = nativeDragRef.current;
      if (
        !current
        || current.pointerId !== next.pointerId
        || current.sessionId !== next.sessionId
      ) return;
      nativeDragRef.current = {
        ...current,
        armCompleted: true,
      };
    }).catch((error) => {
      cancelledDragSessionsRef.current.delete(next.sessionId);
      const current = nativeDragRef.current;
      if (
        !current
        || current.pointerId !== next.pointerId
        || current.sessionId !== next.sessionId
      ) return;
      nativeDragRef.current = {
        ...current,
        armRequested: false,
        armCompleted: false,
      };
      if (current.thresholdCrossed) {
        suppressClickRef.current = true;
        dragActiveRef.current = false;
        nativeDragRef.current = null;
        activeDragSessionIdRef.current = null;
        setDragSessionItemId(null);
        setDraggingItemId(null);
        collapsePreview();
      }
      console.error("Failed to arm radial file drag:", error);
    }).finally(() => {
      cancelledDragSessionsRef.current.delete(next.sessionId);
    });
  }, [collapsePreview]);

  const finishPendingPointerDrag = useCallback((pending: PendingNativeDrag) => {
    const current = nativeDragRef.current;
    if (!current || current.sessionId !== pending.sessionId) return;
    cancelPendingNativeDrag(current);
    nativeDragRef.current = null;
    dragActiveRef.current = false;
    if (activeDragSessionIdRef.current === pending.sessionId) {
      activeDragSessionIdRef.current = null;
    }
    setDragSessionItemId(null);
    setDraggingItemId(null);
    if (previewRef.current) collapsePreview();
  }, [cancelPendingNativeDrag, collapsePreview]);

  const handleItemPointerDown = useCallback((
    e: PointerEvent,
  ) => {
    const target = e.target instanceof Element
      ? e.target.closest<HTMLElement>(
          '[data-radial-item-id][data-radial-drag-kind="files"]',
        )
      : null;
    flog(
      `pointer-down btn=${e.button} primary=${e.isPrimary} dragActive=${dragActiveRef.current}`
      + ` nativeDrag=${nativeDragRef.current ? nativeDragRef.current.sessionId : "none"}`
      + ` matched=${target ? "yes" : "no"}`,
    );
    if (
      e.button !== 0
      || !e.isPrimary
      || dragActiveRef.current
      || nativeDragRef.current
    ) return;

    const itemId = target?.dataset.radialItemId;
    const dragSource = target?.dataset.radialDragSource as RadialDragSource | undefined;
    if (
      !target
      || !itemId
      || (dragSource !== "clipboard" && dragSource !== "phrase" && dragSource !== "group")
    ) {
      nativeDragRef.current = null;
      setDragSessionItemId(null);
      setDraggingItemId(null);
      return;
    }

    suppressClickRef.current = false;
    setDragSessionItemId(itemId);
    const pending: PendingNativeDrag = {
      itemId,
      dragSource,
      dragPath: target.dataset.radialDragPath || undefined,
      sessionId: ++dragSessionIdRef.current,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      devicePixelRatio: window.devicePixelRatio || 1,
      thresholdCrossed: false,
      armRequested: false,
      armCompleted: false,
      startRequested: false,
      nativeStarted: false,
    };
    flog(`drag session armed item=${itemId} source=${dragSource} session=${pending.sessionId}`);
    nativeDragRef.current = pending;
    activeDragSessionIdRef.current = pending.sessionId;
    dismissPreviewForDrag();
    armRadialFileDrag(pending);
  }, [
    armRadialFileDrag,
    dismissPreviewForDrag,
  ]);

  const handleItemPointerMove = useCallback((e: PointerEvent) => {
    const pending = nativeDragRef.current;
    if (!pending || pending.pointerId !== e.pointerId) return;
    e.preventDefault();
    if (pending.nativeStarted) return;
    if (pending.thresholdCrossed) {
      return;
    }

    const distance = Math.hypot(
      e.clientX - pending.startX,
      e.clientY - pending.startY,
    );
    if (distance < RADIAL_DRAG_THRESHOLD_PX) return;

    flog(
      `threshold crossed session=${pending.sessionId} dist=${distance.toFixed(1)}`
      + ` client=(${e.clientX},${e.clientY}) screen=(${e.screenX},${e.screenY})`,
    );
    suppressClickRef.current = true;
    dragActiveRef.current = true;
    setDraggingItemId(pending.itemId);
    const crossed = { ...pending, thresholdCrossed: true };
    nativeDragRef.current = crossed;
    if (!IS_LINUX) startRadialFileDrag(crossed);
  }, [startRadialFileDrag]);

  const handleItemPointerUp = useCallback((e: PointerEvent) => {
    const pending = nativeDragRef.current;
    if (!pending || pending.pointerId !== e.pointerId) return;
    if (pending.nativeStarted || pending.startRequested) return;
    finishPendingPointerDrag(pending);
  }, [finishPendingPointerDrag]);

  const handleRadialDragStarted = useCallback((event: { payload: RadialDragEvent }) => {
    const pending = nativeDragRef.current;
    if (
      !pending
      || activeDragSessionIdRef.current !== event.payload.session_id
      || pending.sessionId !== event.payload.session_id
    ) return;
    markRadialDragStarted(pending);
  }, [markRadialDragStarted]);

  const handleRadialDragFinished = useCallback((event: { payload: RadialDragEvent }) => {
    if (activeDragSessionIdRef.current !== event.payload.session_id) return;
    const pending = nativeDragRef.current;
    if (
      !pending
      || pending.sessionId !== event.payload.session_id
      || !dragActiveRef.current
    ) return;
    dragActiveRef.current = false;
    nativeDragRef.current = null;
    activeDragSessionIdRef.current = null;
    setDraggingItemId(null);
    resetState(true);
    void invoke("hide_radial_menu");
  }, [resetState]);

  const handleDocumentPointerDown = useCallback((e: PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary) return;
    if (
      e.target instanceof Element
      && e.target.closest("[data-radial-preview-trigger]")
    ) return;
    // 清掉上一次原生拖动为防止幽灵 click 留下的抑制标记。
    suppressClickRef.current = false;
    handleItemPointerDown(e);
  }, [handleItemPointerDown]);

  useEffect(() => {
    document.addEventListener("pointerdown", handleDocumentPointerDown, {
      capture: true,
      passive: false,
    });
    document.addEventListener("pointermove", handleItemPointerMove, {
      capture: true,
      passive: false,
    });
    document.addEventListener("pointerup", handleItemPointerUp, true);
    document.addEventListener("pointercancel", handleItemPointerUp, true);
    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
      document.removeEventListener("pointermove", handleItemPointerMove, true);
      document.removeEventListener("pointerup", handleItemPointerUp, true);
      document.removeEventListener("pointercancel", handleItemPointerUp, true);
    };
  }, [handleDocumentPointerDown, handleItemPointerMove, handleItemPointerUp]);

  // Popup 点击：点在菜单内空白（非按钮/非交互元素）时不再收起菜单，
  // 仅收起预览、关闭分组下拉并清除选中。菜单收起只由点击窗口外部
  // （后端失焦回收）或再次触发快捷键完成。
  const handlePopupClick = useCallback(() => {
    collapsePreview();
    closeResourceGroupMenu();
    setSelectedItemId(null);
    selectedItemIdRef.current = null;
  }, [collapsePreview, closeResourceGroupMenu]);
  useEffect(() => {
    let unlisteners: UnlistenFn[] = [];
    let disposed = false;

    const setup = async () => {
      // 快捷键的 X11 全局 grab 会先抢走焦点（DOM blur），后端的快捷键
      // 处理器随后才运行——若 blur 立即自隐藏，处理器会误判"窗口未显示"
      // 而重新弹出，二次按键永远无法收起。因此自隐藏延迟一拍，期间收到
      // 后端 hide/show 事件或焦点回归（用户点了回来）即取消。
      const cancelPendingBlurHide = () => {
        if (blurHideTimerRef.current !== null) {
          window.clearTimeout(blurHideTimerRef.current);
          blurHideTimerRef.current = null;
        }
      };
      // 诊断：径向窗口焦点丢失往往先于用户感知的"菜单消失"。
      void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        flog(`radial window focus changed: focused=${focused}`);
        if (focused) cancelPendingBlurHide();
      });

      // Listen for radial-menu-show event from backend (keyboard shortcut triggered)
      const [unShow, unHide, unDragStarted, unDragFinished, unScaleChanged] = await Promise.all([
        listen<{ theme: string; scale?: number; previewSide?: RadialPreviewDirection; previewWidth?: number }>("radial-menu-show", (e) => {
          cancelPendingBlurHide();
          // 后端会先显示窗口再发事件，必须先同步开放前端交互，避免首次按下落在隐藏状态。
          if (typeof e.payload.scale === "number") applyUiScale(e.payload.scale);
          // 打开时已按该方向/宽度预留好扩展条带（几何不再变化），此处仅同步。
          const side = e.payload.previewSide === "left" ? "left" : "right";
          previewSideRef.current = side;
          setPreviewSide(side);
          previewWidthRef.current = typeof e.payload.previewWidth === "number"
            ? Math.max(0, Math.floor(e.payload.previewWidth))
            : RADIAL_PREVIEW_WIDTH;
          const pending = nativeDragRef.current;
          if (pending && !pending.nativeStarted) {
            cancelPendingNativeDrag(pending);
            nativeDragRef.current = null;
            dragActiveRef.current = false;
            activeDragSessionIdRef.current = null;
          }
          visibleRef.current = true;
          setVisible(true);
          if (!dragActiveRef.current && !nativeDragRef.current) {
            collapsePreview();
            previewCacheRef.current.clear();
            suppressClickRef.current = false;
            setDragSessionItemId(null);
            setDraggingItemId(null);
          }
          document.documentElement.setAttribute("data-theme", e.payload.theme);
          void loadPasteLeftClickSetting();
          setSelectedItemId(null);
          selectedItemIdRef.current = null;
          // 每次打开菜单恢复「记住的上次模式」：手动切 tab 时已持久化，
          // 无记忆（首次使用）时保持初始「最近」；异步返回前用户已手动
          // 切换 tab 时以用户选择为准。
          tabTouchedRef.current = false;
          closeResourceGroupMenu();
          // 资源分组浏览位置保留记忆：本次运行内沿用内存值，跨重启由设置恢复。
          // 每次打开菜单先重置"用户已手动切换分组"标记，再恢复记忆值；
          // 恢复期间用户的手动切换不会被异步返回的记忆值覆盖。
          resourceGroupTouchedRef.current = false;
          void restoreResourceGroup();
          void restoreLastTab();
          // Refresh data
          useClipboardStore.getState().setCategory("all");
          useClipboardStore.getState().loadRecords(false, "all");
          usePhraseStore.getState().loadGroups();
        }),
        listen("radial-menu-hide", () => {
          cancelPendingBlurHide();
          // 后端约 170ms 后原地停泊（清输入区、归还焦点，不 unmap——
          // 窗管的偏心退场动画永不出现），期间播放居中缩小退场动画。
          setMenuClosing(true);
          window.setTimeout(() => setMenuClosing(false), 150);
          resetStateForNativeHide();
        }),
        listen("radial-drag-started", handleRadialDragStarted),
        listen("radial-drag-finished", handleRadialDragFinished),
        listen<{ scale: number }>("radial-scale-changed", (e) => {
          applyUiScale(e.payload.scale);
        }),
      ]);
      if (disposed) {
        unShow();
        unHide();
        unDragStarted();
        unDragFinished();
        unScaleChanged();
        return;
      }
      unlisteners = [unShow, unHide, unDragStarted, unDragFinished, unScaleChanged];
    };

    void setup().catch((error) => {
      if (!disposed) console.error("Failed to register radial menu listeners:", error);
    });

    // Mouse move: update hover state from cursor position (only when visible)
    const handleMouseMove = (e: MouseEvent) => {
      if (!visibleRef.current) return;
      updateHoverFromPoint(e.clientX, e.clientY);
    };

    // Keyboard: Escape to dismiss
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && visibleRef.current) {
        resetState();
        // Linux 窗口常驻映射，前端不得直接 unmap（会触发窗管偏心退场
        // 动画）；走后端停泊，由后端归还焦点。
        void invoke("hide_radial_menu");
      }
    };

    // Blur: dismiss when window loses focus
    const handleBlur = () => {
      const pending = nativeDragRef.current;
      if (
        visibleRef.current
        && pending
        && !pending.thresholdCrossed
        && !pending.nativeStarted
      ) {
        finishPendingPointerDrag(pending);
        resetState();
        void invoke("hide_radial_menu");
        return;
      }
      // 系统截图会暂时抢走焦点；扩展预览仍由整个弹出窗口承载，不能因此关闭。
      // 真正移出窗口时由 onMouseLeave 收起预览，再沿用普通菜单的失焦隐藏逻辑。
      if (
        visibleRef.current
        && previewRef.current
        && !dragActiveRef.current
        && !nativeDragRef.current
      ) {
        return;
      }
      if (
        visibleRef.current
        && !dragActiveRef.current
        && !nativeDragRef.current
      ) {
        // 延迟自隐藏：给后端快捷键处理器留出竞态窗口（见
        // cancelPendingBlurHide 注释）。真实失焦（点击其他应用）时没有
        // 事件来取消，150ms 后照常隐藏。
        if (blurHideTimerRef.current !== null) {
          window.clearTimeout(blurHideTimerRef.current);
        }
        blurHideTimerRef.current = window.setTimeout(() => {
          blurHideTimerRef.current = null;
          if (
            visibleRef.current
            && !dragActiveRef.current
            && !nativeDragRef.current
          ) {
            resetState();
            void invoke("hide_radial_menu");
          }
        }, 150);
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleBlur);

    return () => {
      disposed = true;
      cancelPendingNativeDrag(nativeDragRef.current);
      if (blurHideTimerRef.current !== null) {
        window.clearTimeout(blurHideTimerRef.current);
        blurHideTimerRef.current = null;
      }
      unlisteners.forEach((fn) => fn());
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleBlur);
    };
  }, [
    applyUiScale,
    closeResourceGroupMenu,
    collapsePreview,
    cancelPendingNativeDrag,
    handleRadialDragFinished,
    handleRadialDragStarted,
    finishPendingPointerDrag,
    loadResourceGroups,
    resetStateForNativeHide,
    resetState,
    restoreLastTab,
    restoreResourceGroup,
    updateHoverFromPoint,
  ]);

  const records = useClipboardStore((s) => s.records);
  const phraseGroups = usePhraseStore((s) => s.groups);
  const phrases = usePhraseStore((s) => s.phrases);
  const pasteLeftClick = useSettingsStore((s) => s.pasteLeftClick);
  const countSortOn = useSettingsStore((s) => s.contentSort === "count");

  const filteredRecords = clipboardCategory === "all"
    ? records.filter((r) => !isResourceRecord(r))
    : clipboardCategory === "resources"
      ? records.filter((r) => isResourceRecord(r))
    : records.filter((r) => !isResourceRecord(r) && r.type === clipboardCategory);

  // 三类来源统一映射为 RadialItem；映射本体在 radialItems 模块，
  // 此处只注入翻译函数。

  const items: RadialItem[] = activeTab === "clipboard"
    ? filteredRecords.slice(0, MAX_ITEMS).map((r) => ({
        ...recordToRadialItem(r, t),
        usedAtLabel: usageTimeLabel(r),
      }))
    : activeTab === "resources"
      ? records
          .filter((r) => isResourceRecord(r))
          .slice(0, MAX_ITEMS)
          .map((r) => {
            const item = recordToRadialItem(r, t);
            if (resourceGroup !== null) {
              // 分组浏览保持原样：不带使用时间标签、来源标签与次数徽标。
              return { ...item, useCount: undefined };
            }
            const leaf = resourceGroupLeafLabel(r.resource_group);
            return {
              ...item,
              usedAtLabel: usageTimeLabel(r),
              sourceLabel: leaf
                ? `${t("tabs.resources")} · ${leaf}`
                : t("tabs.resources"),
            };
          })
      : activeTab === "phrases"
        ? phraseGroupId === ALL_PHRASES_GROUP_ID
          ? buildAllPhraseItems(phrases, t).slice(0, PHRASES_ALL_LIMIT)
          : phrases.map((phrase) => phraseToRadialItem(phrase))
        : [];

  // 统一的「回到顶部」：tab / 分类 / 分组 / 内容变化后重新评估按钮可见性。
  const backToTop = useBackToTop({
    resetKey: `${activeTab}|${clipboardCategory}|${phraseGroupId}|${resourceGroup ?? ""}|${items.length}`,
  });

  const categories = activeTab === "clipboard"
    ? [
        { key: "all", label: t("clipboard.all") },
        { key: "text", label: t("clipboard.text") },
        { key: "image", label: t("clipboard.image") },
        { key: "link", label: t("clipboard.link") },
        { key: "file", label: t("clipboard.file") },
      ]
    : activeTab === "phrases"
      ? [
          { key: ALL_PHRASES_GROUP_ID, label: t("clipboard.all") },
          ...phraseGroups.map((g) => ({
            key: g.id,
            label: g.name,
          })),
        ]
      : [];

  const activeCategory = activeTab === "clipboard" ? clipboardCategory : phraseGroupId;
  const getResourceGroupControlLabel = (group: ResourceFolder) => (
    resourceGroup && isResourceFolderPath(resourceGroup, group.path)
      ? formatResourceFolderPath(resourceGroup)
      : group.name
  );

  // 分组 chip 本身即整组操作入口：单击切分组（保留）、Shift+单击 = 粘贴该组、
  // 按住拖动 = 通过 data-radial-* 属性接入的通用拖拽会话原生拖出该组全部文件。
  // 正在浏览某分组子级时，chip 标签显示当前浏览路径，粘贴/拖出同样只作用于
  // 该路径而非顶层分组；单击切换仍回到 chip 对应的顶层分组。
  // 仅真实分组（非"全部"视图）且 groupCount > 0 时挂载拖拽与粘贴能力。
  const groupChipDragProps = (groupPath: string, groupCount: number) => (
    groupCount > 0
      ? {
        "data-radial-item-id": groupPath,
        "data-radial-drag-kind": "files",
        "data-radial-drag-source": "group",
      }
      : {}
  );

  // groupPath 是单击切换的目标（chip 对应的顶层分组），pastePath 是 Shift+单击
  // 粘贴的目标分组，浏览子分组时两者可能不同。
  const handleGroupChipClick = (
    groupPath: string,
    pastePath: string,
    groupCount: number,
    shiftKey: boolean,
  ) => {
    if (shiftKey && groupCount > 0 && pasteLeftClick !== "terminal") {
      void handlePasteGroup(pastePath);
      return;
    }
    applyResourceGroupSwitch(groupPath);
  };

  const resourceGroupMenu = resourceGroupMenuPath && resourceGroupMenuFolder ? (
    <ResourceGroupMenu
      items={resourceGroupMenuItems}
      position={resourceGroupMenuPosition}
      collapsedPaths={collapsedGroupPaths}
      selectedGroup={resourceGroup}
      menuRef={resourceGroupMenuRef}
      onToggleCollapsed={toggleResourceGroupCollapsed}
      onSwitch={applyResourceGroupSwitch}
    />
  ) : null;

  return (
    <div className={`radial-menu-overlay${visible ? "" : " radial-menu-hidden"}`}>
      <div
        className={`radial-menu-popup ${previewSide === "left" ? "strip-left" : "strip-right"}${preview ? " preview-open" : ""}${dragSessionItemId ? " drag-session" : ""}${visible ? " radial-menu-appearing" : ""}${menuClosing ? " radial-menu-closing" : ""}`}
        style={preview ? {
          "--radial-preview-width": `${preview.layout.width}px`,
        } as CSSProperties : undefined}
        onClick={handlePopupClick}
        onMouseLeave={handlePreviewLeave}
      >
        <div className="radial-menu-main">
          <div className="radial-menu-nav">
          {RADIAL_TAB_KEYS.map((tab) => (
            <button
              key={tab}
              className={`radial-menu-nav-tab ${activeTab === tab ? "active" : ""}`}
              data-radial-nav={tab}
              aria-label={t(`tabs.${tab}`)}
              title={t(`tabs.${tab}`)}
              onClick={(e) => handleTabClick(e, tab)}
            >
              {NAV_TAB_ICONS[tab]}
            </button>
          ))}
          </div>

          {activeTab === "resources" ? (
            <div
              ref={categoriesScrollRef}
              className="radial-menu-categories radial-menu-resource-groups"
              data-radial-categories
            >
              <button
                type="button"
                className={`radial-menu-category-chip ${resourceGroup === null ? "active" : ""}`}
                data-radial-category="all-resources"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  applyResourceGroupSwitch(null);
                }}
              >
                {t("resources.allGroups")}
              </button>
              {(() => {
                const ungroupedCount = resourceGroups.find((group) => group.name === "")?.count ?? 0;
                return (
                  <button
                    type="button"
                    className={`radial-menu-category-chip ${resourceGroup === "" ? "active" : ""}`}
                    data-radial-category="ungrouped-resources"
                    {...groupChipDragProps("", ungroupedCount)}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleGroupChipClick("", "", ungroupedCount, e.shiftKey);
                    }}
                  >
                    {t("resources.ungrouped")}
                  </button>
                );
              })()}
              {resourceFolderGroups.map((group) => {
                const hasChildren = (group.children ?? []).length > 0;
                const isActive = resourceGroup !== null
                  && isResourceFolderPath(resourceGroup, group.path);
                const groupLabel = getResourceGroupControlLabel(group);
                // 标签显示当前浏览路径时，粘贴/拖出与空组判断同样只作用于该路径；
                // 子树中查不到（数据不一致）时 count 视为 0，安全退化为普通切换。
                const pastePath = isActive && resourceGroup !== null ? resourceGroup : group.path;
                const pasteCount = pastePath === group.path
                  ? group.count
                  : findResourceFolder(group.children ?? [], pastePath)?.count ?? 0;
                const dragProps = groupChipDragProps(pastePath, pasteCount);
                const handleChipClick = (e: React.MouseEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleGroupChipClick(group.path, pastePath, pasteCount, e.shiftKey);
                };
                return hasChildren ? (
                  <div
                    key={group.path}
                    className={`radial-menu-resource-group-control${isActive ? " active" : ""}${resourceGroupMenuPath === group.path ? " open" : ""}`}
                  >
                    <button
                      type="button"
                      className="radial-menu-resource-group-main"
                      {...dragProps}
                      onClick={handleChipClick}
                      title={groupLabel}
                    >
                      <span>{groupLabel}</span>
                    </button>
                    <button
                      type="button"
                      className="radial-menu-resource-group-chevron"
                      ref={(element) => {
                        if (resourceGroupMenuPath === group.path) {
                          resourceGroupMenuAnchorRef.current = element;
                        }
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (resourceGroupMenuPath === group.path) {
                          closeResourceGroupMenu();
                          return;
                        }
                        resourceGroupMenuAnchorRef.current = e.currentTarget;
                        setResourceGroupMenuPosition(null);
                        setResourceGroupMenuPath(group.path);
                      }}
                      aria-label={t("resources.openSubfolders")}
                      aria-expanded={resourceGroupMenuPath === group.path}
                      aria-haspopup="menu"
                      title={t("resources.openSubfolders")}
                    >
                      {Icons.chevronDown}
                    </button>
                  </div>
                ) : (
                  <button
                    key={group.path}
                    type="button"
                    className={`radial-menu-category-chip ${isActive ? "active" : ""}`}
                    {...dragProps}
                    onClick={handleChipClick}
                    title={group.name}
                  >
                    {group.name}
                  </button>
                );
              })}
            </div>
          ) : categories.length > 0 && (
            <div
              ref={categoriesScrollRef}
              className="radial-menu-categories"
              data-radial-categories
            >
              {categories.map((cat) => (
                <button
                  key={cat.key}
                  className={`radial-menu-category-chip ${activeCategory === cat.key ? "active" : ""}`}
                  data-radial-category={cat.key}
                  onClick={(e) => handleCategoryClick(e, cat.key)}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          )}

          <div
            ref={(element) => {
              listRef.current = element;
              backToTop.containerRef(element);
            }}
            className="radial-menu-list"
            data-radial-list
          >
            {items.length === 0 ? (
              <div className="radial-menu-empty">{t("radialMenu.empty")}</div>
            ) : (
              items.map((item) => (
                <div
                  key={item.id}
                  className={`radial-menu-item${selectedItemId === item.id ? " selected" : ""}${draggingItemId === item.id ? " dragging" : ""}${item.sourceLabel ? " has-source" : ""}${countSortOn && item.useCount != null ? " has-count" : ""}`}
                  data-radial-item-id={item.id}
                  data-radial-drag-kind={item.dragKind}
                  data-radial-drag-source={item.dragSource}
                  data-radial-drag-path={item.dragPath}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
                    handleItemPaste(
                      item.id,
                      shouldUseTerminalPasteForMouseTrigger(
                        pasteLeftClick,
                        e.shiftKey ? "left-shift" : "left",
                      ),
                    );
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleItemPaste(
                      item.id,
                      shouldUseTerminalPasteForMouseTrigger(pasteLeftClick, "right"),
                    );
                  }}
                >
                    <div className="radial-menu-item-content">
                    {item.isResource ? (
                      <ResourceItemVisual item={item} />
                    ) : item.type === "image" ? (
                      <RadialImageBanner recordId={item.id} />
                    ) : item.imagePath ? (
                      <FileMediaVisual path={item.imagePath} className="radial-menu-file-media" />
                    ) : item.filePath && item.fileMediaKind ? (
                      <FileMediaVisual
                        path={item.filePath}
                        className="radial-menu-file-media"
                      />
                    ) : (
                      <span className="radial-menu-item-text">
                        {item.content.length > 300
                          ? item.content.slice(0, 300) + "…"
                          : item.content}
                      </span>
                    )}
                  </div>
                  {(item.isResource
                    ? (item.resourceTitle || item.createdAt || item.usedAtLabel || item.useCount != null || item.previewAvailable)
                    : (item.createdAt || item.usedAtLabel || item.useCount != null || item.title || item.previewAvailable)) && (
                    <div className="radial-menu-item-footer">
                      <div className="radial-menu-item-meta">
                        {item.isResource && item.resourceTitle && (
                          <strong className="radial-menu-resource-title">{item.resourceTitle}</strong>
                        )}
                        {(item.usedAtLabel || item.createdAt) && (
                          <span className="radial-menu-item-time">
                            {item.usedAtLabel
                              ?? (item.createdAt ? formatTime(item.createdAt) : "")}
                          </span>
                        )}
                        {countSortOn && item.useCount != null && (
                          <UsageCountBadge count={item.useCount} />
                        )}
                        {!item.isResource && item.title && (
                          <span className="radial-menu-item-remark">{item.title}</span>
                        )}
                        {item.sourceLabel && (
                          <span
                            className="radial-menu-item-source"
                            title={item.sourceLabel}
                          >
                            {item.sourceLabel}
                          </span>
                        )}
                      </div>
                      {item.previewAvailable && (
                        <div className="radial-menu-item-actions">
                          <button
                            className="radial-menu-preview-trigger"
                            data-radial-preview-trigger
                            type="button"
                            aria-expanded={preview?.itemId === item.id}
                            aria-label={t(
                              preview?.itemId === item.id
                                ? "radialMenu.closePreview"
                                : "radialMenu.openPreview",
                            )}
                            title={t(
                              preview?.itemId === item.id
                                ? "radialMenu.closePreview"
                                : "radialMenu.openPreview",
                            )}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              suppressClickRef.current = false;
                              togglePreview(item);
                            }}
                          >
                            {preview?.itemId === item.id ? Icons.collapse : Icons.expand}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          <BackToTopButton
            visible={backToTop.visible}
            onTop={backToTop.scrollToTop}
            label={t("common.backToTop")}
          />
        </div>

        {preview && (
          <ContentPreviewPanel
            className={`radial-menu-preview${previewClosing ? " preview-closing" : ""}`}
            segments={preview.segments}
            onClose={() => collapsePreview()}
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>
      {resourceGroupMenu}
    </div>
  );
}
