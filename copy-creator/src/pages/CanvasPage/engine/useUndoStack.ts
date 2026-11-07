import { useCallback, useRef } from "react";
import type { RefObject } from "react";
import type { CanvasConnection, CanvasNode } from "../../../stores/canvasStore";
import { useCanvasStore } from "../../../stores/canvasStore";
import { useCanvasData } from "../dataContext";
import { NODE_DEFS } from "../nodes/registry";
import type { UndoAction } from "./gestureTypes";
import { UNDO_LIMIT } from "./gestureTypes";

// 撤销/重做栈与节点删除（自 FreeCanvas.tsx 零改动搬运，2026-11-03 引擎拆分
// 阶段 6b；2026-11-07 补重做栈——Ctrl+Y / Ctrl+Shift+Z，undo⇄redo 往返：
// 撤销把动作转存重做栈，重做正向重放并按当下状态刷新动作快照后转回撤销栈，
// 任何新用户动作入撤销栈即清空重做栈）。对齐工程画布惯例：undoingRef 锁
// 防 StrictMode 双触发。几何读写走 dataContext；genProgress/cancelGeneration
// 是生成运行时层（自由画布专属，工程作用域无生成节点、该分支永不触发），
// 保持直连。

export function useUndoStack(
  setSelection: (keys: string[]) => void,
  nodesRef?: RefObject<CanvasNode[]>,
  connectionsRef?: RefObject<CanvasConnection[]>,
) {
  const data = useCanvasData();
  const undoStackRef = useRef<UndoAction[]>([]);
  const redoStackRef = useRef<UndoAction[]>([]);
  const undoingRef = useRef(false);

  const pushUndo = useCallback((action: UndoAction) => {
    undoStackRef.current.push(action);
    if (undoStackRef.current.length > UNDO_LIMIT) undoStackRef.current.shift();
    // 新动作使既有重做历史失效（线性历史惯例）。
    redoStackRef.current = [];
  }, []);

  /** 撤销后的公共收尾：动作转存重做栈（放锁统一走 finally 下一宏任务）。 */
  const finishUndo = useCallback((action: UndoAction) => {
    redoStackRef.current.push(action);
  }, []);

  /** 撤销（Ctrl+Z）：layout 恢复布局；delete 重建节点/连线；create 移除。 */
  const runUndo = useCallback(() => {
    if (undoingRef.current) return;
    undoingRef.current = true;
    try {
      const action = undoStackRef.current.pop();
      if (!action) return;
      if (action.kind === "layout") {
        data.commitLayout(action.prev);
        finishUndo(action);
        return;
      }
      if (action.kind === "create") {
        for (const id of action.ids) {
          void data.deleteNode(id);
        }
        setSelection([]);
        // 无快照的旧动作重做不了：只撤销、不入重做栈。
        if (action.nodes?.length) finishUndo(action);
        return;
      }
      // delete：重建节点与连线（归一生成中状态），新 id 记进 restoredIds
      // 供重做按它再删（删除重建 id 换代，旧 id 已失联）。
      void (async () => {
        const idMap = new Map<string, string>();
        for (const node of action.nodes) {
          // 删除时仍在生成中的节点，恢复时按 def 归一为终态——后台任务已
          // 随删除取消，留着 generating 会让节点永远转圈（gen_image 归一
          // 为 error「生成已中断」）。
          const restoredMeta =
            NODE_DEFS[node.type].normalizeRestored?.({ ...node.metadata }) ?? { ...node.metadata };
          const created = await data.createNode({
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
          await data.connect(from, to, conn.to_port);
        }
        action.restoredIds = [...idMap.values()];
        setSelection([...idMap.values()]);
        finishUndo(action);
      })();
    } finally {
      // 撤销里的后端动作是异步的，锁放到下一宏任务才放开。
      window.setTimeout(() => {
        undoingRef.current = false;
      }, 0);
    }
  }, [data, finishUndo, setSelection]);

  /** 重做（Ctrl+Y / Ctrl+Shift+Z）：正向重放动作并转回撤销栈。 */
  const runRedo = useCallback(() => {
    if (undoingRef.current) return;
    undoingRef.current = true;
    try {
      const action = redoStackRef.current.pop();
      if (!action) return;
      if (action.kind === "layout") {
        data.commitLayout(action.next);
        undoStackRef.current.push(action);
        return;
      }
      if (action.kind === "create") {
        // 按快照重建；重建 id 换代，回写 ids 让下一次撤销删得到它们。
        const snapshots = action.nodes ?? [];
        void (async () => {
          const newIds: string[] = [];
          for (const node of snapshots) {
            const restoredMeta =
              NODE_DEFS[node.type].normalizeRestored?.({ ...node.metadata }) ?? { ...node.metadata };
            const created = await data.createNode({
              nodeType: node.type,
              title: node.title,
              posX: node.pos_x,
              posY: node.pos_y,
              width: node.width,
              height: node.height,
              resourcePath: node.resource_path,
              metadata: JSON.stringify(restoredMeta),
            });
            if (created) newIds.push(created.id);
          }
          action.ids = newIds;
          setSelection(newIds);
          undoStackRef.current.push(action);
        })();
        return;
      }
      // delete：按撤销重建出的 id 再删一遍；重抓当下快照回填动作，保证
      // 再次撤销用的还是删前真实状态。
      const ids = action.restoredIds ?? [];
      const targets = (nodesRef?.current ?? []).filter((n) => ids.includes(n.id));
      const conns = (connectionsRef?.current ?? [])
        .filter((c) => targets.some((n) => n.id === c.from_node || n.id === c.to_node))
        .map((c) => ({ from_node: c.from_node, to_node: c.to_node, to_port: c.to_port }));
      if (!targets.length) return;
      action.nodes = targets;
      action.connections = conns;
      void (async () => {
        for (const node of targets) {
          const progress = useCanvasStore.getState().genProgress[node.id];
          if (progress) void useCanvasStore.getState().cancelGeneration(progress.requestId);
          await data.deleteNode(node.id);
        }
        setSelection([]);
        undoStackRef.current.push(action);
      })();
    } finally {
      // 同 runUndo：后端动作异步，锁放到下一宏任务才放开。
      window.setTimeout(() => {
        undoingRef.current = false;
      }, 0);
    }
  }, [connectionsRef, data, nodesRef, setSelection]);

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
        const progress = useCanvasStore.getState().genProgress[node.id];
        if (progress) void useCanvasStore.getState().cancelGeneration(progress.requestId);
        await data.deleteNode(node.id);
      }
      setSelection([]);
    },
    [data, pushUndo, setSelection],
  );

  return { pushUndo, runUndo, runRedo, deleteNodes };
}
