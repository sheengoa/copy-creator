/**
 * 迷你音频播放条（共享媒体组件，2026-11-02）：播放点 + 细进度 + 时间的
 * 单行形态。场景：画布音轨节点的完成态试听——原生 audio 控件在玻璃节点
 * 里过重。媒体地址与失败兜底走与 ResourceMediaPlayer 同源的
 * domain/mediaUrl 回环服务解析（架构守卫规则 3 的白名单组件）。
 */
import { useEffect, useRef, useState } from "react";
import { Icons } from "./Icons";
import { resolveResourceMediaUrl } from "../domain/mediaUrl";

/** m:ss 短时间码（进度行专用，厘秒在这里没有意义）。 */
function mmss(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function AudioMiniPlayer({
  path,
  playLabel,
  pauseLabel,
}: {
  path: string;
  playLabel: string;
  pauseLabel: string;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [pos, setPos] = useState({ t: 0, dur: 0, playing: false });
  const [failed, setFailed] = useState(false);
  const [url, setUrl] = useState("");

  useEffect(() => {
    let alive = true;
    setUrl("");
    setFailed(false);
    setPos({ t: 0, dur: 0, playing: false });
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

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setFailed(true));
    else el.pause();
  };

  if (failed) {
    return (
      <div className="audio-mini is-failed" role="status">
        <span className="audio-mini-time">—</span>
      </div>
    );
  }

  return (
    <div className="audio-mini">
      <button
        type="button"
        className="audio-mini-play"
        aria-label={pos.playing ? pauseLabel : playLabel}
        onClick={toggle}
        disabled={!url}
      >
        {pos.playing ? Icons.pause : Icons.play}
      </button>
      <div className="audio-mini-bar">
        <span
          style={{ width: `${pos.dur > 0 ? Math.min(100, (pos.t / pos.dur) * 100) : 0}%` }}
        />
      </div>
      <span className="audio-mini-time">{mmss(pos.t)}</span>
      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onTimeUpdate={(e) => {
            // 合成事件的 currentTarget 在派发结束后即被 React 置 null，
            // 而 setState updater 是派发后才执行的——必须在此同步取值，
            // updater 只闭包普通量（实测在 updater 里读会整树崩溃）。
            const el = e.currentTarget;
            const t = el.currentTime;
            const d = el.duration;
            const playing = !el.paused;
            setPos((prev) => ({
              t,
              dur: Number.isFinite(d) && d > 0 ? d : prev.dur,
              playing,
            }));
          }}
          onPlay={() => setPos((prev) => ({ ...prev, playing: true }))}
          onPause={() => setPos((prev) => ({ ...prev, playing: false }))}
          onEnded={() => setPos((prev) => ({ ...prev, playing: false, t: 0 }))}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            setPos((prev) => ({
              ...prev,
              dur: Number.isFinite(d) && d > 0 ? d : prev.dur,
            }));
          }}
        />
      )}
    </div>
  );
}
