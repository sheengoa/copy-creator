// 资源回收站面板：独立轻量列表（trash_items 行，非记录卡片，不适用
// 卡片叶子合同）。刷新挂既有 resource-groups-changed 事件。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Icons } from "../../components/Icons";
import { ConfirmDialog } from "../../components/ConfirmDialog";

interface TrashItem {
  id: string;
  file_name: string;
  original_group: string;
  original_path: string;
  trashed_at: string;
  has_attachments: boolean;
}

export function TrashPanel({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmPurgeAll, setConfirmPurgeAll] = useState(false);

  const loadItems = useCallback(async () => {
    try {
      setItems(await invoke<TrashItem[]>("list_trash_items"));
    } catch (e) {
      console.error("Failed to list trash items:", e);
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void loadItems();
    const unlisten = listen("resource-groups-changed", () => {
      void loadItems();
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [loadItems]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await loadItems();
    } catch (e) {
      console.error("Trash action failed:", e);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const formatTime = (raw: string) => {
    const date = new Date(raw);
    return Number.isNaN(date.getTime())
      ? raw
      : date.toLocaleString(undefined, { hour12: false });
  };

  return (
    <div className="trash-panel">
      <div className="trash-head">
        <button
          type="button"
          className="resource-icon-button"
          onClick={onBack}
          aria-label={t("resources.trashBack")}
          title={t("resources.trashBack")}
        >
          {Icons.chevronDown}
        </button>
        <strong className="trash-title">{t("resources.trashTitle")}</strong>
        <span className="trash-count">{items?.length ?? ""}</span>
        <span className="trash-grow" />
        <button
          type="button"
          className="trash-danger-btn"
          disabled={busy || !items || items.length === 0}
          onClick={() => setConfirmPurgeAll(true)}
        >
          {t("resources.trashPurgeAll")}
        </button>
      </div>

      {error && (
        <div className="resource-settings-error" role="alert">
          {error}
        </div>
      )}

      {items === null ? (
        <div className="trash-empty">{t("common.loading")}</div>
      ) : items.length === 0 ? (
        <div className="trash-empty">{t("resources.trashEmpty")}</div>
      ) : (
        <div className="trash-list">
          {items.map((item) => (
            <div className="trash-row" key={item.id}>
              <span className="trash-row-main">
                <span className="trash-row-name" title={item.original_path}>
                  {item.file_name}
                </span>
                <span className="trash-row-meta">
                  {item.original_group
                    ? t("resources.trashFromGroup", { group: item.original_group })
                    : t("resources.trashFromUngrouped")}
                  {" · "}
                  {formatTime(item.trashed_at)}
                  {item.has_attachments ? ` · ${t("resources.trashWithAttachments")}` : ""}
                </span>
              </span>
              <button
                type="button"
                className="trash-row-btn"
                disabled={busy}
                onClick={() => void act(() => invoke("restore_trash_item", { id: item.id }))}
              >
                {t("resources.trashRestore")}
              </button>
              <button
                type="button"
                className="trash-row-btn trash-row-danger"
                disabled={busy}
                onClick={() => void act(() => invoke("purge_trash_items", { ids: [item.id] }))}
              >
                {t("resources.trashPurge")}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="trash-foot">{t("resources.trashRetentionHint")}</div>

      {confirmPurgeAll && (
        <ConfirmDialog
          message={t("resources.trashPurgeAllConfirm", {
            count: items?.length ?? 0,
          })}
          onConfirm={() => {
            setConfirmPurgeAll(false);
            void act(() => invoke("purge_trash_items", { ids: [] }));
          }}
          onCancel={() => setConfirmPurgeAll(false)}
        />
      )}
    </div>
  );
}
