// VSCode 式查找替换条（纯展示 + 键盘交互）：匹配计算与替换落位由宿主
// 实现——资源详情页的 textarea 与新建内容窗口的富文本编辑器分别接入。
// 键盘约定：Enter 下一个、Shift+Enter 上一个、Esc 关闭（拦截冒泡，避免
// 误触宿主的「退出编辑/关闭窗口」）。
import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "./Icons";

interface FindReplaceBarProps {
  /** 覆盖定位样式（如详情页的 fixed 跟随定位）；不传则用默认 absolute。 */
  style?: CSSProperties;
  query: string;
  replacement: string;
  caseSensitive: boolean;
  matchCount: number;
  /** 当前命中（0 基）；无匹配时为 -1。 */
  matchIndex: number;
  onQueryChange: (query: string) => void;
  onReplacementChange: (replacement: string) => void;
  onCaseSensitiveChange: (caseSensitive: boolean) => void;
  onNext: () => void;
  onPrev: () => void;
  onReplaceCurrent: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

export default function FindReplaceBar({
  style,
  query,
  replacement,
  caseSensitive,
  matchCount,
  matchIndex,
  onQueryChange,
  onReplacementChange,
  onCaseSensitiveChange,
  onNext,
  onPrev,
  onReplaceCurrent,
  onReplaceAll,
  onClose,
}: FindReplaceBarProps) {
  const { t } = useTranslation();
  const queryInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    queryInputRef.current?.focus();
    queryInputRef.current?.select();
  }, []);

  const hasMatch = matchCount > 0;
  const displayIndex = hasMatch ? Math.min(matchIndex + 1, matchCount) : 0;

  return (
    <div
      className="find-replace-bar"
      role="search"
      aria-label={t("common.findReplace")}
      style={style}
      onKeyDown={(event) => {
        // 焦点在查找条内时 Ctrl+F 同样是开/关切换（关=当前必然开着）。
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        // 查找条内的按键不再触发宿主快捷键（保存/退出编辑等）。
        event.stopPropagation();
      }}
    >
      <div className="find-replace-row">
        <input
          ref={queryInputRef}
          className="find-replace-input"
          type="text"
          placeholder={t("common.findPlaceholder")}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (event.shiftKey) onPrev();
              else onNext();
            }
          }}
        />
        <span className={`find-replace-count${hasMatch ? "" : " empty"}`} role="status">
          {hasMatch ? `${displayIndex}/${matchCount}` : t("common.findNoResults")}
        </span>
        <button
          type="button"
          className="find-replace-btn"
          title={t("common.findPrev")}
          aria-label={t("common.findPrev")}
          disabled={!hasMatch}
          onClick={onPrev}
        >
          {Icons.chevronUp}
        </button>
        <button
          type="button"
          className="find-replace-btn"
          title={t("common.findNext")}
          aria-label={t("common.findNext")}
          disabled={!hasMatch}
          onClick={onNext}
        >
          {Icons.chevronDown}
        </button>
        <button
          type="button"
          className={`find-replace-btn find-replace-case${caseSensitive ? " active" : ""}`}
          title={t("common.matchCase")}
          aria-label={t("common.matchCase")}
          aria-pressed={caseSensitive}
          onClick={() => onCaseSensitiveChange(!caseSensitive)}
        >
          Aa
        </button>
        <button
          type="button"
          className="find-replace-btn"
          title={t("common.closeFindReplace")}
          aria-label={t("common.closeFindReplace")}
          onClick={onClose}
        >
          {Icons.close}
        </button>
      </div>
      <div className="find-replace-row">
        <input
          className="find-replace-input"
          type="text"
          placeholder={t("common.replacePlaceholder")}
          value={replacement}
          onChange={(event) => onReplacementChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onReplaceCurrent();
            }
          }}
        />
        <button
          type="button"
          className="find-replace-btn find-replace-submit"
          disabled={!hasMatch}
          onClick={onReplaceCurrent}
        >
          {t("common.replaceCurrent")}
        </button>
        <button
          type="button"
          className="find-replace-btn find-replace-submit"
          disabled={!hasMatch}
          onClick={onReplaceAll}
        >
          {t("common.replaceAll")}
        </button>
      </div>
    </div>
  );
}
