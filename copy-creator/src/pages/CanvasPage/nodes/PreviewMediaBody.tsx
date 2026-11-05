import { useTranslation } from "react-i18next";
import { MediaPlayback } from "../../../components/MediaPlayback";
import { ResourceThumb } from "./media";
import { NODE_DEFS } from "./registry";
import type { NodeProps } from "./types";

// 预览三族内容层：媒体形态由入口 mediaKind 驱动——image 静态缩略图，
// video/audio 内嵌 MediaPlayback；未连上游与已连等产物区分占位。
// （点击/双击放大已移除——2026-11-06 用户定案：节点媒体一律原位查看。）
export function PreviewMediaBody({ node, services }: NodeProps) {
  const { t } = useTranslation();
  const upstreamNode = services.upstream(node.id);
  const path = upstreamNode?.paths[0] ?? "";
  // 预览的媒体形态 = 入口的 mediaKind（out 恒 null）。
  const kind = NODE_DEFS[node.type].ports.ins[0]?.mediaKind;
  return (
    <div className="fc-node-form">
      {!upstreamNode ? (
        <div className="fc-node-placeholder">{t("canvas.previewEmpty")}</div>
      ) : kind === "image" ? (
        path ? (
          <ResourceThumb path={path} className="fc-media-box" ratioFit />
        ) : (
          <div className="fc-node-placeholder">{t("canvas.waitingUpstream")}</div>
        )
      ) : kind === "video" ? (
        path ? <MediaPlayback kind="video" path={path} ratioFit /> : <div className="fc-node-placeholder">{t("canvas.waitingUpstream")}</div>
      ) : (
        path ? <MediaPlayback kind="audio" path={path} /> : <div className="fc-node-placeholder">{t("canvas.waitingUpstream")}</div>
      )}
      {upstreamNode?.text && <div className="fc-preview-text">{upstreamNode.text}</div>}
    </div>
  );
}
