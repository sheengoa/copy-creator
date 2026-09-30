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
  /** 条目实体状态（运行时判定）：false = 文件在删除前已不在磁盘、仅记录入桶，恢复无文件可还原。 */
  has_file: boolean;
}

// 与后端 RestoreOutcome / RestoreBatchSummary 对应（snake_case 直传）。
type RestoreOutcome = "restored" | "relinked" | "metadata_only";

interface RestoreBatchSummary {
  restored: number;
  relinked: number;
  metadata_only: number;
  failed: string[];
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
  const [notice, setNotice] = useState<string | null>(null);
  // 文件已丢失条目的恢复确认：恢复仅还原记录元数据（库内有唯一同名文件
  // 时自动关联），提前如实告知，而非恢复后才报 metadata_only。
  const [confirmRestoreMissing, setConfirmRestoreMissing] = useState<TrashItem | null>(null);
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

  // 恢复结果如实汇报：仅在有"自动关联 / 文件已丢失 / 失败"时出提示，
  // 全部正常恢复保持既有静默。
  const noticeFromCounts = (relinked: number, metadataOnly: number, failed: number) => {
    const parts: string[] = [];
    if (relinked > 0) parts.push(t("resources.trashRelinkedCount", { count: relinked }));
    if (metadataOnly > 0)
      parts.push(t("resources.trashMetadataOnlyCount", { count: metadataOnly }));
    if (failed > 0) parts.push(t("resources.trashRestoreFailedCount", { count: failed }));
    return parts.length > 0 ? parts.join("；") : null;
  };

  const act = async <T,>(op: "restore" | "purge", action: () => Promise<T>): Promise<T | undefined> => {
    setBusyOp(op);
    setError(null);
    try {
      const result = await action();
      await loadItems();
      return result;
    } catch (e) {
      console.error("Trash action failed:", e);
      setError(String(e));
      return undefined;
    } finally {
      setBusyOp(null);
    }
  };

  const restoreItem = (item: TrashItem) => {
    void act("restore", () =>
      invoke<RestoreOutcome>("restore_trash_item", { id: item.id }),
    ).then((outcome) => {
      if (outcome && outcome !== "restored") {
        setNotice(
          noticeFromCounts(
            outcome === "relinked" ? 1 : 0,
            outcome === "metadata_only" ? 1 : 0,
            0,
          ),
        );
      }
    });
  };

  const runBatchRestore = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0 || busy) return;
    setBusyOp("restore");
    setError(null);
    try {
      const summary = await invoke<RestoreBatchSummary>("restore_trash_items", { ids });
      pruneSelection(await loadItems());
      setNotice(
        noticeFromCounts(summary.relinked, summary.metadata_only, summary.failed.length),
      );
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

      {notice && (
        <div className="trash-notice" role="status">
          <span className="trash-notice-text">{notice}</span>
          <button
            type="button"
            className="trash-notice-close"
            aria-label={t("common.close")}
            onClick={() => setNotice(null)}
          >
            ×
          </button>
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
                    {/* 缺失标记放 meta 行而非文件名内：文件名过长触发
                        ellipsis 截断时会连角标一起裁掉，标记必须恒可见。 */}
                    {!item.has_file && (
                      <span className="trash-row-missing">{t("resources.trashFileMissing")}</span>
                    )}
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
                      onClick={() => {
                        if (item.has_file) {
                          void restoreItem(item);
                        } else {
                          setConfirmRestoreMissing(item);
                        }
                      }}
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

      {confirmRestoreMissing && (
        <ConfirmDialog
          message={t("resources.trashRestoreMissingConfirm", {
            name: confirmRestoreMissing.file_name,
          })}
          onConfirm={() => {
            const item = confirmRestoreMissing;
            setConfirmRestoreMissing(null);
            if (item) restoreItem(item);
          }}
          onCancel={() => setConfirmRestoreMissing(null)}
        />
      )}

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
