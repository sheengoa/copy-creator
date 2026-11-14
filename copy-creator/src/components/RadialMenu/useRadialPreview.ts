// 径向菜单预览子系统：悬浮条目的展开/收起动画、分段加载与缓存、
// 输入区扩放收口。自 index.tsx 拆出（2026-11-14，架构守卫规则 27 行数
// 上限）；拖拽会话状态经 dragActiveRef / nativeDragRef 注入（预览必须
// 给拖拽让路：拖拽期间禁止展开，收起动画遇拖拽立即中断）。

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useClipboardStore } from "../../stores/clipboardStore";
import { usePhraseStore, isImageFilePath } from "../../stores/phraseStore";
import { readResourceTextPreview, readQuickInputTextPreview } from "../../domain/mediaAssets";
import type { RadialPreviewDirection } from "../../domain/preview";
import {
  loadRecordPreviewSegments,
  RADIAL_PREVIEW_WIDTH,
  type RadialPreviewSegment,
} from "../../domain/preview";
import { inferResourceMediaKind } from "../../domain/mediaKind";
import { getResourcePath, isResourceRecord } from "../../domain/records";
import { flog, type PendingNativeDrag, type PreviewLayout, type PreviewState, type RadialItem } from "./radialShared";

export function useRadialPreview({
  dragActiveRef,
  nativeDragRef,
}: {
  dragActiveRef: { current: boolean };
  nativeDragRef: { current: PendingNativeDrag | null };
}) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  // 收起动画播放中：预览保持挂载滑出，动画结束才真正卸载并恢复穿透。
  const [previewClosing, setPreviewClosing] = useState(false);
  // 条带方向决定主面板贴窗口哪一侧（几何固定，会话内不变）：state 供
  // 渲染取类名，ref 供异步展开逻辑读取。
  const [previewSide, setPreviewSide] = useState<RadialPreviewDirection>("right");
  const previewRequestRef = useRef(0);
  const previewRef = useRef<PreviewState | null>(null);
  const previewCloseTimerRef = useRef<number | null>(null);
  const previewSideRef = useRef<RadialPreviewDirection>("right");
  const previewWidthRef = useRef(RADIAL_PREVIEW_WIDTH);
  const previewCacheRef = useRef(new Map<string, RadialPreviewSegment[]>());

  useEffect(() => { previewRef.current = preview; }, [preview]);

  const invalidatePreviewRequest = useCallback(() => {
    previewRequestRef.current += 1;
  }, []);

  // 展开/收起只做两件事：挂载/卸载预览面板 + 通知后端扩放输入区域。
  // 窗口几何自打开时按"面板 + 预留条带"分配后就固定不变——X11 上任何
  // resize/move 都会被合成器画出一帧"旧内容按左上锚定 + 新区域未绘制"
  // 的闪烁帧（实测帧证据），这是扩展闪烁的物理根源，必须整体绕开。
  // 收起因此也在 web 层做：预览滑出动画播放完毕才卸载并恢复条带穿透，
  // 动画期间输入区域保持展开（用户看到的预览仍可点击）。animated=false
  // 用于窗口隐藏等无需动效的路径，立即复位。
  const cancelPreviewClose = useCallback(() => {
    if (previewCloseTimerRef.current !== null) {
      window.clearTimeout(previewCloseTimerRef.current);
      previewCloseTimerRef.current = null;
    }
    setPreviewClosing(false);
  }, []);

  const collapsePreview = useCallback((animated = true) => {
    invalidatePreviewRequest();
    previewRef.current = null;
    cancelPreviewClose();
    if (!animated) {
      setPreview(null);
      void invoke("set_radial_hit_area", { expanded: false }).catch(() => {});
      return;
    }
    setPreviewClosing(true);
    previewCloseTimerRef.current = window.setTimeout(() => {
      previewCloseTimerRef.current = null;
      setPreviewClosing(false);
      setPreview(null);
      void invoke("set_radial_hit_area", { expanded: false }).catch(() => {});
    }, 160);
  }, [invalidatePreviewRequest, cancelPreviewClose]);

  const dismissPreviewForDrag = useCallback(() => {
    collapsePreview();
  }, [collapsePreview]);

  const expandPreviewWindow = useCallback(async (
    request: number,
    item: RadialItem,
  ): Promise<PreviewLayout | null> => {
    if (dragActiveRef.current || nativeDragRef.current) return null;
    if (request !== previewRequestRef.current) return null;
    if (previewRef.current) return previewRef.current.layout;
    // 收起动画尚在播放时重新展开：取消待执行的卸载，面板直接续用。
    cancelPreviewClose();
    // 条带方向与宽度由后端在打开窗口时一次性决定并随事件下发，
    // 前端不再查询显示器/计算窗口几何。
    const layout = { direction: previewSideRef.current, width: previewWidthRef.current };
    if (layout.width <= 0) return null;
    try {
      // 先扩输入区再挂载面板：面板出现的同一帧即可接收指针事件。
      await invoke("set_radial_hit_area", { expanded: true });
    } catch (error) {
      flog(`[preview] expand hit-area failed: ${String(error)}`);
    }
    if (
      request !== previewRequestRef.current
      || dragActiveRef.current
      || nativeDragRef.current
    ) {
      return null;
    }
    const loadingState = {
      itemId: item.id,
      segments: null,
      layout,
    };
    previewRef.current = loadingState;
    setPreview(loadingState);
    return layout;
  }, [cancelPreviewClose, dragActiveRef, nativeDragRef]);

  const loadPreviewSegments = useCallback(async (item: RadialItem) => {
    const cached = previewCacheRef.current.get(item.id);
    if (cached) return cached;

    const record = useClipboardStore.getState().records.find((entry) => entry.id === item.id);
    let segments: RadialPreviewSegment[];
    if (record) {
      if (isResourceRecord(record)) {
        const kind = inferResourceMediaKind(record);
        const resourcePath = getResourcePath(record);
        if (kind === "image") {
          segments = [{ type: "image", path: resourcePath, version: item.resourceVersion }];
        } else if (kind === "video" || kind === "audio") {
          segments = [{ type: kind, path: resourcePath, version: item.resourceVersion }];
        } else if (item.textPreviewPath) {
          // 文本取材经 domain 判定读文件内容（含编辑后 type 为 text 的记录），
          // 不依赖 resource_kind 与 type；大文件由后端截断返回，读取失败时
          // 回退为路径展示。
          try {
            const preview = await readResourceTextPreview(item.textPreviewPath);
            segments = [{ type: "text", content: preview.content }];
          } catch {
            segments = [{ type: "text", content: item.textPreviewPath }];
          }
        } else {
          const content = kind === "text"
            ? await useClipboardStore.getState().getRecordContent(record)
            : item.resourceTitle || item.content;
          segments = [{ type: "text", content }];
        }
      } else {
        segments = await loadRecordPreviewSegments({
          id: record.id,
          recordType: record.type,
          content: record.content,
          contentTruncated: Boolean(record.content_truncated),
          hasImages: Boolean(record.has_images),
        });
      }
    } else {
      const phrase = usePhraseStore.getState().phrases.find((entry) => entry.id === item.id);
      if (phrase && phrase.input_type === "file" && isImageFilePath(phrase.content)) {
        segments = [{ type: "image", path: phrase.content }];
      } else if (phrase && phrase.input_type === "file") {
        // 文件短语：常见文本格式读取内容预览，与主窗口一致。
        try {
          const text = await readQuickInputTextPreview(phrase.content);
          segments = [{ type: "text", content: text }];
        } catch {
          segments = [{ type: "text", content: phrase.content }];
        }
      } else {
        segments = [{ type: "text", content: phrase?.content ?? item.content }];
      }
    }
    previewCacheRef.current.set(item.id, segments);
    return segments;
  }, []);

  const showPreview = useCallback(async (item: RadialItem) => {
    if (dragActiveRef.current || nativeDragRef.current) return;
    const request = ++previewRequestRef.current;
    const layout = await expandPreviewWindow(request, item);
    if (
      !layout
      || request !== previewRequestRef.current
      || dragActiveRef.current
      || nativeDragRef.current
    ) return;
    try {
      const segments = await loadPreviewSegments(item);
      if (
        request !== previewRequestRef.current
        || dragActiveRef.current
        || nativeDragRef.current
      ) return;
      const loadedState = {
        itemId: item.id,
        segments,
        layout,
      };
      previewRef.current = loadedState;
      setPreview(loadedState);
    } catch {
      if (
        request !== previewRequestRef.current
        || dragActiveRef.current
        || nativeDragRef.current
      ) return;
      const failedState = {
        itemId: item.id,
        segments: [{ type: "text" as const, content: item.content }],
        layout,
      };
      previewRef.current = failedState;
      setPreview(failedState);
    }
  }, [expandPreviewWindow, loadPreviewSegments, dragActiveRef, nativeDragRef]);

  const togglePreview = useCallback((item: RadialItem) => {
    if (previewRef.current?.itemId === item.id) {
      collapsePreview();
      return;
    }
    void showPreview(item);
  }, [collapsePreview, showPreview]);

  const handlePreviewLeave = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (
      !previewRef.current
      || dragActiveRef.current
      || nativeDragRef.current
    ) return;

    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    collapsePreview();
  }, [collapsePreview, dragActiveRef, nativeDragRef]);

  return {
    /** 预览面板状态（渲染 ContentPreviewPanel 与展开宽度样式）。 */
    preview,
    /** 收起滑出动画播放中：面板保持挂载。 */
    previewClosing,
    /** 条带方向（渲染取类名；show 事件经 setPreviewSide 同步）。 */
    previewSide,
    setPreviewSide,
    /** 条带几何 ref：show 事件按后端预留条带同步（几何固定不再计算）。 */
    previewSideRef,
    previewWidthRef,
    /** 分段缓存：show 事件清空（每次打开菜单取新鲜内容）。 */
    previewCacheRef,
    /** 预览实况镜像（拖拽收尾等异步逻辑读，不触发重渲）。 */
    previewRef,
    invalidatePreviewRequest,
    collapsePreview,
    dismissPreviewForDrag,
    togglePreview,
    handlePreviewLeave,
  };
}
