import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";

interface ToastItem {
  id: number;
  recordId: string;
  keyPreview: string;
  guess: string | null;
}

let toastCounter = 0;

export default function ApiKeyToast() {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const unlisten = listen<{ record_id: string; key_preview: string; guess: string | null }>(
      "api-key-detected",
      (event) => {
        const { record_id, key_preview, guess } = event.payload;
        const item: ToastItem = {
          id: ++toastCounter,
          recordId: record_id,
          keyPreview: key_preview,
          guess: guess ?? null,
        };
        setToasts((prev) => [...prev, item]);
        // Auto-dismiss after 5s
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== item.id));
        }, 5000);
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="api-toast-container">
      {toasts.map((toast) => (
        <div key={toast.id} className="api-toast">
          <div className="api-toast-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
              <line x1="7" y1="7" x2="7.01" y2="7" />
            </svg>
          </div>
          <div className="api-toast-body">
            <span className="api-toast-title">{t("clipboard.toastTitle")}</span>
            <span className="api-toast-sub">
              {toast.guess
                ? t("clipboard.toastHintLabeled", { guess: toast.guess })
                : t("clipboard.toastHint")}
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
