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
  buildRadialPreviewSegments,
  calculateRadialExpansion,
  RADIAL_MENU_HEIGHT,
  RADIAL_MENU_WIDTH,
  type RadialPreviewDirection,
  type RadialPreviewSegment,
} from "../../utils/radialPreview";
import i18n from "../../i18n";

type TabKey = "clipboard" | "phrases";

const MAX_ITEMS = 2000;
const PREVIEW_DELAY_MS = 800;

interface RadialItem {
  id: string;
  content: string;
  type: string;
  /** file 短语指向图像文件时为相对存储路径：条目显示缩略图，悬浮展开大图预览。 */
  imagePath?: string;
  createdAt?: string;
  title?: string;
  contentTruncated?: boolean;
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
      style={{ width: 48, height: 36, objectFit: "cover", borderRadius: 5 }}
    />
  );
}

function PreviewImage({ path }: { path: string }) {
  const { t } = useTranslation();
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_image_thumbnail", { path, maxSize: 480 })
      .then((base64) => {
        if (!cancelled) setSrc(`data:image/png;base64,${base64}`);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [path]);

  if (failed) {
    return (
      <span className="radial-menu-preview-image-error">
        {t("radialMenu.imageUnavailable")}
      </span>
    );
  }
  if (!src) return <span className="radial-menu-preview-image-loading" aria-hidden="true" />;
  return (
    <img
      className="radial-menu-preview-image"
      src={src}
      alt={t("radialMenu.previewImage")}
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

  const collapsePreview = useCallback(() => {
    clearPreviewTimer();
    previewRequestRef.current += 1;
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
  }, [clearPreviewTimer]);

  const expandPreviewWindow = useCallback(async (
    request: number,
    itemId: string,
  ): Promise<PreviewLayout | null> => {
    if (previewRef.current) return previewRef.current.layout;
    const appWindow = getCurrentWindow();
    try {
      const [position, monitor, scaleFactor] = await Promise.all([
        appWindow.outerPosition(),
        currentMonitor(),
        appWindow.scaleFactor(),
      ]);
      if (!monitor || request !== previewRequestRef.current) return null;
      originalWindowPositionRef.current = position;
      const expansion = calculateRadialExpansion({
        windowX: position.x,
        workAreaX: monitor.workArea.position.x,
        workAreaWidth: monitor.workArea.size.width,
        scaleFactor,
      });
      if (expansion.previewWidth <= 0) return null;

      const layout = { direction: expansion.direction, width: expansion.previewWidth };
      const loadingState = { itemId, segments: null, layout };
      previewRef.current = loadingState;
      setPreview(loadingState);
      await appWindow.setSize(new LogicalSize(
        RADIAL_MENU_WIDTH + expansion.previewWidth,
        RADIAL_MENU_HEIGHT,
      ));
      if (expansion.direction === "left") {
        await appWindow.setPosition(new PhysicalPosition(expansion.windowX, position.y));
      }
      if (request !== previewRequestRef.current) {
        await appWindow.setSize(new LogicalSize(RADIAL_MENU_WIDTH, RADIAL_MENU_HEIGHT));
        await appWindow.setPosition(position);
        if (originalWindowPositionRef.current === position) {
          originalWindowPositionRef.current = null;
        }
        return null;
      }
      return layout;
    } catch {
      const originalPosition = originalWindowPositionRef.current;
      originalWindowPositionRef.current = null;
      if (request === previewRequestRef.current) {
        previewRef.current = null;
        setPreview(null);
      }
      try {
        await appWindow.setSize(new LogicalSize(RADIAL_MENU_WIDTH, RADIAL_MENU_HEIGHT));
        if (originalPosition) await appWindow.setPosition(originalPosition);
      } catch {
        // 后端会在菜单下次打开时恢复紧凑尺寸。
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
      if (record.type === "image") {
        segments = [{ type: "image", path: record.content }];
      } else {
        const [content, imagePaths] = await Promise.all([
          useClipboardStore.getState().getRecordContent(record),
          record.has_images
            ? invoke<string[]>("get_stash_record_images", { id: record.id })
            : Promise.resolve([]),
        ]);
        segments = buildRadialPreviewSegments(content, imagePaths);
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
    const request = ++previewRequestRef.current;
    const layout = await expandPreviewWindow(request, item.id);
    if (!layout || request !== previewRequestRef.current) return;
    try {
      const segments = await loadPreviewSegments(item);
      if (request !== previewRequestRef.current) return;
      const loadedState = { itemId: item.id, segments, layout };
      previewRef.current = loadedState;
      setPreview(loadedState);
    } catch {
      if (request !== previewRequestRef.current) return;
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
    clearPreviewTimer();
    if (previewRef.current) collapsePreview();

    const isImageItem = item.type === "image" || Boolean(item.imagePath);
    if (isImageItem) {
      // 图像缩略图信息量不足，悬浮一律展开预览面板（同长文本的交互）。
      setPendingPreviewId(item.id);
      previewTimerRef.current = window.setTimeout(() => {
        previewTimerRef.current = null;
        setPendingPreviewId(null);
        void showPreview(item);
      }, PREVIEW_DELAY_MS);
      return;
    }
    if (item.type === "file") return;

    const text = element.querySelector<HTMLElement>(".radial-menu-item-text");
    const isClipped = Boolean(
      item.contentTruncated
      || item.content.length > 300
      || (text && text.scrollHeight > text.clientHeight + 1),
    );
    if (!isClipped) return;

    setPendingPreviewId(item.id);
    previewTimerRef.current = window.setTimeout(() => {
      previewTimerRef.current = null;
      setPendingPreviewId(null);
      void showPreview(item);
    }, PREVIEW_DELAY_MS);
  }, [clearPreviewTimer, collapsePreview, showPreview]);

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
    if (tab === "phrases") {
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
    } else {
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

  const resetState = useCallback(() => {
    collapsePreview();
    visibleRef.current = false;
    setVisible(false);
    setSelectedItemId(null);
    selectedItemIdRef.current = null;
  }, [collapsePreview]);

  const updateHoverFromPoint = useCallback((cssX: number, cssY: number) => {
    const el = document.elementFromPoint(cssX, cssY);
    if (!el) {
      selectedItemIdRef.current = null;
      setSelectedItemId(null);
      return;
    }
    if ((el as HTMLElement).closest("[data-radial-preview]")) return;
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
        useClipboardStore.getState().loadRecords();
        usePhraseStore.getState().loadGroups();
      });

      unlisteners = [unShow];
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

      const previewContainer = (el as HTMLElement).closest("[data-radial-preview-scroll]");
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
      if (visibleRef.current) {
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
  }, [collapsePreview, resetState, updateHoverFromPoint]);

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
      }));

  const categories = activeTab === "clipboard"
    ? [
        { key: "all", label: t("clipboard.all") },
        { key: "text", label: t("clipboard.text") },
        { key: "image", label: t("clipboard.image") },
        { key: "link", label: t("clipboard.link") },
        { key: "file", label: t("clipboard.file") },
        { key: "stash", label: t("clipboard.stash") },
      ]
    : phraseGroups.map((g) => ({
        key: g.id,
        label: g.name,
      }));

  const activeCategory = activeTab === "clipboard" ? clipboardCategory : phraseGroupId;

  return (
    <div className={`radial-menu-overlay${visible ? "" : " radial-menu-hidden"}`}>
      <div
        className={`radial-menu-popup${preview ? ` preview-open preview-${preview.layout.direction}` : ""}`}
        style={preview ? {
          "--radial-preview-width": `${preview.layout.width}px`,
        } as CSSProperties : undefined}
        onClick={handlePopupClick}
        onMouseLeave={collapsePreview}
      >
        <div className="radial-menu-main">
          <div className="radial-menu-nav">
          {(["clipboard", "phrases"] as TabKey[]).map((tab) => (
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
                  className={`radial-menu-item${selectedItemId === item.id ? " selected" : ""}${pendingPreviewId === item.id ? " preview-pending" : ""}`}
                  data-radial-item-id={item.id}
                  onMouseEnter={(e) => schedulePreview(item, e.currentTarget)}
                  onMouseLeave={() => {
                    if (!previewRef.current) collapsePreview();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
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
          <section
            className="radial-menu-preview"
            aria-label={t("radialMenu.previewTitle")}
            data-radial-preview
            onClick={(e) => e.stopPropagation()}
          >
            <div className="radial-menu-preview-title">{t("radialMenu.previewTitle")}</div>
            <div className="radial-menu-preview-body" data-radial-preview-scroll>
              {preview.segments === null ? (
                <div className="radial-menu-preview-loading">{t("common.loading")}</div>
              ) : (
                preview.segments.map((segment, index) => segment.type === "text" ? (
                  <div className="radial-menu-preview-text" key={`text-${index}`}>
                    {segment.content}
                  </div>
                ) : (
                  <PreviewImage path={segment.path} key={`image-${index}-${segment.path}`} />
                ))
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
