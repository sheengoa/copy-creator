import { useTranslation } from "react-i18next";
import {
  RADIAL_SCALE_DEFAULT,
  RADIAL_SCALE_MAX,
  RADIAL_SCALE_MIN,
} from "../../stores/settingsStore";

interface RadialSectionProps {
  localRadialMenuScale: number;
  setLocalRadialMenuScale: (scale: number) => void;
}

export function RadialSection({
  localRadialMenuScale,
  setLocalRadialMenuScale,
}: RadialSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.radialSection")}</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.radialMenuSize")}</div>
          <div className="radial-scale-control">
            <input
              type="range"
              className="radial-scale-slider"
              min={RADIAL_SCALE_MIN}
              max={RADIAL_SCALE_MAX}
              step={5}
              value={localRadialMenuScale}
              aria-label={t("settings.radialMenuSize")}
              onChange={(e) => setLocalRadialMenuScale(Number(e.target.value))}
            />
            <span className="radial-scale-value">{localRadialMenuScale}%</span>
            <button
              type="button"
              className="radial-scale-reset"
              disabled={localRadialMenuScale === RADIAL_SCALE_DEFAULT}
              onClick={() => setLocalRadialMenuScale(RADIAL_SCALE_DEFAULT)}
            >
              {t("settings.radialMenuSizeReset")}
            </button>
          </div>
        </div>
        <div className="settings-storage-hint">
          {t("settings.radialMenuSizeHint")}
        </div>
      </div>
    </div>
  );
}
