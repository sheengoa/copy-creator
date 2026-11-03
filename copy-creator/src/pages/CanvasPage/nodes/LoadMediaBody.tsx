import { useTranslation } from "react-i18next";
import { Icons } from "../../../components/Icons";
import { MediaPlayback } from "../../../components/MediaPlayback";
import { ResourceThumb } from "./media";
import { NodeHint } from "./NodeHint";
import { useNodeErrors } from "./nodeErrors";
import type { NodeProps } from "./types";

// 媒体加载三族内容层（image/video/audio）：已加载媒体盒（形态随类型）+
// 悬浮 × 清除；入口区（库选/盘选按钮行）只在空节点时可见——加载完成后
// 整体「溜走」收合（grid 行高收合 + 下滑淡出），× 清除后反向滑回。
export function LoadMediaBody({ node, services }: NodeProps) {
  const { t } = useTranslation();
  const nodeErrors = useNodeErrors((s) => s.errors);
  const kind = node.type === "load_image" ? "image" : node.type === "load_video" ? "video" : node.type === "load_audio" ? "audio" : null;
  if (!kind) return null;
  return (
    <div className="fc-node-form">
      {node.resource_path ? (
        <div className="fc-load-media">
          {kind === "image" ? (
            <ResourceThumb path={node.resource_path} className="fc-media-box" />
          ) : (
            <MediaPlayback kind={kind} path={node.resource_path} ratioFit={kind === "video"} />
          )}
          {/* 悬浮右上角的圆形 ×：清除已选文件回到未加载态，不必删节点重来。 */}
          <NodeHint text={t("canvas.clearLoaded")}>
            <button
              type="button"
              className="fc-load-clear"
              aria-label={t("canvas.clearLoaded")}
              onClick={(e) => {
                e.stopPropagation();
                services.clearMedia(node);
              }}
            >
              {Icons.close}
            </button>
          </NodeHint>
        </div>
      ) : (
        <div className="fc-node-placeholder">{t("canvas.loadEmpty")}</div>
      )}
      {/* 入口区（按钮行 + 提示）只在空节点时有意义：加载完成后
          整体"溜走"收起（grid 行高收合 + 下滑淡出），× 清除后
          反向滑回。生成节点的参数收起将复用这套动效。 */}
      <div className={`fc-load-entry${node.resource_path ? " is-loaded" : ""}`}>
        <div className="fc-load-entry-clip">
          <div className="fc-node-row">
            <NodeHint text={t("canvas.loadFromLibrary")} className="is-grow">
              <button
                className="fc-node-btn ghost is-icon grow"
                aria-label={t("canvas.loadFromLibrary")}
                onClick={() => services.pickMedia(node, "library")}
              >
                {Icons.resources}
              </button>
            </NodeHint>
            <NodeHint text={t("canvas.loadFromFile")} className="is-grow">
              <button
                className="fc-node-btn ghost is-icon grow"
                aria-label={t("canvas.loadFromFile")}
                onClick={() => services.pickMedia(node, "disk")}
              >
                {Icons.folderOpen}
              </button>
            </NodeHint>
          </div>
        </div>
      </div>
      {nodeErrors[node.id] && <div className="fc-gen-warn">{nodeErrors[node.id]}</div>}
    </div>
  );
}
