import { useCallback, useRef } from "react";
import type { RefObject } from "react";
import type { CanvasConnection, CanvasNode } from "../../../stores/canvasStore";
import { useCanvasStore } from "../../../stores/canvasStore";
import type { UndoAction } from "./gestureTypes";
import { groupSnapshotOf } from "./groupOps";

// 复制 / 粘贴（Ctrl+C/V，自 FreeCanvas.tsx 零改动搬运，2026-11-03 引擎
// 拆分阶段 6b）。对齐工程画布惯例：pastingRef 防重入。

export function useClipboardOps(
  canvasId: string,
  nodesRef: RefObject<CanvasNode[]>,
  connectionsRef: RefObject<CanvasConnection[]>,
  selRef: RefObject<string[]>,
  setSelection: (keys: string[]) => void,
  pushUndo: (action: UndoAction) => void,
) {
  const store = useCanvasStore;
  const clipRef = useRef<{ nodes: CanvasNode[]; wires: { from_node: string; to_node: string; to_port: string }[]; ax: number; ay: number } | null>(null);
  const pastingRef = useRef(false);

  const copySelection = useCallback(() => {
    const members = groupSnapshotOf(selRef, nodesRef, 1);
    if (!members) return;
    const ax = Math.min(...members.map((m) => m.x));
    const ay = Math.min(...members.map((m) => m.y));
    const ids = members.map((m) => m.key);
    const copied = nodesRef.current.filter((n) => ids.includes(n.id));
    const wires = connectionsRef.current
      .filter((c) => ids.includes(c.from_node) && ids.includes(c.to_node))
      .map((c) => ({ from_node: c.from_node, to_node: c.to_node, to_port: c.to_port }));
    if (copied.length) clipRef.current = { nodes: copied, wires, ax, ay };
  }, [connectionsRef, nodesRef, selRef]);

  const pasteClipboard = useCallback(async () => {
    if (pastingRef.current) return;
    pastingRef.current = true;
    try {
      const clip = clipRef.current;
      if (!clip?.nodes.length) return;
      const st = store.getState();
      const idMap = new Map<string, string>();
      const newIds: string[] = [];
      for (const node of clip.nodes) {
        const created = await st.createNode({
          canvasId,
          nodeType: node.type,
          title: node.title,
          posX: node.pos_x - clip.ax + 28,
          posY: node.pos_y - clip.ay + 28,
          width: node.width,
          height: node.height,
          resourcePath: node.resource_path,
          metadata: JSON.stringify(node.metadata),
        });
        if (created) {
          idMap.set(node.id, created.id);
          newIds.push(created.id);
        }
      }
      for (const wire of clip.wires) {
        const from = idMap.get(wire.from_node);
        const to = idMap.get(wire.to_node);
        if (from && to) await st.connect(canvasId, from, to, wire.to_port);
      }
      if (newIds.length) {
        pushUndo({ kind: "create", ids: newIds });
        setSelection(newIds);
      }
    } finally {
      pastingRef.current = false;
    }
  }, [canvasId, pushUndo, setSelection, store]);

  return { copySelection, pasteClipboard };
}
