import { useTranslation } from "react-i18next";

/** 「最多使用」模式的次数徽标：剪切板 / 资源 / 快捷输入卡片与径向菜单共用。 */
export function UsageCountBadge({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <span className="usage-count-badge">
      {t("common.usageCount", { count })}
    </span>
  );
}
