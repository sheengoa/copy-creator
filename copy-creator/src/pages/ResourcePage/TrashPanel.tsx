// 资源回收站面板：独立轻量列表（trash_items 行，非记录卡片，不适用
// 卡片叶子合同）。刷新挂既有 resource-groups-changed 事件。
// 批量选择复用共享 BatchSelectionBar 与全局 selection-checkbox 视觉。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Icons } from "../../components/Icons";
import BatchSelectionBar from "../../components/BatchSelectionBar";
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
  const [busyOp, setBusyOp] = useState<"restore" | "purge" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmPurgeAll, setConfirmPurgeAll] = useState(false);
  const [confirmPurgeSelected, setConfirmPurgeSelected] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const busy = busyOp !== null;

  const loadItems = useCallback(async (): Promise<TrashItem[]> => {
    try {
      const fresh = await invoke<TrashItem[]>("list_trash_items");
      setItems(fresh);
      return fresh;
    } catch (e) {
      console.error("Failed to list trash items:", e);
      setError(String(e));
      return [];
    }
  }, []);

  // 批量操作或跨窗口刷新后按幸存条目收敛勾选；回收站被清空时自动退出选择模式。
  const pruneSelection = useCallback((fresh: TrashItem[]) => {
    const alive = new Set(fresh.map((item) => item.id));
    setSelectedIds((prev) => prev.filter((id) => alive.has(id)));
    if (fresh.length === 0) setSelectionMode(false);
  }, []);

  useEffect(() => {
    void loadItems();
    const unlisten = listen("resource-groups-changed", () => {
      void loadItems().then(pruneSelection);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [loadItems, pruneSelection]);

  const act = async (op: "restore" | "purge", action: () => Promise<unknown>) => {
    setBusyOp(op);
    setError(null);
    try {
      await action();
      await loadItems();
    } catch (e) {
      console.error("Trash action failed:", e);
      setError(String(e));
    } finally {
      setBusyOp(null);
    }
  };

  const runBatchRestore = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0 || busy) return;
    setBusyOp("restore");
    setError(null);
    try {
      await invoke("restore_trash_items", { ids });
      pruneSelection(await loadItems());
    } catch (e) {
      console.error("Trash batch restore failed:", e);
      setError(String(e));
    } finally {
      setBusyOp(null);
    }
  };

  const runBatchPurge = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0 || busy) return;
    setBusyOp("purge");
    setError(null);
    try {
      await invoke("purge_trash_items", { ids });
      pruneSelection(await loadItems());
    } catch (e) {
      console.error("Trash batch purge failed:", e);
      setError(String(e));
    } finally {
      setBusyOp(null);
    }
  };

  const allSelected =
    items !== null && items.length > 0 && items.every((item) => selectedIds.includes(item.id));

  const toggleAll = () => {
    if (items) setSelectedIds(allSelected ? [] : items.map((item) => item.id));
  };

  const toggleRow = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((selected) => selected !== id) : [...prev, id],
    );
  };

  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedIds([]);
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
        {/* 与详情页返回键同款（resource-back-button）：纯图标曾是折叠控件观感 */}
        <button type="button" className="resource-back-button" onClick={onBack}>
          {Icons.arrowLeft}
          <span>{t("resources.backToLibrary")}</span>
        </button>
        <strong className="trash-title">{t("resources.trashTitle")}</strong>
        <span className="trash-count">{items?.length ?? ""}</span>
        <span className="trash-grow" />
        {items !== null && items.length > 0 && !selectionMode && (
          <button
            type="button"
            className="trash-select-btn"
            onClick={() => {
              setSelectionMode(true);
              setSelectedIds([]);
            }}
          >
            {Icons.check}
            <span>{t("common.select")}</span>
          </button>
        )}
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

      {selectionMode && items !== null && (
        <BatchSelectionBar
          selectedCount={selectedIds.length}
          totalCount={items.length}
          allSelected={allSelected}
          onToggleAll={toggleAll}
          onRestore={() => void runBatchRestore()}
          onDelete={() => setConfirmPurgeSelected(true)}
          onCancel={exitSelection}
          busy={busy}
          busyLabel={busyOp === "restore" ? t("common.restoring") : t("common.deleting")}
        />
      )}

      {items === null ? (
        <div className="trash-empty">{t("common.loading")}</div>
      ) : items.length === 0 ? (
        <div className="trash-empty">{t("resources.trashEmpty")}</div>
      ) : (
        <div className="trash-list">
          {items.map((item) => {
            const selected = selectedIds.includes(item.id);
            return (
              <div
                className={`trash-row${selectionMode ? " is-selecting" : ""}${selected ? " selected" : ""}`}
                key={item.id}
                onClick={selectionMode ? () => toggleRow(item.id) : undefined}
              >
                {selectionMode && (
                  <label className="trash-row-check" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={busy}
                      onChange={() => toggleRow(item.id)}
                    />
                    <span className="selection-checkbox" aria-hidden="true" />
                  </label>
                )}
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
                {!selectionMode && (
                  <>
                    <button
                      type="button"
                      className="trash-row-btn"
                      disabled={busy}
                      onClick={() =>
                        void act("restore", () => invoke("restore_trash_item", { id: item.id }))
                      }
                    >
                      {t("resources.trashRestore")}
                    </button>
                    <button
                      type="button"
                      className="trash-row-btn trash-row-danger"
                      disabled={busy}
                      onClick={() =>
                        void act("purge", () => invoke("purge_trash_items", { ids: [item.id] }))
                      }
                    >
                      {t("resources.trashPurge")}
                    </button>
                  </>
                )}
              </div>
            );
          })}
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
            void act("purge", () => invoke("purge_trash_items", { ids: [] }));
          }}
          onCancel={() => setConfirmPurgeAll(false)}
        />
      )}

      {confirmPurgeSelected && (
        <ConfirmDialog
          message={t("resources.trashPurgeSelectedConfirm", {
            count: selectedIds.length,
          })}
          onConfirm={() => {
            setConfirmPurgeSelected(false);
            void runBatchPurge();
          }}
          onCancel={() => setConfirmPurgeSelected(false)}
        />
      )}
    </div>
  );
}
