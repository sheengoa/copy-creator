import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { CanvasNode } from "../../../stores/canvasStore";
import { useCanvasData } from "../dataContext";
import { extOf } from "../nodes/exts";
import { MENU_TYPE_ORDER, NODE_DEFAULT_SIZE, NODE_DEFS, loadAllowedExts, scopeFits } from "../nodes/registry";
import type { ViewState } from "./useViewport";

// OS 文件拖入（自 FreeCanvas.tsx 零改动搬运，2026-11-03 引擎拆分阶段 6b）：
// 命中加载/抽帧节点 = 加载到该节点；空白 = 按扩展名新建加载节点。
// 命中/分发语义查 nodes/registry 的 def（dropAccept/applyMode/
// blankDropExtensions）。

export function useFileDrop(
  vpRef: RefObject<HTMLDivElement | null>,
  view: ViewState,
  nodesRef: RefObject<CanvasNode[]>,
  applyFrameVideo: (nodeId: string, type: CanvasNode["type"], videoPath: string) => Promise<void>,
  pulseNodes: (ids: string[]) => void,
) {
  const data = useCanvasData();
  const scope = data.scope;
  const [dropHint, setDropHint] = useState(false);

  const handleFileDrop = useCallback(
    async (paths: string[], logical: { x: number; y: number }) => {
      const rect = vpRef.current?.getBoundingClientRect();
      const world = rect
        ? {
            x: (logical.x - rect.left - view.x) / view.scale,
            y: (logical.y - rect.top - view.y) / view.scale,
          }
        : { x: 0, y: 0 };
      // 命中加载节点：按节点类型过滤扩展名，加载到该节点（多文件取首张）。
      // 抽帧节点与 load_video 同吃视频扩展名，但写入 metadata.video_path
      // 并清旧帧产物（视频是输入，帧产物占 resource_path）。
      const hitEl = document.elementFromPoint(logical.x, logical.y) as Element | null;
      const targetNodeEl = hitEl?.closest(".pc-node[data-key]");
      const targetId = targetNodeEl?.getAttribute("data-key") ?? "";
      const targetNode = nodesRef.current.find((n) => n.id === targetId);
      // 命中节点是否接收拖入，查 def（dropAccept + 扩展名白名单 + 写回模式）。
      if (targetNode && NODE_DEFS[targetNode.type].dropAccept) {
        const allowed = loadAllowedExts(targetNode.type);
        const match = paths.find((p) => allowed.includes(extOf(p)));
        if (match) {
          await invoke("canvas_authorize_media", { path: match }).catch(() => {});
          if (NODE_DEFS[targetNode.type].applyMode === "video-tool") {
            await applyFrameVideo(targetNode.id, targetNode.type, match);
          } else {
            await data.updateNode(targetNode.id, { resourcePath: match });
          }
          return;
        }
        return;
      }
      // 空白：按扩展名分发到声明了 blankDropExtensions 的加载节点（图像/
      // 视频/音频，每文件一个，错开 24px）；不认识的扩展名忽略。作用域
      // 互斥（2026-11-05 阶段 B）：工程视图不创建自由画布加载节点。
      let offset = 0;
      const createdIds: string[] = [];
      for (const path of paths) {
        const ext = extOf(path);
        const kind = MENU_TYPE_ORDER.find(
          (t) => NODE_DEFS[t].blankDropExtensions?.includes(ext) && scopeFits(NODE_DEFS[t].scope, scope),
        ) ?? null;
        if (!kind) continue;
        try {
          await invoke("canvas_authorize_media", { path }).catch(() => {});
          const node = await data.createNode({
            nodeType: kind,
            posX: world.x + offset,
            posY: world.y + offset,
            width: NODE_DEFAULT_SIZE[kind].w,
            height: NODE_DEFAULT_SIZE[kind].h,
            resourcePath: path,
          });
          if (node) createdIds.push(node.id);
          offset += 24;
        } catch (err) {
          console.error("拖入加载失败:", err);
        }
      }
      pulseNodes(createdIds);
    },
    [applyFrameVideo, data, nodesRef, pulseNodes, scope, view.scale, view.x, view.y, vpRef],
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        // 保挂载面板：画布被 display:none 隐藏时不接管拖放。
        if (!vpRef.current || vpRef.current.offsetParent === null) return;
        const payload = event.payload;
        if (payload.type === "over" || payload.type === "drop") {
          const dpr = window.devicePixelRatio || 1;
          const logical = { x: payload.position.x / dpr, y: payload.position.y / dpr };
          if (payload.type === "over") {
            setDropHint(true);
          } else {
            setDropHint(false);
            void handleFileDrop(payload.paths, logical);
          }
        } else {
          setDropHint(false);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleFileDrop, vpRef]);

  return dropHint;
}
