import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "../stores/settingsStore";
import {
  FIND_HISTORY_SETTING_KEY,
  normalizeFindHistory,
  parseFindHistory,
  recordFindQuery,
  recordReplacement,
  removeFindHistoryEntry,
  type FindHistoryEntry,
} from "../utils/findHistory";

// 跨窗口同步监听的窗口级单例：与窗口同生命周期，不随查找条卸载摘除；
// 事件回调直接写 store（不经持久化 action），不会形成回环。
let historySyncReady = false;

// 本地变更序号：refresh 在途期间若发生本地记录/删除/清空，返回的存储
// 快照已过期（不含这些变更），按序号失配丢弃，避免旧快照回写覆盖新数据。
let mutationSeq = 0;

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
      // 事件携带的是其他窗口持久化时刻的完整列表，比在途 refresh 的存储
      // 快照更新；按变更处理使在途 refresh 失效，避免旧快照回写覆盖。
      mutationSeq += 1;
      useSettingsStore.setState({ findReplaceHistory: normalizeFindHistory(event.payload.entries) });
    });
  }, []);

  return {
    history,
    /** 打开历史面板时调用：从设置 KV 重读最新历史。监听只在查找条
     * 首次挂载后才建立，从未开过查找条的窗口持有的是启动期快照，
     * 打开面板时必须主动拉取，否则展示陈旧列表。 */
    refresh: () => {
      const seqAtIssue = mutationSeq;
      void invoke<string>("get_setting", { key: FIND_HISTORY_SETTING_KEY })
        .then((raw) => {
          if (seqAtIssue !== mutationSeq) return;
          useSettingsStore.setState({ findReplaceHistory: parseFindHistory(raw) });
        })
        .catch((e) => {
          console.error("Failed to refresh find/replace history:", e);
        });
    },
    recordFind: (query: string) => {
      mutationSeq += 1;
      void useSettingsStore.getState().setFindReplaceHistory((prev) => recordFindQuery(prev, query));
    },
    recordReplace: (query: string, replacement: string) => {
      mutationSeq += 1;
      void useSettingsStore
        .getState()
        .setFindReplaceHistory((prev) => recordReplacement(prev, query, replacement));
    },
    removeEntry: (query: string) => {
      mutationSeq += 1;
      void useSettingsStore.getState().setFindReplaceHistory((prev) => removeFindHistoryEntry(prev, query));
    },
    clearHistory: () => {
      mutationSeq += 1;
      void useSettingsStore.getState().setFindReplaceHistory(() => []);
    },
  };
}
