import { useTranslation } from "react-i18next";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { CanvasNode } from "../../../stores/canvasStore";
import { NodeHint } from "../nodes/NodeHint";
import { MINI_H, MINI_W } from "../engine/gestureTypes";
import { nodeSize } from "../engine/wireGeom";
import { contentBBoxOf } from "../engine/useViewport";
import type { ViewState } from "../engine/useViewport";

// 迷你地图（自 FreeCanvas.tsx 渲染区零改动搬运，2026-11-03 引擎拆分阶段
// 6c）。工程画布同款：节点包围盒 + 视口矩形，点击跳转。

export function MiniMap({
  nodes,
  view,
  setView,
  saveView,
  vpSize,
  vpRef,
}: {
  nodes: CanvasNode[];
  view: ViewState;
  setView: Dispatch<SetStateAction<ViewState>>;
  saveView(next: ViewState): void;
  vpSize: { w: number; h: number } | null;
  vpRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const miniBBox = contentBBoxOf(nodes);
  const miniRatio = miniBBox
    ? Math.min(MINI_W / Math.max(miniBBox.w, 1), MINI_H / Math.max(miniBBox.h, 1))
    : 1;
  if (!miniBBox) return null;
  return (
    <NodeHint text={t("project.canvas.minimap")} className="is-minimap">
      <div className="pc-glass pc-minimap">
      <svg
        width={MINI_W}
        height={MINI_H}
        viewBox={`0 0 ${MINI_W} ${MINI_H}`}
        onPointerDown={(e) => {
          e.stopPropagation();
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const wx = (e.clientX - rect.left) / miniRatio + miniBBox.x;
          const wy = (e.clientY - rect.top) / miniRatio + miniBBox.y;
          const vpRect = vpRef.current?.getBoundingClientRect();
          if (!vpRect) return;
          setView((prev) => {
            const next = {
              ...prev,
              x: vpRect.width / 2 - wx * prev.scale,
              y: vpRect.height / 2 - wy * prev.scale,
            };
            saveView(next);
            return next;
          });
        }}
      >
        {nodes.map((node) => {
          const size = nodeSize(node);
          return (
            <rect
              key={node.id}
              x={(node.pos_x - miniBBox.x) * miniRatio}
              y={(node.pos_y - miniBBox.y) * miniRatio}
              width={Math.max(3, size.w * miniRatio)}
              height={Math.max(2.5, size.h * miniRatio)}
              rx="1.5"
              fill="var(--text-tertiary)"
            />
          );
        })}
        <rect
          x={(((-view.x / view.scale) - miniBBox.x) * miniRatio)}
          y={(((-view.y / view.scale) - miniBBox.y) * miniRatio)}
          width={((vpSize?.w ?? 1200) / view.scale) * miniRatio}
          height={((vpSize?.h ?? 700) / view.scale) * miniRatio}
          fill="rgba(127,127,140,.1)"
          stroke="var(--text-primary)"
          strokeWidth="1.2"
          rx="2"
        />
      </svg>
    </div>
    </NodeHint>
  );
}
