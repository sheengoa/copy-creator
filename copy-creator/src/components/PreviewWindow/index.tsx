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

/**
 * 独立内容预览窗口的根组件：常驻隐藏，收到 preview-content 事件后
 * 渲染对应内容；ESC 隐藏窗口，系统关闭按钮由 Rust 侧按隐藏处理。
 */
export default function PreviewWindow() {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<PreviewPayload | null>(null);

  useEffect(() => {
    invoke<string>("get_setting", { key: "theme" }).then((theme) => {
      if (theme === "dark" || theme === "light") {
        document.documentElement.setAttribute("data-theme", theme);
      }
    }).catch(() => {});

    invoke<string>("get_setting", { key: "language" }).then((lang) => {
      if (lang && lang !== i18n.language) void i18n.changeLanguage(lang);
    }).catch(() => {});

    const unlistenPromise = listen<PreviewPayload>("preview-content", (event) => {
      setPayload(event.payload);
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

  // 数据变化时同步主题（打开期间设置可能被修改，下次打开前跟随最新值）。
  useEffect(() => {
    if (!payload) return;
    invoke<string>("get_setting", { key: "theme" }).then((theme) => {
      if (theme === "dark" || theme === "light") {
        document.documentElement.setAttribute("data-theme", theme);
      }
    }).catch(() => {});
  }, [payload]);

  if (!payload) {
    return <div className="preview-window-empty" aria-hidden="true" />;
  }

  return (
    <div className="preview-window-root">
      <ContentPreviewPanel segments={payload.segments} className="" ariaLabel={t("radialMenu.previewTitle")} />
    </div>
  );
}
