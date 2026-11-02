import type { ReactNode } from "react";
import type { CanvasNode } from "../../../stores/canvasStore";
import type { RefObject } from "react";
import type { CanvasConnection } from "../../../stores/canvasStore";
import { NODE_DEFS } from "../nodes/registry";
import { NodeShell } from "../nodes/shell";
import { nodeSize } from "../engine/wireGeom";
import type { NodeServices } from "../nodes/types";

// 节点层（自 FreeCanvas.tsx 渲染区零改动搬运，2026-11-03 引擎拆分阶段
// 6c）。全部 22 种类型经注册表 def.Component 分发（新增节点 = 写一个
// Body 模块 + def 登记，此处无类型分支）。

export function NodesLayer({
  nodes,
  selKeys,
  pulseKeys,
  scale,
  canvasServices,
  nodesRef,
  connectionsRef,
  deleteNodes,
}: {
  nodes: CanvasNode[];
  selKeys: string[];
  pulseKeys: string[];
  scale: number;
  canvasServices: NodeServices;
  nodesRef: RefObject<CanvasNode[]>;
  connectionsRef: RefObject<CanvasConnection[]>;
  deleteNodes(nodesRef: RefObject<CanvasNode[]>, connectionsRef: RefObject<CanvasConnection[]>, ids: string[]): Promise<void>;
}) {
  return (
    <>
    {nodes.map((node) => {
      const selected = selKeys.includes(node.id);
      const size = nodeSize(node);
      const Body = NODE_DEFS[node.type].Component;
      const body: ReactNode = (
        <Body
          node={node}
          selected={selected}
          pulsing={pulseKeys.includes(node.id)}
          autoHeight={node.height == null}
          scale={scale}
          services={canvasServices}
        />
      );

      return (
        <NodeShell
          key={node.id}
          def={NODE_DEFS[node.type]}
          node={node}
          selected={selected}
          pulsing={pulseKeys.includes(node.id)}
          size={size}
          onDelete={(id) => void deleteNodes(nodesRef, connectionsRef, [id])}
        >
          {body}
        </NodeShell>
      );
    })}
    </>
  );
}
