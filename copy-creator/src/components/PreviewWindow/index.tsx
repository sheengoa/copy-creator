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
 * 渲染对应内容；ESC 隐藏窗口，系统关闭按钮由 Rust 侧按隐藏处理。
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

  if (loadError) {
    return (
      <div className="preview-window-error" role="alert">{String(loadError)}</div>
    );
  }

  if (!payload) {
    return <div className="preview-window-empty" aria-hidden="true" />;
  }

  const segments = Array.isArray(payload.segments) ? payload.segments : null;

  return (
    <div className="preview-window-root">
      <ContentPreviewPanel segments={segments} className="" ariaLabel={payload.title || t("radialMenu.previewTitle")} />
    </div>
  );
}
