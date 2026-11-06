// 工程画布布局：世界常量 + 切线几何 + 确定性自动布局（自 ProjectCanvas.tsx
// 零改动搬运，2026-11-03 引擎拆分阶段 11a；fork 对齐点按原注释保持）。

import type { ProjectAsset, ProjectScene, ProjectShot } from "../../../stores/projectStore";
import type { CanvasCard, CanvasFrame, CanvasLayout, CardAsset, Pos } from "./types";

// ── 布局常量（世界像素） ──────────────────────────────────────
// 节点默认宽统一 208（2026-11-06 用户定案「默认尺寸不能有的很大有的
// 非常小」）：资料/镜头/片段/剧本纸片/提示词纸片/成片输出同宽，高度
// 按内容分化（图框 16:9 节奏：资料预览 190×109、片段缩略 192×108）。
export const FRAME_MIN_W = 340;
export const FRAME_MIN_H = 260;
export const FRAME_PAD_X = 32;
export const FRAME_PAD_TOP = 60;
export const FRAME_PAD_BOTTOM = 32;
export const CARD_GAP = 24;
export const CARD_W = 208; // 镜头卡宽（统一默认宽）
export const CARD_HEAD_H = 44; // 卡头（镜头号 + 描述）
export const THUMB_W = 95; // 卡内素材缩略宽（两列铺满 208 内宽）
export const THUMB_RATIO = 0.68;
export const THUMB_GAP = 8;
export const INFO_W = 208; // 资料卡宽（角色/场景/道具/组/占位，统一默认宽）
export const INFO_H = 180; // 含标题条 + 接口行 + 预览卡（接口行内移后增高的估算值）
export const SCRIPT_W = 208; // 剧本/提示词纸片宽（统一默认宽）
export const WORLD_MARGIN = 60;
/** 连线层视口外沿的世界余量（把可见区外一点的线也画进来，避免边缘裁切）。 */
export const WIRES_VIEWPORT_PAD = 64;
export const MINI_W = 150;
export const MINI_H = 96;
export const OUTPUT_W = 208; // 成片输出节点（每集工作流的总输出口，统一默认宽）
export const OUTPUT_H = 72;
export const SEG_W = 208; // 片段节点（AI 分段生成的视频分段）
export const SEG_H = 108;

// 线段相交（同横坐标单调判定，经典叉积法）——切线的扫过判定用。
export const segsIntersect = (
  a1: { x: number; y: number }, a2: { x: number; y: number },
  b1: { x: number; y: number }, b2: { x: number; y: number },
): boolean => {
  const d = (b1.x - a1.x) * (a2.y - a1.y) - (b1.y - a1.y) * (a2.x - a1.x);
  const e = (b2.x - a1.x) * (a2.y - a1.y) - (b2.y - a1.y) * (a2.x - a1.x);
  const f = (b2.x - b1.x) * (a2.y - a1.y) - (b2.y - b1.y) * (a2.x - a1.x);
  const g = (a1.x - b1.x) * (b2.y - b1.y) - (a1.y - b1.y) * (b2.x - b1.x);
  return d * e < 0 && f * g < 0;
};
// 轨迹段到点的最短距离（刀刃擦过采样点也算切到）。
export const distToSeg = (
  p: { x: number; y: number },
  a1: { x: number; y: number }, a2: { x: number; y: number },
): number => {
  const dx = a2.x - a1.x;
  const dy = a2.y - a1.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a1.x) * dx + (p.y - a1.y) * dy) / len2));
  const ex = p.x - (a1.x + t * dx);
  const ey = p.y - (a1.y + t * dy);
  return Math.hypot(ex, ey);
};
// 切割线段是否命中折线（连线按贝塞尔采样后的屏幕坐标点列）。
// 叉积法对「恰好穿过采样顶点」的零面积相交会漏判，补 2px 触碰判定：
// 刀刃扫到即断，符合 knife 手势直觉。
export const CUT_TOUCH_PX = 2;
export const segHitsPolyline = (
  a1: { x: number; y: number }, a2: { x: number; y: number },
  pts: { x: number; y: number }[],
): boolean => {
  for (let i = 0; i < pts.length; i++) {
    if (distToSeg(pts[i], a1, a2) < CUT_TOUCH_PX) return true;
  }
  for (let i = 1; i < pts.length; i++) {
    if (segsIntersect(a1, a2, pts[i - 1], pts[i])) return true;
  }
  return false;
};

/** ComfyUI 风格连线：直接接收两端端口点（输出在节点右缘、输入在左缘），
 *  控制点沿水平方向延伸两点距离的 1/4，任意角度都是平滑弯出的贝塞尔，
 *  不存在直线或拐角形态。 */
export function wirePathD(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const offset = Math.hypot(b.x - a.x, b.y - a.y) * 0.25;
  return `M ${a.x} ${a.y} C ${a.x + offset} ${a.y}, ${b.x - offset} ${b.y}, ${b.x} ${b.y}`;
}

/** 输入端口列的垂直比例：第 i 口（0 起）位于节点高度的 (i+1)/(n+1) 处
 *  （ComfyUI 槽位分布），单口即中点。 */
export function portRatio(index: number, count: number): number {
  return (index + 1) / (count + 1);
}

/** 镜头卡尺寸：卡头 + 素材两列网格（空镜头为挂靠占位高度）。 */
export function shotCardSize(shot: ProjectShot): { w: number; h: number } {
  const rows = Math.ceil(shot.assets.length / 2);
  const gridH = shot.assets.length
    ? rows * (THUMB_W * THUMB_RATIO + THUMB_GAP) + 10
    : 64;
  return { w: CARD_W, h: CARD_HEAD_H + gridH };
}

/** 确定性自动布局：已摆放的镜头卡/散件用存储坐标；未摆放的按场景
 *  横排 + 框内网格补位（跳过已占用格位，避免新卡叠在旧卡下）。 */
export function buildLayout(
  scenes: ProjectScene[],
): Omit<CanvasLayout, "infoFramePos"> {
  const cardPos: Record<string, Pos> = {};
  const cards: CanvasCard[] = [];
  const frames: CanvasFrame[] = [];
  // 世界宽度基线 1500：默认模板的片段占位横排（约 1000 宽）+ 片段列 +
  // 成片节点都要落在正坐标内，首开视口即完整可见。
  let worldW = 1500;
  let worldH = 900;
  // 场景框默认位置：按上一帧右缘顺序累计（固定间距会让变宽的框互相
  // 重叠）；用户摆过的场景用存储坐标，但游标仍吸收其占位。
  const framePos: Record<string, Pos> = {};
  let sceneCursorX = WORLD_MARGIN;

  scenes.forEach((scene) => {
    const fx = scene.canvas_x ?? sceneCursorX;
    const fy = scene.canvas_y ?? 110;
    const sceneCards: CanvasCard[] = [];
    const occupied = new Set<string>(); // 已摆放卡占用的网格格位
    const CELL_W = CARD_W + CARD_GAP;
    const cellKey = (col: number, row: number) => `${col}:${row}`;

    scene.shots.forEach((shot) => {
      const size = shotCardSize(shot);
      const fixed =
        shot.canvas_x != null && shot.canvas_y != null
          ? { x: shot.canvas_x, y: shot.canvas_y }
          : null;
      if (fixed) {
        cardPos[shot.id] = fixed;
        // 反推占用格位（以框原点为网格原点）。
        const col = Math.round((fixed.x - fx - FRAME_PAD_X) / CELL_W);
        const row = Math.round((fixed.y - fy - FRAME_PAD_TOP) / CELL_W);
        for (let dc = -1; dc <= 1; dc++) {
          for (let dr = -1; dr <= 1; dr++) occupied.add(cellKey(col + dc, row + dr));
        }
      }
      const assets: CardAsset[] = shot.assets.map((asset) => {
        const w = THUMB_W;
        return { asset, w, h: Math.round(w * THUMB_RATIO) };
      });
      sceneCards.push({ key: `shot:${shot.id}`, shot, sceneId: scene.id, w: size.w, h: size.h, assets });
    });

    // 未摆放卡按网格找空位（3 列，跳过占用）。
    let col = 0;
    let row = 0;
    sceneCards.forEach((card) => {
      if (cardPos[card.shot.id]) return;
      while (occupied.has(cellKey(col, row))) {
        col += 1;
        if (col === 3) {
          col = 0;
          row += 1;
        }
      }
      cardPos[card.shot.id] = { x: fx + FRAME_PAD_X + col * CELL_W, y: fy + FRAME_PAD_TOP + row * CELL_W };
      occupied.add(cellKey(col, row));
      const colNext = col + 1;
      if (colNext === 3) {
        col = 0;
        row += 1;
      } else {
        col = colNext;
      }
    });

    sceneCards.forEach((card) => {
      const pos = cardPos[card.shot.id];
      card.w = CARD_W;
      card.h = shotCardSize(card.shot).h;
      void pos;
    });
    cards.push(...sceneCards);

    const maxX = Math.max(
      fx + FRAME_MIN_W,
      ...sceneCards.map((c) => cardPos[c.shot.id].x + c.w),
    );
    const maxY = Math.max(
      fy + FRAME_MIN_H,
      ...sceneCards.map((c) => cardPos[c.shot.id].y + c.h),
    );
    frames.push({
      id: scene.id, scene, label: scene.heading || "",
      w: maxX - fx, h: maxY - fy,
    });
    framePos[scene.id] = { x: fx, y: fy };
    sceneCursorX = Math.max(sceneCursorX, maxX + 80);
    worldW = Math.max(worldW, maxX + 60);
    worldH = Math.max(worldH, maxY + 60);
  });

  // 集级散件已不再上画布（素材节点整体移除）：场景框之外只有资料框与
  // 片段列，世界尺寸按场景框推导。
  let scenesMaxY = 0;
  scenes.forEach((scene) => {
    const fy = scene.canvas_y ?? 110;
    const frame = frames.find((f) => f.id === scene.id);
    scenesMaxY = Math.max(scenesMaxY, fy + (frame?.h ?? 0));
  });
  worldW = Math.max(worldW, WORLD_MARGIN + 60);
  worldH = Math.max(worldH, scenesMaxY + 60);

  return { cards, infos: [], frames, cardPos, framePos, worldW, worldH };
}

/** 本集镜头挂靠的全部素材（散件不上画布，仅用于成片来源显示等回退）。 */
export function allAssetsOf(scenes: ProjectScene[]): ProjectAsset[] {
  const list: ProjectAsset[] = [];
  scenes.forEach((scene) => scene.shots.forEach((shot) => list.push(...shot.assets)));
  return list;
}
