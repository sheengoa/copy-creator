import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useSettingsStore } from "../stores/settingsStore";
import { StorageSection, LanguageSection, ShortcutSection, TranslationSection, StartupSection, PasteSection } from "./settings";
import { useShortcutRecording } from "./settings/useShortcutRecording";

interface Props {
  embedded?: boolean;
}

export default function SettingsContent({ embedded }: Props) {
  const { i18n, t } = useTranslation();
  const settings = useSettingsStore();
  const loadSettings = settings.loadSettings;

  const [localRetention, setLocalRetention] = useState(settings.clipboardRetention);
  const [localEngine, setLocalEngine] = useState(settings.defaultEngine);
  const [localApiUrl, setLocalApiUrl] = useState(settings.apiUrl);
  const [localApiKey, setLocalApiKey] = useState(settings.apiKey);
  const [localModel, setLocalModel] = useState(settings.model);
  const [localGoogleApiKey, setLocalGoogleApiKey] = useState(settings.googleApiKey);
  const [localTranslateProxy, setLocalTranslateProxy] = useState(settings.translateProxy);
  const [localLang, setLocalLang] = useState(i18n.language);
  const [localShortcutKey, setLocalShortcutKey] = useState(settings.shortcutKey);
  const [localRadialShortcutKey, setLocalRadialShortcutKey] = useState(settings.radialShortcutKey);
  const [localRadialMenuEnabled, setLocalRadialMenuEnabled] = useState(settings.radialMenuEnabled);
  const ccShortcut = useShortcutRecording();
  const { setShortcut: setClipboardCreateShortcut } = ccShortcut;
  const [localAutostart, setLocalAutostart] = useState(settings.autostartEnabled);
  const [localPasteLeftClick, setLocalPasteLeftClick] = useState<"normal" | "terminal">(settings.pasteLeftClick);
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const keydownHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const [radialRecording, setRadialRecording] = useState(false);
  const radialRecordingRef = useRef(false);
  const radialKeydownHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const [storagePath, setStoragePath] = useState("");
  const [saved, setSaved] = useState(false);
  const [shortcutError, setShortcutError] = useState(false);
  const syncedSettingsRef = useRef<{
    clipboardRetention: string;
    defaultEngine: string;
    apiUrl: string;
    apiKey: string;
    model: string;
    googleApiKey: string;
    translateProxy: string;
    language: string;
    shortcutKey: string;
    radialShortcutKey: string;
    clipboardCreateShortcutKey: string;
    radialMenuEnabled: boolean;
    autostartEnabled: boolean;
    pasteLeftClick: "normal" | "terminal";
  } | null>(null);

  useEffect(() => {
    loadSettings();
    invoke<string>("get_storage_path").then(setStoragePath).catch(console.error);
  }, [loadSettings]);

  useEffect(() => {
    const next = {
      clipboardRetention: settings.clipboardRetention,
      defaultEngine: settings.defaultEngine,
      apiUrl: settings.apiUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      googleApiKey: settings.googleApiKey,
      translateProxy: settings.translateProxy,
      language: i18n.language,
      shortcutKey: settings.shortcutKey,
      radialShortcutKey: settings.radialShortcutKey,
      clipboardCreateShortcutKey: settings.clipboardCreateShortcutKey,
      radialMenuEnabled: settings.radialMenuEnabled,
      autostartEnabled: settings.autostartEnabled,
      pasteLeftClick: settings.pasteLeftClick,
    };
    const prev = syncedSettingsRef.current;

    if (!prev || prev.clipboardRetention !== next.clipboardRetention) setLocalRetention(next.clipboardRetention);
    if (!prev || prev.defaultEngine !== next.defaultEngine) setLocalEngine(next.defaultEngine);
    if (!prev || prev.apiUrl !== next.apiUrl) setLocalApiUrl(next.apiUrl);
    if (!prev || prev.apiKey !== next.apiKey) setLocalApiKey(next.apiKey);
    if (!prev || prev.model !== next.model) setLocalModel(next.model);
    if (!prev || prev.googleApiKey !== next.googleApiKey) setLocalGoogleApiKey(next.googleApiKey);
    if (!prev || prev.translateProxy !== next.translateProxy) setLocalTranslateProxy(next.translateProxy);
    if (!prev || prev.language !== next.language) setLocalLang(next.language);
    if (!prev || prev.shortcutKey !== next.shortcutKey) setLocalShortcutKey(next.shortcutKey);
    if (!prev || prev.radialShortcutKey !== next.radialShortcutKey) setLocalRadialShortcutKey(next.radialShortcutKey);
    if (!prev || prev.clipboardCreateShortcutKey !== next.clipboardCreateShortcutKey) setClipboardCreateShortcut(next.clipboardCreateShortcutKey);
    if (!prev || prev.radialMenuEnabled !== next.radialMenuEnabled) setLocalRadialMenuEnabled(next.radialMenuEnabled);
    if (!prev || prev.autostartEnabled !== next.autostartEnabled) setLocalAutostart(next.autostartEnabled);
    if (!prev || prev.pasteLeftClick !== next.pasteLeftClick) setLocalPasteLeftClick(next.pasteLeftClick);

    syncedSettingsRef.current = next;
  }, [
    settings.clipboardRetention,
    settings.defaultEngine,
    settings.apiUrl,
    settings.apiKey,
    settings.model,
    settings.googleApiKey,
    settings.translateProxy,
    i18n.language,
    settings.shortcutKey,
    settings.radialShortcutKey,
    settings.clipboardCreateShortcutKey,
    settings.radialMenuEnabled,
    settings.autostartEnabled,
    settings.pasteLeftClick,
    setClipboardCreateShortcut,
  ]);

  const startRecording = () => {
    recordingRef.current = true;
    setRecording(true);
    setLocalShortcutKey("");

    const cleanup = () => {
      document.removeEventListener("keydown", handler, true);
      keydownHandlerRef.current = null;
    };

    const handler = (e: KeyboardEvent) => {
      if (!recordingRef.current) {
        cleanup();
        return;
      }

      // Ignore modifier-only presses
      if (["Control", "Alt", "Shift", "Meta", "CapsLock", "NumLock", "ScrollLock", "Dead"].includes(e.key)) {
        return;
      }

      // Require at least one modifier
      if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (e.metaKey) parts.push("Super");

      // Map physical key code to layout-independent name
      const code = e.code;
      let keyName: string;
      if (code.startsWith("Key")) {
        keyName = code[3]; // KeyA → A
      } else if (code.startsWith("Digit")) {
        keyName = code[5]; // Digit1 → 1
      } else if (code.startsWith("Numpad")) {
        keyName = "NumPad" + code.substring(6);
      } else {
        keyName = e.key;
        if (keyName === " ") keyName = "Space";
      }
      parts.push(keyName);

      const shortcut = parts.join("+");
      setLocalShortcutKey(shortcut);
      recordingRef.current = false;
      setRecording(false);
      cleanup();
    };

    keydownHandlerRef.current = handler;
    document.addEventListener("keydown", handler, true);
  };

  const stopRecording = () => {
    recordingRef.current = false;
    setRecording(false);
    if (keydownHandlerRef.current) {
      document.removeEventListener("keydown", keydownHandlerRef.current, true);
      keydownHandlerRef.current = null;
    }
  };

  const startRadialRecording = () => {
    radialRecordingRef.current = true;
    setRadialRecording(true);
    setLocalRadialShortcutKey("");

    const cleanup = () => {
      document.removeEventListener("keydown", handler, true);
      radialKeydownHandlerRef.current = null;
    };

    const handler = (e: KeyboardEvent) => {
      if (!radialRecordingRef.current) {
        cleanup();
        return;
      }

      if (["Control", "Alt", "Shift", "Meta", "CapsLock", "NumLock", "ScrollLock", "Dead"].includes(e.key)) {
        return;
      }

      if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (e.metaKey) parts.push("Super");

      const code = e.code;
      let keyName: string;
      if (code.startsWith("Key")) {
        keyName = code[3];
      } else if (code.startsWith("Digit")) {
        keyName = code[5];
      } else if (code.startsWith("Numpad")) {
        keyName = "NumPad" + code.substring(6);
      } else {
        keyName = e.key;
        if (keyName === " ") keyName = "Space";
      }
      parts.push(keyName);

      const shortcut = parts.join("+");
      setLocalRadialShortcutKey(shortcut);
      radialRecordingRef.current = false;
      setRadialRecording(false);
      cleanup();
    };

    radialKeydownHandlerRef.current = handler;
    document.addEventListener("keydown", handler, true);
  };

  const stopRadialRecording = () => {
    radialRecordingRef.current = false;
    setRadialRecording(false);
    if (radialKeydownHandlerRef.current) {
      document.removeEventListener("keydown", radialKeydownHandlerRef.current, true);
      radialKeydownHandlerRef.current = null;
    }
  };

  const handleSave = async () => {
    setShortcutError(false);
    let shortcutUpdateFailed = false;

    await settings.setSettingsBatch({
      clipboard_retention: localRetention,
      default_translate_engine: localEngine,
      ai_api_url: localApiUrl,
      ai_api_key: localApiKey,
      ai_model: localModel,
      google_api_key: localGoogleApiKey,
      translate_proxy: localTranslateProxy,
      language: localLang,
      paste_left_click: localPasteLeftClick,
    });

    const oldKey = settings.shortcutKey;
    const newKey = localShortcutKey;
    if (oldKey !== newKey) {
      try {
        await invoke("update_shortcut", { oldShortcut: oldKey, newShortcut: newKey });
        await settings.setSetting("shortcut_key", newKey);
      } catch (e) {
        console.error("Failed to update shortcut:", e);
        shortcutUpdateFailed = true;
        setLocalShortcutKey(oldKey);
      }
    }

    const oldRadialKey = settings.radialShortcutKey;
    const newRadialKey = localRadialShortcutKey;
    if (oldRadialKey !== newRadialKey) {
      try {
        await invoke("update_radial_shortcut", { oldShortcut: oldRadialKey, newShortcut: newRadialKey });
        await settings.setSetting("shortcut_radial", newRadialKey);
      } catch (e) {
        console.error("Failed to update radial shortcut:", e);
        shortcutUpdateFailed = true;
        setLocalRadialShortcutKey(oldRadialKey);
      }
    }

    const oldClipboardCreateKey = settings.clipboardCreateShortcutKey;
    const newClipboardCreateKey = ccShortcut.shortcut;
    if (oldClipboardCreateKey !== newClipboardCreateKey) {
      try {
        await invoke("update_clipboard_create_shortcut", {
          oldShortcut: oldClipboardCreateKey,
          newShortcut: newClipboardCreateKey,
        });
        await settings.setSetting("shortcut_clipboard_create", newClipboardCreateKey);
      } catch (e) {
        console.error("Failed to update clipboard create shortcut:", e);
        shortcutUpdateFailed = true;
        setClipboardCreateShortcut(oldClipboardCreateKey);
      }
    }

    try {
      await invoke("set_radial_menu_enabled", { enabled: localRadialMenuEnabled });
    } catch (e) {
      console.error("Failed to set radial menu enabled:", e);
    }

    try {
      await settings.setAutostart(localAutostart);
    } catch (e) {
      console.error("Failed to set autostart:", e);
      // Roll back the local state so the toggle reflects reality
      setLocalAutostart(!localAutostart);
    }

    if (localLang !== i18n.language) {
      i18n.changeLanguage(localLang);
      emit("language-changed", { language: localLang });
      invoke("update_tray_language").catch(console.error);
    }

    if (shortcutUpdateFailed) {
      setShortcutError(true);
      setSaved(false);
    } else {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  const content = (
    <>
      <StorageSection
        storagePath={storagePath}
        setStoragePath={setStoragePath}
        localRetention={localRetention}
        setLocalRetention={setLocalRetention}
      />

      <LanguageSection
        localLang={localLang}
        setLocalLang={setLocalLang}
      />

      <ShortcutSection
        localShortcutKey={localShortcutKey}
        recording={recording}
        startRecording={startRecording}
        stopRecording={stopRecording}
        localRadialShortcutKey={localRadialShortcutKey}
        radialRecording={radialRecording}
        startRadialRecording={startRadialRecording}
        stopRadialRecording={stopRadialRecording}
        localClipboardCreateShortcutKey={ccShortcut.shortcut}
        clipboardCreateRecording={ccShortcut.recording}
        startClipboardCreateRecording={ccShortcut.startRecording}
        stopClipboardCreateRecording={ccShortcut.stopRecording}
      />
      {shortcutError && (
        <div className="settings-shortcut-error" role="alert">
          {t("settings.shortcutRegistrationFailed")}
        </div>
      )}

      <StartupSection
        localAutostart={localAutostart}
        setLocalAutostart={setLocalAutostart}
      />

      <PasteSection
        localPasteLeftClick={localPasteLeftClick}
        setLocalPasteLeftClick={(mode) => {
          setLocalPasteLeftClick(mode);
          settings.setPasteLeftClick(mode);
        }}
      />

      <TranslationSection
        localEngine={localEngine}
        setLocalEngine={setLocalEngine}
        localApiUrl={localApiUrl}
        setLocalApiUrl={setLocalApiUrl}
        localApiKey={localApiKey}
        setLocalApiKey={setLocalApiKey}
        localModel={localModel}
        setLocalModel={setLocalModel}
        localGoogleApiKey={localGoogleApiKey}
        setLocalGoogleApiKey={setLocalGoogleApiKey}
        localTranslateProxy={localTranslateProxy}
        setLocalTranslateProxy={setLocalTranslateProxy}
      />

      <div className="settings-actions">
        <button className={`settings-save-btn${saved ? " saved" : ""}`} onClick={handleSave}>
          {saved ? t("common.saved") : t("common.save")}
        </button>
      </div>
    </>
  );

  if (embedded) {
    return <div className="settings-panel-content">{content}</div>;
  }

  return content;
}
