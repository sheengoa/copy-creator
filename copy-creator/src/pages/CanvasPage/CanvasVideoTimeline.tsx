/**
 * 视频工具节点的时间轴（2026-11-02 视觉方案定稿）：ffmpeg 缩略图铺底 +
 * 播放头（抽帧）/ 可拖选区（转 GIF、抽音轨）。
 *
 * 手势为元素级自包含（对齐 startCollectionReorder 模式）：pointerdown 后
 * setPointerCapture 到轨道元素，move/up 都挂在轨道上，用完即摘。定位换算
 * 走比例法（videoTimeline.timeAtClientX），天然免疫画布缩放。
 * 组件是纯受控：拖动中持续回调 onSeek/onRange，松手回调 onCommit（参数
 * 落 metadata 的时机由父层决定，避免拖动中频繁落库）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { resolveResourceMediaUrl } from "../../domain/mediaUrl";
import {
  filmstripCells,
  formatTimecode,
  rangeHandleEnd,
  rangeHandleStart,
  rangeTranslate,
  timeAtClientX,
  type VideoRange,
} from "./videoTimeline";

export interface TimelineThumb {
  t: number;
  path: string;
}

/** 轨道像素高：与 canvas-video-tools.css 的 .fc-vtl-strip height 对齐。 */
const STRIP_H = 40;

interface CanvasVideoTimelineProps {
  duration: number;
  thumbnails: TimelineThumb[];
  mode: "seek" | "range";
  /** seek 模式：播放头时间；range 模式：选区。 */
  value: number | VideoRange;
  onSeek?: (t: number) => void;
  onRange?: (range: VideoRange) => void;
  /** 拖动结束（pointerup）——父层在此落 metadata。 */
  onCommit?: () => void;
  /** 选区时长钳制（GIF 0.5–10s；音轨 min 0.5、max 取总时长）。 */
  rangeLimits?: { min: number; max: number };
  disabled?: boolean;
  /** 帧宽高比（后端 IHDR 实测 w/h）：格子按它取宽，铺出的画面轨以接近
   *  原始比例还原视频画面；缺省回退 16:9。 */
  frameAspect?: number;
}

/** 选区时长徽标：3.0s 风格（≥60s 收敛为时间码）。 */
function rangeBadgeText(dur: number): string {
  if (dur >= 60) return formatTimecode(dur);
  return `${dur.toFixed(1)}s`;
}

export default function CanvasVideoTimeline({
  duration,
  thumbnails,
  mode,
  value,
  onSeek,
  onRange,
  onCommit,
  rangeLimits = { min: 0.5, max: 10 },
  disabled = false,
  frameAspect,
}: CanvasVideoTimelineProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  // 拖动会话态：0=无 1=播放头 2=左手柄 3=右手柄 4=中段平移。
  const dragKindRef = useRef(0);
  const grabOffsetRef = useRef(0);

  // 轨道实测宽度：格子数随宽度走（节点缩放、窗口变化都跟着重铺）。
  const [stripW, setStripW] = useState(0);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setStripW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 铺格：每格取用第几帧（帧富余时均匀抽稀，不足时一格一帧）。
  const cellIdxs = useMemo(
    () => filmstripCells(thumbnails.length, stripW || 460, frameAspect ?? 16 / 9, STRIP_H),
    [thumbnails.length, stripW, frameAspect],
  );

  // 格子路径 → 媒体服务 URL（只解析上格的那几张；dataURL 原样直通）。
  const pathsKey = useMemo(
    () => cellIdxs.map((i) => thumbnails[i]?.path ?? "").join("\n"),
    [cellIdxs, thumbnails],
  );
  const [cellUrls, setCellUrls] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    const paths = pathsKey ? pathsKey.split("\n") : [];
    Promise.all(paths.map((p) => resolveResourceMediaUrl(p).catch(() => "")))
      .then((urls) => {
        if (alive) setCellUrls(urls);
      });
    return () => {
      alive = false;
    };
  }, [pathsKey]);

  const timeAt = (clientX: number) => {
    const rect = stripRef.current?.getBoundingClientRect();
    return rect ? timeAtClientX(clientX, rect, duration) : 0;
  };

  const applyMove = (clientX: number) => {
    const t = timeAt(clientX);
    if (dragKindRef.current === 1) {
      onSeek?.(t);
      return;
    }
    const range = value as VideoRange;
    const maxDur = Math.min(rangeLimits.max, duration);
    if (dragKindRef.current === 2) {
      onRange?.(rangeHandleStart(range, t, rangeLimits.min, maxDur, duration));
    } else if (dragKindRef.current === 3) {
      onRange?.(rangeHandleEnd(range, t, rangeLimits.min, maxDur, duration));
    } else if (dragKindRef.current === 4) {
      onRange?.(rangeTranslate(range, t, grabOffsetRef.current, rangeLimits.min, maxDur, duration));
    }
  };

  const onStripPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || !(duration > 0) || event.button !== 0) return;
    const strip = stripRef.current;
    if (!strip) return;
    const t = timeAt(event.clientX);
    // range 模式按命中分类手柄/选区/空白，其余场景一律按播放头拖。
    // 选区内/外判定用纯几何（时间落点），不依赖元素命中——选区框是
    // pointer-events:none 的视觉层，元素级 closest 永远测不到（实测
    // 中段平移因此整个失效，按下全落「就近端吸附」把端点拉走）。
    let kind = 1;
    if (mode === "range") {
      const range = value as VideoRange;
      const target = event.target as HTMLElement;
      const end = range.start + range.duration;
      if (target.closest("[data-vtl-handle='start']")) {
        kind = 2;
      } else if (target.closest("[data-vtl-handle='end']")) {
        kind = 3;
      } else if (t > range.start && t < end) {
        // 选区内按住 = 整段平移。
        kind = 4;
        grabOffsetRef.current = t - range.start;
      } else {
        // 空白轨道：把更近的一端拖到点击处（剪辑软件直觉）。
        kind = Math.abs(t - range.start) <= Math.abs(end - t) ? 2 : 3;
      }
    }
    dragKindRef.current = kind;
    applyMove(event.clientX);
    strip.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onStripPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragKindRef.current === 0) return;
    // 主键已松开却没收到 pointerup（外层手势抢走捕获等情形）时，move 仍会
    // 以 buttons=0 到达——此时结束会话，绝不「点一下就跟着悬停走」。
    if ((event.buttons & 1) === 0) {
      endDrag(event);
      return;
    }
    applyMove(event.clientX);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragKindRef.current === 0) return;
    dragKindRef.current = 0;
    try {
      stripRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // 捕获已被外层接管/指针已失效：会话已在上面结束，无须补救。
    }
    onCommit?.();
  };

  if (!(duration > 0)) return null;
  const pct = (t: number) => `${Math.min(100, Math.max(0, (t / duration) * 100))}%`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => r * duration);

  return (
    <div className={`fc-vtl${disabled ? " is-disabled" : ""}${mode === "range" ? " is-range" : ""}`}>
      <div
        ref={stripRef}
        className="fc-vtl-strip"
        onPointerDown={onStripPointerDown}
        onPointerMove={onStripPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="fc-vtl-cells">
          {cellUrls.map((url, i) => (
            <span key={i} className="fc-vtl-cell" style={url ? { backgroundImage: `url("${url}")` } : undefined} />
          ))}
        </div>
        {mode === "range" ? (
          (() => {
            const range = value as VideoRange;
            const end = range.start + range.duration;
            return (
              <>
                <span className="fc-vtl-dim is-l" style={{ width: pct(range.start) }} />
                <span className="fc-vtl-dim is-r" style={{ left: pct(end), right: 0 }} />
                <span
                  data-vtl-range=""
                  className="fc-vtl-range"
                  style={{ left: pct(range.start), width: pct(range.duration) }}
                />
                <span
                  data-vtl-handle="start"
                  className="fc-vtl-handle"
                  style={{ left: pct(range.start) }}
                />
                <span
                  data-vtl-handle="end"
                  className="fc-vtl-handle"
                  style={{ left: pct(end) }}
                />
                <span
                  className="fc-vtl-rbadge"
                  style={{ left: `calc(${pct(range.start)} + ${pct(range.duration)} / 2)` }}
                >
                  {rangeBadgeText(range.duration)}
                </span>
              </>
            );
          })()
        ) : (
          <span className="fc-vtl-playhead" style={{ left: pct(value as number) }} />
        )}
      </div>
      <div className="fc-vtl-ticks">
        {ticks.map((t, i) => (
          <span key={i}>{formatTimecode(t)}</span>
        ))}
      </div>
    </div>
  );
}
