import { useEffect, useRef, useState, useCallback, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  currentMonitor,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Icons } from "../Icons";
import { useClipboardStore, type ClipType } from "../../stores/clipboardStore";
import { usePhraseStore, isImageFilePath } from "../../stores/phraseStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { shouldUseTerminalPasteForMouseTrigger } from "../../utils/pasteMode";
import {
  calculateRadialExpansion,
  isContentPreviewAvailable,
  RADIAL_MENU_HEIGHT,
  RADIAL_MENU_WIDTH,
  RADIAL_SHADOW_MARGIN,
  type RadialPreviewDirection,
  type RadialPreviewSegment,
} from "../../utils/radialPreview";
import {
  getClipboardRadialDragKind,
  getPhraseRadialDragKind,
  type RadialDragKind,
  type RadialDragSource,
} from "../../utils/radialDrag";
import { ContentPreviewPanel } from "../ContentPreviewPanel";
import { InlineTextFilePreview } from "../InlinePreview";
import { loadClipboardPreviewSegments } from "../../utils/contentPreview";
import { isResourceRecord } from "../../utils/clipboardRecord";
import type { ResourceFolder } from "../../types";
import {
  findResourceFolder,
  flattenResourceFolders,
  getResourcePath,
  getResourceSummary,
  getResourceTitle,
  inferResourceMediaKind,
  isResourceFolderPath,
  type ResourceMediaKind,
} from "../../pages/ResourcePage/resourceUtils";
import { ResourceFileImage } from "../../pages/ResourcePage/ResourceMedia";
import i18n from "../../i18n";

type TabKey = "clipboard" | "phrases" | "resources";

const MAX_ITEMS = 2000;
const RADIAL_DRAG_THRESHOLD_PX = 6;
const IS_LINUX = typeof navigator !== "undefined"
  && /Linux/i.test(navigator.userAgent)
  && !/Android/i.test(navigator.userAgent);

interface RadialItem {
  id: string;
  content: string;
  type: string;
  /** file 短语指向图像文件时为相对存储路径：条目显示缩略图，悬浮展开大图预览。 */
  imagePath?: string;
  createdAt?: string;
  title?: string;
  contentTruncated?: boolean;
  previewAvailable: boolean;
  dragPath?: string;
  dragKind: RadialDragKind;
  dragSource: RadialDragSource;
  isResource?: boolean;
  resourceKind?: ResourceMediaKind;
  resourcePath?: string;
  resourceTitle?: string;
  resourceSummary?: string;
}

interface PreviewLayout {
  direction: RadialPreviewDirection;
  width: number;
}

interface PreviewState {
  itemId: string;
  segments: RadialPreviewSegment[] | null;
  layout: PreviewLayout;
}

interface PendingNativeDrag {
  itemId: string;
  dragSource: RadialDragSource;
  dragPath?: string;
  sessionId: number;
  pointerId: number;
  startX: number;
  startY: number;
  startScreenX: number;
  startScreenY: number;
  devicePixelRatio: number;
  thresholdCrossed: boolean;
  armRequested: boolean;
  armCompleted: boolean;
  startRequested: boolean;
  nativeStarted: boolean;
}

interface RadialDragEvent {
  session_id: number;
}

const filenameFromPath = (path: string) => path.replace(/\\/g, "/").split("/").pop() || path;

function formatResourceFolderPath(path: string): string {
  return path.split("/").filter(Boolean).join(" / ");
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${month}/${day} ${hours}:${minutes}`;
}

async function loadPasteLeftClickSetting() {
  try {
    const mode = await invoke<string>("get_setting", { key: "paste_left_click" });
    useSettingsStore.setState({
      pasteLeftClick: mode === "terminal" ? "terminal" : "normal",
    });
  } catch {
    // Keep the default normal paste mode if the setting is unavailable.
  }
}

function ImageThumb({ recordId }: { recordId: string }) {
  const [src, setSrc] = useState("");
  const { records, getThumbnail } = useClipboardStore();

  useEffect(() => {
    const record = records.find((r) => r.id === recordId);
    if (!record || record.type !== "image") return;
    let cancelled = false;
    getThumbnail(record).then((url) => {
      if (!cancelled && url) setSrc(url);
    });
    return () => { cancelled = true; };
  }, [recordId, records, getThumbnail]);

  if (!src) return <span className="radial-menu-item-text">…</span>;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      style={{ width: 48, height: 36, objectFit: "cover", borderRadius: 5 }}
    />
  );
}

/** 图像文件短语的缩略图（content 为相对存储目录的路径），加载失败回退文件名。 */
function FileThumb({ path }: { path: string }) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_image_thumbnail", { path, maxSize: 200 })
      .then((base64) => {
        if (!cancelled) setSrc(`data:image/png;base64,${base64}`);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path]);

  if (!src) return <span className="radial-menu-item-text">{filenameFromPath(path)}</span>;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      style={{ width: 48, height: 36, objectFit: "cover", borderRadius: 5 }}
    />
  );
}

function ResourceItemVisual({ item }: { item: RadialItem }) {
  const { t } = useTranslation();
  const kind = item.resourceKind;

  if (!kind) return null;

  if (kind === "image" && item.type === "image") {
    return (
      <div className="radial-menu-resource-visual">
        <ImageThumb recordId={item.id} />
      </div>
    );
  }

  if (kind === "image" && item.resourcePath) {
    return (
      <ResourceFileImage
        path={item.resourcePath}
        alt={item.resourceTitle || t("resources.imagePreview")}
        className="radial-menu-resource-image"
      />
    );
  }

  if (kind === "text" && item.type === "file" && item.resourcePath) {
    return (
      <div className="radial-menu-resource-text-file">
        <InlineTextFilePreview
          resourcePath={item.resourcePath}
          resourceVersion={item.createdAt}
        />
      </div>
    );
  }

  if (kind === "text") {
    return (
      <div className="radial-menu-resource-text">
        {item.resourceSummary || t("resources.empty")}
      </div>
    );
  }

  return (
    <div className={`radial-menu-resource-type radial-menu-resource-type-${kind}`}>
      {kind === "video" ? Icons.video : kind === "audio" ? Icons.audio : Icons.file}
      <span>{t(`resources.type${kind[0].toUpperCase()}${kind.slice(1)}`)}</span>
    </div>
  );
}

export default function RadialMenu() {
  const { t } = useTranslation();

  const [visible, setVisible] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("clipboard");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [clipboardCategory, setClipboardCategory] = useState<ClipType>("all");
  const [resourceGroups, setResourceGroups] = useState<ResourceFolder[]>([]);
  const [resourceGroup, setResourceGroup] = useState<string | null>(null);
  const [resourceGroupMenuPath, setResourceGroupMenuPath] = useState<string | null>(null);
  const [resourceGroupMenuPosition, setResourceGroupMenuPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [phraseGroupId, setPhraseGroupId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [dragSessionItemId, setDragSessionItemId] = useState<string | null>(null);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [showBackTop, setShowBackTop] = useState(false);

  const visibleRef = useRef(false);
  const selectedItemIdRef = useRef<string | null>(null);
  const activeTabRef = useRef<TabKey>("clipboard");
  const clipboardCategoryRef = useRef<ClipType>("all");
  const resourceGroupRef = useRef<string | null>(null);
  const resourceGroupMenuRef = useRef<HTMLDivElement>(null);
  const resourceGroupMenuAnchorRef = useRef<HTMLButtonElement>(null);
  const categoriesScrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const phraseGroupIdRef = useRef<string | null>(null);
  const previewRequestRef = useRef(0);
  const previewRef = useRef<PreviewState | null>(null);
  const originalWindowPositionRef = useRef<PhysicalPosition | null>(null);
  const windowRestoreRef = useRef<Promise<void> | null>(null);
  const windowOperationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const previewCacheRef = useRef(new Map<string, RadialPreviewSegment[]>());
  const dragActiveRef = useRef(false);
  const suppressClickRef = useRef(false);
  const nativeDragRef = useRef<PendingNativeDrag | null>(null);
  const dragSessionIdRef = useRef(0);
  const activeDragSessionIdRef = useRef<number | null>(null);
  const cancelledDragSessionsRef = useRef(new Set<number>());

  useEffect(() => { visibleRef.current = visible; }, [visible]);
  useEffect(() => { selectedItemIdRef.current = selectedItemId; }, [selectedItemId]);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { clipboardCategoryRef.current = clipboardCategory; }, [clipboardCategory]);
  useEffect(() => { resourceGroupRef.current = resourceGroup; }, [resourceGroup]);
  useEffect(() => { phraseGroupIdRef.current = phraseGroupId; }, [phraseGroupId]);
  useEffect(() => { previewRef.current = preview; }, [preview]);

  const updateBackTopVisibility = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    setShowBackTop(list.scrollTop > list.clientHeight);
  }, []);

  const handleBackToTop = useCallback(() => {
    listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.addEventListener("scroll", updateBackTopVisibility, { passive: true });
    return () => list.removeEventListener("scroll", updateBackTopVisibility);
  }, [updateBackTopVisibility]);

  const loadResourceGroups = useCallback(async () => {
    try {
      const groups = await invoke<ResourceFolder[]>("get_resource_groups");
      setResourceGroups(groups);
    } catch (error) {
      console.error("Failed to load radial resource groups:", error);
    }
  }, []);

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
  const resourceGroupMenuItems = resourceGroupMenuFolder
    ? [
        { folder: resourceGroupMenuFolder, depth: 0 },
        ...flattenResourceFolders(resourceGroupMenuFolder.children ?? [], 1),
      ]
    : [];

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
  }, [closeResourceGroupMenu, resourceGroupMenuPath, updateResourceGroupMenuPosition]);

  const invalidatePreviewRequest = useCallback(() => {
    previewRequestRef.current += 1;
  }, []);

  const enqueueWindowOperation = useCallback((operation: () => Promise<void>) => {
    const task = windowOperationQueueRef.current.then(
      () => operation(),
      () => operation(),
    );
    windowOperationQueueRef.current = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }, []);

  const collapsePreview = useCallback(() => {
    const shouldRestoreWindow = Boolean(
      previewRef.current || originalWindowPositionRef.current,
    );
    invalidatePreviewRequest();
    setPreview(null);
    previewRef.current = null;
    const restoreTask = windowRestoreRef.current;
    if (!shouldRestoreWindow && !restoreTask) return;

    const originalPosition = originalWindowPositionRef.current;
    originalWindowPositionRef.current = null;
    const nextRestoreTask = restoreTask ?? enqueueWindowOperation(async () => {
      const appWindow = getCurrentWindow();
      try {
        await appWindow.setSize(new LogicalSize(
          RADIAL_MENU_WIDTH + 2 * RADIAL_SHADOW_MARGIN,
          RADIAL_MENU_HEIGHT + 2 * RADIAL_SHADOW_MARGIN,
        ));
        if (originalPosition) await appWindow.setPosition(originalPosition);
      } catch {
        // 后端会在菜单下次打开时恢复紧凑尺寸。
      }
    });
    windowRestoreRef.current = nextRestoreTask;
    void nextRestoreTask.finally(() => {
      if (windowRestoreRef.current === nextRestoreTask) {
        windowRestoreRef.current = null;
      }
    });
  }, [enqueueWindowOperation, invalidatePreviewRequest]);

  const dismissPreviewForDrag = useCallback(() => {
    invalidatePreviewRequest();
    setPreview(null);
    previewRef.current = null;
  }, [invalidatePreviewRequest]);

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
    if (windowRestoreRef.current) await windowRestoreRef.current;
    if (request !== previewRequestRef.current) return null;
    if (previewRef.current) return previewRef.current.layout;
    const appWindow = getCurrentWindow();
    try {
      const [position, monitor, scaleFactor] = await Promise.all([
        appWindow.outerPosition(),
        currentMonitor(),
        appWindow.scaleFactor(),
      ]);
      if (
        !monitor
        || request !== previewRequestRef.current
        || dragActiveRef.current
        || nativeDragRef.current
      ) return null;
      // position 是含阴影边距的窗口原点；展开计算按可见内容区域换算。
      const marginPhysical = RADIAL_SHADOW_MARGIN * scaleFactor;
      const expansion = calculateRadialExpansion({
        windowX: position.x + marginPhysical,
        workAreaX: monitor.workArea.position.x,
        workAreaWidth: monitor.workArea.size.width,
        scaleFactor,
      });
      if (expansion.previewWidth <= 0) return null;

      originalWindowPositionRef.current = position;
      const layout = { direction: expansion.direction, width: expansion.previewWidth };
      const loadingState = {
        itemId: item.id,
        segments: null,
        layout,
      };
      previewRef.current = loadingState;
      setPreview(loadingState);
      await enqueueWindowOperation(async () => {
        await appWindow.setSize(new LogicalSize(
          RADIAL_MENU_WIDTH + 2 * RADIAL_SHADOW_MARGIN + expansion.previewWidth,
          RADIAL_MENU_HEIGHT + 2 * RADIAL_SHADOW_MARGIN,
        ));
        if (expansion.direction === "left") {
          // 展开计算给出的是内容原点，回写窗口位置时补回阴影边距。
          await appWindow.setPosition(new PhysicalPosition(
            expansion.windowX - marginPhysical,
            position.y,
          ));
        }
      });
      if (
        request !== previewRequestRef.current
        || dragActiveRef.current
        || nativeDragRef.current
      ) {
        return null;
      }
      return layout;
    } catch {
      if (request !== previewRequestRef.current) return null;
      const deferRestore = dragActiveRef.current || nativeDragRef.current;
      const originalPosition = originalWindowPositionRef.current;
      if (!deferRestore) originalWindowPositionRef.current = null;
      if (request === previewRequestRef.current) {
        previewRef.current = null;
        setPreview(null);
      }
      if (!deferRestore) {
        try {
          await enqueueWindowOperation(async () => {
            await appWindow.setSize(new LogicalSize(
              RADIAL_MENU_WIDTH + 2 * RADIAL_SHADOW_MARGIN,
              RADIAL_MENU_HEIGHT + 2 * RADIAL_SHADOW_MARGIN,
            ));
            if (originalPosition) await appWindow.setPosition(originalPosition);
          });
        } catch {
          // 后端会在菜单下次打开时恢复紧凑尺寸。
        }
      }
      return null;
    }
  }, [enqueueWindowOperation]);

  const loadPreviewSegments = useCallback(async (item: RadialItem) => {
    const cached = previewCacheRef.current.get(item.id);
    if (cached) return cached;

    const record = useClipboardStore.getState().records.find((entry) => entry.id === item.id);
    let segments: RadialPreviewSegment[];
    if (record) {
      if (isResourceRecord(record)) {
        const kind = inferResourceMediaKind(record);
        const resourcePath = getResourcePath(record);
        if (kind === "image") {
          segments = [{ type: "image", path: resourcePath }];
        } else if (kind === "video" || kind === "audio") {
          segments = [{ type: kind, path: resourcePath }];
        } else if (kind === "text" && record.type === "file") {
          const content = await invoke<string>("read_resource_text_preview", {
            path: resourcePath,
          });
          segments = [{ type: "text", content }];
        } else {
          const content = kind === "text"
            ? await useClipboardStore.getState().getRecordContent(record)
            : item.resourceTitle || item.content;
          segments = [{ type: "text", content }];
        }
      } else {
        segments = await loadClipboardPreviewSegments(record);
      }
    } else {
      const phrase = usePhraseStore.getState().phrases.find((entry) => entry.id === item.id);
      if (phrase && phrase.input_type === "file" && isImageFilePath(phrase.content)) {
        segments = [{ type: "image", path: phrase.content }];
      } else {
        segments = [{ type: "text", content: phrase?.content ?? item.content }];
      }
    }
    previewCacheRef.current.set(item.id, segments);
    return segments;
  }, []);

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
  }, [loadResourceGroups]);

  const applyResourceGroupSwitch = useCallback((nextGroup: string | null) => {
    collapsePreview();
    closeResourceGroupMenu();
    setResourceGroup(nextGroup);
    resourceGroupRef.current = nextGroup;
    useClipboardStore.getState().setResourceGroup(nextGroup);
    useClipboardStore.getState().loadRecords(false, "resources", nextGroup);
    setSelectedItemId(null);
    selectedItemIdRef.current = null;
  }, [closeResourceGroupMenu, collapsePreview]);

  const handleTabSwitch = useCallback((key: string) => {
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
      setClipboardCategory("resources");
      clipboardCategoryRef.current = "resources";
      setResourceGroup(null);
      resourceGroupRef.current = null;
      closeResourceGroupMenu();
      useClipboardStore.getState().setCategory("resources");
      useClipboardStore.getState().setResourceGroup(null);
      useClipboardStore.getState().loadRecords(false, "resources", null);
      void loadResourceGroups();
    } else {
      const { groups, loadPhrases } = usePhraseStore.getState();
      if (groups.length > 0) {
        const firstId = groups[0].id;
        setPhraseGroupId(firstId);
        phraseGroupIdRef.current = firstId;
        loadPhrases(firstId);
      }
    }
  }, [closeResourceGroupMenu, collapsePreview, loadResourceGroups]);

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
    collapsePreview();
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
    // 原生窗口已经被后端隐藏，下一次显示会重新定位到鼠标处，
    // 不能让上一次预览的恢复任务把窗口移回旧位置。
    originalWindowPositionRef.current = null;
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
    resetState();
    getCurrentWindow().hide();
  }, [resetState]);

  // 整组粘贴（方案 A）：分组内全部为文本时合并为一段文本粘贴，
  // 否则把分组内全部文件按文件列表一次写入剪切板再模拟 Ctrl+V。
  // groupPath 为 null 时作用于当前选中的分组。
  const handlePasteGroup = useCallback(async (groupPath: string | null) => {
    const store = useClipboardStore.getState();
    const allRecords = await store.loadAllRecords("resources", groupPath ?? resourceGroupRef.current);
    const records = (allRecords ?? []).filter((record) => isResourceRecord(record));
    if (records.length > 0) {
      const allText = records.every((record) => inferResourceMediaKind(record) === "text");
      try {
        if (allText) {
          const parts: string[] = [];
          for (const record of records) {
            parts.push(await store.getRecordContent(record));
          }
          await invoke("paste_text", { text: parts.join("\n") });
        } else {
          const paths = records
            .map((record) => record.resource_path)
            .filter((path): path is string => Boolean(path));
          if (paths.length === 0) throw new Error("分组内没有可粘贴的文件");
          await invoke("paste_files", { paths });
        }
      } catch (error) {
        console.error("Failed to paste resource group:", error);
      }
    }
    resetState();
    getCurrentWindow().hide();
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
    void invoke("start_radial_file_drag", {
      source: next.dragSource,
      id: next.itemId,
      path: next.dragPath || null,
      sessionId: next.sessionId,
    }).catch((error) => {
      const current = nativeDragRef.current;
      if (
        !current
        || current.pointerId !== next.pointerId
        || current.sessionId !== next.sessionId
      ) return;
      resetState(true);
      void getCurrentWindow().hide();
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
    if (previewRef.current || originalWindowPositionRef.current) {
      collapsePreview();
    }
  }, [cancelPendingNativeDrag, collapsePreview]);

  const handleItemPointerDown = useCallback((
    e: PointerEvent,
  ) => {
    if (
      e.button !== 0
      || !e.isPrimary
      || dragActiveRef.current
      || nativeDragRef.current
    ) return;

    const target = e.target instanceof Element
      ? e.target.closest<HTMLElement>(
          '[data-radial-item-id][data-radial-drag-kind="files"]',
        )
      : null;
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
    void getCurrentWindow().hide();
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

  // Popup click handler: dismiss when clicking on empty space.
  // Items, nav tabs, and category chips all call stopPropagation on
  // their own onClick, so this only fires for truly unhandled clicks.
  const handlePopupClick = useCallback(() => {
    resetState();
    getCurrentWindow().hide();
  }, [resetState]);
  useEffect(() => {
    let unlisteners: UnlistenFn[] = [];
    let disposed = false;

    const setup = async () => {
      // Listen for radial-menu-show event from backend (keyboard shortcut triggered)
      const [unShow, unHide, unDragStarted, unDragFinished] = await Promise.all([
        listen<{ theme: string }>("radial-menu-show", (e) => {
          // 后端会先显示窗口再发事件，必须先同步开放前端交互，避免首次按下落在隐藏状态。
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
            originalWindowPositionRef.current = null;
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
          // Reset to clipboard tab on each open
          setActiveTab("clipboard");
          activeTabRef.current = "clipboard";
          setClipboardCategory("all");
          clipboardCategoryRef.current = "all";
          setResourceGroup(null);
          resourceGroupRef.current = null;
          closeResourceGroupMenu();
          // Refresh data
          useClipboardStore.getState().setCategory("all");
          useClipboardStore.getState().loadRecords(false, "all");
          usePhraseStore.getState().loadGroups();
        }),
        listen("radial-menu-hide", resetStateForNativeHide),
        listen("radial-drag-started", handleRadialDragStarted),
        listen("radial-drag-finished", handleRadialDragFinished),
      ]);
      if (disposed) {
        unShow();
        unHide();
        unDragStarted();
        unDragFinished();
        return;
      }
      unlisteners = [unShow, unHide, unDragStarted, unDragFinished];
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
        getCurrentWindow().hide();
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
        getCurrentWindow().hide();
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
        resetState();
        getCurrentWindow().hide();
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleBlur);

    return () => {
      disposed = true;
      cancelPendingNativeDrag(nativeDragRef.current);
      unlisteners.forEach((fn) => fn());
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleBlur);
    };
  }, [
    closeResourceGroupMenu,
    collapsePreview,
    cancelPendingNativeDrag,
    handleRadialDragFinished,
    handleRadialDragStarted,
    finishPendingPointerDrag,
    loadResourceGroups,
    resetStateForNativeHide,
    resetState,
    updateHoverFromPoint,
  ]);

  const records = useClipboardStore((s) => s.records);
  const phraseGroups = usePhraseStore((s) => s.groups);
  const phrases = usePhraseStore((s) => s.phrases);
  const loadPhrases = usePhraseStore((s) => s.loadPhrases);
  const pasteLeftClick = useSettingsStore((s) => s.pasteLeftClick);

  useEffect(() => {
    if (visible && activeTab === "phrases" && !phraseGroupId && phraseGroups.length > 0) {
      const firstId = phraseGroups[0].id;
      setPhraseGroupId(firstId);
      phraseGroupIdRef.current = firstId;
      loadPhrases(firstId);
    }
  }, [visible, activeTab, phraseGroupId, phraseGroups, loadPhrases]);

  const filteredRecords = clipboardCategory === "all"
    ? records.filter((r) => !isResourceRecord(r))
    : clipboardCategory === "resources"
      ? records.filter((r) => isResourceRecord(r))
    : records.filter((r) => !isResourceRecord(r) && r.type === clipboardCategory);

  const items: RadialItem[] = activeTab === "clipboard"
    ? filteredRecords.slice(0, MAX_ITEMS).map((r) => ({
        id: r.id,
        content: r.type === "image"
          ? `[${t("clipboard.image")}]`
          : r.type === "file"
            ? r.content.replace(/\\/g, "/").split("/").pop() || r.content
            : r.is_api_key
              ? r.key_preview || r.content
              : r.content,
        type: r.type,
        createdAt: r.created_at,
        contentTruncated: r.content_truncated,
        previewAvailable: isContentPreviewAvailable({
          type: r.type,
          contentTruncated: r.content_truncated,
          hasImages: r.has_images,
        }, r.content.length > 300),
        dragKind: getClipboardRadialDragKind(r.type, r.has_images),
        dragSource: "clipboard",
        dragPath: r.drag_path,
      }))
    : activeTab === "resources"
      ? records
          .filter((r) => isResourceRecord(r))
          .slice(0, MAX_ITEMS)
          .map((r) => {
            const resourceKind = inferResourceMediaKind(r);
            const resourcePath = getResourcePath(r);
            const resourceTitle = getResourceTitle(r, resourceKind);
            const resourceSummary = r.type === "file"
              ? undefined
              : getResourceSummary(r);
            return {
              id: r.id,
              content: resourceTitle,
              type: r.type,
              createdAt: r.created_at,
              contentTruncated: r.content_truncated,
              previewAvailable: resourceKind === "image"
                || resourceKind === "text"
                || resourceKind === "video"
                || resourceKind === "audio",
              dragKind: getClipboardRadialDragKind(r.type, r.has_images),
              dragSource: "clipboard" as const,
              dragPath: r.drag_path || (r.type === "file" ? resourcePath : undefined),
              isResource: true,
              resourceKind,
              resourcePath,
              resourceTitle,
              resourceSummary,
            };
          })
      : phrases.map((p) => ({
          id: p.id,
          content: p.input_type === "file"
            ? filenameFromPath(p.source_path || p.content)
            : p.content,
          type: p.input_type === "file" ? "file" : "phrase",
          imagePath:
            p.input_type === "file" && isImageFilePath(p.content) ? p.content : undefined,
          title: p.title,
          previewAvailable: isContentPreviewAvailable({
            type: p.input_type,
          }, p.content.length > 300),
          dragKind: getPhraseRadialDragKind(p.input_type),
          dragSource: "phrase",
          dragPath: p.input_type === "file" ? p.content : undefined,
      }));

  const categories = activeTab === "clipboard"
    ? [
        { key: "all", label: t("clipboard.all") },
        { key: "text", label: t("clipboard.text") },
        { key: "image", label: t("clipboard.image") },
        { key: "link", label: t("clipboard.link") },
        { key: "file", label: t("clipboard.file") },
      ]
    : activeTab === "phrases"
      ? phraseGroups.map((g) => ({
          key: g.id,
          label: g.name,
      }))
      : [];

  const activeCategory = activeTab === "clipboard" ? clipboardCategory : phraseGroupId;
  const getResourceGroupControlLabel = (group: ResourceFolder) => (
    resourceGroup && isResourceFolderPath(resourceGroup, group.path)
      ? formatResourceFolderPath(resourceGroup)
      : group.name
  );

  // 分组 chip 本身即整组操作入口：单击切分组（保留）、Shift+单击 = 粘贴该组、
  // 按住拖动 = 通过 data-radial-* 属性接入的通用拖拽会话原生拖出该组全部文件。
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

  const handleGroupChipClick = (groupPath: string, groupCount: number, shiftKey: boolean) => {
    if (shiftKey && groupCount > 0 && pasteLeftClick !== "terminal") {
      void handlePasteGroup(groupPath);
      return;
    }
    applyResourceGroupSwitch(groupPath);
  };

  const resourceGroupMenu = resourceGroupMenuPath && resourceGroupMenuFolder
    ? createPortal(
      <div
        ref={resourceGroupMenuRef}
        className="radial-menu-resource-group-dropdown"
        role="menu"
        aria-label={t("resources.openSubfolders")}
        style={{
          left: resourceGroupMenuPosition?.left ?? 0,
          top: resourceGroupMenuPosition?.top ?? 0,
          visibility: resourceGroupMenuPosition ? "visible" : "hidden",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {resourceGroupMenuItems.map(({ folder, depth }) => (
          <button
            key={folder.path}
            type="button"
            className={`radial-menu-resource-group-menu-item${resourceGroup === folder.path ? " selected" : ""}`}
            role="menuitem"
            aria-current={resourceGroup === folder.path ? "page" : undefined}
            title={folder.path}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            onClick={() => applyResourceGroupSwitch(folder.path)}
          >
            {Icons.resources}
            <span>{depth === 0 ? t("resources.allFiles") : folder.name}</span>
          </button>
        ))}
      </div>,
      document.body,
    )
    : null;

  useEffect(() => {
    updateBackTopVisibility();
  }, [activeTab, clipboardCategory, phraseGroupId, resourceGroup, items.length, updateBackTopVisibility]);

  return (
    <div className={`radial-menu-overlay${visible ? "" : " radial-menu-hidden"}`}>
      <div
        className={`radial-menu-popup${preview ? ` preview-open preview-${preview.layout.direction}` : ""}${dragSessionItemId ? " drag-session" : ""}`}
        style={preview ? {
          "--radial-preview-width": `${preview.layout.width}px`,
        } as CSSProperties : undefined}
        onClick={handlePopupClick}
        onMouseLeave={handlePreviewLeave}
      >
        <div className="radial-menu-main">
          <div className="radial-menu-nav">
          {(["clipboard", "phrases", "resources"] as TabKey[]).map((tab) => (
            <button
              key={tab}
              className={`radial-menu-nav-tab ${activeTab === tab ? "active" : ""}`}
              data-radial-nav={tab}
              onClick={(e) => handleTabClick(e, tab)}
            >
              <span className="radial-menu-nav-label">{t(`tabs.${tab}`)}</span>
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
                      handleGroupChipClick("", ungroupedCount, e.shiftKey);
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
                const dragProps = groupChipDragProps(group.path, group.count);
                const handleChipClick = (e: React.MouseEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleGroupChipClick(group.path, group.count, e.shiftKey);
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

          <div ref={listRef} className="radial-menu-list" data-radial-list>
            {items.length === 0 ? (
              <div className="radial-menu-empty">{t("radialMenu.empty")}</div>
            ) : (
              items.map((item) => (
                <div
                  key={item.id}
                  className={`radial-menu-item${selectedItemId === item.id ? " selected" : ""}${draggingItemId === item.id ? " dragging" : ""}`}
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
                      <ImageThumb recordId={item.id} />
                    ) : item.imagePath ? (
                      <FileThumb path={item.imagePath} />
                    ) : (
                      <span className="radial-menu-item-text">
                        {item.content.length > 300
                          ? item.content.slice(0, 300) + "…"
                          : item.content}
                      </span>
                    )}
                  </div>
                  {(item.isResource
                    ? (item.resourceTitle || item.createdAt || item.previewAvailable)
                    : (item.createdAt || item.title || item.previewAvailable)) && (
                    <div className="radial-menu-item-footer">
                      <div className="radial-menu-item-meta">
                        {item.isResource && item.resourceTitle && (
                          <strong className="radial-menu-resource-title">{item.resourceTitle}</strong>
                        )}
                        {item.createdAt && (
                          <span className="radial-menu-item-time">{formatTime(item.createdAt)}</span>
                        )}
                        {!item.isResource && item.title && (
                          <span className="radial-menu-item-remark">{item.title}</span>
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

          <button
            type="button"
            className={`radial-menu-back-top${showBackTop ? " visible" : ""}`}
            aria-label={t("radialMenu.backToTop")}
            title={t("radialMenu.backToTop")}
            onClick={(e) => {
              e.stopPropagation();
              handleBackToTop();
            }}
          >
            {Icons.arrowUp}
          </button>
        </div>

        {preview && (
          <ContentPreviewPanel
            className="radial-menu-preview"
            segments={preview.segments}
            onClose={collapsePreview}
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>
      {resourceGroupMenu}
    </div>
  );
}
