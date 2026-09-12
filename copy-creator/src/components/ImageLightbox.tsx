import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

interface ImageLightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
}

/**
 * 全屏图片灯箱：点击遮罩、右上角按钮或按 ESC 关闭。
 * 主窗口内查看大图的统一出口（剪切板/快捷输入展开图、资源详情页大图）。
 */
export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      ref={containerRef}
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      tabIndex={-1}
      onClick={onClose}
    >
      <button
        type="button"
        className="image-lightbox-close"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        aria-label={t("common.close")}
        title={t("common.close")}
      >
        ×
      </button>
      <img className="image-lightbox-image" src={src} alt={alt} draggable={false} />
    </div>
  );
}
