import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

// 窗口从隐藏（托盘/快捷键隐藏）恢复显示时执行回调：兜底隐藏期间可能
// 丢失或被 WebView 节流的刷新事件，保证用户看到窗口时数据是当前的。
// 径向菜单每次显示已自带重载，勿重复接入。
//
// 重载时机不能依赖 document.visibilitychange：WebKitGTK 在窗口 hide/
// show 时不会触发该事件（探针实测 0 次），因此真正的信号来自后端
// show_main_window 在 window.show() 后广播的 main-window-shown（所有
// 显示路径——快捷键/托盘/IPC/启动——都经该函数）。visibilitychange
// 监听保留给语义正常的平台，两路并发由数据层的加载代数去重。
export function useRefreshOnShow(onShow: () => void) {
  const onShowRef = useRef(onShow);
  useEffect(() => {
    onShowRef.current = onShow;
  }, [onShow]);
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        onShowRef.current();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const unlisten = listen("main-window-shown", () => onShowRef.current());
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void unlisten.then((fn) => fn());
    };
  }, []);
}
