// 「库设置」弹层：受控组件，展示当前库路径并提供切换入口。
// 打开状态与路径数据由容器持有；按钮 ref 由容器传入以支持点外关闭。
import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";

interface ResourceLibrarySettingsProps {
  path: string;
  loading: boolean;
  changing: boolean;
  error: string | null;
  popoverRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onChangePath: () => void;
}

export default function ResourceLibrarySettings({
  path,
  loading,
  changing,
  error,
  popoverRef,
  onClose,
  onChangePath,
}: ResourceLibrarySettingsProps) {
  const { t } = useTranslation();
  return (
    <section
      ref={popoverRef}
      className="resource-settings-popover"
      role="dialog"
      aria-label={t("resources.librarySettings")}
    >
      <div className="resource-settings-header">
        <strong>{t("resources.librarySettings")}</strong>
        <button
          type="button"
          className="resource-icon-button"
          onClick={onClose}
          aria-label={t("common.close")}
          title={t("common.close")}
        >
          {Icons.close}
        </button>
      </div>
      <code className="resource-settings-path" title={path}>
        {loading ? t("common.loading") : path || t("resources.libraryPathError")}
      </code>
      <p className="resource-settings-hint">{t("resources.libraryPathHint")}</p>
      {error && (
        <span className="resource-settings-error" role="alert">
          {error}
        </span>
      )}
      <button
        type="button"
        className="resource-secondary-button"
        onClick={onChangePath}
        disabled={loading || changing}
      >
        {Icons.edit}
        <span>
          {changing ? t("common.saving") : t("resources.changeLibraryPath")}
        </span>
      </button>
    </section>
  );
}
