// 详情页文本标注子系统：阅读态划选换算全文偏移、标注工具条
// （高亮/加粗/下划线/复制/清除区间）、标注列表面板（定位/单删/清空）、
// 块内分段派生与 toast 反馈。
// 自 ResourceDetailPage.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）。
// 标注激活态（annotationsActive）、记录 id、取材全文（textContent）、
// 编辑态、文本分块与 stage 容器经 params 注入。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RefObject } from "react";
import {
  addResourceAnnotation,
  annotationsForChunk,
  buildAnnotatedSegments,
  clearResourceAnnotations,
  fetchResourceAnnotations,
  removeResourceAnnotation,
  removeResourceAnnotationsInRange,
  validateAnnotations,
  type AnnotationKind,
  type ResourceAnnotation,
} from "../../domain/annotations";
import type { ResourceTextPreview } from "../../domain/mediaAssets";

export function useResourceAnnotations({
  annotationsActive,
  recordId,
  recordNote,
  textContent,
  contentEditing,
  textChunks,
  stageRef,
}: {
  annotationsActive: boolean;
  recordId: string;
  recordNote: string | null | undefined;
  textContent: ResourceTextPreview | null;
  contentEditing: boolean;
  textChunks: string[];
  stageRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const [annotations, setAnnotations] = useState<ResourceAnnotation[]>([]);
  const [annSelection, setAnnSelection] = useState<
    { start: number; end: number; text: string } | null
  >(null);
  const [annFeedback, setAnnFeedback] = useState<string | null>(null);
  const annFeedbackTimer = useRef<number | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!annotationsActive || textContent === null) {
      setAnnotations([]);
      return;
    }
    let cancelled = false;
    fetchResourceAnnotations(recordId)
      .then((list) => {
        if (!cancelled) setAnnotations(validateAnnotations(textContent.content, list));
      })
      .catch(() => {
        if (!cancelled) setAnnotations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [annotationsActive, recordId, textContent]);

  useEffect(() => () => {
    if (annFeedbackTimer.current !== null) window.clearTimeout(annFeedbackTimer.current);
  }, []);

  // 记录切换必须清掉上一条记录的划选态：否则工具条残留，此时点标注
  // 会把旧记录的偏移区间写进新记录（脏标注）。
  useEffect(() => {
    setAnnSelection(null);
  }, [recordId, recordNote]);

  const showAnnFeedback = useCallback((message: string | null) => {
    setAnnFeedback(message);
    if (annFeedbackTimer.current !== null) window.clearTimeout(annFeedbackTimer.current);
    if (message !== null) {
      annFeedbackTimer.current = window.setTimeout(() => {
        setAnnFeedback(null);
        annFeedbackTimer.current = null;
      }, 1800);
    }
  }, []);

  // 每块的全局起点 + 字符数（供高度估算）+ 块内标注分段（标注偏移先经
  // domain 裁剪平移到块内）。
  const annotatedChunks = useMemo(() => {
    const result: { start: number; chars: number; segments: ReturnType<typeof buildAnnotatedSegments> }[] = [];
    let offset = 0;
    for (const chunk of textChunks) {
      result.push({
        start: offset,
        chars: chunk.length,
        segments: buildAnnotatedSegments(
          chunk,
          annotationsForChunk(annotations, offset, chunk.length),
        ),
      });
      offset += chunk.length;
    }
    return result;
  }, [textChunks, annotations]);

  const hideAnnToolbar = useCallback(() => {
    setAnnSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  // 阅读态划选：把 Selection 换算为全文偏移区间（跨块自动换算）。
  const handleStageMouseUp = useCallback(() => {
    if (toolbarRef.current?.contains(document.activeElement)) return;
    window.setTimeout(() => {
      if (contentEditing || !annotationsActive) {
        setAnnSelection(null);
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setAnnSelection(null);
        return;
      }
      const range = selection.getRangeAt(0);
      // 全文偏移 = 所在块起点 + 块内文本节点累计长度 + Range 在节点内的偏移。
      // offsetInNode 缺失会让同节点内的划选算出 start === end，工具条永不出现。
      const locate = (node: Node | null, offsetInNode: number): number | null => {
        let current: Node | null = node;
        while (current && current !== stageRef.current) {
          if (current instanceof HTMLElement && current.dataset.chunkStart !== undefined) {
            const chunkStart = Number(current.dataset.chunkStart);
            const walker = document.createTreeWalker(current, NodeFilter.SHOW_TEXT);
            let total = 0;
            while (walker.nextNode()) {
              if (walker.currentNode === node) return chunkStart + total + offsetInNode;
              total += walker.currentNode.textContent?.length ?? 0;
            }
            return null;
          }
          current = current.parentNode;
        }
        return null;
      };
      const start = locate(range.startContainer, range.startOffset);
      const end = locate(range.endContainer, range.endOffset);
      if (start === null || end === null || start === end) {
        setAnnSelection(null);
        return;
      }
      const [lo, hi] = start < end ? [start, end] : [end, start];
      const text = textContent?.content.slice(lo, hi) ?? "";
      if (!text.trim()) {
        setAnnSelection(null);
        return;
      }
      setAnnSelection({ start: lo, end: hi, text });
    }, 10);
  }, [contentEditing, annotationsActive, textContent, stageRef]);

  const applyAnnotation = useCallback((kind: AnnotationKind) => {
    if (!annSelection) return;
    addResourceAnnotation(recordId, annSelection.start, annSelection.end - annSelection.start, kind, annSelection.text)
      .then((annotation) => {
        setAnnotations((prev) => [...prev, annotation]);
        hideAnnToolbar();
      })
      .catch(() => showAnnFeedback(t("resources.annSaveFailed")));
  }, [annSelection, recordId, hideAnnToolbar, showAnnFeedback, t]);

  const clearAnnotationsInRange = useCallback(() => {
    if (!annSelection) return;
    const { start, end } = annSelection;
    removeResourceAnnotationsInRange(recordId, start, end - start)
      .then(() => {
        setAnnotations((prev) => prev.filter(
          (a) => !(a.start < end && a.start + a.length > start),
        ));
        hideAnnToolbar();
        showAnnFeedback(t("resources.annCleared"));
      })
      .catch(() => showAnnFeedback(t("resources.annSaveFailed")));
  }, [annSelection, recordId, hideAnnToolbar, showAnnFeedback, t]);

  const copySelectedText = useCallback(() => {
    if (!annSelection) return;
    (navigator.clipboard?.writeText(annSelection.text) ?? Promise.reject())
      .then(() => showAnnFeedback(t("resources.annCopied")))
      .catch(() => showAnnFeedback(t("resources.annCopyFailed")));
    hideAnnToolbar();
  }, [annSelection, hideAnnToolbar, showAnnFeedback, t]);

  const removeOneAnnotation = useCallback((id: string) => {
    removeResourceAnnotation(id)
      .then((removed) => {
        if (removed) setAnnotations((prev) => prev.filter((a) => a.id !== id));
      })
      .catch(() => showAnnFeedback(t("resources.annSaveFailed")));
  }, [showAnnFeedback, t]);

  const clearAllAnnotations = useCallback(() => {
    clearResourceAnnotations(recordId)
      .then(() => {
        setAnnotations([]);
        showAnnFeedback(t("resources.annAllCleared"));
      })
      .catch(() => showAnnFeedback(t("resources.annSaveFailed")));
  }, [recordId, showAnnFeedback, t]);

  const jumpToAnnotation = useCallback((id: string) => {
    const target = stageRef.current?.querySelector(`[data-ann="${id}"]`);
    if (!(target instanceof HTMLElement)) {
      showAnnFeedback(t("resources.annJumpMiss"));
      return;
    }
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.remove("ann-jump"); void target.offsetWidth;
    target.classList.add("ann-jump");
    window.setTimeout(() => target.classList.remove("ann-jump"), 2100);
  }, [showAnnFeedback, t, stageRef]);

  // 工具条定位：钉在选区上方，箭头跟随选区中心；超出 stage 视口时收拢。
  useLayoutEffect(() => {
    if (!annSelection || !stageRef.current || !toolbarRef.current) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const live = selection.getRangeAt(0);
    // 定位依赖几何信息；环境不提供（如测试的 jsdom）时跳过，工具条
    // 仍渲染在 stage 内容位置，功能不受影响。
    if (typeof live.getBoundingClientRect !== "function") return;
    const liveRect = live.getBoundingClientRect();
    const stage = stageRef.current;
    const stageRect = stage.getBoundingClientRect();
    const toolbar = toolbarRef.current;
    const top = liveRect.top - stageRect.top + stage.scrollTop - 46;
    const centerX = liveRect.left - stageRect.left + liveRect.width / 2;
    const left = Math.min(
      Math.max(8, centerX - toolbar.offsetWidth / 2),
      stage.clientWidth - toolbar.offsetWidth - 8,
    );
    toolbar.style.top = `${Math.max(6, top)}px`;
    toolbar.style.left = `${Math.max(8, left)}px`;
    toolbar.style.setProperty("--arrow-x", `${centerX - left}px`);
  }, [annSelection, stageRef]);

  return {
    annotations,
    annSelection,
    setAnnSelection,
    annFeedback,
    toolbarRef,
    annotatedChunks,
    handleStageMouseUp,
    hideAnnToolbar,
    applyAnnotation,
    clearAnnotationsInRange,
    copySelectedText,
    removeOneAnnotation,
    clearAllAnnotations,
    jumpToAnnotation,
  };
}
