/**
 * 统一媒体播放器（2026-11-02）：裸画面（视频）+ 自绘播放条——紫色播放钮 +
 * 可拖进度 + 时间码 + 音量，一套控件逻辑驱动 <audio>/<video>（两者 DOM
 * 接口同构）。场景：画布全部媒体预览/试听（预览/保存盒/加载节点/视频
 * 工具监视器/抽音轨试听），替代 WebView 原生控件——原生样式不可控、暗色
 * 主题不跟随、与玻璃节点视觉不统一（AudioMiniPlayer 的同语言增强后继）。
 * 媒体地址经 domain/mediaUrl 回环服务解析（架构守卫规则 3 白名单组件）；
 * 传入 path 须为绝对路径（画布侧先经 resolveCanvasMediaPath 归一）。
 * 播放条与进度/音量的承载元素用 button：画布视口手势按 closest("button")
 * 放行，拖动不会拖走节点。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "./Icons";
import { resolveResourceMediaUrl } from "../domain/mediaUrl";
import { openResourceFile } from "../domain/mediaAssets";

/** m:ss 短时间码（进度行专用，厘秒在这里没有意义）。 */
function mmss(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs) % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function MediaPlayback({
  kind,
  path,
  autoPlay = false,
  ratioFit = false,
  mediaRefCallback,
  onTimeUpdate,
  onVideoRatio,
}: {
  kind: "audio" | "video";
  path: string;
  /** 一律不自动播放（2026-11-02 用户定案：媒体挂载/节点重挂——包括切
   *  画布——都不得未经点击开播，默认 false 令全部接入点安全；保存盒/
   *  监视器/试听条此前的显式 false 已是冗余）。播放只由点击触发。 */
  autoPlay?: boolean;
  /** 视频比例贴合（画布节点预览用）：加载后读真实宽高，把画面元素宽度
   *  收敛到「容器宽与 330px 高帽按比例换算的较小值」并锁定 aspect-ratio
   *  ——元素盒恒等于视频盒，object-fit: contain 不再产生黑边，任意
   *  横/竖/方屏都完整展示视频比例。默认关（监视器等自行控制比例的
   *  场景不受影响）。 */
  ratioFit?: boolean;
  /** 媒体元素引用回调：调用方程序化 seek（视频工具播放头同步）时需要。 */
  mediaRefCallback?: (el: HTMLVideoElement | HTMLAudioElement | null) => void;
  /** 播放时刻回调：播放条拖动/走带时回写外部状态（选区循环钳制等）。 */
  onTimeUpdate?: (t: number) => void;
  /** 视频真实宽高上报（视频工具监视器兜底用）：loadedmetadata 实测，
   *  与内部 ratioFit 同一测量点；调用方拿它撑容器比例（时间轴回传前/
   *  失败时不再卡 16:9 黑边窗）。音频流宽高为 0 不回调。 */
  onVideoRatio?: (w: number, h: number) => void;
}) {
  const { t } = useTranslation();
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [pos, setPos] = useState({ t: 0, dur: 0, playing: false });
  const [blocked, setBlocked] = useState(false);
  // 视频真实宽高（ratioFit 用）：loadedmetadata 实测，宽高为 0（未就绪/
  // 音频流）时不干预布局。
  const [ratio, setRatio] = useState<{ w: number; h: number } | null>(null);
  // 音量走 state：直接改元素的 muted/volume 不触发重渲染，图标与滑条
  // 填充就不会更新。mute 与拖动都经这里统一应用。
  const [vol, setVol] = useState({ v: 1, muted: false });

  useEffect(() => {
    let alive = true;
    setUrl("");
    setFailed(false);
    setOpenFailed(false);
    setBlocked(false);
    setPos({ t: 0, dur: 0, playing: false });
    setVol({ v: 1, muted: false });
    setRatio(null);
    resolveResourceMediaUrl(path)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [path]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !url) return;
    return () => {
      media.pause();
    };
  }, [url]);

  const toggle = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) {
      const r = el.play();
      if (r) void r.catch(() => setBlocked(true));
    } else {
      el.pause();
    }
  };

  const applyVol = (v: number, muted: boolean) => {
    const el = mediaRef.current;
    if (el) {
      el.volume = v;
      el.muted = muted;
    }
    setVol({ v, muted });
  };

  const seekTo = (t: number) => {
    const el = mediaRef.current;
    if (!el) return;
    try {
      el.currentTime = t;
    } catch {
      // 元数据未就绪时忽略：元素会延迟生效或自然失败。
    }
    setPos((prev) => ({ ...prev, t }));
  };

  const handleRef = (el: HTMLVideoElement | HTMLAudioElement | null) => {
    mediaRef.current = el;
    mediaRefCallback?.(el);
  };

  // 合成事件的 currentTarget 在派发结束后即被 React 置 null，而 setState
  // updater 是派发后才执行的——必须在此同步取值，updater 只闭包普通量
  // （AudioMiniPlayer 实测在 updater 里读会整树崩溃）。
  const readPos = (e: React.SyntheticEvent<HTMLMediaElement>) => {
    const el = e.currentTarget;
    const t = el.currentTime;
    const d = el.duration;
    const playing = !el.paused;
    onTimeUpdate?.(t);
    setPos((prev) => ({
      t,
      dur: Number.isFinite(d) && d > 0 ? d : prev.dur,
      playing,
    }));
  };

  const openInSystemPlayer = async () => {
    setOpenFailed(false);
    try {
      await openResourceFile(path);
    } catch {
      setOpenFailed(true);
    }
  };

  if (failed) {
    return (
      <div className="resource-media-fallback media-playback-fallback" role="status">
        {kind === "video" ? Icons.video : Icons.audio}
        <span>{t("resources.mediaUnavailable")}</span>
        <button type="button" className="resource-secondary-button resource-media-open-button" onClick={() => void openInSystemPlayer()}>
          {Icons.play}
          <span>{t("resources.openInSystemPlayer")}</span>
        </button>
        {openFailed && <span className="resource-media-note">{t("resources.openMediaFailed")}</span>}
      </div>
    );
  }

  const dur = pos.dur > 0 ? pos.dur : 0;
  const pct = dur > 0 ? Math.min(100, (pos.t / dur) * 100) : 0;

  const ratioStyle =
    ratioFit && ratio && ratio.w > 0 && ratio.h > 0
      ? {
          // 宽度 = 容器宽与「330px 高帽 × 比例」的较小者：横屏吃满容器
          // 宽，竖/方屏按高度帽收敛居中；aspect-ratio 锁定后高度随之
          // ≤330，元素盒 = 视频盒，contain 不再出黑边。
          width: `min(100%, ${Math.round(330 * (ratio.w / ratio.h))}px)`,
          aspectRatio: `${ratio.w} / ${ratio.h}`,
          marginInline: "auto",
        }
      : undefined;

  const player = kind === "video" ? (
    <video
      ref={handleRef}
      className="media-playback-video"
      style={ratioStyle}
      src={url || undefined}
      key={`video-${url}`}
      // 无 controls：控制全部走下方自绘播放条。
      playsInline
      preload="metadata"
      onClick={toggle}
      onTimeUpdate={readPos}
      onPlay={() => { setBlocked(false); setPos((prev) => ({ ...prev, playing: true })); }}
      onPause={() => setPos((prev) => ({ ...prev, playing: false }))}
      onEnded={() => setPos((prev) => ({ ...prev, playing: false }))}
      onLoadedMetadata={(e) => {
        const d = e.currentTarget.duration;
        setPos((prev) => ({ ...prev, dur: Number.isFinite(d) && d > 0 ? d : prev.dur }));
        setRatio({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight });
        if (e.currentTarget.videoWidth > 0 && e.currentTarget.videoHeight > 0) {
          onVideoRatio?.(e.currentTarget.videoWidth, e.currentTarget.videoHeight);
        }
        if (autoPlay) {
          const r = e.currentTarget.play();
          if (r) void r.catch(() => setBlocked(true));
        }
      }}
      onError={(e) => {
        if (e.currentTarget === mediaRef.current) setFailed(true);
      }}
    />
  ) : (
    <audio
      ref={handleRef}
      className="media-playback-audio"
      src={url || undefined}
      key={`audio-${url}`}
      preload="metadata"
      onTimeUpdate={readPos}
      onPlay={() => { setBlocked(false); setPos((prev) => ({ ...prev, playing: true })); }}
      onPause={() => setPos((prev) => ({ ...prev, playing: false }))}
      onEnded={() => setPos((prev) => ({ ...prev, playing: false }))}
      onLoadedMetadata={(e) => {
        const d = e.currentTarget.duration;
        setPos((prev) => ({ ...prev, dur: Number.isFinite(d) && d > 0 ? d : prev.dur }));
        if (autoPlay) {
          const r = e.currentTarget.play();
          if (r) void r.catch(() => setBlocked(true));
        }
      }}
      onError={(e) => {
        if (e.currentTarget === mediaRef.current) setFailed(true);
      }}
    />
  );

  return (
    <div className={`media-playback${kind === "video" ? " has-video" : ""}`}>
      {player}
      <div className="media-playback-bar">
        <button
          type="button"
          className="media-playback-play"
          aria-label={pos.playing ? t("canvas.audioPause") : t("canvas.audioPlay")}
          onClick={toggle}
          disabled={!url}
        >
          {pos.playing ? Icons.pause : Icons.play}
        </button>
        <button
          type="button"
          className="media-playback-track"
          aria-label={t("canvas.playbackSeek")}
          onPointerDown={(e) => {
            // 拖动即 seek：以轨道几何换算位置，捕获指针到轨道元素，
            // move 连续跟手、up 收尾（捕获失败退化为元素监听）。
            const track = e.currentTarget;
            const seekAt = (clientX: number) => {
              const r = track.getBoundingClientRect();
              if (r.width <= 0) return;
              seekTo(Math.min(dur || 0, Math.max(0, ((clientX - r.left) / r.width) * (dur || 0))));
            };
            seekAt(e.clientX);
            try {
              track.setPointerCapture(e.pointerId);
            } catch {
              // 指针不可捕获（合成事件等）：退化由 window 监听兜底。
            }
            const move = (ev: PointerEvent) => seekAt(ev.clientX);
            const up = () => {
              track.removeEventListener("pointermove", move);
              track.removeEventListener("pointerup", up);
              track.removeEventListener("pointercancel", up);
            };
            track.addEventListener("pointermove", move);
            track.addEventListener("pointerup", up);
            track.addEventListener("pointercancel", up);
          }}
        >
          <span className="media-playback-fill" style={{ width: `${pct}%` }} />
          <span className="media-playback-knob" style={{ left: `${pct}%` }} />
        </button>
        <span className="media-playback-time">{mmss(pos.t)} / {mmss(dur)}</span>
        <span className="media-playback-vol">
          <button
            type="button"
            className="media-playback-vol-btn"
            aria-label={t("canvas.playbackMute")}
            onClick={() => applyVol(vol.v, !vol.muted)}
            disabled={!url}
          >
            <span className="media-playback-vol-ico">
              {vol.muted || vol.v === 0 ? Icons.volumeOff : Icons.volume2}
            </span>
          </button>
          <button
            type="button"
            className="media-playback-vol-bar"
            aria-label={t("canvas.playbackVolume")}
            onPointerDown={(e) => {
              // 拖动调音量（0-1）：与进度条同一手势骨架。
              const bar = e.currentTarget;
              const setAt = (clientX: number) => {
                const r = bar.getBoundingClientRect();
                if (r.width <= 0) return;
                const v = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
                applyVol(v, v === 0);
              };
              setAt(e.clientX);
              try {
                bar.setPointerCapture(e.pointerId);
              } catch {
                // 同进度条。
              }
              const move = (ev: PointerEvent) => setAt(ev.clientX);
              const up = () => {
                bar.removeEventListener("pointermove", move);
                bar.removeEventListener("pointerup", up);
                bar.removeEventListener("pointercancel", up);
              };
              bar.addEventListener("pointermove", move);
              bar.addEventListener("pointerup", up);
              bar.addEventListener("pointercancel", up);
            }}
          >
            <span className="media-playback-vol-fill" style={{ width: `${vol.muted ? 0 : vol.v * 100}%` }} />
          </button>
        </span>
      </div>
      {!pos.playing && blocked && (
        <span className="resource-media-note media-playback-note" role="status">
          {t("resources.autoplayBlocked")}
        </span>
      )}
    </div>
  );
}
