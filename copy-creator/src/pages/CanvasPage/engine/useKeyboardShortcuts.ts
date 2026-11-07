import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { CanvasNode } from "../../../stores/canvasStore";
import { useCanvasData } from "../dataContext";
import { memberFrameOf } from "./groupOps";

// 键盘快捷键（自 FreeCanvas.tsx 零改动搬运，2026-11-03 引擎拆分阶段 6b）：
// 删除选中、撤销、全选、复制粘贴、Ctrl+G 打组/解组。

export function useKeyboardShortcuts(
  vpRef: RefObject<HTMLDivElement | null>,
  nodesRef: RefObject<CanvasNode[]>,
  selRef: RefObject<string[]>,
  setSelection: (keys: string[]) => void,
  addMenuOpen: boolean,
  copySelection: () => void,
  pasteClipboard: () => Promise<void> | void,
  runUndo: () => void,
  runRedo: () => void,
  deleteSelected: () => Promise<void> | void,
) {
  const data = useCanvasData();
  const { t } = useTranslation();

  // 防重入：StrictMode 开发态会双挂载键盘监听，一次 Ctrl+G 建组又解组。
  const groupingRef = useRef(false);
  const toggleGroup = useCallback(() => {
    if (groupingRef.current) return;
    groupingRef.current = true;
    window.setTimeout(() => {
      groupingRef.current = false;
    }, 0);
    const sel = selRef.current;
    if (sel.length === 0) return;
    // 先剪枝：成员已被删除的组清掉死成员（空组丢弃）。
    const pruned = data
      .groups()
      .map((g) => ({ ...g, members: g.members.filter((key) => memberFrameOf(nodesRef, key) !== null) }))
      .filter((g) => g.members.length > 0);
    const fullGroup = pruned.find(
      (g) => g.members.length === sel.length && sel.every((key) => g.members.includes(key)),
    );
    if (fullGroup) {
      void data.setGroups(pruned.filter((g) => g.id !== fullGroup.id));
    } else {
      const kept = pruned
        .map((g) => ({ ...g, members: g.members.filter((key) => !sel.includes(key)) }))
        .filter((g) => g.members.length > 0);
      void data.setGroups([
        ...kept,
        {
          id: `ng${Date.now()}${Math.floor(Math.random() * 1e4)}`,
          label: t("project.canvas.nodeGroup"),
          members: [...sel],
        },
      ]);
    }
  }, [data, nodesRef, selRef, t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      // 面板保挂载：画布被 display:none 隐藏（用户在其他顶级区）时不响应。
      if (!vpRef.current || vpRef.current.offsetParent === null) return;
      // 弹层打开时不响应（对齐工程画布惯例）。
      if (document.querySelector(".dialog-overlay, .canvas-dialog-overlay, .canvas-chip-popover") || addMenuOpen) {
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl) {
        const k = e.key.toLowerCase();
        if (k === "c") {
          copySelection();
          return;
        }
        if (k === "v") {
          e.preventDefault();
          void pasteClipboard();
          return;
        }
        if (k === "z") {
          e.preventDefault();
          // Shift 组合＝重做（与 Ctrl+Y 等价，照顾两派手感）。
          if (e.shiftKey) runRedo();
          else runUndo();
          return;
        }
        if (k === "y") {
          e.preventDefault();
          runRedo();
          return;
        }
        if (k === "a") {
          e.preventDefault();
          setSelection(nodesRef.current.map((n) => n.id));
          return;
        }
        if (k === "g") {
          e.preventDefault();
          toggleGroup();
          return;
        }
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selRef.current.length) {
        e.preventDefault();
        void deleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addMenuOpen, copySelection, deleteSelected, nodesRef, pasteClipboard, runRedo, runUndo, selRef, setSelection, toggleGroup, vpRef]);
}
