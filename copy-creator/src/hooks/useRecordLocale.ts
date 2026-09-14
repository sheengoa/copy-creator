import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { RecordLocaleText } from "../domain/records";

/** domain 视图组装（buildRecordView / getResourceTitle / getResourceSummary）
 *  的 i18n 兜底文案：图片占位与文本/链接兜底标题，随界面语言切换。 */
export function useRecordLocale(): RecordLocaleText {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      imagePlaceholder: t("clipboard.image"),
      textFallbackTitle: t("clipboard.textContent"),
      linkFallbackTitle: t("clipboard.linkContent"),
    }),
    [t],
  );
}
