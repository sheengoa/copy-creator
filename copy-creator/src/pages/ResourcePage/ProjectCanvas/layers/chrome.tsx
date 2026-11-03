// 工程画布视口 chrome：缩放条 + 迷你地图（自 ProjectCanvas.tsx 渲染区
// 零改动搬运，2026-11-03 引擎拆分阶段 11c；fork 对齐点按原注释保持）。
import { Icons } from "../../../../components/Icons";
import { useTranslation } from "react-i18next";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ProjectScene } from "../../../../stores/projectStore";
import { FRAME_MIN_H, FRAME_MIN_W, MINI_H, MINI_W, shotCardSize } from "../layout";
import type { CanvasLayout, Pos, PosMap } from "../types";

type ViewState = { x: number; y: number; scale: number };

/** 缩放条：缩小 / 百分比 / 放大 / 适配。 */
export function ZoomBar({
  view, zoomAt, fitAll, vpRef,
}: {
  view: ViewState;
  zoomAt(mx: number, my: number, factor: number): void;
  fitAll(): void;
  vpRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  return (
<div className="pc-glass pc-zoombar">
  <button
    type="button"
    data-tooltip={t("project.canvas.zoomOut")}
    onClick={() => {
      const rect = vpRef.current?.getBoundingClientRect();
      if (rect) zoomAt(rect.width / 2, rect.height / 2, 1 / 1.2);
    }}
  >
    <span aria-hidden="true">−</span>
  </button>
  <span className="pc-zpct">{Math.round(view.scale * 100)}%</span>
  <button
    type="button"
    data-tooltip={t("project.canvas.zoomIn")}
    onClick={() => {
      const rect = vpRef.current?.getBoundingClientRect();
      if (rect) zoomAt(rect.width / 2, rect.height / 2, 1.2);
    }}
  >
    <span aria-hidden="true">+</span>
  </button>
  <span className="pc-sep" />
  <button type="button" data-tooltip={t("project.canvas.fit")} onClick={fitAll}>
    {Icons.expand}
  </button>
</div>
  );
}

/** 迷你地图：场景框虚线矩形 + 镜头卡实体矩形 + 视口矩形，点击跳转。 */
export function MiniMap({
  scenes, scenePos, layout, pos, view, vpSize, vpRef, setView, saveView,
}: {
  scenes: ProjectScene[];
  scenePos: Record<string, Pos>;
  layout: Omit<CanvasLayout, "infoFramePos">;
  pos: PosMap;
  view: ViewState;
  vpSize: { w: number; h: number } | null;
  vpRef: RefObject<HTMLDivElement | null>;
  setView: Dispatch<SetStateAction<ViewState>>;
  saveView(next: ViewState): void;
}) {
  const { t } = useTranslation();
  const miniRatio = Math.min(
    MINI_W / Math.max(layout.worldW, 1),
    MINI_H / Math.max(layout.worldH + 320, 1),
  );
  return (
<div className="pc-glass pc-minimap" data-tooltip={t("project.canvas.minimap")}>
  <svg
    width={MINI_W}
    height={MINI_H}
    viewBox={`0 0 ${MINI_W} ${MINI_H}`}
    onPointerDown={(e) => {
      e.stopPropagation();
      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
      const wx = (e.clientX - rect.left) / miniRatio;
      const wy = (e.clientY - rect.top) / miniRatio;
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
    {scenes.map((scene) => {
      const spos = scenePos[scene.id];
      if (!spos) return null;
      return (
        <rect
          key={scene.id}
          x={spos.x * miniRatio}
          y={spos.y * miniRatio}
          width={FRAME_MIN_W * miniRatio}
          height={FRAME_MIN_H * miniRatio}
          rx="3"
          fill="none"
          stroke="var(--text-tertiary)"
          strokeDasharray="2,2"
        />
      );
    })}
    {layout.cards.map((card) => {
      const p = pos.cards[card.shot.id];
      if (!p) return null;
      const size = shotCardSize(card.shot);
      return (
        <rect
          key={card.key}
          x={p.x * miniRatio}
          y={p.y * miniRatio}
          width={Math.max(3, size.w * miniRatio)}
          height={Math.max(2.5, size.h * miniRatio)}
          rx="1.5"
          fill="var(--text-tertiary)"
        />
      );
    })}
    <rect
      x={(-view.x / view.scale) * miniRatio}
      y={(-view.y / view.scale) * miniRatio}
      width={((vpSize?.w ?? 1200) / view.scale) * miniRatio}
      height={((vpSize?.h ?? 700) / view.scale) * miniRatio}
      fill="rgba(127,127,140,.1)"
      stroke="var(--text-primary)"
      strokeWidth="1.2"
      rx="4"
    />
  </svg>
</div>
  );
}
