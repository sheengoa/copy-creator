import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";

type ShortcutAction = "main" | "radial" | "clipboard_create";

interface FailurePayload {
  action: ShortcutAction;
  key: string;
}

interface ToastItem extends FailurePayload {
  id: number;
}

let toastCounter = 0;

const actionLabelKey: Record<ShortcutAction, string> = {
  main: "settings.windowShortcut",
  radial: "settings.radialShortcut",
  clipboard_create: "settings.clipboardCreateShortcut",
};

// 启动时全局快捷键注册失败（被系统或其他应用占用）仅有日志记录，用户
// 毫无感知；这里在主窗口弹出可关闭的提示。
//
// 时序说明：后端在 setup 阶段记录失败，但该时机与主窗口 webview 挂载互
// 有先后（窗口创建耗时 1-2 秒不定），因此后端不发事件，由前端在挂载后
// 带短重试拉取 take_startup_shortcut_failures（拉取即清空），并在收到
// main-window-shown（后端 setup 完成后必发）时补拉一次，确保不丢。
export default function ShortcutToast() {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addItem = useCallback((payload: FailurePayload) => {
    const item: ToastItem = {
      id: ++toastCounter,
      action: payload.action,
      key: payload.key,
    };
    setToasts((prev) => [...prev, item]);
    // 警示信息比普通 toast 停留更久
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== item.id));
    }, 8000);
  }, []);

  const pull = useCallback(() => {
    invoke<FailurePayload[]>("take_startup_shortcut_failures")
      .then((failures) => {
        failures.forEach(addItem);
      })
      .catch(() => {
        // 后端不可达时静默跳过（提示属尽力而为的附加信息）
      });
  }, [addItem]);

  useEffect(() => {
    let cancelled = false;
    const pullOnce = async (delay: number) => {
      await new Promise((r) => setTimeout(r, delay));
      if (cancelled) return false;
      try {
        const failures = await invoke<FailurePayload[]>(
          "take_startup_shortcut_failures",
        );
        failures.forEach(addItem);
        return failures.length > 0;
      } catch {
        return true; // 后端不可达，停止重试
      }
    };
    void (async () => {
      // setup 的注册块可能晚于本次挂载（其前置的窗口创建各需 1-2 秒），
      // 拉到即停，未拉到按阶梯间隔重试覆盖最慢的启动路径
      for (const delay of [0, 1000, 2500, 5000]) {
        const done = await pullOnce(delay);
        if (cancelled || done) return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addItem]);

  useEffect(() => {
    // main-window-shown 在后端 setup 全部完成（含快捷键注册）之后发出，
    // 此时补拉一次即为确定性的最终兜底
    const unlisten = listen("main-window-shown", () => pull());
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [pull]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="api-toast-container shortcut-toast-container">
      {toasts.map((toast) => (
        <div key={toast.id} className="api-toast" role="alert">
          <div className="api-toast-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div className="api-toast-body">
            <span className="api-toast-title">
              {t("settings.shortcutToastTitle", {
                name: t(actionLabelKey[toast.action]),
                key: toast.key,
              })}
            </span>
            <span className="api-toast-sub">
              {t("settings.shortcutRegistrationFailed")}
            </span>
          </div>
          <button
            className="api-toast-close"
            onClick={() => dismiss(toast.id)}
            type="button"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
