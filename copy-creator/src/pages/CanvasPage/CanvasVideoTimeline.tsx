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
}: CanvasVideoTimelineProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  // 拖动会话态：0=无 1=播放头 2=左手柄 3=右手柄 4=中段平移。
  const dragKindRef = useRef(0);
  const grabOffsetRef = useRef(0);

  // 缩略图路径 → 媒体服务 URL（resolveResourceMediaUrl 异步，路径集合
  // 变化才重解析；dataURL 原样直通）。
  const pathsKey = useMemo(() => thumbnails.map((t) => t.path).join("\n"), [thumbnails]);
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
    // range 模式按命中元素分类手柄/选区/空白，其余场景一律按播放头拖。
    let kind = 1;
    if (mode === "range") {
      const range = value as VideoRange;
      const target = event.target as HTMLElement;
      if (target.closest("[data-vtl-handle='start']")) {
        kind = 2;
      } else if (target.closest("[data-vtl-handle='end']")) {
        kind = 3;
      } else if (target.closest("[data-vtl-range]")) {
        kind = 4;
        grabOffsetRef.current = t - range.start;
      } else {
        // 空白轨道：把更近的一端拖到点击处（剪辑软件直觉）。
        const end = range.start + range.duration;
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
    applyMove(event.clientX);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragKindRef.current === 0) return;
    dragKindRef.current = 0;
    stripRef.current?.releasePointerCapture?.(event.pointerId);
    onCommit?.();
  };

  if (!(duration > 0)) return null;
  const pct = (t: number) => `${Math.min(100, Math.max(0, (t / duration) * 100))}%`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => r * duration);

  return (
    <div className={`fc-vtl${disabled ? " is-disabled" : ""}`}>
      <div
        ref={stripRef}
        className="fc-vtl-strip"
        onPointerDown={onStripPointerDown}
        onPointerMove={onStripPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="fc-vtl-cells">
          {(thumbnails.length ? cellUrls : []).map((url, i) => (
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
