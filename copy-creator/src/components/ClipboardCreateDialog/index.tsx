import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { resolveDoubleEnterSave } from "../../utils/doubleEnterShortcut";
import i18n from "../../i18n";

export default function ClipboardCreateDialog() {
  const { t } = useTranslation();
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastEnterAtRef = useRef(0);

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
      setTimeout(() => textareaRef.current?.focus(), 50);
    }).then((fn) => { unlistenShow = fn; });

    return () => {
      if (unlistenTheme) unlistenTheme();
      if (unlistenLang) unlistenLang();
      if (unlistenShow) unlistenShow();
    };
  }, []);

  const hideWindow = useCallback(() => {
    getCurrentWindow().hide();
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await invoke("create_clipboard_record", {
        content: trimmed,
      });
      setContent("");
      hideWindow();
    } catch (e) {
      console.error("Failed to create clipboard record:", e);
    } finally {
      setSaving(false);
    }
  }, [content, saving, hideWindow]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      lastEnterAtRef.current = 0;
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
  }, [content, hideWindow, handleSave]);

  return (
    <div className="clipboard-create-dialog" onKeyDown={handleKeyDown}>
      <div className="clipboard-create-header" data-tauri-drag-region>
        <span className="clipboard-create-title">{t("clipboard.create")}</span>
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
        placeholder={t("clipboard.createPlaceholder")}
        autoFocus
      />
      <div className="clipboard-create-footer">
        <div className="clipboard-create-actions">
          <button className="dialog-btn secondary" onClick={hideWindow}>
            {t("common.cancel")}
          </button>
          <button
            className="dialog-btn save"
            onClick={handleSave}
            disabled={!content.trim() || saving}
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
