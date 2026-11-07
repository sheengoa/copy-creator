import { useTranslation } from "react-i18next";
import { Icons } from "../../../components/Icons";
import { MediaPlayback } from "../../../components/MediaPlayback";
import { useNodeErrors } from "./nodeErrors";
import { NodeHint } from "./NodeHint";
import { ResourceThumb } from "./media";
import { useVideoToolRuntime } from "./videoToolRuntimeCtx";
import type { NodeProps } from "./types";

// 视频抽帧节点内容层（视频首帧/尾帧，2026-11-01）：视频进、图片出。
// 视频在 metadata.video_path（来源：资源库/本地磁盘），提取出的帧图片占
// 节点行 resource_path（下游图像消费口通用聚合）。视频来源入口选定后与
// 加载节点同款「溜走」收合，×清除后滑回；两个状态的控制区等高，执行前后
// 节点外框尺寸一点不变（用户 2026-11-01 定案）。
// 悬浮×（2026-11-07 用户反馈）：与工具三节点/加载节点同款——只要加载了
// 视频且不在执行中就显示（未执行/失败/完成三态全覆盖），点击清空回未
// 加载态重新选片；此前只在执行成功有产物时渲染，未执行/失败态无从换片。
export function FrameExtractBody({ node, services }: NodeProps) {
  const { t } = useTranslation();
  const nodeErrors = useNodeErrors((s) => s.errors);
  const rt = useVideoToolRuntime();
  const isLastFrame = node.type === "video_last_frame";
  const meta = node.metadata;
  if (meta.kind !== "video_first_frame" && meta.kind !== "video_last_frame") return null;
  const videoPath = meta.video_path ?? "";
  const framePath = node.resource_path;
  const frameBusyNow = !!rt.frameBusy[node.id];
  const frameError = nodeErrors[node.id];
  // 悬浮×：清除视频回空态、产物一并清掉重新选片（与加载/工具节点同款）。
  const clearBtn = (
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
  );
  return (
    <div className="fc-node-form">
      {/* 视频来源入口：选定后与加载节点同款「溜走」收合，×清除后滑回 */}
      <div className={`fc-load-entry${videoPath ? " is-loaded" : ""}`}>
        <div className="fc-load-entry-clip">
          <div className="fc-node-placeholder">
            <i>{t("canvas.frameEmpty")}</i>
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
      {videoPath && !frameBusyNow && (
        <>
          <div className="fc-load-media">
            {framePath ? (
              <div className="fc-frame-thumb">
                <ResourceThumb path={framePath} className="fc-media-box" ratioFit />
                <span className="fc-frame-badge">
                  {isLastFrame ? t("canvas.frameLastBadge") : t("canvas.frameFirstBadge")}
                </span>
              </div>
            ) : (
              <MediaPlayback kind="video" path={videoPath} ratioFit />
            )}
            {clearBtn}
          </div>
          {framePath ? (
            <div className="fc-node-row">
              <span className="fc-frame-ok">{t("canvas.frameDone")}</span>
              <NodeHint text={isLastFrame ? t("canvas.frameHintLast") : t("canvas.frameHintFirst")}>
                <button
                  type="button"
                  className="fc-node-btn ghost"
                  onClick={() => void rt.runFrameExtract(node)}
                >
                  {t("canvas.frameRedo")}
                </button>
              </NodeHint>
            </div>
          ) : (
            <NodeHint text={frameError ? frameError : ""}>
              <button
                type="button"
                className="fc-node-btn accent"
                onClick={() => void rt.runFrameExtract(node)}
              >
                {t("canvas.frameExec")}
              </button>
            </NodeHint>
          )}
          {/* 与加载态同款可见提示行：两个状态的控制区等高，执行
              前后节点外框尺寸一点不变（用户 2026-11-01 定案）。 */}
          <div className="fc-frame-hint">
            {isLastFrame ? t("canvas.frameHintLast") : t("canvas.frameHintFirst")}
          </div>
        </>
      )}
      {videoPath && frameBusyNow && (
        <>
          <MediaPlayback kind="video" path={videoPath} ratioFit />
          <button type="button" className="fc-node-btn accent" disabled>
            {t("canvas.frameRunning")}
          </button>
        </>
      )}
      {frameError && !frameBusyNow && <div className="fc-gen-warn">{frameError}</div>}
    </div>
  );
}
