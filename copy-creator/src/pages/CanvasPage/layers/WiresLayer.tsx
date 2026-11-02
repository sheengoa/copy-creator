import type { CanvasConnection, CanvasNode } from "../../../stores/canvasStore";
import { PORT_DEFS, outMediaColor } from "../nodes/registry";
import type { Pos } from "../engine/gestureTypes";
import { WIRES_VIEWPORT_PAD } from "../engine/gestureTypes";
import { wirePathD } from "../engine/wireGeom";
import type { ViewState } from "../engine/useViewport";

// 连线层与切痕层（自 FreeCanvas.tsx 渲染区零改动搬运，2026-11-03 引擎
// 拆分阶段 6c）。连线为类型化端口语义：锚点取实测端口位，着色按上游
// 节点媒体通道（MEDIA_COLOR 单源）。

/** 连线层（卡片之下）：按视口尺寸渲染 + 平移组换算世界坐标。 */
export function WiresLayer({
  connections,
  nodes,
  view,
  vpSize,
  liftedWire,
  wireDraft,
  outPointOf,
  inPointOf,
}: {
  connections: CanvasConnection[];
  nodes: CanvasNode[];
  view: ViewState;
  vpSize: { w: number; h: number } | null;
  /** 摘线拿着（rewire）中：该连线暂隐藏，收尾时转接或放回。 */
  liftedWire: { connId: string; fromKey: string } | null;
  wireDraft: { d: string; invalid: boolean; color?: string } | null;
  outPointOf(key: string): Pos | null;
  inPointOf(key: string, portId: string): Pos | null;
}) {
  const wiresVis = {
    x: -view.x / view.scale - WIRES_VIEWPORT_PAD,
    y: -view.y / view.scale - WIRES_VIEWPORT_PAD,
    w: ((vpSize?.w ?? 0) || 1600) / view.scale + WIRES_VIEWPORT_PAD * 2,
    h: ((vpSize?.h ?? 0) || 900) / view.scale + WIRES_VIEWPORT_PAD * 2,
  };
  return (
    <svg
      className="pc-wires"
      aria-hidden="true"
      style={{
        left: wiresVis.x,
        top: wiresVis.y,
        width: wiresVis.w,
        height: wiresVis.h,
      }}
    >
      <g transform={`translate(${-wiresVis.x}, ${-wiresVis.y})`}>
        {connections.map((conn) => {
          // 被摘下的线（拿着换目标中）暂时隐藏，收尾时转接或放回。
          if (liftedWire && conn.id === liftedWire.connId) return null;
          const from = nodes.find((n) => n.id === conn.from_node);
          const to = nodes.find((n) => n.id === conn.to_node);
          if (!from || !to) return null;
          const a = outPointOf(from.id);
          const b = inPointOf(to.id, conn.to_port || PORT_DEFS[to.type].ins[0]?.id || "in");
          if (!a || !b) return null;
          const d = wirePathD(a, b);
          return (
            <g key={conn.id} className="pc-wire" data-cut={conn.id}>
              <path className="pc-wire-hit" d={d} />
              <path className="pc-wire-line" d={d} style={{ stroke: outMediaColor(from.type) }} />
            </g>
          );
        })}
        {wireDraft && (
          <path
            className={`pc-wire-temp${wireDraft.invalid ? " invalid" : ""}`}
            d={wireDraft.d}
            style={wireDraft.color ? { stroke: wireDraft.color } : undefined}
          />
        )}
      </g>
    </svg>
  );
}

/** 刀切痕层：视口直下的绝对定位层（pc-world 之后 → 盖在卡片上）。
 *  polyline 由手势层（useCanvasGestures）持 ref 直写 points。 */
export function CutTrailLayer({
  cutTrailUnderRef,
  cutTrailRef,
}: {
  cutTrailUnderRef: React.RefObject<SVGPolylineElement | null>;
  cutTrailRef: React.RefObject<SVGPolylineElement | null>;
}) {
  return (
    <svg className="pc-trailayer" aria-hidden="true">
      <polyline ref={cutTrailUnderRef} className="pc-wire-cut-under" points="" />
      <polyline ref={cutTrailRef} className="pc-wire-cut" points="" />
    </svg>
  );
}
