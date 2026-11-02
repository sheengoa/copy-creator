import type { CanvasGroup } from "../../../stores/canvasStore";

// 节点分组框层（自 FreeCanvas.tsx 渲染区零改动搬运，2026-11-03 引擎拆分
// 阶段 6c）。Ctrl+G 的组：框自适应成员包围盒，渲染在节点层之下。

export function NodeGroupsLayer({
  groups,
  memberFrame,
}: {
  groups: CanvasGroup[];
  memberFrame(key: string): { x: number; y: number; w: number; h: number } | null;
}) {
  return (
    <>
      {/* memberFrame 由上层以 nodeMetrics 实测缓存实现（手势层维护的
          ref 惯例），本层只消费函数结果，无渲染期 ref 访问。 */}
      {groups.map((group) => {
        const frames = group.members
          .map((key) => memberFrame(key))
          .filter((f): f is { x: number; y: number; w: number; h: number } => f !== null);
        if (frames.length === 0) return null;
        const pad = 14;
        const left = Math.min(...frames.map((f) => f.x)) - pad;
        const top = Math.min(...frames.map((f) => f.y)) - pad - 18;
        const right = Math.max(...frames.map((f) => f.x + f.w)) + pad;
        const bottom = Math.max(...frames.map((f) => f.y + f.h)) + pad;
        return (
          <div
            key={group.id}
            data-group={group.id}
            className="pc-nodegroup"
            style={{ left, top, width: right - left, height: bottom - top }}
          >
            <div className="pc-nodegroup-label">{group.label}</div>
          </div>
        );
      })}
    </>
  );
}
