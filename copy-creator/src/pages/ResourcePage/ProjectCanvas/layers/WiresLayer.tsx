// 工程画布连线层：等视口 SVG（自 ProjectCanvas.tsx 渲染区零改动搬运，
// 2026-11-03 引擎拆分阶段 11c；fork 对齐点按原注释保持）。含素材连线、
// 片段输入口连线、占位暂存线、片段→成片聚合线、拖线草稿与成片连线。
// 2026-11-05 数据流指引：每条线上叠加流动光点（stroke-dashoffset 动画，
// path 正向即 from→to 数据方向）与线色同色箭头——「数据从哪来、到哪去」
// 一眼可循；渲染几何与切线/摘线命中层不变。
import type { EpisodeOverview, ProjectNodeLink, ProjectSegment } from "../../../../stores/projectStore";
import type { LiftedWire } from "../engine/useGestures";
import { NODE_ACCENTS, WIRE_TYPE_COLORS } from "../colors";
import { wirePathD } from "../layout";
import type { PendingLink, Pos, WireBox, WireItem } from "../types";

type WireDraftT = { d: string; invalid: boolean; color?: string } | null;
type WiresVis = { x: number; y: number; w: number; h: number };

/** 箭头 marker id：按线色注册（十六进制去 # 即可作稳定 id）。 */
const arrowIdOf = (color: string) => `pc-arrow-${color.replace("#", "")}`;
/** 光点速度档：生成链/产出汇聚快，参考/组成缓，手动线中速。 */
const flowClassOf = (kind: "fast" | "mid" | "slow") =>
  kind === "fast" ? "pc-wire-flow is-fast" : kind === "slow" ? "pc-wire-flow is-slow" : "pc-wire-flow";

/** 连线层（卡片之下）：按视口尺寸渲染 + 平移组换算世界坐标。 */
export function WiresLayer({
  wires, segWires, pendingLinks, liftedWire, wireDraft, outputBox, segments,
  overview, wiresVis, outPointOf, inPointOf, portsOf, nodeWireColorOf,
}: {
  wires: WireItem[];
  segWires: ReadonlyArray<{ key: string; fromKey: string; links: ProjectNodeLink[] }>;
  pendingLinks: PendingLink[];
  liftedWire: LiftedWire | null;
  wireDraft: WireDraftT;
  outputBox: WireBox | null;
  segments: ProjectSegment[];
  overview: EpisodeOverview | null;
  wiresVis: WiresVis;
  outPointOf(key: string): Pos | null;
  inPointOf(key: string, portId?: string): Pos | null;
  portsOf(key: string): { ins: { id: string; label: string; accepts: string[] }[]; out?: { label: string; type: string } };
  nodeWireColorOf(key: string): string | null | undefined;
}) {
  return (
    <>
{/* 连线层（卡片之下）。按视口尺寸渲染 + 平移组换算世界坐标，
    不再铺世界范围的巨型图层（部分 WebView2 GPU 栅格化超限时
    会整层不绘制，表现为连线全不可见）。 */}
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
  {/* 箭头 marker：按线色注册一枚（颜色集合 = 线色表 ∪ 节点类型色 ∪
      兜底灰），线只引用不重复定义。 */}
  <defs>
    {(() => {
      const colors = new Set<string>(["#94a3b8"]);
      Object.values(WIRE_TYPE_COLORS).forEach((c) => colors.add(c));
      Object.values(NODE_ACCENTS).forEach((c) => colors.add(c));
      return [...colors].map((c) => (
        <marker
          key={c}
          id={arrowIdOf(c)}
          viewBox="0 0 10 10"
          refX={8}
          refY={5}
          markerWidth={6.5}
          markerHeight={6.5}
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 z" fill={c} />
        </marker>
      ));
    })()}
  </defs>
  {wires.map((wire) => {
    const a = outPointOf(wire.fromKey);
    const b = inPointOf(wire.toKey);
    if (!a || !b) return null;
    const d = wirePathD(a, b);
    const color = WIRE_TYPE_COLORS[wire.type] ?? "#94a3b8";
    return (
      <g
        key={`${wire.fromKey}->${wire.toKey}`}
        className="pc-wire"
        data-cut={wire.kind === "manual" ? `m:${wire.fromKey}|${wire.toKey}` : undefined}
      >
        <path className="pc-wire-hit" d={d} />
        <path className="pc-wire-line" d={d} style={{ stroke: color }} markerEnd={`url(#${arrowIdOf(color)})`} />
        {/* 流动光点：gen 生成链快、manual 手动线中速 */}
        <path className={flowClassOf(wire.kind === "gen" ? "fast" : "mid")} d={d} style={{ stroke: color }} />
      </g>
    );
  })}
  {/* 片段输入口连线（角色/场景/道具/剧本/素材/片段 → 片段口）。
      组节点的多条成员连线按承载节点去重成一条，删线全断。 */}
  {segWires.map((wire) => {
    // 被摘下的线（拿着换源中）暂时隐藏，收尾时转接或放回。
    if (liftedWire && wire.links.some((l) => liftedWire.rows.some((r) => r.id === l.id))) return null;
    const link = wire.links[0];
    const a = outPointOf(wire.fromKey);
    const b = inPointOf(`segment:${link.to_segment}`, link.to_port);
    if (!a || !b) return null;
    const d = wirePathD(a, b);
    // 线色：资料来源跟片段对应输入口同色（角色粉/场景绿/道具橙），
    // 其余（素材/镜头/片段）按数据类型（图蓝/视频紫）。
    const fromColor = nodeWireColorOf(wire.fromKey);
    const fromType = portsOf(wire.fromKey).out?.type;
    const color = fromColor ?? WIRE_TYPE_COLORS[fromType ?? ""] ?? WIRE_TYPE_COLORS.video;
    return (
      <g key={wire.key} className="pc-wire" data-cut={`s:${link.id}`}>
        <path className="pc-wire-hit" d={d} />
        <path
          className="pc-wire-line"
          d={d}
          style={{ stroke: color, strokeOpacity: 0.55 }}
          markerEnd={`url(#${arrowIdOf(color)})`}
        />
        <path className={flowClassOf("slow")} d={d} style={{ stroke: color }} />
      </g>
    );
  })}
  {/* 占位/剧本纸片 → 片段的暂存线：一律实线（连线无虚线是全局
      视觉约定）；占位线不透明度略高作区分，加载实体后转正为
      正式 node_link 连线。 */}
  {pendingLinks.map((link) => {
    if (liftedWire?.pendings.includes(link)) return null;
    const a = outPointOf(link.fromKey);
    const b = inPointOf(`segment:${link.toSegmentId}`, link.toPort);
    if (!a || !b) return null;
    const d = wirePathD(a, b);
    const fromType = portsOf(link.fromKey).out?.type;
    const solid = link.fromKey.startsWith("script:") || link.fromKey.startsWith("prompt:");
    const color = nodeWireColorOf(link.fromKey) ?? WIRE_TYPE_COLORS[fromType ?? ""] ?? "#94a3b8";
    return (
      <g
        key={`pending-${link.fromKey}-${link.toSegmentId}-${link.toPort}`}
        className="pc-wire"
        data-cut={`p:${link.fromKey}|${link.toSegmentId}|${link.toPort}`}
      >
        <path className="pc-wire-hit" d={d} />
        <path
          className="pc-wire-line"
          d={d}
          style={{
            stroke: color,
            strokeOpacity: solid ? 0.55 : 0.7,
          }}
          markerEnd={`url(#${arrowIdOf(color)})`}
        />
        <path className={flowClassOf("slow")} d={d} style={{ stroke: color }} />
      </g>
    );
  })}
  {/* 片段 → 成片：按拼接序隐式聚合（无需连线数据，恒显示） */}
  {outputBox &&
    segments.map((segment) => {
      const a = outPointOf(`segment:${segment.id}`);
      // 终点 = 实测「成片」输入口（端口在卡内，随卡体尺寸实测）。
      const b = inPointOf("output");
      if (!a || !b) return null;
      const d = wirePathD(a, b);
      const color = WIRE_TYPE_COLORS.video;
      return (
        <g key={`seg-out-${segment.id}`} className="pc-wire">
          <path className="pc-wire-hit" d={d} />
          <path
            className="pc-wire-line"
            d={d}
            style={{ stroke: color, strokeOpacity: 0.55 }}
            markerEnd={`url(#${arrowIdOf(color)})`}
          />
          <path className={flowClassOf("fast")} d={d} style={{ stroke: color }} />
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
  {/* 成片连线：总输出来源 → 成片节点（由 output_asset_id 推导） */}
  {(() => {
    const outputKey = overview?.episode.output_asset_id;
    if (!outputKey || !outputBox) return null;
    const a = outPointOf(outputKey.startsWith("shot:") ? outputKey : `asset:${outputKey}`);
    const b = inPointOf("output");
    if (!a || !b) return null;
    const d = wirePathD(a, b);
    const color = WIRE_TYPE_COLORS.video;
    return (
      <g className="pc-wire" data-cut="o">
        <path className="pc-wire-hit" d={d} />
        <path
          className="pc-wire-line"
          d={d}
          style={{ stroke: color }}
          markerEnd={`url(#${arrowIdOf(color)})`}
        />
        <path className={flowClassOf("fast")} d={d} style={{ stroke: color }} />
      </g>
    );
  })()}
  </g>
</svg>

    </>
  );
}
