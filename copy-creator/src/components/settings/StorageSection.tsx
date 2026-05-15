import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

interface StorageSectionProps {
  storagePath: string;
  setStoragePath: (path: string) => void;
}

export function StorageSection({ storagePath, setStoragePath }: StorageSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.storage")}</div>
      <div className="settings-card">
        <div className="settings-row vertical">
          <div className="settings-row-label">{t("settings.storagePath")}</div>
          <div className="settings-storage-hint">{t("settings.storageHint")}</div>
          <div className="settings-storage-row">
            <span className="settings-storage-path">{storagePath}</span>
            <button
              className="settings-storage-btn"
              onClick={async () => {
                try {
                  const folder = await invoke<string>("select_storage_folder");
                  await invoke("set_setting", { key: "storage_path", value: folder });
                  setStoragePath(folder);
                } catch {}
              }}
            >
              {t("settings.changeFolder")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
