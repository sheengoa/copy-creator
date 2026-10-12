import {
  openResourceFile,
  readResourceTextDetail,
  readResourceTextPreview,
  type ResourceTextPreview,
} from "../../domain/mediaAssets";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord } from "../../types";
import { useResourceStore } from "../../stores/clipboardStore";
import { Icons } from "../../components/Icons";
import { BackToTopButton } from "../../components/BackToTop";
import { useBackToTop } from "../../hooks/useBackToTop";
import { ImageLightbox } from "../../components/ImageLightbox";
import FindReplaceBar from "../../components/FindReplaceBar";
import { findMatchPositions } from "../../utils/findReplace";
import { loadRecordPreviewSegments, splitTextChunks, type RadialPreviewSegment } from "../../domain/preview";
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
import { formatResourceBitrate, formatResourceDuration, formatResourceFileSize } from "./resourceUtils";
import { type ResourceMediaKind } from "../../domain/mediaKind";
import { getResourceFileName, isResourceTitleRenameable, splitResourceFileName } from "../../domain/fileName";
import { formatResourceFolderPath } from "../../domain/groups";
import { inferResourceMediaKind } from "../../domain/mediaKind";
import { resolveResourceMediaUrl } from "../../domain/mediaUrl";
import { getResourcePath, getResourceTitle, resourceMediaVersion, resourceTextPreviewPath } from "../../domain/records";
import { useRecordLocale } from "../../hooks/useRecordLocale";
import {
  ResourceImageOriginal,
  ResourceMediaPlayer,
  ResourceSegments,
  type ResourceMediaMetadata,
} from "./ResourceMedia";

interface ResourceDetailPageProps {
  record: ClipboardRecord;
  typeLabel: (kind: ResourceMediaKind) => string;
  onBack: () => void;
  onCopy: (record: ClipboardRecord) => void | Promise<void>;
  onDelete: (id: string) => void;
  onRecordUpdated: (record: ClipboardRecord) => void;
  onMoveRecord?: (record: ClipboardRecord) => void;
}

/* 自绘滚动进度条 thumb 在滚动视口上下的留白（px） */
const SCROLLBAR_INSET = 14;

/* content-visibility 跳渲染时的高度估算：每行约 72 个全半角混合字符，
   行高由 CSS 1.9em 承担。硬编码大估算值会在小文本上严重失真
   （曾用 30000px，5KB 文本滚动行程被撑成 13 倍），必须按块字符数算。 */
const CHUNK_CHARS_PER_LINE = 72;

/* ── 文本标注工具条：高亮色板与图标（纯图标 + data-tip 悬停说明） ── */
const ANN_HL_KINDS: { kind: AnnotationKind; tipKey: string; swatchClass: string }[] = [
  { kind: "hl-y", tipKey: "resources.annHlY", swatchClass: "tb-swatch-y" },
  { kind: "hl-g", tipKey: "resources.annHlG", swatchClass: "tb-swatch-g" },
  { kind: "hl-b", tipKey: "resources.annHlB", swatchClass: "tb-swatch-b" },
  { kind: "hl-o", tipKey: "resources.annHlO", swatchClass: "tb-swatch-o" },
  { kind: "hl-p", tipKey: "resources.annHlP", swatchClass: "tb-swatch-p" },
];

const ANN_ICONS = {
  bold: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 4h6.5a3.5 3.5 0 0 1 0 7H7z" />
      <path d="M7 11h7.5a3.5 3.5 0 0 1 0 7H7z" />
    </svg>
  ),
  underline: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M7 4v6.5a5 5 0 0 0 10 0V4" />
      <path d="M5 20h14" />
    </svg>
  ),
  copy: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  ),
  eraser: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 16 8.5-8.5a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L13 20H8z" />
      <path d="M6 20h13" />
    </svg>
  ),
  pen: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19l7-7a4.95 4.95 0 1 0-7-7l-7 7v7h7z" />
      <path d="M16 5l3 3" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
};

export default function ResourceDetailPage({
  record,
  typeLabel,
  onBack,
  onCopy,
  onDelete,
  onRecordUpdated,
  onMoveRecord,
}: ResourceDetailPageProps) {
  const { t } = useTranslation();
  const recordLocale = useRecordLocale();
  const updateResourceNote = useResourceStore((state) => state.updateResourceNote);
  const kind = inferResourceMediaKind(record);
  const resourcePath = getResourcePath(record);
  const mediaVersion = resourceMediaVersion(record);
  const [segments, setSegments] = useState<RadialPreviewSegment[] | null>(null);
  const [textContent, setTextContent] = useState<ResourceTextPreview | null>(null);
  // 加载失败的后端原因（文件丢失/非文本等），null=无错误；空串表示拿不到
  // 具体原因，展示时回退泛化文案。超限不属于失败——后端截断返回。
  const [errorReason, setErrorReason] = useState<string | null>(null);
  // 「用系统应用打开」失败反馈（超长文本回退态的兜底动作）。
  const [openExternalFailed, setOpenExternalFailed] = useState(false);
  // ── 文本标注（阅读态划选标记）──
  const [annotations, setAnnotations] = useState<ResourceAnnotation[]>([]);
  const [annSelection, setAnnSelection] = useState<
    { start: number; end: number; text: string } | null
  >(null);
  const [annFeedback, setAnnFeedback] = useState<string | null>(null);
  const annFeedbackTimer = useRef<number | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  // 正文列自绘滚动进度条（WebKitGTK 原生滚动条不可见）。
  // mainEl 用 callback ref + state：hash 直开详情页时记录异步加载、
  // MAIN 晚于组件挂载渲染——普通 ref 的 effect 会因拿到 null 而早退，
  // 滚动监听与初始进度将永不绑定。
  const mainElRef = useRef<HTMLElement | null>(null);
  const [mainElReady, setMainElReady] = useState(false);
  const scrollThumbRef = useRef<HTMLDivElement | null>(null);
  const scrollTrackRef = useRef<HTMLDivElement | null>(null);
  // 拖动进行中挂在 window 上的监听清理函数；组件卸载（HMR、记录删除）
  // 或重复按下时调用，避免监听器悬挂到下一次 pointerup。
  const thumbDragCleanupRef = useRef<(() => void) | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [mediaSource, setMediaSource] = useState<string | null>(null);
  const [mediaMeta, setMediaMeta] = useState<ResourceMediaMetadata>({});
  const [noteDraft, setNoteDraft] = useState(record.resource_note ?? "");
  const [savedNote, setSavedNote] = useState(record.resource_note ?? "");
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);
  const [noteError, setNoteError] = useState(false);
  const noteSavedTimerRef = useRef<number | null>(null);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [contentEditing, setContentEditing] = useState(false);
  const [contentDraft, setContentDraft] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [contentSaving, setContentSaving] = useState(false);
  const [contentSaved, setContentSaved] = useState(false);
  // 正文保存失败的后端原因（超 1 MB、文件被外部替换等），null=无错误；
  // 空串表示拿不到具体原因，展示时回退泛化文案。
  const [contentSaveError, setContentSaveError] = useState<string | null>(null);
  const contentSavedTimerRef = useRef<number | null>(null);
  const contentEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // 文本取材唯一入口（domain 判定）：有文件承载一律读文件全文——含详情页
  // 编辑后 type 已转为 text 的记录；无文件承载的纯文本资源走 segments。
  const externalTextPath = kind === "text" ? resourceTextPreviewPath(record) : null;
  const noteDirty = noteDraft.trim() !== savedNote;

  useEffect(() => {
    setMediaMeta({});
    setLightboxSrc(null);
    setNoteDraft(record.resource_note ?? "");
    setSavedNote(record.resource_note ?? "");
    setNoteSaved(false);
    setNoteError(false);
    setRenameDraft(null);
    setRenameError(null);
    setContentEditing(false);
    setContentSaved(false);
    setContentSaveError(null);
    setOpenExternalFailed(false);
    // 记录切换必须清掉上一条记录的划选态：否则工具条残留，此时点标注
    // 会把旧记录的偏移区间写进新记录（脏标注）。
    setAnnSelection(null);
  }, [record.id, record.resource_note]);

  useEffect(() => () => {
    if (noteSavedTimerRef.current !== null) window.clearTimeout(noteSavedTimerRef.current);
    if (contentSavedTimerRef.current !== null) window.clearTimeout(contentSavedTimerRef.current);
  }, []);

  // 编辑器高度跟随内容伸缩，避免固定高度出现内部滚动条截断正文。
  // 加 2px 余量：分数缩放下 scrollHeight 取整可能略小于实际内容，
  // 否则会浮现一条内部滚动条（滚动统一交给主窗口页面层级）。
  useEffect(() => {
    const el = contentEditorRef.current;
    if (!el) return;
    const syncHeight = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
    };
    syncHeight();
    window.addEventListener("resize", syncHeight);
    return () => window.removeEventListener("resize", syncHeight);
  }, [contentDraft, contentEditing]);

  // 详情页自身不滚动，滚动发生在窗口内容容器（祖先节点）上；
  // 用统一 hook 解析该滚动容器，下滑后显示「回到顶部」按钮。
  const pageRef = useRef<HTMLDivElement | null>(null);
  const findPageScroller = useCallback(() => {
    // 滚动收敛后，详情页真正的滚动容器是正文列（mainElRef）。旧实现沿
    // 祖先链找 overflow:auto 的元素，收敛后只会命中零溢出、恒不滚动的
    // 外层面板——scrollTop 恒 0，返回顶部按钮因此永不出现。正文列晚于
    // 组件就绪时（全文异步加载）由 mainElReady 触发本回调重建、hook 重新解析。
    return mainElRef.current;
  }, [mainElReady]);
  const backToTop = useBackToTop({ resolveContainer: findPageScroller });

  const handleSaveNote = async () => {
    const note = noteDraft.trim();
    if (noteSaving || note === savedNote) return;
    setNoteSaving(true);
    setNoteError(false);
    try {
      const saved = await invoke<string>("set_resource_note", {
        id: record.id,
        note,
      });
      setSavedNote(saved);
      setNoteDraft(saved);
      updateResourceNote(record.id, saved);
      setNoteSaved(true);
      if (noteSavedTimerRef.current !== null) window.clearTimeout(noteSavedTimerRef.current);
      noteSavedTimerRef.current = window.setTimeout(() => {
        setNoteSaved(false);
        noteSavedTimerRef.current = null;
      }, 2200);
    } catch {
      setNoteError(true);
    } finally {
      setNoteSaving(false);
    }
  };

  // 超长文本回退态的兜底动作：用系统默认程序打开文件（阅读/编辑皆宜）。
  const handleOpenExternal = () => {
    if (!externalTextPath) return;
    setOpenExternalFailed(false);
    openResourceFile(externalTextPath).catch(() => setOpenExternalFailed(true));
  };

  const mediaMetaRows = useMemo(() => {
    const rows: { label: string; value: string }[] = [];
    if (mediaMeta.width && mediaMeta.height) {
      rows.push({
        label: t("resources.metaResolution"),
        value: `${mediaMeta.width}×${mediaMeta.height}`,
      });
    }
    if (mediaMeta.duration) {
      rows.push({
        label: t("resources.metaDuration"),
        value: formatResourceDuration(mediaMeta.duration),
      });
    }
    if (kind === "video" || kind === "audio") {
      const bitrate = formatResourceBitrate(record.resource_file_size, mediaMeta.duration);
      if (bitrate) rows.push({ label: t("resources.metaBitrate"), value: bitrate });
    }
    return rows;
  }, [kind, mediaMeta, record.resource_file_size, t]);

  useEffect(() => {
    let cancelled = false;
    const fail = (reason: unknown) => {
      if (!cancelled) setErrorReason(typeof reason === "string" ? reason : "");
    };
    setSegments(null);
    setTextContent(null);
    setErrorReason(null);
    setMediaSource(null);
    if (kind === "video" || kind === "audio" || kind === "file" || kind === "image") {
      if (kind === "video" || kind === "audio") {
        resolveResourceMediaUrl(resourcePath, mediaVersion)
          .then((url) => {
            if (!cancelled) setMediaSource(url);
          })
          .catch(fail);
      }
      return () => {
        cancelled = true;
      };
    }

    if (externalTextPath) {
      // 详情页优先全文（64 MB 上限内整读，前端分块虚拟渲染）；超上限
      // 或读取失败回退 1 MB 截断预览，预览也失败才是真错误（文件缺失、
      // 非文本、非 UTF-8），由 fail 透传原因。
      readResourceTextDetail(externalTextPath)
        .then((preview) => {
          if (!cancelled) setTextContent(preview);
        })
        .catch(() => {
          readResourceTextPreview(externalTextPath)
            .then((preview) => {
              if (!cancelled) setTextContent(preview);
            })
            .catch(fail);
        });
      return () => {
        cancelled = true;
      };
    }

    loadRecordPreviewSegments({
      id: record.id,
      recordType: record.type,
      content: record.content,
      contentTruncated: Boolean(record.content_truncated),
      hasImages: Boolean(record.has_images),
    })
      .then((next: RadialPreviewSegment[]) => {
        if (!cancelled) setSegments(next);
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [externalTextPath, kind, mediaVersion, record, resourcePath]);

  const title = getResourceTitle(record, kind, recordLocale);

  const renameable = isResourceTitleRenameable(record);
  // 标题编辑基于文件名：文件记录的路径在 content/resource_path，文本资源记录的
  // 路径只在 resource_path（content 是正文）。
  const titlePath = record.type === "file" || record.type === "image"
    ? getResourcePath(record)
    : record.resource_path || "";
  const { stem: currentStem, extension: titleExtension } = splitResourceFileName(
    getResourceFileName(titlePath),
  );

  const cancelRename = () => {
    setRenameDraft(null);
    setRenameError(null);
  };

  const commitRename = async () => {
    if (renameDraft === null || renameSaving) return;
    const stem = renameDraft.trim();
    if (!stem) {
      setRenameError(t("resources.nameRequired"));
      return;
    }
    if (stem === currentStem) {
      cancelRename();
      return;
    }
    setRenameSaving(true);
    setRenameError(null);
    try {
      const updated = await invoke<{
        id: string;
        resource_path?: string;
        resource_relative_path?: string | null;
        content?: string;
      }>("rename_resource_file", { id: record.id, newName: stem });
      onRecordUpdated({
        ...record,
        ...(updated.id ? { id: updated.id } : null),
        ...(updated.resource_path !== undefined
          ? { resource_path: updated.resource_path }
          : null),
        ...(updated.content !== undefined ? { content: updated.content } : null),
        ...(updated.resource_relative_path
          ? { resource_relative_path: updated.resource_relative_path }
          : null),
      });
      setRenameDraft(null);
    } catch (error) {
      setRenameError(String(error));
    } finally {
      setRenameSaving(false);
    }
  };

  const detailReady = kind === "video" || kind === "audio"
    ? Boolean(mediaSource)
    : kind === "file" || kind === "image" || Boolean(segments);
  const textDetailReady = externalTextPath ? textContent !== null : Boolean(segments);
  // 截断展示（>64MB 回退 1MB 预览）时禁止进入正文编辑：编辑器持有的
  // 是前缀副本，保存会以副本覆盖整个文件、丢掉未展示的部分。
  const textDetailTruncated = textContent?.truncated === true;
  const contentReady = externalTextPath ? textDetailReady : detailReady;
  // 正文分块（domain 切分，配合 CSS content-visibility 只排版可视块）。
  const textChunks = useMemo(
    () => (textContent ? splitTextChunks(textContent.content) : []),
    [textContent],
  );

  // ── 文本标注：加载与锚文本校验 ──
  // 仅完整全文态启用（截断回退态内容不完整，标注定位无意义）；编辑态
  // 暂离（textarea 内不显示标注），退出后随文本重载重新校验。
  const annotationsActive = Boolean(externalTextPath) && !textDetailTruncated && !contentEditing;
  useEffect(() => {
    if (!annotationsActive || textContent === null) {
      setAnnotations([]);
      return;
    }
    let cancelled = false;
    fetchResourceAnnotations(record.id)
      .then((list) => {
        if (!cancelled) setAnnotations(validateAnnotations(textContent.content, list));
      })
      .catch(() => {
        if (!cancelled) setAnnotations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [annotationsActive, record.id, textContent]);

  useEffect(() => () => {
    if (annFeedbackTimer.current !== null) window.clearTimeout(annFeedbackTimer.current);
  }, []);

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
  }, [contentEditing, annotationsActive, textContent]);

  const applyAnnotation = useCallback((kind: AnnotationKind) => {
    if (!annSelection) return;
    addResourceAnnotation(record.id, annSelection.start, annSelection.end - annSelection.start, kind, annSelection.text)
      .then((annotation) => {
        setAnnotations((prev) => [...prev, annotation]);
        hideAnnToolbar();
      })
      .catch(() => showAnnFeedback(t("resources.annSaveFailed")));
  }, [annSelection, record.id, hideAnnToolbar, showAnnFeedback, t]);

  const clearAnnotationsInRange = useCallback(() => {
    if (!annSelection) return;
    const { start, end } = annSelection;
    removeResourceAnnotationsInRange(record.id, start, end - start)
      .then(() => {
        setAnnotations((prev) => prev.filter(
          (a) => !(a.start < end && a.start + a.length > start),
        ));
        hideAnnToolbar();
        showAnnFeedback(t("resources.annCleared"));
      })
      .catch(() => showAnnFeedback(t("resources.annSaveFailed")));
  }, [annSelection, record.id, hideAnnToolbar, showAnnFeedback, t]);

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
    clearResourceAnnotations(record.id)
      .then(() => {
        setAnnotations([]);
        showAnnFeedback(t("resources.annAllCleared"));
      })
      .catch(() => showAnnFeedback(t("resources.annSaveFailed")));
  }, [record.id, showAnnFeedback, t]);

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
  }, [showAnnFeedback, t]);

  // ── 正文列滚动进度条（自绘）：WebKitGTK 的原生滚动条不可见，
  // 用 sticky 轨道 + thumb 反映阅读进度；thumb 位置直接写 style。
  // 轨道元素高度为 0（sticky 钉住不占布局），行程几何一律从滚动
  // 视口（main）推导，轨道自身 clientHeight 恒为 0 不可用作分母。 ──
  const trackMetrics = useCallback(() => {
    const main = mainElRef.current;
    if (!main) return null;
    const trackH = Math.max(0, main.clientHeight - SCROLLBAR_INSET * 2);
    const max = main.scrollHeight - main.clientHeight;
    const thumbH = Math.max(48, main.clientHeight > 0
      ? trackH * (main.clientHeight / main.scrollHeight)
      : trackH);
    return { main, trackH, max, thumbH };
  }, []);

  const updateScrollThumb = useCallback(() => {
    const metrics = trackMetrics();
    const thumb = scrollThumbRef.current;
    if (!metrics || !thumb) return;
    const { main, trackH, max, thumbH } = metrics;
    const y = SCROLLBAR_INSET + (trackH - thumbH) * (max > 0 ? main.scrollTop / max : 0);
    thumb.style.height = `${Math.round(thumbH)}px`;
    thumb.style.transform = `translateY(${Math.round(y)}px)`;
  }, [trackMetrics]);

  // callback ref：元素挂载/卸载时记录并发出就绪信号（滚动监听随之绑定）
  const setMainElRef = useCallback((el: HTMLElement | null) => {
    mainElRef.current = el;
    setMainElReady(el !== null);
  }, []);

  // thumb 当前顶部（translateY 值，与 updateScrollThumb 的写入口径一致）
  const currentThumbTop = useCallback(
    () => parseFloat(scrollThumbRef.current?.style.transform.replace(/[^\d.-]/g, "") || "0") || 0,
    [],
  );

  // thumb 目标顶部位置换算滚动位置（超出轨道行程时夹取）
  const thumbYToScroll = useCallback((thumbTopY: number) => {
    const metrics = trackMetrics();
    if (!metrics) return;
    const { main, trackH, max, thumbH } = metrics;
    const clamped = Math.max(0, Math.min(thumbTopY - SCROLLBAR_INSET, trackH - thumbH));
    main.scrollTop = max * (clamped / (trackH - thumbH || 1));
  }, [trackMetrics]);

  // 拖动用 window 级原生监听：不依赖 setPointerCapture（各引擎行为
  // 差异大，WebKitGTK 上曾失效），指针快速移动或移出窗口也不丢。
  const beginThumbDrag = useCallback((grabOffset: number) => {
    const track = scrollTrackRef.current;
    if (!track) return;
    const trackTop = () => track.getBoundingClientRect().top;
    const onMove = (ev: PointerEvent) => {
      thumbYToScroll(ev.clientY - trackTop() - grabOffset);
    };
    const onUp = () => {
      thumbDragCleanupRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    thumbDragCleanupRef.current?.();
    thumbDragCleanupRef.current = onUp;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [thumbYToScroll]);

  useEffect(() => () => thumbDragCleanupRef.current?.(), []);

  const handleTrackPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const metrics = trackMetrics();
    const track = scrollTrackRef.current;
    if (!metrics || !track) return;
    event.preventDefault();
    const y = event.clientY - track.getBoundingClientRect().top;
    if (event.target === scrollThumbRef.current) {
      // 抓住 thumb：保持按下点相对 thumb 顶部的偏移，原地进入拖动不跳变
      beginThumbDrag(y - currentThumbTop());
    } else {
      // 点击轨道空白：thumb 中心对齐点击处跳转并进入拖动
      thumbYToScroll(y - metrics.thumbH / 2);
      beginThumbDrag(metrics.thumbH / 2);
    }
  }, [beginThumbDrag, currentThumbTop, thumbYToScroll, trackMetrics]);

  useEffect(() => {
    const main = mainElRef.current;
    if (!mainElReady || !main) return;
    // 滚动/窗口尺寸变化时同步更新 thumb（轻量 style 写入，无需 rAF
    // 节流——后台页面 rAF 被冻结会导致更新完全停摆）。
    const update = () => updateScrollThumb();
    main.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
    // 内容高度变化（content-visibility 块进入视口按真实高度重排、字体
    // 加载完成等）不触发 scroll 事件，main 自身是恒定高的滚动视口也测
    // 不到——观察内容容器 stage，高度跳变时同步 thumb 比例。
    let observer: ResizeObserver | null = null;
    const content = stageRef.current;
    if (typeof ResizeObserver !== "undefined" && content) {
      observer = new ResizeObserver(update);
      observer.observe(content);
    }
    return () => {
      main.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [mainElReady, updateScrollThumb]);

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
  }, [annSelection]);

  // 正文编辑面向有文件承载的文本资源（不含内嵌图片）：取材与保存目标
  // 都是文件本身，文件是全文的唯一事实来源。
  // 编辑目标与取材同源：一律指向 backing 文件（domain 判定已校验文本扩展名）。
  const textEditPath = kind === "text" ? externalTextPath : null;
  const fullTextContent = useMemo(() => {
    if (externalTextPath) return textContent?.content ?? null;
    if (!segments) return null;
    return segments
      .filter((segment): segment is Extract<RadialPreviewSegment, { type: "text" }> =>
        segment.type === "text")
      .map((segment) => segment.content)
      .join("\n");
  }, [externalTextPath, segments, textContent]);
  // 全文加载后截断不再是唯一编辑门槛：正文过大同样不适合应用内编辑，
  // 用系统应用修改文件，改动经监听与媒体版本机制同步回来。闸门与写入
  // 侧（write_resource_text_content 的 ensure_capped_file，1 MiB =
  // 1024 × 1024 字节）同值同口径——字符数口径对中文会放宽约 3 倍，
  // 1～3 MB 的中文文件会「进得去编辑、存不回去」。文件大小缺失时退回
  // 字符数估算。
  const contentEditable = Boolean(textEditPath) && !record.has_images && fullTextContent !== null
    && !textDetailTruncated
    && (record.resource_file_size ?? fullTextContent.length) <= 1024 * 1024;
  // 正文加载完成后把当前内容作为「已保存」基准，进入编辑态时以此为草稿初值。
  useEffect(() => {
    if (fullTextContent === null) return;
    setSavedContent(fullTextContent);
  }, [fullTextContent]);
  const contentDirty = contentDraft.trim() !== savedContent.trim();

  // ── 查找替换（编辑模式，Ctrl+F）──
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findReplaceText, setFindReplaceText] = useState("");
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findIndex, setFindIndex] = useState(0);
  // 查找条 fixed 定位：按内容区（stage）的实时视口位置钉在其右上角，
  // 随页面滚动/窗口缩放持续跟随（信息面板与窗口头不被遮挡）。
  const [findBarPos, setFindBarPos] = useState({ top: 120, right: 24 });
  const findMatches = useMemo(
    () => (contentEditing ? findMatchPositions(contentDraft, findQuery, findCaseSensitive) : []),
    [contentEditing, contentDraft, findQuery, findCaseSensitive],
  );

  useEffect(() => {
    if (!findOpen || !contentEditing) return;
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => {
      const rect = stage.getBoundingClientRect();
      setFindBarPos((prev) => {
        const next = {
          top: Math.max(rect.top + 20, 76),
          right: Math.max(window.innerWidth - rect.right + 28, 14),
        };
        return prev.top === next.top && prev.right === next.right ? prev : next;
      });
    };
    update();
    const scroller = findPageScroller();
    scroller?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      scroller?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [findOpen, contentEditing, findPageScroller]);

  // 选中指定匹配并滚到可视区：textarea 自动增高、无内部滚动，页面级
  // 滚动容器按匹配所在行手工定位——浏览器对 focus 的默认呈现不保证
  // 滚到选区（用户实测「下一个匹配」不跳转）。
  const focusFindMatch = useCallback((start: number, end: number) => {
    const textarea = contentEditorRef.current;
    if (!textarea) return;
    textarea.setSelectionRange(start, end);
    textarea.focus();
    const scroller = findPageScroller();
    if (!scroller) return;
    const style = window.getComputedStyle(textarea);
    const lineHeight =
      Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5 || 20;
    const line = (contentDraft.slice(0, start).match(/\n/g) ?? []).length;
    const textareaRect = textarea.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const target =
      textareaRect.top - scrollerRect.top + scroller.scrollTop + line * lineHeight + 8;
    scroller.scrollTop = Math.max(0, target - scroller.clientHeight / 3);
  }, [contentDraft, findPageScroller]);

  const goToFindMatch = useCallback((index: number) => {
    if (findMatches.length === 0) return;
    const wrapped = ((index % findMatches.length) + findMatches.length) % findMatches.length;
    setFindIndex(wrapped);
    const start = findMatches[wrapped];
    focusFindMatch(start, start + findQuery.length);
  }, [findMatches, findQuery, focusFindMatch]);

  // 查询/大小写变化只更新计数与索引：textarea 无法在不移动光标的
  // 前提下高亮匹配，若此处抢焦点选区，会把用户正在查找输入框打的字
  // 截进正文（曾实测「打着字光标突然跳走」）。定位只发生在显式导航。
  const handleFindQueryChange = useCallback((query: string) => {
    setFindQuery(query);
    setFindIndex(0);
  }, []);

  const handleFindCaseSensitiveChange = useCallback((nextCaseSensitive: boolean) => {
    setFindCaseSensitive(nextCaseSensitive);
    setFindIndex(0);
  }, []);

  const handleFindReplaceCurrent = useCallback(() => {
    if (findMatches.length === 0 || findQuery === "") return;
    const index = Math.min(findIndex, findMatches.length - 1);
    const start = findMatches[index];
    const nextDraft =
      contentDraft.slice(0, start) + findReplaceText + contentDraft.slice(start + findQuery.length);
    setContentDraft(nextDraft);
    setContentSaveError(null);
    const positions = findMatchPositions(nextDraft, findQuery, findCaseSensitive);
    const shifted = positions.findIndex((position) => position >= start + findReplaceText.length);
    const target = shifted === -1 ? 0 : shifted;
    setFindIndex(target);
    if (positions.length > 0) focusFindMatch(positions[target], positions[target] + findQuery.length);
  }, [contentDraft, findMatches, findIndex, findQuery, findReplaceText, findCaseSensitive, focusFindMatch]);

  const handleFindReplaceAll = useCallback(() => {
    if (findMatches.length === 0 || findQuery === "") return;
    let result = "";
    let cursor = 0;
    for (const position of findMatches) {
      result += contentDraft.slice(cursor, position) + findReplaceText;
      cursor = position + findQuery.length;
    }
    result += contentDraft.slice(cursor);
    setContentDraft(result);
    setContentSaveError(null);
    setFindIndex(0);
    contentEditorRef.current?.focus();
  }, [contentDraft, findMatches, findQuery, findReplaceText]);

  const startContentEdit = () => {
    setContentDraft(fullTextContent ?? "");
    setContentSaved(false);
    setContentSaveError(null);
    setContentEditing(true);
  };

  const cancelContentEdit = () => {
    setContentEditing(false);
    setContentDraft("");
    setContentSaveError(null);
  };

  const handleSaveContent = async () => {
    if (!textEditPath || contentSaving || !contentDirty) return;
    setContentSaving(true);
    setContentSaveError(null);
    try {
      const saved = await invoke<{ content: string; record_type?: string }>(
        "write_resource_text_content",
        {
          path: textEditPath,
          content: contentDraft,
          ...(record.resource_managed !== false ? { id: record.id } : {}),
        },
      );
      setContentEditing(false);
      setContentDraft("");
      setSavedContent(saved.content);
      setContentSaved(true);
      if (contentSavedTimerRef.current !== null) window.clearTimeout(contentSavedTimerRef.current);
      contentSavedTimerRef.current = window.setTimeout(() => {
        setContentSaved(false);
        contentSavedTimerRef.current = null;
      }, 2200);
      onRecordUpdated({
        ...record,
        // 保存后记录归一为文件承载形态（与 write_resource_text_content 的
        // 归一更新一致）：type=file、content=文件路径，全文以文件为唯一事实来源。
        type: "file",
        content: saved.content,
      });
    } catch (error) {
      // 超长、文件被外部替换等失败重试无效，后端原因必须可见；拿不到
      // 原因时展示层回退泛化文案。
      setContentSaveError(typeof error === "string" ? error : "");
    } finally {
      setContentSaving(false);
    }
  };

  return (
    <div className="resource-detail-page" ref={pageRef}>
      <header className="resource-detail-header">
        <button type="button" className="resource-back-button" onClick={onBack}>
          {Icons.arrowLeft}
          <span>{t("resources.backToLibrary")}</span>
        </button>
        <div className="resource-detail-actions">
          {contentEditable && !contentEditing && (
            <button
              type="button"
              className="resource-secondary-button"
              onClick={startContentEdit}
            >
              {Icons.edit}
              <span>{t("resources.editContent")}</span>
            </button>
          )}
          {contentEditing && (
            <>
              <button
                type="button"
                className="resource-secondary-button"
                onClick={cancelContentEdit}
                disabled={contentSaving}
              >
                <span>{t("resources.discardChanges")}</span>
              </button>
              <button
                type="button"
                className="resource-primary-button"
                onClick={() => void handleSaveContent()}
                disabled={contentSaving || !contentDirty}
              >
                <span>{contentSaving ? t("common.saving") : t("resources.saveChanges")}</span>
              </button>
            </>
          )}
          {contentSaved && <span className="resource-content-saved" role="status">{t("resources.contentSaved")}</span>}
          {contentSaveError !== null && (
            <span className="resource-content-error" role="alert">
              {contentSaveError || t("resources.contentSaveFailed")}
            </span>
          )}
          <button type="button" className="resource-secondary-button" onClick={() => void onCopy(record)}>
            {Icons.copy}
            <span>{t("resources.copy")}</span>
          </button>
          <button type="button" className="resource-delete-button resource-detail-delete" onClick={() => onDelete(record.id)}>
            {Icons.delete}
            <span>{t("common.delete")}</span>
          </button>
        </div>
      </header>

      <main
        className="resource-detail-body"
        onDoubleClick={(event) => {
          // 视图态：双击内容区进入编辑。编辑态：双击文本区/控件外的
          // 任意空白（含内容框外的页面空白）退出——有修改保存退出，
          // 无修改直接退出（否则未改动的编辑态无法用双击离开）；
          // 文本区内双击保留原生选词。标题双击是重命名，信息面板是
          // 备注编辑，均排除。
          if (!contentEditable) return;
          const target = event.target instanceof HTMLElement ? event.target : null;
          if (!target) return;
          if (
            target.closest(
              "button, a, input, textarea, select, img, video, audio, .find-replace-bar, .resource-detail-aside, .resource-detail-header, .resource-detail-title",
            )
          ) {
            return;
          }
          if (!contentEditing) {
            if (target.closest(".resource-detail-stage")) startContentEdit();
            return;
          }
          if (contentSaving) return;
          if (!contentDirty) {
            cancelContentEdit();
            return;
          }
          void handleSaveContent();
        }}
      >
        <section
          className="resource-detail-main"
          ref={setMainElRef}
          aria-busy={!(externalTextPath ? textDetailReady : detailReady) && !errorReason}
        >
          <div
            className="resource-main-scrollbar-track"
            ref={scrollTrackRef}
            role="scrollbar"
            aria-controls="resource-detail-main-scroll"
            aria-orientation="vertical"
            aria-valuenow={undefined}
            onPointerDown={handleTrackPointerDown}
          >
            <div className="resource-main-scrollbar-thumb" ref={scrollThumbRef} />
          </div>
          <span className="resource-detail-kind">{typeLabel(kind)}</span>
          {renameDraft === null ? (
            <h1
              className={renameable ? "resource-detail-title" : undefined}
              title={renameable ? t("resources.renameTitleHint") : undefined}
              onDoubleClick={renameable ? () => {
                setRenameDraft(currentStem);
                setRenameError(null);
              } : undefined}
            >
              {title}
            </h1>
          ) : (
            <div className="resource-detail-title-editor">
              <input
                className="resource-detail-title-input"
                autoFocus
                value={renameDraft}
                maxLength={120}
                disabled={renameSaving}
                aria-label={t("resources.renameTitleHint")}
                onChange={(event) => {
                  setRenameDraft(event.target.value);
                  setRenameError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commitRename();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
                onBlur={() => void commitRename()}
              />
              {titleExtension && (
                <span className="resource-detail-title-extension">{titleExtension}</span>
              )}
              {renameError && (
                <span className="resource-detail-title-error" role="alert">{renameError}</span>
              )}
            </div>
          )}
          <p className="resource-detail-subtitle">
            {typeLabel(kind)} · {record.source_app || t("resources.localSource")}
          </p>
          <div
            ref={stageRef}
            className={`resource-detail-stage resource-detail-stage-${kind}`}
            onMouseUp={handleStageMouseUp}
          >
            {contentEditing && findOpen && createPortal(
              <FindReplaceBar
                style={{
                  position: "fixed",
                  top: findBarPos.top,
                  right: findBarPos.right,
                }}
                query={findQuery}
                replacement={findReplaceText}
                caseSensitive={findCaseSensitive}
                matchCount={findMatches.length}
                matchIndex={findIndex}
                onQueryChange={handleFindQueryChange}
                onReplacementChange={setFindReplaceText}
                onCaseSensitiveChange={handleFindCaseSensitiveChange}
                onNext={() => goToFindMatch(findIndex + 1)}
                onPrev={() => goToFindMatch(findIndex - 1)}
                onReplaceCurrent={handleFindReplaceCurrent}
                onReplaceAll={handleFindReplaceAll}
                onClose={() => setFindOpen(false)}
              />,
              document.body,
            )}
            {errorReason !== null ? (
              <div className="resource-detail-error" role="alert">
                <strong>{t("resources.detailError")}</strong>
                {errorReason && <span>{errorReason}</span>}
                <button type="button" className="resource-secondary-button" onClick={onBack}>
                  {t("resources.backToLibrary")}
                </button>
              </div>
            ) : !contentReady ? (
              <div className="resource-preview-loading" role="status">{t("common.loading")}</div>
            ) : kind === "video" || kind === "audio" ? (
              <ResourceMediaPlayer
                kind={kind}
                path={resourcePath}
                resolvedSrc={mediaSource ?? undefined}
                onMediaMetadata={setMediaMeta}
                version={mediaVersion}
              />
            ) : kind === "image" ? (
              <>
                <ResourceImageOriginal
                  path={resourcePath}
                  alt={title}
                  className="resource-segment-image"
                  onMetadata={({ width, height }) => setMediaMeta({ width, height })}
                  onZoom={(src) => setLightboxSrc(src)}
                  version={mediaVersion}
                />
                {lightboxSrc && (
                  <ImageLightbox
                    src={lightboxSrc}
                    alt={title}
                    onClose={() => setLightboxSrc(null)}
                  />
                )}
              </>
            ) : kind === "file" ? (
              <div className="resource-detail-file">
                {Icons.file}
                <strong>{getResourceFileName(resourcePath)}</strong>
                <span>
                  {t("resources.fileDetailNote")}
                  {record.resource_file_size !== undefined && ` · ${formatResourceFileSize(record.resource_file_size)}`}
                </span>
                <code>{record.resource_relative_path || record.resource_path || record.content}</code>
              </div>
            ) : contentEditing && contentEditable ? (
              <textarea
                ref={contentEditorRef}
                className="resource-detail-text-editor"
                autoFocus
                value={contentDraft}
                maxLength={1_000_000}
                disabled={contentSaving}
                aria-label={t("resources.editContent")}
                onChange={(event) => {
                  setContentDraft(event.target.value);
                  setContentSaveError(null);
                }}
                onKeyDown={(event) => {
                  // Escape 只退出编辑（放弃改动），不触发页面级返回。
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelContentEdit();
                    return;
                  }
                  // Ctrl+Enter 保存（双击选词与 Enter 换行语义保持原生）。
                  // 中文输入法激活时 key 可能报 "Process"，补 code 物理键判断。
                  if (
                    (event.ctrlKey || event.metaKey)
                    && (event.key === "Enter" || event.code === "Enter")
                  ) {
                    event.preventDefault();
                    if (contentDirty && !contentSaving) void handleSaveContent();
                    return;
                  }
                  // Ctrl+F 开/关查找替换条。
                  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
                    event.preventDefault();
                    event.stopPropagation();
                    setFindOpen((open) => !open);
                  }
                }}
              />
            ) : externalTextPath ? (
              <div className="resource-detail-text-body">
                {textDetailTruncated && (
                  <div className="resource-detail-truncated-hint" role="note">
                    <span>{t("resources.textTruncatedHint")}</span>
                    {openExternalFailed && (
                      <span className="resource-text-external-failed" role="alert">
                        {t("resources.openInSystemAppFailed")}
                      </span>
                    )}
                    <button
                      type="button"
                      className="resource-secondary-button resource-text-external-open"
                      onClick={handleOpenExternal}
                    >
                      {t("resources.openInSystemApp")}
                    </button>
                  </div>
                )}
                <div className="resource-detail-text-chunks">
                  {annotatedChunks.map((chunk, index) => (
                    <pre
                      key={index}
                      className="resource-detail-text-chunk"
                      data-chunk-start={chunk.start}
                      style={{
                        containIntrinsicSize: `auto calc(${Math.ceil(chunk.chars / CHUNK_CHARS_PER_LINE)} * 1.9em)`,
                      }}
                    >
                      {chunk.segments.map((segment, segIndex) =>
                        segment.kinds.length ? (
                          <span
                            key={segIndex}
                            className={`ann ${segment.kinds.join(" ")}`}
                            data-ann={segment.annId}
                          >
                            {segment.text}
                          </span>
                        ) : (
                          segment.text
                        ),
                      )}
                    </pre>
                  ))}
                </div>
                {annSelection && !contentEditing && (
                  <div
                    ref={toolbarRef}
                    className="annotation-toolbar"
                    role="toolbar"
                    aria-label={t("resources.annToolbarLabel")}
                  >
                    {ANN_HL_KINDS.map((entry) => (
                      <button
                        key={entry.kind}
                        type="button"
                        className="tb-btn"
                        data-tip={t(entry.tipKey)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => applyAnnotation(entry.kind)}
                      >
                        <span className={`tb-swatch ${entry.swatchClass}`} />
                      </button>
                    ))}
                    <span className="tb-divider" />
                    <button
                      type="button"
                      className="tb-btn"
                      data-tip={t("resources.annBold")}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => applyAnnotation("bold")}
                    >
                      {ANN_ICONS.bold}
                    </button>
                    <button
                      type="button"
                      className="tb-btn"
                      data-tip={t("resources.annUnderline")}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => applyAnnotation("underline")}
                    >
                      {ANN_ICONS.underline}
                    </button>
                    <span className="tb-divider" />
                    <button
                      type="button"
                      className="tb-btn"
                      data-tip={t("resources.annCopy")}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={copySelectedText}
                    >
                      {ANN_ICONS.copy}
                    </button>
                    {annotations.some(
                      (a) => a.start < annSelection.end && a.start + a.length > annSelection.start,
                    ) && (
                      <button
                        type="button"
                        className="tb-btn danger"
                        data-tip={t("resources.annClear")}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={clearAnnotationsInRange}
                      >
                        {ANN_ICONS.eraser}
                      </button>
                    )}
                  </div>
                )}
                {annFeedback && (
                  <div className="annotation-toast" role="status">{annFeedback}</div>
                )}
              </div>
            ) : (
              <ResourceSegments segments={segments || []} />
            )}
          </div>
        </section>

        <aside className="resource-detail-aside" aria-label={t("resources.info")}>
          <h2>{t("resources.info")}</h2>
          <dl>
            <div>
              <dt>{t("resources.type")}</dt>
              <dd>{typeLabel(kind)}</dd>
            </div>
            <div>
              <dt>{t("resources.createdAt")}</dt>
              <dd>{new Date(record.created_at).toLocaleString()}</dd>
            </div>
            {record.resource_file_size !== undefined && (
              <div>
                <dt>{t("resources.fileSize")}</dt>
                <dd>{formatResourceFileSize(record.resource_file_size)}</dd>
              </div>
            )}
            {mediaMetaRows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
            {record.source_app && (
              <div>
                <dt>{t("resources.sourceApp")}</dt>
                <dd>{record.source_app}</dd>
              </div>
            )}
          </dl>
          {annotationsActive && (
            <section className="marker-panel" aria-label={t("resources.markerPanelTitle")}>
              <div className="marker-head">
                <h2 className="marker-title">
                  {t("resources.markerPanelTitle")}
                  <span className="marker-count">{annotations.length}</span>
                </h2>
                {annotations.length > 0 && (
                  <button
                    type="button"
                    className="marker-clear-all"
                    onClick={clearAllAnnotations}
                  >
                    {t("resources.markerClearAll")}
                  </button>
                )}
              </div>
              {annotations.length === 0 ? (
                <div className="marker-empty">
                  {ANN_ICONS.pen}
                  <p>{t("resources.markerEmpty")}</p>
                </div>
              ) : (
                <ul className="marker-list">
                  {[...annotations]
                    .sort((a, b) => a.start - b.start)
                    .map((annotation) => {
                      const percent = fullTextContent === null || fullTextContent.length === 0
                        ? 0
                        : Math.min(100, Math.round((annotation.start / fullTextContent.length) * 100));
                      const excerpt = annotation.anchorText
                        .slice(0, 48)
                        .replace(/\n/g, " ");
                      const kindLabel = annotation.kind.startsWith("hl-")
                        ? t("resources.markerKindHighlight", {
                            color: t(`resources.annHl${annotation.kind.slice(3).toUpperCase()}`),
                          })
                        : annotation.kind === "bold"
                          ? t("resources.markerKindBold")
                          : t("resources.markerKindUnderline");
                      return (
                        <li
                          key={annotation.id}
                          className={annotation.stale
                            ? `marker-item kind-${annotation.kind} stale`
                            : `marker-item kind-${annotation.kind}`}
                          title={annotation.stale
                            ? t("resources.annStaleHint")
                            : t("resources.markerJumpHint")}
                          onClick={() => {
                            if (!annotation.stale) jumpToAnnotation(annotation.id);
                          }}
                        >
                          <span className="marker-body">
                            <span className="marker-excerpt">{excerpt}</span>
                            <span className="marker-meta">
                              {kindLabel}
                              {" · "}
                              {annotation.stale
                                ? t("resources.annStale")
                                : t("resources.markerPosition", { percent })}
                            </span>
                          </span>
                          <button
                            type="button"
                            className="marker-del"
                            title={t("resources.markerDelete")}
                            onClick={(event) => {
                              event.stopPropagation();
                              removeOneAnnotation(annotation.id);
                            }}
                          >
                            {ANN_ICONS.close}
                          </button>
                        </li>
                      );
                    })}
                </ul>
              )}
            </section>
          )}
          {onMoveRecord && (
            <div className="resource-group-line">
              <span className="resource-group-line-label">{t("resources.currentGroup")}</span>
              <span className="resource-group-pill">
                <span className="resource-group-pill-name">
                  {record.resource_folder
                    ? formatResourceFolderPath(record.resource_folder)
                    : t("resources.ungrouped")}
                </span>
                <button type="button" onClick={() => onMoveRecord(record)}>
                  {t("resources.move")}
                </button>
              </span>
            </div>
          )}
          <div className="resource-note-block">
            <label className="resource-note-label" htmlFor="resource-note-input">
              {t("resources.note")}
            </label>
            <textarea
              id="resource-note-input"
              className="resource-note-input"
              rows={3}
              maxLength={1000}
              value={noteDraft}
              placeholder={t("resources.notePlaceholder")}
              onChange={(event) => {
                setNoteDraft(event.target.value);
                setNoteError(false);
              }}
            />
            <div className="resource-note-actions">
              {noteSaved && <span className="resource-note-saved" role="status">{t("resources.noteSaved")}</span>}
              {noteError && <span className="resource-note-error" role="alert">{t("resources.noteSaveFailed")}</span>}
              {noteDirty && (
                <button
                  type="button"
                  className="resource-secondary-button resource-note-save"
                  onClick={() => void handleSaveNote()}
                  disabled={noteSaving}
                >
                  {noteSaving ? t("common.saving") : t("common.save")}
                </button>
              )}
            </div>
          </div>
          <p>{t("resources.detailHint")}</p>
        </aside>
      </main>
      <BackToTopButton
        visible={backToTop.visible}
        onTop={backToTop.scrollToTop}
        label={t("common.backToTop")}
        className="back-to-top-fixed"
        portal
      />
    </div>
  );
}
