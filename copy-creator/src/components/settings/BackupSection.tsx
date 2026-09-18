// 备份与恢复：入口在设置页存储区块之下，交互与存储迁移同款
// （应用内确认对话框 + 重启提示）。导出默认不含资源库——它本身就是
// 普通文件夹；导入前展示概要并校验，通过后写 storage_path 重启切换。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";

interface BackupManifestView {
  format_version: number;
  app_version: string;
  exported_at: string;
  includes_library: boolean;
  library_path: string;
  table_counts: Record<string, number>;
}

type ImportSelection = {
  zipPath: string;
  manifest: BackupManifestView;
  libraryTarget: string | null;
};

export function BackupSection() {
  const { t } = useTranslation();
  const [includeLibrary, setIncludeLibrary] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProcessed, setExportProcessed] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importProcessed, setImportProcessed] = useState(0);
  const [selection, setSelection] = useState<ImportSelection | null>(null);
  const [needRestart, setNeedRestart] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 进度事件由后端按处理条数节流（每 200/500 条一条），只做量级展示。
    const unlisten = listen<{ phase: string; processed: number }>(
      "backup-progress",
      (event) => {
        if (event.payload.phase === "export") setExportProcessed(event.payload.processed);
        if (event.payload.phase === "import") setImportProcessed(event.payload.processed);
      },
    );
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const guard = (e: unknown) => {
    const message = String(e);
    // 对话框取消/超时不算失败，保持既有 select_* 命令的语义。
    if (message.includes("cancelled") || message.includes("timeout")) return;
    console.error("backup action failed:", e);
    setError(message);
  };

  const handleExport = async () => {
    setError(null);
    try {
      const target = await invoke<string>("select_backup_save_path");
      if (!target) return;
      setExporting(true);
      setExportProcessed(0);
      await invoke("export_backup", { targetZip: target, includeLibrary });
    } catch (e) {
      guard(e);
    } finally {
      setExporting(false);
    }
  };

  const handleCancelExport = async () => {
    try {
      await invoke("cancel_backup_export");
    } catch (e) {
      guard(e);
    }
  };

  const handlePickBackup = async () => {
    setError(null);
    try {
      const zipPath = await invoke<string>("select_backup_zip_path");
      if (!zipPath) return;
      const manifest = await invoke<BackupManifestView>("preview_backup", { zipPath });
      setSelection({
        zipPath,
        manifest,
        libraryTarget: manifest.includes_library ? manifest.library_path : null,
      });
    } catch (e) {
      guard(e);
    }
  };

  const handlePickLibraryTarget = async () => {
    try {
      const folder = await invoke<string>("select_resource_library_folder");
      if (!folder) return;
      setSelection((current) => (current === null ? current : { ...current, libraryTarget: folder }));
    } catch (e) {
      guard(e);
    }
  };

  const handleImport = async () => {
    if (selection === null) return;
    setError(null);
    setImporting(true);
    setImportProcessed(0);
    try {
      await invoke("import_backup", {
        zipPath: selection.zipPath,
        restoreLibraryTo: selection.libraryTarget,
      });
      setSelection(null);
      setNeedRestart(true);
    } catch (e) {
      guard(e);
    } finally {
      setImporting(false);
    }
  };

  const summary = (manifest: BackupManifestView) => {
    const parts = [
      `${t("settings.backupSummaryRecords")} ${manifest.table_counts.clipboard_records ?? 0}`,
      `${t("settings.backupSummaryPhrases")} ${manifest.table_counts.phrases ?? 0}`,
      `${t("settings.backupSummaryGroups")} ${manifest.table_counts.phrase_groups ?? 0}`,
    ];
    return parts.join(" · ");
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.backupTitle")}</div>
      <div className="settings-card">
        <div className="settings-row vertical">
          <div className="settings-row-label">{t("settings.backupExportLabel")}</div>
          <div className="settings-storage-row">
            <button
              className="settings-storage-btn"
              onClick={() => void handleExport()}
              disabled={exporting}
            >
              {exporting ? t("settings.backupExporting") : t("settings.backupExportAction")}
            </button>
            {exporting && (
              <button className="settings-storage-btn" onClick={() => void handleCancelExport()}>
                {t("settings.backupCancelExport")}
              </button>
            )}
            {exporting && <span className="settings-storage-hint">{t("settings.backupProcessed", { count: exportProcessed })}</span>}
          </div>
          <label className="settings-storage-hint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={includeLibrary}
              disabled={exporting}
              onChange={(e) => setIncludeLibrary(e.target.checked)}
            />
            <span>{t("settings.backupIncludeLibrary")}</span>
          </label>
          <div className="settings-storage-hint">{t("settings.backupExportHint")}</div>
        </div>

        <div className="settings-row vertical">
          <div className="settings-row-label">{t("settings.backupImportLabel")}</div>
          <div className="settings-storage-row">
            <button
              className="settings-storage-btn"
              onClick={() => void handlePickBackup()}
              disabled={importing}
            >
              {t("settings.backupImportAction")}
            </button>
            {importing && (
              <span className="settings-storage-hint">{t("settings.backupProcessed", { count: importProcessed })}</span>
            )}
          </div>
          <div className="settings-storage-hint">{t("settings.backupImportHint")}</div>
        </div>

        {needRestart && (
          <div className="settings-restart-hint">
            <span>{t("settings.restartHint")}</span>
            <button className="settings-restart-btn" onClick={() => relaunch()}>
              {t("settings.restartNow")}
            </button>
          </div>
        )}
      </div>

      {selection !== null && (
        <div className="settings-card">
          <div className="settings-row vertical">
            <div className="settings-row-label">{t("settings.backupSummaryTitle")}</div>
            <div className="settings-storage-hint">
              {t("settings.backupSummaryVersion")}: {selection.manifest.app_version} ·{" "}
              {new Date(selection.manifest.exported_at).toLocaleString()}
            </div>
            <div className="settings-storage-hint">{summary(selection.manifest)}</div>
            {selection.manifest.includes_library && (
              <>
                <div className="settings-row-label" style={{ marginTop: 8 }}>
                  {t("settings.backupLibraryTarget")}
                </div>
                <div className="settings-storage-row">
                  <span className="settings-storage-path">{selection.libraryTarget}</span>
                  <button className="settings-storage-btn" onClick={() => void handlePickLibraryTarget()}>
                    {t("settings.changeFolder")}
                  </button>
                </div>
                {selection.libraryTarget !== null &&
                  selection.libraryTarget !== selection.manifest.library_path && (
                    <div className="settings-storage-hint" />
                  )}
              </>
            )}
            <div className="settings-storage-hint">{t("settings.backupImportCoverHint")}</div>
            <div className="settings-storage-row">
              <button
                className="settings-storage-btn"
                onClick={() => void handleImport()}
                disabled={importing}
              >
                {importing ? t("settings.backupImporting") : t("settings.backupStartImport")}
              </button>
              <button
                className="settings-storage-btn"
                onClick={() => setSelection(null)}
                disabled={importing}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="settings-restart-hint">
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
