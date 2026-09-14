import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { ConfirmDialog } from "../ConfirmDialog";

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
  // 迁移确认走应用内 ConfirmDialog：WebView 禁用 window.confirm（恒返回
  // false），此前「迁移」分支在 Windows 上用户永远无法触达，只会静默
  // 走不迁移分支。
  const [pendingMigratePath, setPendingMigratePath] = useState<string | null>(
    null,
  );

  const handleChangeFolder = async () => {
    try {
      const folder = await invoke<string>("select_storage_folder");
      if (!folder) return;

      // 是否迁移现有数据：确认 → set_setting（完整迁移）；取消 → 仅改路径。
      setPendingMigratePath(folder);
    } catch {
      // User cancelled folder picker
    }
  };

  const applyStoragePath = async (folder: string, migrate: boolean) => {
    if (migrate) {
      await invoke("set_setting", { key: "storage_path", value: folder });
    } else {
      // Just update the path without migrating data
      await invoke("set_setting_skip_migrate", {
        key: "storage_path",
        value: folder,
      });
    }
    setStoragePath(folder);
    setNeedRestart(true);
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

      {pendingMigratePath !== null && (
        <ConfirmDialog
          message={t("settings.migratePrompt")}
          onConfirm={() => {
            void applyStoragePath(pendingMigratePath, true);
          }}
          onCancel={() => {
            void applyStoragePath(pendingMigratePath, false);
          }}
        />
      )}
    </div>
  );
}
