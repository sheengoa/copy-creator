import { useCallback, useRef } from "react";
import type { RefObject } from "react";
import type { CanvasConnection, CanvasNode } from "../../../stores/canvasStore";
import { useCanvasStore } from "../../../stores/canvasStore";
import { NODE_DEFS } from "../nodes/registry";
import type { UndoAction } from "./gestureTypes";
import { UNDO_LIMIT } from "./gestureTypes";

// 撤销栈与节点删除（自 FreeCanvas.tsx 零改动搬运，2026-11-03 引擎拆分
// 阶段 6b）。对齐工程画布惯例：undoingRef 锁防 StrictMode 双触发。

export function useUndoStack(canvasId: string, setSelection: (keys: string[]) => void) {
  const store = useCanvasStore;
  const undoStackRef = useRef<UndoAction[]>([]);
  const undoingRef = useRef(false);

  const pushUndo = useCallback((action: UndoAction) => {
    undoStackRef.current.push(action);
    if (undoStackRef.current.length > UNDO_LIMIT) undoStackRef.current.shift();
  }, []);

  /** 撤销（Ctrl+Z）：layout 恢复布局；delete 重建节点/连线；create 移除。 */
  const runUndo = useCallback(() => {
    if (undoingRef.current) return;
    undoingRef.current = true;
    try {
      const action = undoStackRef.current.pop();
      if (!action) return;
      if (action.kind === "layout") {
        store.getState().commitLayout(canvasId, action.prev);
        return;
      }
      if (action.kind === "create") {
        for (const id of action.ids) {
          void store.getState().deleteNode(id);
        }
        setSelection([]);
        return;
      }
      void (async () => {
        const idMap = new Map<string, string>();
        for (const node of action.nodes) {
          // 删除时仍在生成中的节点，恢复时按 def 归一为终态——后台任务已
          // 随删除取消，留着 generating 会让节点永远转圈（gen_image 归一
          // 为 error「生成已中断」）。
          const restoredMeta =
            NODE_DEFS[node.type].normalizeRestored?.({ ...node.metadata }) ?? { ...node.metadata };
          const created = await store.getState().createNode({
            canvasId,
            nodeType: node.type,
            title: node.title,
            posX: node.pos_x,
            posY: node.pos_y,
            width: node.width,
            height: node.height,
            resourcePath: node.resource_path,
            metadata: JSON.stringify(restoredMeta),
          });
          if (created) idMap.set(node.id, created.id);
        }
        for (const conn of action.connections) {
          const from = idMap.get(conn.from_node) ?? conn.from_node;
          const to = idMap.get(conn.to_node) ?? conn.to_node;
          await store.getState().connect(canvasId, from, to, conn.to_port);
        }
        setSelection([...idMap.values()]);
      })();
    } finally {
      // 撤销里的后端动作是异步的，锁放到下一宏任务才放开。
      window.setTimeout(() => {
        undoingRef.current = false;
      }, 0);
    }
  }, [canvasId, setSelection, store]);

  // ── 删除（可完整恢复，记撤销栈） ─────────────────────────

  const deleteNodes = useCallback(
    async (nodesRef: RefObject<CanvasNode[]>, connectionsRef: RefObject<CanvasConnection[]>, ids: string[]) => {
      if (!ids.length) return;
      const targets = nodesRef.current.filter((n) => ids.includes(n.id));
      const conns = connectionsRef.current
        .filter((c) => targets.some((n) => n.id === c.from_node || n.id === c.to_node))
        .map((c) => ({ from_node: c.from_node, to_node: c.to_node, to_port: c.to_port }));
      if (targets.length) {
        pushUndo({ kind: "delete", nodes: targets, connections: conns });
      }
      for (const node of targets) {
        // 生成中的节点先取消后端任务再删：否则孤儿请求继续跑完。
        const progress = store.getState().genProgress[node.id];
        if (progress) void store.getState().cancelGeneration(progress.requestId);
        await store.getState().deleteNode(node.id);
      }
      setSelection([]);
    },
    [pushUndo, setSelection, store],
  );

  return { pushUndo, runUndo, deleteNodes };
}
