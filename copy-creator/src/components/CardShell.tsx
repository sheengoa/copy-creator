import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "./Icons";

/**
 * 卡片外壳共用件：三卡（资源 ResourceCard / 剪藏 ClipboardCard / 短语
 * PhraseList 的短语卡）此前各写一份「⋯触发钮 / 多选框」，结构逐行同构，
 * 口径漂移需三处同步；菜单项本身各卡不同，仍归各卡。菜单锚点换算在
 * utils/cardShell.ts（组件文件不得混出非组件导出）。
 */

/** 卡片「⋯」触发钮：stopPropagation 后交 onToggle（防触发卡片激活）。 */
export function CardMoreTrigger({
  open,
  onToggle,
  buttonRef,
  label,
}: {
  open: boolean;
  onToggle: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  label: string;
}) {
  return (
    <div className="resource-card-more">
      <button
        type="button"
        ref={buttonRef}
        className="resource-card-more-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        {Icons.more}
      </button>
    </div>
  );
}

/** 卡片多选框：选择模式下卡片左上的复选标签。 */
export function CardSelectionCheckbox({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="resource-card-selection" onClick={(event) => event.stopPropagation()}>
      <input
        type="checkbox"
        checked={checked}
        aria-label={t("common.selectItem")}
        onChange={onToggle}
      />
      <span className="selection-checkbox" aria-hidden="true" />
    </label>
  );
}
