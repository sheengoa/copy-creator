import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { ContentPreviewPanel } from "../ContentPreviewPanel";
import type { RadialPreviewSegment } from "../../utils/radialPreview";

interface PreviewPayload {
  title: string;
  segments: RadialPreviewSegment[];
}

// 诊断日志：转发到后端日志文件，排查预览窗口的加载时序问题。
const plog = (message: string) => {
  void invoke("debug_log", { message: `[preview-window] ${message}` }).catch(() => {});
};

/**
 * 独立内容预览窗口的根组件：常驻隐藏，收到 preview-content 事件后
 * 渲染对应内容；自绘标题栏支持拖拽移动，ESC 或关闭按钮隐藏窗口
 * （窗口常驻复用，系统层关闭请求由 Rust 侧按隐藏处理）。
 */
export default function PreviewWindow() {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<PreviewPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    plog("root mounted, registering listener");
    invoke<string>("get_setting", { key: "theme" }).then((theme) => {
      if (theme === "dark" || theme === "light") {
        document.documentElement.setAttribute("data-theme", theme);
      }
    }).catch(() => {});

    invoke<string>("get_setting", { key: "language" }).then((lang) => {
      if (lang && lang !== i18n.language) void i18n.changeLanguage(lang);
    }).catch(() => {});

    const unlistenPromise = listen<PreviewPayload>("preview-content", (event) => {
      plog(`preview-content received: title=${event.payload?.title} segments=${Array.isArray(event.payload?.segments) ? event.payload.segments.length : typeof event.payload?.segments}`);
      setPayload(event.payload ?? null);
    });
    unlistenPromise
      .then(() => plog("listener registered"))
      .catch((error) => {
        plog(`listener registration failed: ${String(error)}`);
        setLoadError(String(error));
      });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        void invoke("hide_preview_window").catch(() => {});
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const hideWindow = () => {
    void invoke("hide_preview_window").catch(() => {});
  };

  if (loadError) {
    return (
      <div className="preview-window-root">
        <div className="preview-window-header" data-tauri-drag-region>
          <span className="preview-window-title">{t("radialMenu.previewTitle")}</span>
          <button
            type="button"
            className="preview-window-close-btn"
            onClick={hideWindow}
            aria-label={t("common.close")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="preview-window-error" role="alert">{String(loadError)}</div>
      </div>
    );
  }

  const segments = payload && Array.isArray(payload.segments) ? payload.segments : null;
  const title = payload?.title || t("radialMenu.previewTitle");

  return (
    <div className="preview-window-root">
      <div className="preview-window-header" data-tauri-drag-region>
        <span className="preview-window-title" title={title}>{title}</span>
        <button
          type="button"
          className="preview-window-close-btn"
          onClick={hideWindow}
          aria-label={t("common.close")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="preview-window-body">
        <ContentPreviewPanel segments={segments} className="" ariaLabel={title} />
      </div>
    </div>
  );
}
