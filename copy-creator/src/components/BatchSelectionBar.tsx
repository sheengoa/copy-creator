import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "./Icons";

interface BatchSelectionBarProps {
  selectedCount: number;
  totalCount: number;
  allSelected: boolean;
  onToggleAll: () => void | Promise<void>;
  onDelete: () => void;
  onCancel: () => void;
  busy?: boolean;
  busyLabel?: string;
}

export default function BatchSelectionBar({
  selectedCount,
  totalCount,
  allSelected,
  onToggleAll,
  onDelete,
  onCancel,
  busy = false,
  busyLabel,
}: BatchSelectionBarProps) {
  const { t } = useTranslation();
  const checkboxRef = useRef<HTMLInputElement>(null);
  const resolvedBusyLabel = busyLabel ?? t("common.loading");

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = selectedCount > 0 && !allSelected;
    }
  }, [allSelected, selectedCount]);

  return (
    <div className="batch-selection-bar" aria-busy={busy}>
      <label className="batch-select-all">
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={allSelected}
          disabled={totalCount === 0 || busy}
          aria-busy={busy}
          onChange={() => void onToggleAll()}
        />
        <span className="selection-checkbox" aria-hidden="true" />
        <span>{allSelected ? t("common.deselectAll") : t("common.selectAll")}</span>
      </label>
      <span className="batch-selection-count" aria-live="polite">
        {t("common.selectedCount", { count: selectedCount })}
      </span>
      <div className="batch-selection-actions">
        <button
          className="batch-delete-btn"
          type="button"
          disabled={selectedCount === 0 || busy}
          onClick={onDelete}
        >
          {busy ? <span className="batch-selection-spinner" aria-hidden="true" /> : Icons.delete}
          <span>{busy ? resolvedBusyLabel : t("common.delete")}</span>
        </button>
        <button className="batch-cancel-btn" type="button" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
