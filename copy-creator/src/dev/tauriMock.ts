// 浏览器验证专用内存后端：invoke 命令分派与插件装配。命令实现按域拆在
// ./mock/commands{Project,Clipboard,CanvasAi}（2026-11-14 拆分，守卫规则 27
// 行数上限——walk 修复后本文件纳入 1000 行守卫）；数据与事件通道见
// ./mock/db，媒体合成与 AI 生成模拟见 ./mock/media；页面不在 Tauri 环境
// 运行（无 __TAURI_INTERNALS__）时由 main.tsx 动态注入本模块。

import {
  loadCanvasDbFromStorage,
  mockEmit,
  mockEventEntries,
  mockEventListeners,
  MOCK_NOT_HANDLED,
  nextMockEventId,
  saveCanvasDbToStorage,
  type MockEventListener,
} from "./mock/db";
import { handleCanvasAiCommands } from "./mock/commandsCanvasAi";
import { handleClipboardCommands } from "./mock/commandsClipboard";
import { handleProjectCommands } from "./mock/commandsProject";

function handleInvoke(cmd: string, args: Record<string, unknown>): unknown {
  // 三个域模块依次认领（命令名互不重叠，先后无语义）；全部未认领走
  // 兜底——plugin: 命令静默、list_/get_ 前缀回空数组、其余提示后回 null。
  for (const handler of [handleProjectCommands, handleClipboardCommands, handleCanvasAiCommands]) {
    const result = handler(cmd, args);
    if (result !== MOCK_NOT_HANDLED) return result;
  }
  if (cmd.startsWith("plugin:")) return null;
  if (/^(list_|get_[a-z_]*groups|get_[a-z_]*records|get_[a-z_]*phrases)/.test(cmd)) return [];
  console.info("[tauriMock] 未模拟的命令:", cmd, args);
  return null;
}

/** 注入内存后端：伪装 __TAURI_INTERNALS__，并预置工程视图的定位键，
 *  使浏览器直接打开 http://localhost:5173 即落在工程画布。 */
export function installBrowserMock(): void {
  const callbacks = new Map<number, (...args: unknown[]) => void>();
  let callbackSeq = 1;
  let eventSeq = 1;

  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: (callback: (...args: unknown[]) => void) => {
      const id = callbackSeq++;
      callbacks.set(id, callback);
      return id;
    },
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      try {
        // 事件插件命令：listen 把 handler 回调登记进 mockEventListeners，
        // 供 mockEmit 广播；unlisten 按 eventId 真正摘除。
        if (cmd === "plugin:event|listen") {
          const cb = callbacks.get(Number(args?.handler));
          if (cb && typeof args?.event === "string") {
            const entry = { event: args.event, cb: cb as MockEventListener };
            const eventId = nextMockEventId();
            mockEventListeners.push(entry);
            mockEventEntries.set(eventId, entry);
            return Promise.resolve(eventId);
          }
          return Promise.resolve(nextMockEventId());
        }
        if (cmd === "plugin:event|unlisten") {
          const entry = mockEventEntries.get(Number(args?.eventId));
          if (entry) {
            const idx = mockEventListeners.indexOf(entry);
            if (idx >= 0) mockEventListeners.splice(idx, 1);
            mockEventEntries.delete(Number(args?.eventId));
          }
          return Promise.resolve(null);
        }
        const result = handleInvoke(cmd, args ?? {});
        // 画布域落 localStorage：真实后端写 SQLite，mock 内存表刷新即失
        // （曾表现为「自由画布刷新全丢」）。所有 canvas_* 命令统一在此收口。
        if (cmd.startsWith("canvas_")) saveCanvasDbToStorage();
        return Promise.resolve(result);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    plugin: {},
  };
  // @tauri-apps/api/event 的 unlisten 依赖事件插件内部表。
  (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    registerListener: () => eventSeq++,
    unregisterListener: () => {},
  };
  // 测试钩子：允许页面上下文（Playwright 等）广播 mock 事件，例如驱动
  // OS 拖入链路 mockEmit("tauri://drag-drop", { paths, position })。
  (window as unknown as { __TAURI_MOCK_EMIT__?: (event: string, payload: unknown) => void }).__TAURI_MOCK_EMIT__ =
    mockEmit;

  try {
    window.localStorage.setItem("resource_view_mode", "project");
    window.localStorage.setItem("project_current_show", "show-1");
    window.localStorage.setItem("project_current_episode", "ep-1");
  } catch {
    // 存储不可用：仅影响初始定位。
  }
  // 自由画布域恢复：上一次会话的画布/节点/连线（真实后端在 SQLite 里）。
  loadCanvasDbFromStorage();
  console.info("[tauriMock] 已注入浏览器内存后端（仅开发验证用）");
}
