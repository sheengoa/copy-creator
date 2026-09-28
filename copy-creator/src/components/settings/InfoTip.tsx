import { useTranslation } from "react-i18next";

// 设置行尾的 ⓘ 信息图标：完整说明收进悬停气泡（原生 title），页面只保留
// 控件本身。键盘可达：可聚焦，聚焦即显示同款气泡文本（aria-label）。
export function InfoTip({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <span
      className="settings-info-tip"
      title={text}
      aria-label={`${t("common.moreInfo")}: ${text}`}
      role="note"
      tabIndex={0}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    </span>
  );
}
