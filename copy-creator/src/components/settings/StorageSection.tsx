import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";

interface StorageSectionProps {
  storagePath: string;
  setStoragePath: (path: string) => void;
}

export function StorageSection({
  storagePath,
  setStoragePath,
}: StorageSectionProps) {
  const { t } = useTranslation();
  const [needRestart, setNeedRestart] = useState(false);

  const handleChangeFolder = async () => {
    try {
      const folder = await invoke<string>("select_storage_folder");
      if (!folder) return;

      // Ask whether to migrate existing data
      const migrate = window.confirm(t("settings.migratePrompt"));

      if (migrate) {
        await invoke("set_setting", { key: "storage_path", value: folder });
      } else {
        // Just update the path without migrating data
        await invoke("set_setting_skip_migrate", { key: "storage_path", value: folder });
      }

      setStoragePath(folder);
      setNeedRestart(true);
    } catch {
      // User cancelled folder picker
    }
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.storage")}</div>
      <div className="settings-card">
        <div className="settings-row vertical">
          <div className="settings-row-label">{t("settings.storagePath")}</div>
          <div className="settings-storage-row">
            <span className="settings-storage-path">{storagePath}</span>
            <button
              className="settings-storage-btn"
              onClick={handleChangeFolder}
            >
              {t("settings.changeFolder")}
            </button>
          </div>
          <div className="settings-storage-hint">
            {t("settings.storagePathHint")}
          </div>
          {needRestart && (
            <div className="settings-restart-hint">
              <span>{t("settings.restartHint")}</span>
              <button
                className="settings-restart-btn"
                onClick={() => relaunch()}
              >
                {t("settings.restartNow")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
