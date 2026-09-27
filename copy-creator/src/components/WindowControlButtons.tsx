import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";

/**
 * 无边框窗口共用的最小化/最大化（还原）按钮，与关闭键 .window-close-btn
 * 同组幽灵钮外观（components.css）；径向菜单为光标处透明弹层，不适用。
 */
export function WindowControlButtons() {
  const { t } = useTranslation();
  const appWindow = getCurrentWindow();

  return (
    <>
      <button
        type="button"
        className="window-min-btn"
        onClick={() => void appWindow.minimize()}
        title={t("common.minimize")}
        aria-label={t("common.minimize")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button
        type="button"
        className="window-max-btn"
        onClick={() => void appWindow.toggleMaximize()}
        title={t("common.maximize")}
        aria-label={t("common.maximize")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      </button>
    </>
  );
}
