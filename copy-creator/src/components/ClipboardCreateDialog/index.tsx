import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { resolveDoubleEnterSave } from "../../utils/doubleEnterShortcut";
import i18n from "../../i18n";
import StashEditor, { type StashEditorHandle, type StashImage } from "./StashEditor";

interface StashRecord {
  id: string;
  type: "text" | "link" | "image" | "file";
  content: string;
  content_truncated?: boolean;
  group_name?: string;
  has_images?: boolean;
}

const CLIPBOARD_RESIZE_HANDLES = [
  { className: "north", direction: "North" },
  { className: "south", direction: "South" },
  { className: "west", direction: "West" },
  { className: "east", direction: "East" },
  { className: "north-west", direction: "NorthWest" },
  { className: "north-east", direction: "NorthEast" },
  { className: "south-west", direction: "SouthWest" },
  { className: "south-east", direction: "SouthEast" },
] as const;

type ClipboardResizeDirection = (typeof CLIPBOARD_RESIZE_HANDLES)[number]["direction"];

export default function ClipboardCreateDialog() {
  const { t } = useTranslation();
  const [content, setContent] = useState("");
  const [images, setImages] = useState<StashImage[]>([]);
  const [editorVersion, setEditorVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [stashRecords, setStashRecords] = useState<StashRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [loadingRecordId, setLoadingRecordId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<StashEditorHandle>(null);
  const lastEnterAtRef = useRef(0);
  const resizeSaveTimerRef = useRef<number | null>(null);

  const resetDraft = useCallback((nextContent = "", nextImages: StashImage[] = []) => {
    setContent(nextContent);
    setImages(nextImages);
    setEditorVersion((version) => version + 1);
    lastEnterAtRef.current = 0;
  }, []);

  const loadStashRecords = useCallback(async (showLoading = false) => {
    if (showLoading) setLoadingRecords(true);
    try {
      const records = await invoke<StashRecord[]>("get_clipboard_records", {
        limit: 120,
        offset: 0,
        category: "stash",
      });
      setStashRecords(records.filter((record) =>
        (record.group_name === "暂存" || record.group_name === "stash")
        && (record.type === "text" || record.type === "link")
      ));
    } catch (e) {
      console.error("Failed to load stash records:", e);
      setError(i18n.t("clipboard.loadStashError"));
    } finally {
      setLoadingRecords(false);
    }
  }, []);

  // 初始化：主题 + 语言 + 事件监听
  useEffect(() => {
    invoke<string>("get_setting", { key: "theme" }).then((theme) => {
      if (theme === "dark" || theme === "light") {
        document.documentElement.setAttribute("data-theme", theme);
      }
    });
    invoke<string>("get_setting", { key: "language" })
      .then((language) => {
        if (language) i18n.changeLanguage(language);
      })
      .catch(() => {});

    let unlistenTheme: UnlistenFn | undefined;
    listen<{ theme: string }>("theme-changed", (e) => {
      document.documentElement.setAttribute("data-theme", e.payload.theme);
    }).then((fn) => { unlistenTheme = fn; });

    let unlistenLang: UnlistenFn | undefined;
    listen<{ language: string }>("language-changed", (e) => {
      if (e.payload.language) i18n.changeLanguage(e.payload.language);
    }).then((fn) => { unlistenLang = fn; });

    // 监听后端 clipboard-create-show 事件（快捷键触发时）
    let unlistenShow: UnlistenFn | undefined;
    listen<{ theme: string }>("clipboard-create-show", (e) => {
      if (resizeSaveTimerRef.current !== null) {
        window.clearTimeout(resizeSaveTimerRef.current);
        resizeSaveTimerRef.current = null;
      }
      document.documentElement.setAttribute("data-theme", e.payload.theme);
      resetDraft();
      setEditingId(null);
      setError(null);
      setDropdownOpen(false);
      loadStashRecords();
      setTimeout(() => editorRef.current?.focus(), 50);
    }).then((fn) => { unlistenShow = fn; });

    loadStashRecords(true);

    return () => {
      if (unlistenTheme) unlistenTheme();
      if (unlistenLang) unlistenLang();
      if (unlistenShow) unlistenShow();
    };
  }, [loadStashRecords, resetDraft]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let cancelled = false;
    let unlistenResize: UnlistenFn | undefined;
    appWindow.onResized(({ payload }) => {
      if (resizeSaveTimerRef.current !== null) {
        window.clearTimeout(resizeSaveTimerRef.current);
      }
      resizeSaveTimerRef.current = window.setTimeout(async () => {
        resizeSaveTimerRef.current = null;
        try {
          const scaleFactor = await appWindow.scaleFactor();
          await invoke("set_settings_batch", {
            settings: {
              clipboard_create_width: String(Math.round(payload.width / scaleFactor)),
              clipboard_create_height: String(Math.round(payload.height / scaleFactor)),
            },
          });
        } catch (e) {
          console.error("保存暂存窗口尺寸失败:", e);
        }
      }, 300);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlistenResize = unlisten;
      }
    });

    return () => {
      cancelled = true;
      if (unlistenResize) unlistenResize();
      if (resizeSaveTimerRef.current !== null) {
        window.clearTimeout(resizeSaveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let cancelled = false;
    let unlistenClose: UnlistenFn | undefined;
    appWindow.onCloseRequested((event) => {
      event.preventDefault();
      void appWindow.hide();
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlistenClose = unlisten;
      }
    });

    return () => {
      cancelled = true;
      if (unlistenClose) unlistenClose();
    };
  }, []);

  const hideWindow = useCallback(() => {
    getCurrentWindow().hide();
  }, []);

  const handleResizeMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const direction = event.currentTarget.dataset.resizeDirection as ClipboardResizeDirection | undefined;
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    void getCurrentWindow().startResizeDragging(direction).catch((resizeError) => {
      console.error("启动暂存窗口缩放失败:", resizeError);
    });
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || saving || images.some((image) => image.pending)) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("save_stash_record", {
        id: editingId,
        content: trimmed,
        images: images.map((image) => image.sourcePath || image.dataUrl),
      });
      resetDraft();
      setEditingId(null);
      hideWindow();
    } catch (e) {
      console.error("Failed to save clipboard record:", e);
      setError(t("clipboard.saveStashError"));
    } finally {
      setSaving(false);
    }
  }, [content, editingId, images, saving, hideWindow, resetDraft, t]);

  const handleSelectRecord = useCallback(async (record: StashRecord) => {
    if (loadingRecordId) return;
    setDropdownOpen(false);
    setLoadingRecordId(record.id);
    setError(null);
    try {
      const [fullContent, imagePaths] = await Promise.all([
        record.content_truncated || record.has_images
          ? invoke<string>("get_clipboard_record_content", { id: record.id })
          : Promise.resolve(record.content),
        invoke<string[]>("get_stash_record_images", { id: record.id }),
      ]);
      const imageData = await Promise.all(imagePaths.map(async (path, index) => ({
        id: `${record.id}-${index}`,
        dataUrl: `data:image/png;base64,${await invoke<string>("get_image_base64", { path })}`,
        sourcePath: path,
      })));
      setEditingId(record.id);
      resetDraft(fullContent, imageData);
      setTimeout(() => editorRef.current?.focus(), 0);
    } catch (e) {
      console.error("Failed to load clipboard record content:", e);
      setError(t("clipboard.loadStashContentError"));
    } finally {
      setLoadingRecordId(null);
    }
  }, [loadingRecordId, resetDraft, t]);

  const handleExitEdit = useCallback(() => {
    setEditingId(null);
    resetDraft();
    setError(null);
    setTimeout(() => editorRef.current?.focus(), 0);
  }, [resetDraft]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      lastEnterAtRef.current = 0;
      if (dropdownOpen) {
        setDropdownOpen(false);
        return;
      }
      hideWindow();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      lastEnterAtRef.current = 0;
      handleSave();
      return;
    }
    const editor = document.querySelector(".clipboard-create-editor");
    if (!(e.target instanceof Node) || !editor?.contains(e.target)) {
      lastEnterAtRef.current = 0;
      return;
    }

    const shortcut = resolveDoubleEnterSave({
      key: e.key,
      hasContent: Boolean(content.trim()),
      lastEnterAt: lastEnterAtRef.current,
      now: e.timeStamp,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      isComposing: e.nativeEvent.isComposing,
    });
    lastEnterAtRef.current = shortcut.nextLastEnterAt;

    if (shortcut.shouldPreventDefault) {
      e.preventDefault();
    }
    if (shortcut.shouldSave) {
      handleSave();
    }
  }, [content, dropdownOpen, hideWindow, handleSave]);

  return (
    <div className="clipboard-create-dialog" onKeyDown={handleKeyDown}>
      <div className="clipboard-create-header" data-tauri-drag-region>
        <span className="clipboard-create-title">
          {editingId ? t("clipboard.editStash") : t("clipboard.create")}
        </span>
        <button
          type="button"
          className="clipboard-create-close-btn"
          onClick={hideWindow}
          title={t("common.cancel")}
          aria-label={t("common.cancel")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div onFocus={() => setDropdownOpen(false)} className="clipboard-create-editor-wrap">
        <StashEditor
          key={editorVersion}
          ref={editorRef}
          initialContent={content}
          initialImages={images}
          placeholder={t("clipboard.createPlaceholder")}
          previewAlt={t("clipboard.stashImagePreview")}
          closePreviewLabel={t("clipboard.closeImagePreview")}
          onChange={(nextContent, nextImages) => {
            setContent(nextContent);
            setImages(nextImages);
          }}
          onImageError={() => setError(t("clipboard.readStashImageError"))}
        />
      </div>
      <div className="clipboard-create-stash-section">
        <div className="clipboard-create-stash-header">
          <span>{t("clipboard.existingStash")}</span>
          {editingId && (
            <button className="clipboard-create-exit-edit" onClick={handleExitEdit}>
              {t("clipboard.exitEdit")}
            </button>
          )}
        </div>
        <div className={`clipboard-create-stash-picker${dropdownOpen ? " open" : ""}`}>
          <button
            type="button"
            className="clipboard-create-stash-trigger"
            onClick={() => setDropdownOpen((open) => !open)}
            disabled={loadingRecords || stashRecords.length === 0 || loadingRecordId !== null}
            aria-expanded={dropdownOpen}
            aria-haspopup="listbox"
          >
            <span className={editingId ? "selected" : "placeholder"}>
              {editingId
                ? stashRecords.find((record) => record.id === editingId)?.content
                : loadingRecords
                  ? t("common.loading")
                  : stashRecords.length === 0
                    ? t("clipboard.noStash")
                    : t("clipboard.selectStash")}
            </span>
            <svg className="clipboard-create-stash-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {dropdownOpen && stashRecords.length > 0 && (
            <div className="clipboard-create-stash-menu" role="listbox">
              {stashRecords.map((record) => (
                <button
                  key={record.id}
                  type="button"
                  className={`clipboard-create-stash-option${editingId === record.id ? " selected" : ""}`}
                  onClick={() => handleSelectRecord(record)}
                  disabled={loadingRecordId !== null}
                  role="option"
                  aria-selected={editingId === record.id}
                  title={record.content}
                >
                  <span className="clipboard-create-stash-option-content">{record.content}</span>
                  {editingId === record.id && <span className="clipboard-create-stash-check">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="clipboard-create-footer">
        {error && <span className="clipboard-create-error" role="alert">{error}</span>}
        <div className="clipboard-create-actions">
          <button className="dialog-btn secondary" onClick={hideWindow}>
            {t("common.cancel")}
          </button>
          <button
            className="dialog-btn save"
            onClick={handleSave}
            disabled={!content.trim() || saving || loadingRecordId !== null || images.some((image) => image.pending)}
          >
            {saving
              ? t("common.saving")
              : editingId
                ? t("clipboard.updateStash")
                : t("common.save")}
          </button>
        </div>
      </div>
      {CLIPBOARD_RESIZE_HANDLES.map(({ className, direction }) => (
        <div
          key={direction}
          className={`clipboard-create-resize-handle ${className}`}
          data-resize-direction={direction}
          onMouseDown={handleResizeMouseDown}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
