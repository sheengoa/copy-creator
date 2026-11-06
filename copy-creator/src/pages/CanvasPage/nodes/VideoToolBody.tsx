import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "../../../components/Icons";
import { MediaPlayback } from "../../../components/MediaPlayback";
import { useCanvasStore } from "../../../stores/canvasStore";
import { formatTimecode } from "../videoTimeline";
import CanvasVideoTimeline from "../CanvasVideoTimeline";
import { ResourceThumb } from "./media";
import { useNodeErrors } from "./nodeErrors";
import { NodeHint } from "./NodeHint";
import { useVideoToolRuntime } from "./videoToolRuntimeCtx";
import type { NodeProps } from "./types";

// 视频工具节点内容层（抽帧/转GIF/抽音轨，2026-11-02 定稿）：监视器预览
// （随视频真实宽高比自适应）+ ffmpeg 缩略图时间轴 + 侧栏参数的横向长方
// 形。视频进节点（拖入/选片），产物写节点行 resource_path（抽帧/GIF 归
// 图像族、音轨归音频）。isGif/isAudio 双布尔参数化三类型（272 行同构块）。
export function VideoToolBody({ node, services }: NodeProps) {
  const { t } = useTranslation();
  const nodeErrors = useNodeErrors((s) => s.errors);
  const updateNode = useCanvasStore((s) => s.updateNode);
  const rt = useVideoToolRuntime();
  // 监视器比例兜底（2026-11-04）：时间轴回传前/失败时画面盒回退 16:9，
  // 竖版视频在窗口期内露黑边——用视频元素 loadedmetadata 实测值补位
  // （与 timeline 实测取先到优先，掺路径防换片残留）。真实后端两者同源
  // （IHDR 即帧宽高），兜底只为消窗口期与失败态。hook 须在提前 return 前。
  const [measured, setMeasured] = useState<{ path: string; w: number; h: number } | null>(null);
  const isGif = node.type === "video_to_gif";
  const isAudio = node.type === "video_extract_audio";
  const meta = node.metadata;
  if (meta.kind !== "video_seek_frame" && meta.kind !== "video_to_gif" && meta.kind !== "video_extract_audio") return null;
  const videoPath = meta.video_path ?? "";
  const productPath = node.resource_path;
  const toolBusy = !!rt.frameBusy[node.id];
  const toolError = nodeErrors[node.id];
  const timeline = videoPath ? rt.videoTimelines[videoPath] : undefined;
  const trackDur = timeline?.duration ?? 0;
  const measuredRatio =
    measured && measured.path === videoPath && measured.w > 0 && measured.h > 0 ? measured : null;
  const screenRatio =
    timeline && (timeline.w ?? 0) > 0 && (timeline.h ?? 0) > 0
      ? { w: timeline.w as number, h: timeline.h as number }
      : measuredRatio;
  const draft = rt.videoToolDraft[node.id];
  const seekT = draft?.t ?? meta.start_secs ?? 0;
  const rangeStart = draft?.start ?? meta.start_secs ?? 0;
  const rangeDurRaw = draft?.dur ?? meta.duration_secs ?? 0;
  // 选区值合成：draft 优先；GIF 永远有具体时长（未拖过 =
  // 默认 3s，与侧栏显示、执行兜底一致）；音轨未拖过（≤0）
  // 显示整段。
  const rangeValue =
    rangeDurRaw > 0
      ? { start: rangeStart, duration: rangeDurRaw }
      : { start: 0, duration: isGif ? 3 : Math.max(trackDur, 0.5) };
  const rangeLimits = isGif
    ? { min: 0.5, max: 10 }
    : { min: 0.5, max: Math.max(trackDur, 0.5) };
  const isRange = isGif || isAudio;
  const fmtNow = (meta.format || "mp3") as "mp3" | "aac" | string;
  return (
    <div className="fc-node-form">
      {/* 视频来源入口：选定后与加载节点同款「溜走」收合，×清除后滑回 */}
      <div className={`fc-load-entry${videoPath ? " is-loaded" : ""}`}>
        <div className="fc-load-entry-clip">
          <div className="fc-node-placeholder">
            <i>{t("canvas.toolEmpty")}</i>
          </div>
          <div className="fc-node-row">
            <NodeHint text={t("canvas.loadFromLibrary")} className="is-grow">
              <button
                type="button"
                className="fc-node-btn ghost is-icon grow"
                aria-label={t("canvas.loadFromLibrary")}
                onClick={() => services.pickMedia(node, "library")}
              >
                {Icons.resources}
              </button>
            </NodeHint>
            <NodeHint text={t("canvas.loadFromFile")} className="is-grow">
              <button
                type="button"
                className="fc-node-btn ghost is-icon grow"
                aria-label={t("canvas.loadFromFile")}
                onClick={() => services.pickMedia(node, "disk")}
              >
                {Icons.hardDrive}
              </button>
            </NodeHint>
          </div>
        </div>
      </div>
      {videoPath && (
        <>
          <div className="fc-vt-monitor">
            <div
              className="fc-vt-screen"
              /* 监视器随视频真实宽高比自适应（后端时间轴实测的
                 w/h，未回传前用视频元素 loadedmetadata 实测兜底）
                 ——竖版视频不再被 16:9 固定窗缩成小画面。几何走
                 统一机制：组件只写实测变量（--media-fitw/--media-ar），
                 呈现形态由 CSS 消费（canvas-video-tools.css 的等比
                 舞台），与 is-ratio-fit 画布媒体同一套准则。回退值
                 16:9/224px 仅覆盖实测未到的窗口期。 */
              style={
                screenRatio
                  ? ({
                      "--media-fitw": `${Math.round(330 * (screenRatio.w / screenRatio.h))}px`,
                      "--media-ar": `${screenRatio.w} / ${screenRatio.h}`,
                    } as CSSProperties)
                  : undefined
              }
            >
              {/* 抽帧/GIF 完成态显示产物图（原位展示，点击放大已移除）；
                  音轨完成态保留视频画面；其余一律视频预览。 */}
              {productPath && !toolBusy && !isAudio ? (
                <div className="fc-frame-thumb">
                  <ResourceThumb path={productPath} className="fc-media-box" />
                </div>
              ) : (
                <MediaPlayback
                  kind="video"
                  path={videoPath}
                  onVideoRatio={(w, h) => setMeasured({ path: videoPath, w, h })}
                  mediaRefCallback={(el) => {
                    rt.registerVideoEl(node.id, el);
                  }}
                  onTimeUpdate={(t2) => {
                    if (isRange) {
                      // 选区预览（GIF/音轨）：播放只发生在两针
                      // 之间——越出末端回跳起点循环小样，落在
                      // 起点前（拖到选区外）拉回起点；画面的
                      // 拖动跟随由 rangeToolTo 的程序 seek 负责。
                      const start = draft?.start ?? meta.start_secs ?? 0;
                      const dur = rangeDurRaw > 0 ? rangeDurRaw : trackDur;
                      const end = start + dur;
                      if (trackDur > 0 && (t2 >= end || t2 < start - 0.3)) {
                        const el = rt.getVideoEl(node.id);
                        if (el) {
                          try {
                            el.currentTime = start;
                          } catch {
                            // 元数据未就绪时忽略。
                          }
                        }
                      }
                      return;
                    }
                    // 播放条拖动/走带回写播放头（seek 模式）。
                    if (toolBusy || productPath) return;
                    rt.setVideoToolDraft((prev) => ({
                      ...prev,
                      [node.id]: { ...(prev[node.id] ?? {}), t: t2 },
                    }));
                  }}
                />
              )}
              {productPath && !toolBusy && (
                <span className="fc-frame-badge">
                  {isGif
                    ? t("canvas.gifBadge", { d: (rangeDurRaw > 0 ? rangeDurRaw : 3).toFixed(1) })
                    : isAudio
                      ? t("canvas.audioBadge", { fmt: String(fmtNow).toUpperCase() })
                      : formatTimecode(seekT)}
                </span>
              )}
              {/* 悬浮右上角的圆形 ×（与加载节点同款）：清除视频回
                  空态、产物一并清掉重新选片；执行中不显示。 */}
              {videoPath && !toolBusy && (
                <NodeHint text={t("canvas.clearLoaded")}>
                  <button
                    type="button"
                    className="fc-load-clear"
                    aria-label={t("canvas.clearLoaded")}
                    onClick={(e) => {
                      e.stopPropagation();
                      rt.clearFrameVideo(node);
                    }}
                  >
                    {Icons.close}
                  </button>
                </NodeHint>
              )}
            </div>
            <div className="fc-vt-side">
              {productPath && !toolBusy ? (
                <>
                  <div className="fc-vt-time-big is-ok">
                    {isGif ? t("canvas.gifDone") : t("canvas.seekDone")}
                  </div>
                  {isAudio && (
                    <MediaPlayback kind="audio" path={productPath} />
                  )}
                  <div className="fc-vt-sidehint">{t("canvas.toolDoneHint")}</div>
                </>
              ) : isGif ? (
                <>
                  <div className="fc-vt-duo">
                    <div>
                      <div className="k">{t("canvas.gifStart")}</div>
                      <div className="v">{formatTimecode(rangeStart)}</div>
                    </div>
                    <div>
                      <div className="k">{t("canvas.gifDur")}</div>
                      <div className="v">
                        {(rangeDurRaw > 0 ? rangeDurRaw : 3).toFixed(1)}s
                      </div>
                    </div>
                  </div>
                  <div className="fc-vt-sidehint">{t("canvas.gifHint")}</div>
                </>
              ) : isAudio ? (
                <>
                  <div className="fc-vt-pills">
                    <button
                      type="button"
                      className={`fc-vt-pill${fmtNow === "mp3" ? " is-on" : ""}`}
                      onClick={() =>
                        void updateNode(node.id, {
                          metadata: JSON.stringify({ ...meta, format: "mp3" }),
                        })
                      }
                    >
                      {t("canvas.audioMp3")}
                    </button>
                    <button
                      type="button"
                      className={`fc-vt-pill${fmtNow === "aac" ? " is-on" : ""}`}
                      onClick={() =>
                        void updateNode(node.id, {
                          metadata: JSON.stringify({ ...meta, format: "aac" }),
                        })
                      }
                    >
                      {t("canvas.audioAac")}
                    </button>
                  </div>
                  <div className="fc-vt-duo">
                    <div>
                      <div className="k">{t("canvas.audioStart")}</div>
                      <div className="v">{formatTimecode(rangeStart)}</div>
                    </div>
                    <div>
                      <div className="k">{t("canvas.audioDur")}</div>
                      <div className="v">
                        {rangeDurRaw > 0 ? `${rangeDurRaw.toFixed(1)}s` : t("canvas.audioWhole")}
                      </div>
                    </div>
                  </div>
                  <div className="fc-vt-sidehint">{t("canvas.audioHint")}</div>
                </>
              ) : (
                <>
                  <div className="fc-vt-time-big">{formatTimecode(seekT)}</div>
                  <div className="fc-vt-sidehint">{t("canvas.seekHint")}</div>
                </>
              )}
              <div className="fc-vt-spacer" />
              <NodeHint text={toolError ?? ""}>
                <button
                  type="button"
                  className="fc-node-btn accent"
                  disabled={toolBusy}
                  onClick={() => void rt.runVideoTool(node)}
                >
                  {toolBusy
                    ? t("canvas.toolRunning")
                    : productPath
                      ? isGif
                        ? t("canvas.gifRedo")
                        : t("canvas.seekRedo")
                      : isGif
                        ? t("canvas.gifExec")
                        : isAudio
                          ? t("canvas.audioExec")
                          : t("canvas.seekExec")}
                </button>
              </NodeHint>
            </div>
          </div>
          {timeline && (
            <CanvasVideoTimeline
              duration={timeline.duration}
              thumbnails={timeline.thumbnails}
              frameAspect={timeline.w && timeline.h ? timeline.w / timeline.h : undefined}
              mode={isRange ? "range" : "seek"}
              value={isRange ? rangeValue : seekT}
              onSeek={(t2) => rt.seekToolTo(node.id, t2)}
              onRange={(r) => rt.rangeToolTo(node.id, r.start, r.duration, isRange)}
              onCommit={() => rt.commitVideoTool(node.id)}
              rangeLimits={rangeLimits}
              disabled={toolBusy}
            />
          )}
          {toolError && !toolBusy && <div className="fc-gen-warn">{toolError}</div>}
        </>
      )}
    </div>
  );
}
