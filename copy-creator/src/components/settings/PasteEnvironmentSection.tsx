import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

interface PasteBackendStatus {
  session: "windows" | "wayland" | "x11" | "none";
  ydotoolInstalled: boolean;
  ydotooldInstalled: boolean;
  ydotooldRunning: boolean;
  wtypeInstalled: boolean;
  xdotoolInstalled: boolean;
}

// 判定口径与 Rust paste 路径一致（Windows: 系统原生；Wayland: ydotool
// → wtype → enigo；X11: enigo → xdotool）。session 为 "none"（无显示
// 会话）时整卡隐藏。
function pasteStatusKey(status: PasteBackendStatus): string {
  if (status.session === "windows") return "settings.pasteWindowsReady";
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

// 粘贴注入依赖诊断（Linux 工具链 / Windows 原生）。作为「剪切板」区
// 末尾的附属卡渲染（小标题 + 同款卡片样式），不再是独立分区。
export function PasteEnvironmentCard() {
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
    <div className="settings-card">
      <div className="settings-card-subtitle">{t("settings.pasteEnvSection")}</div>
      <div className="settings-row">
        <div className="settings-row-label">{t("settings.pasteSessionLabel")}</div>
        <span className="paste-env-session">
          {status.session === "wayland" ? "Wayland" : status.session === "windows" ? "Windows" : "X11"}
        </span>
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
  );
}
