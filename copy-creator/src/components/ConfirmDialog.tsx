import { useTranslation } from "react-i18next";

export interface ConfirmDialogState {
  message: string;
  onConfirm: () => void | Promise<void>;
}

interface ConfirmDialogProps extends ConfirmDialogState {
  onCancel: () => void;
}

// 页面级确认对话框的统一实现：剪贴板、快捷输入、资源区原先各有一份
// 相同结构的内联 dialog-overlay + 取消/确认按钮。确认后先关闭再执行，
// 避免执行耗时长时确认框滞留。
export function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog-content" onClick={(event) => event.stopPropagation()}>
        <h3 className="dialog-title">{t("common.confirm")}</h3>
        <p className="dialog-message">{message}</p>
        <div className="dialog-actions">
          <button type="button" className="dialog-btn secondary" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="dialog-btn save"
            onClick={() => {
              onCancel();
              void onConfirm();
            }}
          >
            {t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
