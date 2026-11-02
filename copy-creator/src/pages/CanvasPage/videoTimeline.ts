/**
 * 视频工具节点时间轴的纯几何/时间换算。
 *
 * 定位换算用「比例法」：指针在轨道矩形内的横向比例 × 总时长——轨道随
 * 画布缩放同比例伸缩，比例天然免疫缩放，无需 /view.scale 换算。
 * 选区一律 { start, duration } 表示，端点拖拽与平移的钳制集中在此，
 * 组件只做手势分发（便于单测）。
 */

/** 选区拖拽的可变时长范围（GIF 0.5–10s；音轨 max 取轨道总时长）。 */
export interface VideoRange {
  start: number;
  duration: number;
}

/** 屏幕点击位置 → 时间秒；越界夹紧到 [0, duration]。 */
export function timeAtClientX(
  clientX: number,
  rect: { left: number; width: number },
  duration: number,
): number {
  if (rect.width <= 0 || !(duration > 0) || !Number.isFinite(clientX)) return 0;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return ratio * duration;
}

/** 选区基础钳制：时长夹进 [min, max]，起点夹进 [0, trackDur - duration]。 */
export function clampRange(
  start: number,
  duration: number,
  min: number,
  max: number,
  trackDur: number,
): VideoRange {
  const dur = Math.min(max, Math.max(min, duration));
  const st = Math.min(trackDur - dur, Math.max(0, start));
  return { start: Math.max(0, st), duration: dur };
}

/** 拖左手柄：右端固定，左端跟随 t（不得越过右端减最短时长）。 */
export function rangeHandleStart(
  range: VideoRange,
  t: number,
  min: number,
  max: number,
  trackDur: number,
): VideoRange {
  const end = range.start + range.duration;
  const st = Math.min(Math.max(0, t), end - min);
  return clampRange(st, end - st, min, max, trackDur);
}

/** 拖右手柄：左端固定，右端跟随 t（先夹进 [start+min, 轨道尾]，左端不动）。 */
export function rangeHandleEnd(
  range: VideoRange,
  t: number,
  min: number,
  max: number,
  trackDur: number,
): VideoRange {
  const clamped = Math.min(trackDur, Math.max(range.start + min, t));
  return clampRange(range.start, clamped - range.start, min, max, trackDur);
}

/** 按住选区中段整体平移（grabOffset = 按下时刻 t − range.start）。 */
export function rangeTranslate(
  range: VideoRange,
  t: number,
  grabOffset: number,
  min: number,
  max: number,
  trackDur: number,
): VideoRange {
  return clampRange(t - grabOffset, range.duration, min, max, trackDur);
}

/** 时间码：mm:ss.cc；超过一小时收敛为 h:mm:ss（厘秒在长视频上无意义）。
 *  厘秒按总厘秒取整后取模——逐字段 floor 会在 62.05 这类值上吃浮点误差。 */
export function formatTimecode(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) secs = 0;
  const totalCs = Math.round(secs * 100);
  const h = Math.floor(totalCs / 360000);
  const m = Math.floor((totalCs % 360000) / 6000);
  const s = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  const two = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${two(m)}:${two(s)}`;
  return `${two(m)}:${two(s)}.${two(cs)}`;
}

/**
 * 画面轨铺帧：轨道是「还原视频画面」的胶片带，格子数按「格宽 ≈ 帧宽
 * （frameAspect × stripHeight）」从轨道宽推出——竖屏/横屏都以接近原始
 * 比例的格子铺满轨道，cover 裁切几乎不可见。后端帧富余时按均匀步长抽
 * 格（格 i 的时间落在 [i, i+1)/格数 区间内），帧不足时一格一帧。
 * 返回每格取用的帧下标（升序、可重复），空数组表示无帧可铺。
 */
export function filmstripCells(
  totalFrames: number,
  trackWidth: number,
  frameAspect: number,
  stripHeight: number,
): number[] {
  if (!(totalFrames > 0)) return [];
  const aspect = Number.isFinite(frameAspect) && frameAspect > 0 ? frameAspect : 16 / 9;
  const cellW = Math.max(aspect * stripHeight, 1);
  const maxCells = Math.max(2, Math.round(trackWidth / cellW));
  if (totalFrames <= maxCells) {
    return Array.from({ length: totalFrames }, (_, i) => i);
  }
  const stride = totalFrames / maxCells;
  return Array.from({ length: maxCells }, (_, i) =>
    Math.min(totalFrames - 1, Math.floor(i * stride)),
  );
}
