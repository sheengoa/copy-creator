import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useClipboardStore, type ClipType } from "../../stores/clipboardStore";
import { usePhraseStore } from "../../stores/phraseStore";
import { useHoverSwitch } from "./useHoverSwitch";
import { HoverProgress } from "./HoverProgress";
import i18n from "../../i18n";

type TabKey = "clipboard" | "phrases";

const HOVER_DELAY = 500;
const MAX_ITEMS = 2000;

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${month}/${day} ${hours}:${minutes}`;
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

export default function RadialMenu() {
  const { t } = useTranslation();

  const [visible, setVisible] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("clipboard");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [clipboardCategory, setClipboardCategory] = useState<ClipType>("all");
  const [phraseGroupId, setPhraseGroupId] = useState<string | null>(null);

  const visibleRef = useRef(false);
  const selectedItemIdRef = useRef<string | null>(null);
  const activeTabRef = useRef<TabKey>("clipboard");
  const clipboardCategoryRef = useRef<ClipType>("all");
  const phraseGroupIdRef = useRef<string | null>(null);

  useEffect(() => { visibleRef.current = visible; }, [visible]);
  useEffect(() => { selectedItemIdRef.current = selectedItemId; }, [selectedItemId]);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { clipboardCategoryRef.current = clipboardCategory; }, [clipboardCategory]);
  useEffect(() => { phraseGroupIdRef.current = phraseGroupId; }, [phraseGroupId]);

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
      if (unlistenTheme) unlistenTheme();
      if (unlistenLang) unlistenLang();
    };
  }, []);

  const handleTabSwitch = useCallback((key: string) => {
    const tab = key as TabKey;
    setActiveTab(tab);
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
  }, []);

  const handleCategorySwitch = useCallback((key: string) => {
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
  }, []);

  const navSwitch = useHoverSwitch(handleTabSwitch, HOVER_DELAY);
  const categorySwitch = useHoverSwitch(handleCategorySwitch, HOVER_DELAY);

  const navEnterRef = useRef(navSwitch.handleEnter);
  navEnterRef.current = navSwitch.handleEnter;
  const navLeaveRef = useRef(navSwitch.handleLeave);
  navLeaveRef.current = navSwitch.handleLeave;
  const catEnterRef = useRef(categorySwitch.handleEnter);
  catEnterRef.current = categorySwitch.handleEnter;
  const catLeaveRef = useRef(categorySwitch.handleLeave);
  catLeaveRef.current = categorySwitch.handleLeave;

  const resetState = useCallback(() => {
    visibleRef.current = false;
    setVisible(false);
    setSelectedItemId(null);
    selectedItemIdRef.current = null;
    navLeaveRef.current();
    catLeaveRef.current();
  }, []);

  const updateHoverFromPoint = useCallback((cssX: number, cssY: number) => {
    const el = document.elementFromPoint(cssX, cssY);
    if (!el) {
      selectedItemIdRef.current = null;
      setSelectedItemId(null);
      navLeaveRef.current();
      catLeaveRef.current();
      return;
    }

    const itemEl = (el as HTMLElement).closest("[data-radial-item-id]");
    const navEl = (el as HTMLElement).closest("[data-radial-nav]");
    const catEl = (el as HTMLElement).closest("[data-radial-category]");

    if (itemEl) {
      const id = itemEl.getAttribute("data-radial-item-id");
      selectedItemIdRef.current = id;
      setSelectedItemId(id);
      navLeaveRef.current();
      catLeaveRef.current();
    } else if (navEl) {
      const key = navEl.getAttribute("data-radial-nav");
      if (key && key !== activeTabRef.current) {
        navEnterRef.current(key);
      } else {
        navLeaveRef.current();
      }
      catLeaveRef.current();
      selectedItemIdRef.current = null;
      setSelectedItemId(null);
    } else if (catEl) {
      const key = catEl.getAttribute("data-radial-category");
      const activeCat = activeTabRef.current === "clipboard"
        ? clipboardCategoryRef.current
        : phraseGroupIdRef.current;
      if (key && key !== activeCat) {
        catEnterRef.current(key);
      } else {
        catLeaveRef.current();
      }
      navLeaveRef.current();
      selectedItemIdRef.current = null;
      setSelectedItemId(null);
    } else {
      selectedItemIdRef.current = null;
      setSelectedItemId(null);
      navLeaveRef.current();
      catLeaveRef.current();
    }
  }, []);

  const handleItemPaste = useCallback(async (itemId: string) => {
    const { records, pasteRecord } = useClipboardStore.getState();
    const record = records.find((r) => r.id === itemId);
    if (record) {
      await pasteRecord(record);
    } else {
      const { phrases, pastePhrase } = usePhraseStore.getState();
      const phrase = phrases.find((p) => p.id === itemId);
      if (phrase) {
        await pastePhrase(phrase);
      }
    }
    resetState();
    getCurrentWindow().hide();
  }, [resetState]);

  // Main event setup: show/hide and interaction
  useEffect(() => {
    let unlisteners: UnlistenFn[] = [];

    const setup = async () => {
      // Listen for radial-menu-show event from backend (keyboard shortcut triggered)
      const unShow = await listen<{ theme: string }>("radial-menu-show", (e) => {
        document.documentElement.setAttribute("data-theme", e.payload.theme);
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

    // Click: select item or dismiss if clicked outside popup
    const handleClick = (e: MouseEvent) => {
      if (!visibleRef.current) return;
      const itemEl = (e.target as HTMLElement).closest("[data-radial-item-id]");
      if (itemEl) {
        const itemId = itemEl.getAttribute("data-radial-item-id");
        if (itemId) {
          handleItemPaste(itemId);
          return;
        }
      }
      // Clicked outside the popup area — dismiss
      const popup = (e.target as HTMLElement).closest(".radial-menu-popup");
      if (!popup) {
        resetState();
        getCurrentWindow().hide();
      }
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

      const catContainer = (el as HTMLElement).closest("[data-radial-categories]");
      if (catContainer) {
        catContainer.scrollLeft += e.deltaY;
        return;
      }

      const listContainer = (el as HTMLElement).closest("[data-radial-list]");
      if (listContainer) {
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
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("blur", handleBlur);

    return () => {
      unlisteners.forEach((fn) => fn());
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("wheel", handleWheel);
      window.removeEventListener("blur", handleBlur);
    };
  }, [resetState, updateHoverFromPoint, handleItemPaste]);

  const records = useClipboardStore((s) => s.records);
  const phraseGroups = usePhraseStore((s) => s.groups);
  const phrases = usePhraseStore((s) => s.phrases);
  const loadPhrases = usePhraseStore((s) => s.loadPhrases);

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
    : clipboardCategory === "apikey"
      ? records.filter((r) => r.is_api_key)
      : records.filter((r) => r.type === clipboardCategory);

  const items = activeTab === "clipboard"
    ? filteredRecords.slice(0, MAX_ITEMS).map((r) => ({
        id: r.id,
        content: r.type === "image"
          ? `[${t("clipboard.image")}]`
          : r.type === "file"
            ? r.content.replace(/\\/g, "/").split("/").pop() || r.content
            : r.is_api_key
              ? r.key_preview || r.content
              : r.content,
        type: r.is_api_key ? "apikey" : r.type,
        createdAt: r.created_at,
      }))
    : phrases.map((p) => ({
        id: p.id,
        content: p.content,
        type: "phrase" as string,
        title: p.title,
      }));

  const categories = activeTab === "clipboard"
    ? [
        { key: "all", label: t("clipboard.all") },
        { key: "text", label: t("clipboard.text") },
        { key: "image", label: t("clipboard.image") },
        { key: "link", label: t("clipboard.link") },
        { key: "file", label: t("clipboard.file") },
        { key: "apikey", label: t("clipboard.apikey") },
      ]
    : phraseGroups.map((g) => ({
        key: g.id,
        label: g.name,
      }));

  const activeCategory = activeTab === "clipboard" ? clipboardCategory : phraseGroupId;

  return (
    <div className={`radial-menu-overlay${visible ? "" : " radial-menu-hidden"}`}>
      <div className="radial-menu-popup">
        <div className="radial-menu-nav">
          {(["clipboard", "phrases"] as TabKey[]).map((tab) => (
            <button
              key={tab}
              className={`radial-menu-nav-tab ${activeTab === tab ? "active" : ""}`}
              data-radial-nav={tab}
            >
              <span className="radial-menu-nav-label">{t(`tabs.${tab}`)}</span>
              {navSwitch.progressKey === tab && (
                <HoverProgress progress={navSwitch.progress} />
              )}
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
              >
                {cat.label}
                {categorySwitch.progressKey === cat.key && (
                  <HoverProgress progress={categorySwitch.progress} />
                )}
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
                className={`radial-menu-item ${selectedItemId === item.id ? "selected" : ""}`}
                data-radial-item-id={item.id}
              >
                {item.type === "image" ? (
                  <ImageThumb recordId={item.id} />
                ) : (
                  <span className="radial-menu-item-text">
                    {item.content.length > 300
                      ? item.content.slice(0, 300) + "…"
                      : item.content}
                  </span>
                )}
                {"createdAt" in item && item.createdAt && (
                  <span className="radial-menu-item-time">{formatTime(item.createdAt)}</span>
                )}
                {"title" in item && item.title && (
                  <span className="radial-menu-item-remark">{item.title}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
