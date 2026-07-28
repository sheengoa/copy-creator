import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { resolveDoubleEnterSave } from "../../utils/doubleEnterShortcut";
import i18n from "../../i18n";

interface StashRecord {
  id: string;
  type: "text" | "link" | "image" | "file";
  content: string;
  content_truncated?: boolean;
  group_name?: string;
}

export default function ClipboardCreateDialog() {
  const { t } = useTranslation();
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [stashRecords, setStashRecords] = useState<StashRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [loadingRecordId, setLoadingRecordId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastEnterAtRef = useRef(0);

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
      document.documentElement.setAttribute("data-theme", e.payload.theme);
      setContent("");
      setEditingId(null);
      setError(null);
      setDropdownOpen(false);
      loadStashRecords();
      setTimeout(() => textareaRef.current?.focus(), 50);
    }).then((fn) => { unlistenShow = fn; });

    loadStashRecords(true);

    return () => {
      if (unlistenTheme) unlistenTheme();
      if (unlistenLang) unlistenLang();
      if (unlistenShow) unlistenShow();
    };
  }, [loadStashRecords]);

  const hideWindow = useCallback(() => {
    getCurrentWindow().hide();
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await invoke("update_clipboard_record", { id: editingId, content: trimmed });
      } else {
        await invoke("create_clipboard_record", { content: trimmed });
      }
      setContent("");
      setEditingId(null);
      hideWindow();
    } catch (e) {
      console.error("Failed to save clipboard record:", e);
      setError(t("clipboard.saveStashError"));
    } finally {
      setSaving(false);
    }
  }, [content, editingId, saving, hideWindow, t]);

  const handleSelectRecord = useCallback(async (record: StashRecord) => {
    if (loadingRecordId) return;
    setDropdownOpen(false);
    setLoadingRecordId(record.id);
    setError(null);
    try {
      const fullContent = record.content_truncated
        ? await invoke<string>("get_clipboard_record_content", { id: record.id })
        : record.content;
      setEditingId(record.id);
      setContent(fullContent);
      lastEnterAtRef.current = 0;
      setTimeout(() => textareaRef.current?.focus(), 0);
    } catch (e) {
      console.error("Failed to load clipboard record content:", e);
      setError(t("clipboard.loadStashContentError"));
    } finally {
      setLoadingRecordId(null);
    }
  }, [loadingRecordId, t]);

  const handleExitEdit = useCallback(() => {
    setEditingId(null);
    setContent("");
    setError(null);
    lastEnterAtRef.current = 0;
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

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
    if (e.target !== textareaRef.current) {
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
        <button className="clipboard-create-close-btn" onClick={hideWindow} title={t("common.cancel")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <textarea
        ref={textareaRef}
        className="clipboard-create-textarea"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onFocus={() => setDropdownOpen(false)}
        placeholder={t("clipboard.createPlaceholder")}
        autoFocus
      />
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
            disabled={!content.trim() || saving || loadingRecordId !== null}
          >
            {saving
              ? t("common.saving")
              : editingId
                ? t("clipboard.updateStash")
                : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
