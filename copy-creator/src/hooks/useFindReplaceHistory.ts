import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "../stores/settingsStore";
import {
  normalizeFindHistory,
  recordFindQuery,
  recordReplacement,
  removeFindHistoryEntry,
  type FindHistoryEntry,
} from "../utils/findHistory";

// 跨窗口同步监听的窗口级单例：与窗口同生命周期，不随查找条卸载摘除；
// 事件回调直接写 store（不经持久化 action），不会形成回环。
let historySyncReady = false;

/**
 * 查找替换历史的读写入口：资源详情页与新建内容窗口共用。挂载即建立
 * 跨窗口同步；记录/删除/清空经 settingsStore 函数式更新并持久化广播。
 * 回调经 getState() 取最新状态，可安全地内联给事件处理器。
 */
export function useFindReplaceHistory() {
  const history = useSettingsStore((state) => state.findReplaceHistory);

  useEffect(() => {
    if (historySyncReady) return;
    historySyncReady = true;
    void listen<{ entries: FindHistoryEntry[] }>("find-replace-history-changed", (event) => {
      useSettingsStore.setState({ findReplaceHistory: normalizeFindHistory(event.payload.entries) });
    });
  }, []);

  return {
    history,
    recordFind: (query: string) => {
      void useSettingsStore.getState().setFindReplaceHistory((prev) => recordFindQuery(prev, query));
    },
    recordReplace: (query: string, replacement: string) => {
      void useSettingsStore
        .getState()
        .setFindReplaceHistory((prev) => recordReplacement(prev, query, replacement));
    },
    removeEntry: (query: string) => {
      void useSettingsStore.getState().setFindReplaceHistory((prev) => removeFindHistoryEntry(prev, query));
    },
    clearHistory: () => {
      void useSettingsStore.getState().setFindReplaceHistory(() => []);
    },
  };
}
