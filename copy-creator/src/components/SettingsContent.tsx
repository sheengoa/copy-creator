import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settingsStore";
import { StorageSection, LanguageSection, TranslationSection } from "./settings";

interface Props {
  embedded?: boolean;
}

export default function SettingsContent({ embedded }: Props) {
  const { i18n } = useTranslation();
  const settings = useSettingsStore();

  const [localRetention, setLocalRetention] = useState(settings.clipboardRetention);
  const [localEngine, setLocalEngine] = useState(settings.defaultEngine);
  const [localApiUrl, setLocalApiUrl] = useState(settings.apiUrl);
  const [localApiKey, setLocalApiKey] = useState(settings.apiKey);
  const [localModel, setLocalModel] = useState(settings.model);
  const [localBaiduAppId, setLocalBaiduAppId] = useState(settings.baiduAppId);
  const [localBaiduSecret, setLocalBaiduSecret] = useState(settings.baiduSecret);
  const [localGoogleApiKey, setLocalGoogleApiKey] = useState(settings.googleApiKey);
  const [localLang, setLocalLang] = useState(i18n.language);
  const [localShortcutKey, setLocalShortcutKey] = useState(settings.shortcutKey);
  const [recording, setRecording] = useState(false);
  const recordRef = useRef(false);
  const [storagePath, setStoragePath] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    settings.loadSettings();
    invoke<string>("get_storage_path").then(setStoragePath).catch(console.error);
  }, []);

  useEffect(() => {
    setLocalRetention(settings.clipboardRetention);
    setLocalEngine(settings.defaultEngine);
    setLocalApiUrl(settings.apiUrl);
    setLocalApiKey(settings.apiKey);
    setLocalModel(settings.model);
    setLocalBaiduAppId(settings.baiduAppId);
    setLocalBaiduSecret(settings.baiduSecret);
    setLocalGoogleApiKey(settings.googleApiKey);
    setLocalLang(i18n.language);
    setLocalShortcutKey(settings.shortcutKey);
  }, [settings, i18n.language]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!recordRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Super");

    const key = e.key;
    if (!["Control", "Alt", "Shift", "Meta"].includes(key)) {
      let keyName = key;
      if (key === " ") keyName = "Space";
      else if (key.length === 1) keyName = key.toUpperCase();
      parts.push(keyName);
    }

    if (parts.length > 1 || (parts.length === 1 && !["Ctrl", "Alt", "Shift", "Super"].includes(parts[0]))) {
      setLocalShortcutKey(parts.join("+"));
      setRecording(false);
      recordRef.current = false;
    }
  }, []);

  const startRecording = () => {
    setRecording(true);
    recordRef.current = true;
    setLocalShortcutKey("");
  };

  const stopRecording = () => {
    setRecording(false);
    recordRef.current = false;
  };

  useEffect(() => {
    if (recording) {
      window.addEventListener("keydown", handleKeyDown, true);
      return () => window.removeEventListener("keydown", handleKeyDown, true);
    }
  }, [recording, handleKeyDown]);

  const handleSave = async () => {
    await settings.setSetting("clipboard_retention", localRetention);
    await settings.setSetting("default_translate_engine", localEngine);
    await settings.setSetting("ai_api_url", localApiUrl);
    await settings.setSetting("ai_api_key", localApiKey);
    await settings.setSetting("ai_model", localModel);
    await settings.setSetting("baidu_appid", localBaiduAppId);
    await settings.setSetting("baidu_secret", localBaiduSecret);
    await settings.setSetting("google_api_key", localGoogleApiKey);
    await settings.setSetting("language", localLang);

    const oldKey = settings.shortcutKey;
    const newKey = localShortcutKey;
    if (oldKey !== newKey) {
      try {
        await invoke("update_shortcut", { oldShortcut: oldKey, newShortcut: newKey });
        await settings.setSetting("shortcut_key", newKey);
      } catch (e) {
        console.error("Failed to update shortcut:", e);
      }
    }

    if (localLang !== i18n.language) {
      i18n.changeLanguage(localLang);
    }

    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const content = (
    <>
      <StorageSection storagePath={storagePath} setStoragePath={setStoragePath} />

      <LanguageSection
        localLang={localLang}
        setLocalLang={setLocalLang}
        localRetention={localRetention}
        setLocalRetention={setLocalRetention}
        localShortcutKey={localShortcutKey}
        setLocalShortcutKey={setLocalShortcutKey}
        recording={recording}
        startRecording={startRecording}
        stopRecording={stopRecording}
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
      />

      <div className="settings-actions">
        <button className={`settings-save-btn${saved ? " saved" : ""}`} onClick={handleSave}>
          {saved ? "✓" : "保存"}
        </button>
      </div>
    </>
  );

  if (embedded) {
    return <div className="settings-panel-content">{content}</div>;
  }

  return content;
}
