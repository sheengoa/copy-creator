import { useEffect, useRef } from "react";

// 窗口从隐藏（托盘/快捷键隐藏）恢复显示时执行回调：兜底隐藏期间可能
// 丢失或被 WebView 节流的刷新事件，保证用户看到窗口时数据是当前的。
// 径向菜单每次显示已自带重载，勿重复接入。
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
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
}
