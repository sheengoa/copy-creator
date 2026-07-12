import { useState, useRef, useCallback } from "react";

/**
 * 快捷键录制 hook —— 封装录制状态和 keydown 处理逻辑。
 * 用于设置页面中多个快捷键的录制（主窗口、径向菜单、新建剪切板输入）。
 */
export function useShortcutRecording() {
  const [shortcut, setShortcut] = useState("");
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const handlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);

  const startRecording = useCallback(() => {
    recordingRef.current = true;
    setRecording(true);
    setShortcut("");

    const cleanup = () => {
      document.removeEventListener("keydown", handler, true);
      handlerRef.current = null;
    };

    const handler = (e: KeyboardEvent) => {
      if (!recordingRef.current) {
        cleanup();
        return;
      }

      if (["Control", "Alt", "Shift", "Meta", "CapsLock", "NumLock", "ScrollLock", "Dead"].includes(e.key)) {
        return;
      }

      if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (e.metaKey) parts.push("Super");

      const code = e.code;
      let keyName: string;
      if (code.startsWith("Key")) {
        keyName = code[3];
      } else if (code.startsWith("Digit")) {
        keyName = code[5];
      } else if (code.startsWith("Numpad")) {
        keyName = "NumPad" + code.substring(6);
      } else {
        keyName = e.key;
        if (keyName === " ") keyName = "Space";
      }
      parts.push(keyName);

      setShortcut(parts.join("+"));
      recordingRef.current = false;
      setRecording(false);
      cleanup();
    };

    handlerRef.current = handler;
    document.addEventListener("keydown", handler, true);
  }, []);

  const stopRecording = useCallback(() => {
    recordingRef.current = false;
    setRecording(false);
    if (handlerRef.current) {
      document.removeEventListener("keydown", handlerRef.current, true);
      handlerRef.current = null;
    }
  }, []);

  return { shortcut, setShortcut, recording, startRecording, stopRecording };
}
