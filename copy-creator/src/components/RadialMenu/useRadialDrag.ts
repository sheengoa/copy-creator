// 径向菜单原生拖拽子系统：条目按下的拖拽会话武装（arm）、阈值越限、
// 原生拖拽启动（先隐藏窗口释放捕获）、会话收尾与 document 级 pointer
// 事件装配。自 index.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）。
// 拖拽会话状态 ref 与选择态 ref 由 index 注入（大 effect 的 blur 编排、
// show 事件清理与 resetState 共享同一套会话状态）；预览收口经
// dismissPreviewForDrag / previewRef 注入（按下即收预览、收尾清预览）。

import { useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IS_LINUX, RADIAL_DRAG_THRESHOLD_PX, captureDragThumbnail, flog, type PendingNativeDrag, type RadialDragEvent } from "./radialShared";
import type { RadialDragSource } from "../../utils/radialDrag";

export function useRadialDrag({
  dragActiveRef,
  nativeDragRef,
  suppressClickRef,
  cancelledDragSessionsRef,
  activeDragSessionIdRef,
  dragSessionIdRef,
  visibleRef,
  setVisible,
  shiftClickSelectionModeRef,
  selectedItemIdsRef,
  setDragSessionItemId,
  setDraggingItemId,
  resetState,
  cancelPendingNativeDrag,
  dismissPreviewForDrag,
  previewRef,
}: {
  dragActiveRef: { current: boolean };
  nativeDragRef: { current: PendingNativeDrag | null };
  suppressClickRef: { current: boolean };
  cancelledDragSessionsRef: { current: Set<number> };
  activeDragSessionIdRef: { current: number | null };
  dragSessionIdRef: { current: number };
  visibleRef: { current: boolean };
  setVisible: (visible: boolean) => void;
  shiftClickSelectionModeRef: { current: boolean };
  selectedItemIdsRef: { current: string[] };
  setDragSessionItemId: (id: string | null) => void;
  setDraggingItemId: (id: string | null) => void;
  resetState: (preserveClickSuppression?: boolean) => void;
  cancelPendingNativeDrag: (pending: PendingNativeDrag | null) => void;
  dismissPreviewForDrag: () => void;
  previewRef: { current: { itemId: string } | null };
}) {
  const markRadialDragStarted = useCallback((pending: PendingNativeDrag) => {
    if (pending.nativeStarted) return;
    dragActiveRef.current = true;
    nativeDragRef.current = {
      ...pending,
      thresholdCrossed: true,
      nativeStarted: true,
    };
    suppressClickRef.current = true;
    setDraggingItemId(pending.itemId);
  }, [dragActiveRef, nativeDragRef, setDraggingItemId, suppressClickRef]);

  const startRadialFileDrag = useCallback((pending: PendingNativeDrag) => {
    if (
      !pending.thresholdCrossed
      || pending.startRequested
      || pending.nativeStarted
    ) return;

    const next = { ...pending, startRequested: true };
    nativeDragRef.current = next;
    // 先隐藏窗口再启动拖动：视觉即时反馈，同时释放 WebView2 的隐式
    // 鼠标捕获。此前要等后端解码完虚影才隐藏，期间界面毫无反应。
    // 停泊模型下后端不再 unmap 窗口（Linux），这里必须自行隐藏内容
    // （只翻 visible，不清拖拽会话状态——原生拖拽还在进行中）。
    visibleRef.current = false;
    setVisible(false);
    void invoke("hide_radial_menu");
    const dragId = next.dragIds ? JSON.stringify(next.dragIds) : next.itemId;
    flog(`invoking start_radial_file_drag session=${next.sessionId} item=${dragId}`);
    void invoke("start_radial_file_drag", {
      source: next.dragSource,
      id: dragId,
      path: next.dragPath || null,
      sessionId: next.sessionId,
      dragImageBase64: captureDragThumbnail(next.itemId),
    }).catch((error) => {
      flog(`start_radial_file_drag rejected session=${next.sessionId}: ${error}`);
      const current = nativeDragRef.current;
      if (
        !current
        || current.pointerId !== next.pointerId
        || current.sessionId !== next.sessionId
      ) return;
      resetState(true);
      void invoke("hide_radial_menu");
      console.error("Failed to start radial file drag:", error);
    });
  }, [nativeDragRef, resetState, setVisible, visibleRef]);

  const armRadialFileDrag = useCallback((pending: PendingNativeDrag) => {
    if (pending.armRequested || pending.nativeStarted) return;

    const next = { ...pending, armRequested: true };
    nativeDragRef.current = next;
    const dragId = next.dragIds ? JSON.stringify(next.dragIds) : next.itemId;
    void invoke("arm_radial_file_drag", {
      source: next.dragSource,
      id: dragId,
      path: next.dragPath || null,
      sessionId: next.sessionId,
      screenX: next.startScreenX,
      screenY: next.startScreenY,
      devicePixelRatio: next.devicePixelRatio,
    }).then(() => {
      const wasCancelled = cancelledDragSessionsRef.current.delete(next.sessionId);
      if (wasCancelled) {
        void invoke("cancel_radial_file_drag", {
          sessionId: next.sessionId,
        }).catch(() => {});
        return;
      }

      const current = nativeDragRef.current;
      if (
        !current
        || current.pointerId !== next.pointerId
        || current.sessionId !== next.sessionId
      ) return;
      nativeDragRef.current = {
        ...current,
        armCompleted: true,
      };
    }).catch((error) => {
      cancelledDragSessionsRef.current.delete(next.sessionId);
      const current = nativeDragRef.current;
      if (
        !current
        || current.pointerId !== next.pointerId
        || current.sessionId !== next.sessionId
      ) return;
      nativeDragRef.current = {
        ...current,
        armRequested: false,
        armCompleted: false,
      };
      if (current.thresholdCrossed) {
        suppressClickRef.current = true;
        dragActiveRef.current = false;
        nativeDragRef.current = null;
        activeDragSessionIdRef.current = null;
        setDragSessionItemId(null);
        setDraggingItemId(null);
        dismissPreviewForDrag();
      }
      console.error("Failed to arm radial file drag:", error);
    }).finally(() => {
      cancelledDragSessionsRef.current.delete(next.sessionId);
    });
    // arm 失败回滚收预览经 dismissPreviewForDrag（与 index 注入的预览收口一致）。
  }, [activeDragSessionIdRef, cancelledDragSessionsRef, dismissPreviewForDrag, dragActiveRef, nativeDragRef, setDragSessionItemId, setDraggingItemId, suppressClickRef]);

  const finishPendingPointerDrag = useCallback((pending: PendingNativeDrag) => {
    const current = nativeDragRef.current;
    if (!current || current.sessionId !== pending.sessionId) return;
    cancelPendingNativeDrag(current);
    nativeDragRef.current = null;
    dragActiveRef.current = false;
    if (activeDragSessionIdRef.current === pending.sessionId) {
      activeDragSessionIdRef.current = null;
    }
    setDragSessionItemId(null);
    setDraggingItemId(null);
    if (previewRef.current) dismissPreviewForDrag();
  }, [activeDragSessionIdRef, cancelPendingNativeDrag, dismissPreviewForDrag, dragActiveRef, nativeDragRef, previewRef, setDragSessionItemId, setDraggingItemId]);

  const handleItemPointerDown = useCallback((
    e: PointerEvent,
  ) => {
    const target = e.target instanceof Element
      ? e.target.closest<HTMLElement>(
          '[data-radial-item-id][data-radial-drag-kind="files"]',
        )
      : null;
    flog(
      `pointer-down btn=${e.button} primary=${e.isPrimary} dragActive=${dragActiveRef.current}`
      + ` nativeDrag=${nativeDragRef.current ? nativeDragRef.current.sessionId : "none"}`
      + ` matched=${target ? "yes" : "no"}`,
    );
    if (
      e.button !== 0
      || !e.isPrimary
      || dragActiveRef.current
      || nativeDragRef.current
    ) return;

    const itemId = target?.dataset.radialItemId;
    const selectedIds = shiftClickSelectionModeRef.current
      ? selectedItemIdsRef.current
      : [];
    const isSelectedItem = Boolean(itemId && selectedIds.includes(itemId));
    // Shift+按下未选中条目仍用于扩展选择；已选条目可直接拖出整组选中项。
    if (e.shiftKey && !isSelectedItem) return;
    let dragIds: string[] | undefined;
    if (isSelectedItem && selectedIds.length > 1) {
      // 混合选区（如文本+文件）拖拽放行：文本不可拖（OLE 拖不出剪切板
      // 文本与文件并存的目标体验），拖出其中的文件子集。子集恰为一个
      // 条目时退回普通单条拖拽（selection 来源要求 ≥2 个条目）；一个
      // 可拖条目都没有时维持旧行为吞掉这次按下。
      const fileKindIds = selectedIds.filter((id) => {
        const element = document.querySelector<HTMLElement>(
          `[data-radial-item-id="${CSS.escape(id)}"]`,
        );
        return element?.dataset.radialDragKind === "files";
      });
      if (fileKindIds.length > 1) {
        dragIds = fileKindIds;
      } else if (fileKindIds.length === 1 && fileKindIds[0] !== itemId) {
        suppressClickRef.current = true;
        return;
      }
    }
    const itemDragSource = target?.dataset.radialDragSource as RadialDragSource | undefined;
    const dragSource: RadialDragSource | undefined = dragIds
      ? "selection"
      : itemDragSource;
    if (
      !target
      || !itemId
      || (dragSource !== "clipboard"
        && dragSource !== "phrase"
        && dragSource !== "group"
        && dragSource !== "selection")
    ) {
      nativeDragRef.current = null;
      setDragSessionItemId(null);
      setDraggingItemId(null);
      return;
    }

    suppressClickRef.current = false;
    setDragSessionItemId(itemId);
    const pending: PendingNativeDrag = {
      itemId,
      dragIds,
      dragSource,
      dragPath: dragIds ? undefined : target.dataset.radialDragPath || undefined,
      sessionId: ++dragSessionIdRef.current,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      devicePixelRatio: window.devicePixelRatio || 1,
      thresholdCrossed: false,
      armRequested: false,
      armCompleted: false,
      startRequested: false,
      nativeStarted: false,
    };
    flog(`drag session armed item=${itemId} source=${dragSource} session=${pending.sessionId}`);
    nativeDragRef.current = pending;
    activeDragSessionIdRef.current = pending.sessionId;
    dismissPreviewForDrag();
    armRadialFileDrag(pending);
  }, [
    armRadialFileDrag,
    dismissPreviewForDrag,
    dragActiveRef,
    dragSessionIdRef,
    nativeDragRef,
    selectedItemIdsRef,
    setDragSessionItemId,
    setDraggingItemId,
    shiftClickSelectionModeRef,
    suppressClickRef,
  ]);

  const handleItemPointerMove = useCallback((e: PointerEvent) => {
    const pending = nativeDragRef.current;
    if (!pending || pending.pointerId !== e.pointerId) return;
    e.preventDefault();
    if (pending.nativeStarted) return;
    if (pending.thresholdCrossed) {
      return;
    }

    const distance = Math.hypot(
      e.clientX - pending.startX,
      e.clientY - pending.startY,
    );
    if (distance < RADIAL_DRAG_THRESHOLD_PX) return;

    flog(
      `threshold crossed session=${pending.sessionId} dist=${distance.toFixed(1)}`
      + ` client=(${e.clientX},${e.clientY}) screen=(${e.screenX},${e.screenY})`,
    );
    suppressClickRef.current = true;
    dragActiveRef.current = true;
    setDraggingItemId(pending.itemId);
    const crossed = { ...pending, thresholdCrossed: true };
    nativeDragRef.current = crossed;
    if (!IS_LINUX) startRadialFileDrag(crossed);
  }, [dragActiveRef, nativeDragRef, setDraggingItemId, startRadialFileDrag, suppressClickRef]);

  const handleItemPointerUp = useCallback((e: PointerEvent) => {
    const pending = nativeDragRef.current;
    if (!pending || pending.pointerId !== e.pointerId) return;
    if (pending.nativeStarted || pending.startRequested) return;
    finishPendingPointerDrag(pending);
  }, [finishPendingPointerDrag, nativeDragRef]);

  const handleRadialDragStarted = useCallback((event: { payload: RadialDragEvent }) => {
    const pending = nativeDragRef.current;
    if (
      !pending
      || activeDragSessionIdRef.current !== event.payload.session_id
      || pending.sessionId !== event.payload.session_id
    ) return;
    markRadialDragStarted(pending);
  }, [activeDragSessionIdRef, markRadialDragStarted, nativeDragRef]);

  const handleRadialDragFinished = useCallback((event: { payload: RadialDragEvent }) => {
    if (activeDragSessionIdRef.current !== event.payload.session_id) return;
    const pending = nativeDragRef.current;
    if (
      !pending
      || pending.sessionId !== event.payload.session_id
      || !dragActiveRef.current
    ) return;
    dragActiveRef.current = false;
    nativeDragRef.current = null;
    activeDragSessionIdRef.current = null;
    setDraggingItemId(null);
    resetState(true);
    void invoke("hide_radial_menu");
  }, [activeDragSessionIdRef, dragActiveRef, nativeDragRef, resetState, setDraggingItemId]);

  const handleDocumentPointerDown = useCallback((e: PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary) return;
    // 动作按钮是点击热区（28px），按下不应武装 6px 阈值的条目拖拽——
    // 预览触发器与收藏星标都豁免。
    if (
      e.target instanceof Element
      && (e.target.closest("[data-radial-preview-trigger]")
        || e.target.closest("[data-radial-item-pin]"))
    ) return;
    // 清掉上一次原生拖动为防止幽灵 click 留下的抑制标记。
    suppressClickRef.current = false;
    handleItemPointerDown(e);
  }, [handleItemPointerDown, suppressClickRef]);

  useEffect(() => {
    document.addEventListener("pointerdown", handleDocumentPointerDown, {
      capture: true,
      passive: false,
    });
    document.addEventListener("pointermove", handleItemPointerMove, {
      capture: true,
      passive: false,
    });
    document.addEventListener("pointerup", handleItemPointerUp, true);
    document.addEventListener("pointercancel", handleItemPointerUp, true);
    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
      document.removeEventListener("pointermove", handleItemPointerMove, true);
      document.removeEventListener("pointerup", handleItemPointerUp, true);
      document.removeEventListener("pointercancel", handleItemPointerUp, true);
    };
  }, [handleDocumentPointerDown, handleItemPointerMove, handleItemPointerUp]);

  return {
    finishPendingPointerDrag,
    handleRadialDragStarted,
    handleRadialDragFinished,
  };
}
