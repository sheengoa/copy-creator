import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

interface PasteBackendStatus {
  session: "wayland" | "x11" | "none";
  ydotoolInstalled: boolean;
  ydotooldInstalled: boolean;
  ydotooldRunning: boolean;
  wtypeInstalled: boolean;
  xdotoolInstalled: boolean;
}

// 判定口径与 Rust paste 路径一致（Wayland: ydotool → wtype → enigo；
// X11: enigo → xdotool）。session 为 "none"（非 Linux 或无显示会话）时
// 整卡隐藏。
function pasteStatusKey(status: PasteBackendStatus): string {
  if (status.session === "wayland") {
    if (status.ydotoolInstalled && status.ydotooldRunning) return "settings.pasteWaylandReady";
    if (status.ydotoolInstalled) return "settings.pasteYdotooldNotRunning";
    if (status.wtypeInstalled) return "settings.pasteWtypeLimited";
    return "settings.pasteNeedYdotool";
  }
  if (status.session === "x11") {
    return status.xdotoolInstalled ? "settings.pasteX11Ready" : "settings.pasteX11SuggestXdotool";
  }
  return "settings.pasteNeedYdotool";
}

// Linux 粘贴注入依赖外部工具链（Wayland 尤甚），这是用户最能感知的
// 「粘贴不工作」根因。设置页显式呈现会话、后端可用性与安装指引，
// 替代只在启动时弹一次的系统通知。
export function PasteEnvironmentSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PasteBackendStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<PasteBackendStatus>("get_paste_backend_status")
      .then((next) => {
        if (!cancelled && next.session !== "none") setStatus(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return null;

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.pasteEnvSection")}</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.pasteSessionLabel")}</div>
          <span className="paste-env-session">{status.session === "wayland" ? "Wayland" : "X11"}</span>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.pasteBackendLabel")}</div>
          <span className="paste-env-status">{t(pasteStatusKey(status))}</span>
        </div>
        {status.session === "wayland" && !status.ydotooldRunning && (
          <>
            <div className="settings-row-hint">{t("settings.pasteInstallHint")}</div>
            <div className="settings-row-hint paste-env-command">
              <code>sudo apt install ydotool</code>
              <code>sudo systemctl enable --now ydotoold</code>
            </div>
          </>
        )}
        {status.session === "x11" && !status.xdotoolInstalled && (
          <div className="settings-row-hint paste-env-command">
            <code>sudo apt install xdotool</code>
          </div>
        )}
      </div>
    </div>
  );
}
