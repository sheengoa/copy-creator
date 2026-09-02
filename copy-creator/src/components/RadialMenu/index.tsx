import { useEffect, useRef, useState, useCallback, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  currentMonitor,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useClipboardStore, type ClipType } from "../../stores/clipboardStore";
import { usePhraseStore, isImageFilePath } from "../../stores/phraseStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { shouldUseTerminalPasteForMouseTrigger } from "../../utils/pasteMode";
import {
  calculateRadialExpansion,
  CONTENT_PREVIEW_DELAY_MS,
  RADIAL_MENU_HEIGHT,
  RADIAL_MENU_WIDTH,
  shouldScheduleContentPreview,
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
import { loadClipboardPreviewSegments } from "../../utils/contentPreview";
import i18n from "../../i18n";

type TabKey = "clipboard" | "phrases" | "resources";

const MAX_ITEMS = 2000;
const RADIAL_DRAG_THRESHOLD_PX = 6;

interface RadialItem {
  id: string;
  content: string;
  type: string;
  /** file 短语指向图像文件时为相对存储路径：条目显示缩略图，悬浮展开大图预览。 */
  imagePath?: string;
  createdAt?: string;
  title?: string;
  contentTruncated?: boolean;
  dragPath?: string;
  dragKind: RadialDragKind;
  dragSource: RadialDragSource;
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
  pointerId: number;
  startX: number;
  startY: number;
  thresholdCrossed: boolean;
  startRequested: boolean;
}

const filenameFromPath = (path: string) => path.replace(/\\/g, "/").split("/").pop() || path;

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

export default function RadialMenu() {
  const { t } = useTranslation();

  const [visible, setVisible] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("clipboard");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [clipboardCategory, setClipboardCategory] = useState<ClipType>("all");
  const [phraseGroupId, setPhraseGroupId] = useState<string | null>(null);
  const [pendingPreviewId, setPendingPreviewId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [dragSessionItemId, setDragSessionItemId] = useState<string | null>(null);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);

  const visibleRef = useRef(false);
  const selectedItemIdRef = useRef<string | null>(null);
  const activeTabRef = useRef<TabKey>("clipboard");
  const clipboardCategoryRef = useRef<ClipType>("all");
  const phraseGroupIdRef = useRef<string | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const previewRequestRef = useRef(0);
  const previewRef = useRef<PreviewState | null>(null);
  const originalWindowPositionRef = useRef<PhysicalPosition | null>(null);
  const previewCacheRef = useRef(new Map<string, RadialPreviewSegment[]>());
  const dragActiveRef = useRef(false);
  const suppressClickRef = useRef(false);
  const nativeDragRef = useRef<PendingNativeDrag | null>(null);

  useEffect(() => { visibleRef.current = visible; }, [visible]);
  useEffect(() => { selectedItemIdRef.current = selectedItemId; }, [selectedItemId]);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { clipboardCategoryRef.current = clipboardCategory; }, [clipboardCategory]);
  useEffect(() => { phraseGroupIdRef.current = phraseGroupId; }, [phraseGroupId]);
  useEffect(() => { previewRef.current = preview; }, [preview]);

  const clearPreviewTimer = useCallback(() => {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    setPendingPreviewId(null);
  }, []);

  const invalidatePreviewRequest = useCallback(() => {
    previewRequestRef.current += 1;
    clearPreviewTimer();
  }, [clearPreviewTimer]);

  const collapsePreview = useCallback(() => {
    invalidatePreviewRequest();
    setPreview(null);
    previewRef.current = null;

    const appWindow = getCurrentWindow();
    const originalPosition = originalWindowPositionRef.current;
    originalWindowPositionRef.current = null;
    void (async () => {
      try {
        await appWindow.setSize(new LogicalSize(RADIAL_MENU_WIDTH, RADIAL_MENU_HEIGHT));
        if (originalPosition) await appWindow.setPosition(originalPosition);
      } catch {
        // 后端会在菜单下次打开时恢复紧凑尺寸。
      }
    })();
  }, [invalidatePreviewRequest]);

  const dismissPreviewForDrag = useCallback(() => {
    invalidatePreviewRequest();
    setPreview(null);
    previewRef.current = null;
  }, [invalidatePreviewRequest]);

  const expandPreviewWindow = useCallback(async (
    request: number,
    item: RadialItem,
  ): Promise<PreviewLayout | null> => {
    if (dragActiveRef.current || nativeDragRef.current) return null;
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
      originalWindowPositionRef.current = position;
      const expansion = calculateRadialExpansion({
        windowX: position.x,
        workAreaX: monitor.workArea.position.x,
        workAreaWidth: monitor.workArea.size.width,
        scaleFactor,
      });
      if (expansion.previewWidth <= 0) return null;

      const layout = { direction: expansion.direction, width: expansion.previewWidth };
      const loadingState = {
        itemId: item.id,
        segments: null,
        layout,
      };
      previewRef.current = loadingState;
      setPreview(loadingState);
      await appWindow.setSize(new LogicalSize(
        RADIAL_MENU_WIDTH + expansion.previewWidth,
        RADIAL_MENU_HEIGHT,
      ));
      if (expansion.direction === "left") {
        await appWindow.setPosition(new PhysicalPosition(expansion.windowX, position.y));
      }
      if (
        request !== previewRequestRef.current
        || dragActiveRef.current
        || nativeDragRef.current
      ) {
        if (!dragActiveRef.current && !nativeDragRef.current) {
          await appWindow.setSize(new LogicalSize(RADIAL_MENU_WIDTH, RADIAL_MENU_HEIGHT));
          await appWindow.setPosition(position);
          if (originalWindowPositionRef.current === position) {
            originalWindowPositionRef.current = null;
          }
        }
        return null;
      }
      return layout;
    } catch {
      const deferRestore = dragActiveRef.current || nativeDragRef.current;
      const originalPosition = originalWindowPositionRef.current;
      if (!deferRestore) originalWindowPositionRef.current = null;
      if (request === previewRequestRef.current) {
        previewRef.current = null;
        setPreview(null);
      }
      if (!deferRestore) {
        try {
          await appWindow.setSize(new LogicalSize(RADIAL_MENU_WIDTH, RADIAL_MENU_HEIGHT));
          if (originalPosition) await appWindow.setPosition(originalPosition);
        } catch {
          // 后端会在菜单下次打开时恢复紧凑尺寸。
        }
      }
      return null;
    }
  }, []);

  const loadPreviewSegments = useCallback(async (item: RadialItem) => {
    const cached = previewCacheRef.current.get(item.id);
    if (cached) return cached;

    const record = useClipboardStore.getState().records.find((entry) => entry.id === item.id);
    let segments: RadialPreviewSegment[];
    if (record) {
      segments = await loadClipboardPreviewSegments(record);
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

  const schedulePreview = useCallback((item: RadialItem, element: HTMLElement) => {
    if (dragActiveRef.current || nativeDragRef.current) return;
    invalidatePreviewRequest();
    if (previewRef.current || originalWindowPositionRef.current) collapsePreview();

    const record = useClipboardStore.getState().records.find((entry) => entry.id === item.id);
    const text = element.querySelector<HTMLElement>(".radial-menu-item-text");
    const isClipped = Boolean(text && text.scrollHeight > text.clientHeight + 1);
    const shouldPreview = record
      ? shouldScheduleContentPreview({
          type: record.type,
          contentTruncated: record.content_truncated,
          hasImages: record.has_images,
        }, isClipped)
      : Boolean(item.imagePath)
        || shouldScheduleContentPreview({
          type: item.type,
          contentTruncated: item.contentTruncated,
        }, isClipped || item.content.length > 300);

    if (shouldPreview) {
      // 图片、图文资源和被截断的文本统一延迟展开。
      setPendingPreviewId(item.id);
      previewTimerRef.current = window.setTimeout(() => {
        previewTimerRef.current = null;
        setPendingPreviewId(null);
        void showPreview(item);
      }, CONTENT_PREVIEW_DELAY_MS);
    }
  }, [collapsePreview, invalidatePreviewRequest, showPreview]);

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

    return () => {
      clearPreviewTimer();
      if (unlistenTheme) unlistenTheme();
      if (unlistenLang) unlistenLang();
    };
  }, [clearPreviewTimer]);

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
      useClipboardStore.getState().setCategory("resources");
      useClipboardStore.getState().loadRecords(false, "resources");
    } else {
      const { groups, loadPhrases } = usePhraseStore.getState();
      if (groups.length > 0) {
        const firstId = groups[0].id;
        setPhraseGroupId(firstId);
        phraseGroupIdRef.current = firstId;
        loadPhrases(firstId);
      }
    }
  }, [collapsePreview]);

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
    collapsePreview();
    dragActiveRef.current = false;
    if (!preserveClickSuppression) suppressClickRef.current = false;
    visibleRef.current = false;
    setVisible(false);
    setSelectedItemId(null);
    selectedItemIdRef.current = null;
    setDragSessionItemId(null);
    setDraggingItemId(null);
    nativeDragRef.current = null;
  }, [collapsePreview]);

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

  const startRadialFileDrag = useCallback((pending: PendingNativeDrag) => {
    if (pending.startRequested) return;

    const next = { ...pending, startRequested: true };
    nativeDragRef.current = next;
    void invoke("start_radial_file_drag", {
      source: next.dragSource,
      id: next.itemId,
      path: next.dragPath || null,
    }).catch((error) => {
      const current = nativeDragRef.current;
      if (
        !current
        || current.pointerId !== next.pointerId
        || current.itemId !== next.itemId
      ) return;
      resetState(true);
      void getCurrentWindow().hide();
      console.error("Failed to start radial file drag:", error);
    });
  }, [resetState]);

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
      || (dragSource !== "clipboard" && dragSource !== "phrase")
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
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      thresholdCrossed: false,
      startRequested: false,
    };
    nativeDragRef.current = pending;
    dismissPreviewForDrag();
  }, [
    dismissPreviewForDrag,
  ]);

  const handleItemPointerMove = useCallback((e: PointerEvent) => {
    const pending = nativeDragRef.current;
    if (!pending || pending.pointerId !== e.pointerId) return;
    if (pending.thresholdCrossed) return;

    const distance = Math.hypot(
      e.clientX - pending.startX,
      e.clientY - pending.startY,
    );
    if (distance < RADIAL_DRAG_THRESHOLD_PX) return;

    suppressClickRef.current = true;
    dragActiveRef.current = true;
    const crossed = { ...pending, thresholdCrossed: true };
    nativeDragRef.current = crossed;
    setDraggingItemId(pending.itemId);
    e.preventDefault();
    startRadialFileDrag(crossed);
  }, [startRadialFileDrag]);

  const handleItemPointerUp = useCallback((e: PointerEvent) => {
    const pending = nativeDragRef.current;
    if (!pending || pending.pointerId !== e.pointerId) return;
    if (pending.startRequested) return;

    nativeDragRef.current = null;
    dragActiveRef.current = false;
    setDragSessionItemId(null);
    setDraggingItemId(null);
    if (previewRef.current || originalWindowPositionRef.current) {
      collapsePreview();
    }
  }, [collapsePreview]);

  const handleRadialDragFinished = useCallback(() => {
    dragActiveRef.current = false;
    nativeDragRef.current = null;
    setDraggingItemId(null);
    resetState(true);
    void getCurrentWindow().hide();
  }, [resetState]);

  const handleDocumentPointerDown = useCallback((e: PointerEvent) => {
    if (!visibleRef.current || e.button !== 0 || !e.isPrimary) return;
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

    const setup = async () => {
      // Listen for radial-menu-show event from backend (keyboard shortcut triggered)
      const unShow = await listen<{ theme: string }>("radial-menu-show", async (e) => {
        originalWindowPositionRef.current = null;
        collapsePreview();
        previewCacheRef.current.clear();
        dragActiveRef.current = false;
        nativeDragRef.current = null;
        suppressClickRef.current = false;
        setDragSessionItemId(null);
        setDraggingItemId(null);
        document.documentElement.setAttribute("data-theme", e.payload.theme);
        await loadPasteLeftClickSetting();
        visibleRef.current = true;
        setVisible(true);
        setSelectedItemId(null);
        selectedItemIdRef.current = null;
        // Reset to clipboard tab on each open
        setActiveTab("clipboard");
        activeTabRef.current = "clipboard";
        setClipboardCategory("all");
        clipboardCategoryRef.current = "all";
        // Refresh data
        useClipboardStore.getState().setCategory("all");
        useClipboardStore.getState().loadRecords(false, "all");
        usePhraseStore.getState().loadGroups();
      });

      const unDragFinished = await listen("radial-drag-finished", handleRadialDragFinished);
      unlisteners = [unShow, unDragFinished];
    };

    setup();

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

    // Wheel: scroll categories or item list (only when visible)
    const handleWheel = (e: WheelEvent) => {
      if (!visibleRef.current) return;

      e.preventDefault();
      e.stopPropagation();

      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return;

      const previewContainer = (el as HTMLElement).closest("[data-content-preview-scroll]");
      if (previewContainer) {
        previewContainer.scrollTop += e.deltaY;
        return;
      }

      const catContainer = (el as HTMLElement).closest("[data-radial-categories]");
      if (catContainer) {
        collapsePreview();
        catContainer.scrollLeft += e.deltaY;
        return;
      }

      const listContainer = (el as HTMLElement).closest("[data-radial-list]");
      if (listContainer) {
        collapsePreview();
        listContainer.scrollTop += e.deltaY;
      }
    };

    // Blur: dismiss when window loses focus
    const handleBlur = () => {
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
    document.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("blur", handleBlur);

    return () => {
      unlisteners.forEach((fn) => fn());
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("wheel", handleWheel);
      window.removeEventListener("blur", handleBlur);
    };
  }, [
    collapsePreview,
    handleRadialDragFinished,
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
    ? records
    : clipboardCategory === "stash"
      ? records.filter((r) => r.group_name === "暂存" || r.group_name === "stash")
      : clipboardCategory === "resources"
        ? records.filter((r) => Boolean(r.group_name))
      : records.filter((r) => r.type === clipboardCategory);

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
        dragKind: getClipboardRadialDragKind(r.type, r.has_images),
        dragSource: "clipboard",
        dragPath: r.drag_path,
      }))
    : activeTab === "resources"
      ? records
          .filter((r) => Boolean(r.group_name))
          .slice(0, MAX_ITEMS)
          .map((r) => ({
            id: r.id,
            content: r.content,
            type: r.type,
            createdAt: r.created_at,
            contentTruncated: r.content_truncated,
            dragKind: getClipboardRadialDragKind(r.type, r.has_images),
            dragSource: "clipboard",
            dragPath: r.drag_path,
          }))
      : phrases.map((p) => ({
        id: p.id,
        content: p.input_type === "file"
          ? filenameFromPath(p.source_path || p.content)
          : p.content,
        type: p.input_type === "file" ? "file" : "phrase",
        imagePath:
          p.input_type === "file" && isImageFilePath(p.content) ? p.content : undefined,
        title: p.title,
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

  return (
    <div className={`radial-menu-overlay${visible ? "" : " radial-menu-hidden"}`}>
      <div
        className={`radial-menu-popup${preview ? ` preview-open preview-${preview.layout.direction}` : ""}${dragSessionItemId ? " drag-session" : ""}`}
        style={preview ? {
          "--radial-preview-width": `${preview.layout.width}px`,
        } as CSSProperties : undefined}
        onClick={handlePopupClick}
        onMouseLeave={() => {
          if (!dragActiveRef.current && !nativeDragRef.current) collapsePreview();
        }}
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

          {categories.length > 0 && (
            <div className="radial-menu-categories" data-radial-categories>
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

          <div className="radial-menu-list" data-radial-list>
            {items.length === 0 ? (
              <div className="radial-menu-empty">{t("radialMenu.empty")}</div>
            ) : (
              items.map((item) => (
                <div
                  key={item.id}
                  className={`radial-menu-item${selectedItemId === item.id ? " selected" : ""}${pendingPreviewId === item.id ? " preview-pending" : ""}${draggingItemId === item.id ? " dragging" : ""}`}
                  data-radial-item-id={item.id}
                  data-radial-drag-kind={item.dragKind}
                  data-radial-drag-source={item.dragSource}
                  data-radial-drag-path={item.dragPath}
                  onMouseEnter={(e) => {
                    schedulePreview(item, e.currentTarget);
                  }}
                  onMouseLeave={() => {
                    if (!dragActiveRef.current && !nativeDragRef.current && !previewRef.current) {
                      collapsePreview();
                    }
                  }}
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
                  {item.type === "image" ? (
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
                  {item.createdAt && (
                    <span className="radial-menu-item-time">{formatTime(item.createdAt)}</span>
                  )}
                  {item.title && (
                    <span className="radial-menu-item-remark">{item.title}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {preview && (
          <ContentPreviewPanel
            className="radial-menu-preview"
            segments={preview.segments}
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>
    </div>
  );
}
