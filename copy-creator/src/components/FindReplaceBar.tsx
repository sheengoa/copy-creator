// VSCode 式查找替换条：匹配计算与替换落位由宿主实现——资源详情页的
// textarea 与新建内容窗口的富文本编辑器分别接入。查找/替换历史（全局
// 共享持久化）与交换按钮由本组件自管，宿主无感。
// 键盘约定：Enter 下一个、Shift+Enter 上一个、Esc 先关历史面板再关闭
// 查找条（拦截冒泡，避免误触宿主的「退出编辑/关闭窗口」）。
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useFindReplaceHistory } from "../hooks/useFindReplaceHistory";
import type { FindHistoryEntry } from "../utils/findHistory";
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
  const barRef = useRef<HTMLDivElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // 交换按钮每次点击翻转一次旋转方向，形成交替动效反馈。
  const [swapFlipped, setSwapFlipped] = useState(false);
  const { history, recordFind, recordReplace, removeEntry, clearHistory } =
    useFindReplaceHistory();

  useEffect(() => {
    queryInputRef.current?.focus();
    queryInputRef.current?.select();
  }, []);

  // 历史面板打开时，点击条外任意处关闭（pointerdown 捕获按下瞬间，早于失焦）。
  useEffect(() => {
    if (!historyOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (barRef.current?.contains(event.target as Node)) return;
      setHistoryOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [historyOpen]);

  const hasMatch = matchCount > 0;
  const displayIndex = hasMatch ? Math.min(matchIndex + 1, matchCount) : 0;
  // 查询为空时计数区留空——「无结果」只用于确实搜过但没搜到的场景。
  const countText =
    query === "" ? "" : hasMatch ? `${displayIndex}/${matchCount}` : t("common.findNoResults");

  // 查找导航（Enter/上下个按钮）记录查找词；替换动作记录查找词 + 替换值对。
  const navigate = (jump: () => void) => {
    recordFind(query);
    jump();
  };
  const replaceWithRecord = (action: () => void) => {
    recordReplace(query, replacement);
    action();
  };
  const handleHistorySelect = (entry: FindHistoryEntry) => {
    onQueryChange(entry.query);
    onReplacementChange(entry.replaced ? entry.replacement : "");
    setHistoryOpen(false);
    queryInputRef.current?.focus();
    queryInputRef.current?.select();
  };
  const handleSwap = () => {
    if (query === "" && replacement === "") return;
    onQueryChange(replacement);
    onReplacementChange(query);
    setSwapFlipped((flipped) => !flipped);
    queryInputRef.current?.focus();
  };
  const handleHistoryItemKeyDown = (event: ReactKeyboardEvent, entry: FindHistoryEntry) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleHistorySelect(entry);
    }
  };

  return (
    <div
      ref={barRef}
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
          // Esc 分层：先关历史面板，面板已关才关闭查找条。
          if (historyOpen) setHistoryOpen(false);
          else onClose();
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
              if (event.shiftKey) navigate(onPrev);
              else navigate(onNext);
            }
          }}
        />
        <span className={`find-replace-count${hasMatch ? "" : " empty"}`} role="status">
          {countText}
        </span>
        <button
          type="button"
          className={`find-replace-btn${historyOpen ? " active" : ""}`}
          title={t("common.findHistory")}
          aria-label={t("common.findHistory")}
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          {Icons.recent}
        </button>
        <button
          type="button"
          className="find-replace-btn"
          title={t("common.findPrev")}
          aria-label={t("common.findPrev")}
          disabled={!hasMatch}
          onClick={() => navigate(onPrev)}
        >
          {Icons.chevronUp}
        </button>
        <button
          type="button"
          className="find-replace-btn"
          title={t("common.findNext")}
          aria-label={t("common.findNext")}
          disabled={!hasMatch}
          onClick={() => navigate(onNext)}
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
              replaceWithRecord(onReplaceCurrent);
            }
          }}
        />
        <button
          type="button"
          className="find-replace-btn find-replace-submit"
          disabled={!hasMatch}
          onClick={() => replaceWithRecord(onReplaceCurrent)}
        >
          {t("common.replaceCurrent")}
        </button>
        <button
          type="button"
          className="find-replace-btn find-replace-submit"
          disabled={!hasMatch}
          onClick={() => replaceWithRecord(onReplaceAll)}
        >
          {t("common.replaceAll")}
        </button>
      </div>
      <button
        type="button"
        className={`find-replace-swap${swapFlipped ? " swap-flip" : ""}`}
        title={t("common.swapFindReplace")}
        aria-label={t("common.swapFindReplace")}
        disabled={query === "" && replacement === ""}
        onClick={handleSwap}
      >
        {Icons.swap}
      </button>
      {historyOpen && (
        <div className="find-replace-history-pop" role="listbox" aria-label={t("common.findHistory")}>
          <div className="find-replace-history-head">
            <span>{t("common.findHistory")}</span>
            <button
              type="button"
              className="find-replace-history-clear"
              disabled={history.length === 0}
              onClick={clearHistory}
            >
              {t("common.clearFindHistory")}
            </button>
          </div>
          <div className="find-replace-history-list">
            {history.length === 0 ? (
              <div className="find-replace-history-empty">{t("common.findHistoryEmpty")}</div>
            ) : (
              history.map((entry) => (
                <div
                  key={entry.query}
                  role="option"
                  aria-selected={false}
                  tabIndex={0}
                  className="find-replace-history-item"
                  onClick={() => handleHistorySelect(entry)}
                  onKeyDown={(event) => handleHistoryItemKeyDown(event, entry)}
                >
                  <span className="find-replace-history-q" title={entry.query}>
                    {entry.query}
                  </span>
                  {entry.replaced && (
                    <>
                      <span className="find-replace-history-arrow">→</span>
                      <span className="find-replace-history-r" title={entry.replacement}>
                        {entry.replacement === "" ? (
                          <span className="find-replace-history-empty-val">
                            {t("common.findHistoryEmptyValue")}
                          </span>
                        ) : (
                          entry.replacement
                        )}
                      </span>
                    </>
                  )}
                  <span className="find-replace-history-badge">
                    {entry.replaced
                      ? t("common.findHistoryReplaced")
                      : t("common.findHistorySearched")}
                  </span>
                  <button
                    type="button"
                    className="find-replace-history-del"
                    title={t("common.deleteFindHistoryEntry")}
                    aria-label={t("common.deleteFindHistoryEntry")}
                    onClick={(event) => {
                      event.stopPropagation();
                      removeEntry(entry.query);
                    }}
                  >
                    {Icons.close}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
