import { openResourceFile, revealResourceFile } from "../../domain/mediaAssets";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord } from "../../types";
import { useResourceStore } from "../../stores/clipboardStore";
import { Icons } from "../../components/Icons";
import { BackToTopButton } from "../../components/BackToTop";
import { useBackToTop } from "../../hooks/useBackToTop";
import { useDetailScrollThumb } from "./useDetailScrollThumb";
import { ImageLightbox } from "../../components/ImageLightbox";
import FindReplaceBar from "../../components/FindReplaceBar";
import { useResourceFindReplace } from "./useResourceFindReplace";
import { splitTextChunks } from "../../domain/preview";
import { useDetailContentSource } from "./useDetailContentSource";
import { type AnnotationKind } from "../../domain/annotations";
import { useResourceAnnotations } from "./useResourceAnnotations";
import { buildResourceGroupCrumbs, formatResourceBitrate, formatResourceDuration, formatResourceFileSize } from "./resourceUtils";
import { textVersionSourceKey } from "../../domain/textVersions";
import { useResourceVersionHistory } from "./useResourceVersionHistory";
import { useResourceDetailNoteRename } from "./useResourceDetailNoteRename";
import { type ResourceMediaKind } from "../../domain/mediaKind";
import { getResourceFileName, isResourceTitleRenameable, splitResourceFileName } from "../../domain/fileName";
import { formatResourceFolderPath } from "../../domain/groups";
import { inferResourceMediaKind } from "../../domain/mediaKind";
import { getResourcePath, getResourceTitle, recordTextEditable, resourceMediaVersion, resourceTextPreviewPath } from "../../domain/records";
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
  onDelete: (id: string) => void;
  onRecordUpdated: (record: ClipboardRecord) => void;
  onMoveRecord?: (record: ClipboardRecord) => void;
  /** 追溯文件（缺失记录的操作入口）；与列表卡片共用同一语义（守卫规则 23）。 */
  onTrace?: (record: ClipboardRecord) => void;
  /** 主窗口复用形态（剪切板/快捷输入详情）：隐藏资源特有件——备注、
   *  重命名、版本记录、文本标注；编辑与资源库同交互（双击正文进入页内
   *  编辑态，不弹窗），保存经 onSaveContent 注入各页自己的通道。 */
  hideResourceOps?: boolean;
  /** record 形态的内联编辑保存通道：数据库文本 → update_clipboard_record_
   *  content，快捷输入文本短语 → update_phrase。保存成功后由详情页回调
   *  onRecordUpdated 刷新列表。 */
  onSaveContent?: (record: ClipboardRecord, content: string) => Promise<void>;
  /** 返回按钮文案（默认「返回资源库」）。 */
  backLabel?: string;
}

/* 自绘滚动进度条 thumb 在滚动视口上下的留白（px） */

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
  onDelete,
  onRecordUpdated,
  onMoveRecord,
  onTrace,
  hideResourceOps = false,
  onSaveContent,
  backLabel,
}: ResourceDetailPageProps) {
  const { t } = useTranslation();
  const recordLocale = useRecordLocale();
  const updateResourceNote = useResourceStore((state) => state.updateResourceNote);
  const kind = inferResourceMediaKind(record);
  const resourcePath = getResourcePath(record);
  // 打开所在位置：仅文件承载记录可用（数据库承载的文本无文件可定位）。
  const revealPath = record.resource_path || (record.type === "file" ? record.content : null);
  const mediaVersion = resourceMediaVersion(record);
  // 「用系统应用打开」失败反馈（超长文本回退态的兜底动作）。
  const [openExternalFailed, setOpenExternalFailed] = useState(false);
  // 手动刷新计数：顶栏「刷新」递增触发正文加载 effect 重跑——详情页正文
  // 是打开时一次性读入的，本应用其他入口或外部程序改了文本后需手动重读。
  const [textReloadKey, setTextReloadKey] = useState(0);
  // ── 文本标注（阅读态划选标记）子系统收口于 useResourceAnnotations ──
  // 正文列自绘滚动进度条与页面滚动容器解析收口于 useDetailScrollThumb。
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [mediaMeta, setMediaMeta] = useState<ResourceMediaMetadata>({});
  // 备注/标题重命名子系统收口于 useResourceDetailNoteRename。
  const {
    noteDraft,
    setNoteDraft,
    noteDirty,
    noteSaving,
    noteSaved,
    noteError,
    setNoteError,
    noteInputRef,
    handleSaveNote,
    renameDraft,
    setRenameDraft,
    setRenameError,
    renameSaving,
    renameError,
    cancelRename,
    commitRename,
  } = useResourceDetailNoteRename({ record, onRecordUpdated, updateResourceNote });  const [contentEditing, setContentEditing] = useState(false);
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

  useEffect(() => {
    setMediaMeta({});
    setLightboxSrc(null);
    // （备注/重命名/正文的记录切换重置随各自子系统收口。）
    setContentEditing(false);
    setContentSaved(false);
    setContentSaveError(null);
    setOpenExternalFailed(false);
    // （划选态/改动记录/版本预览的记录切换重置随各自子系统收口。）
  }, [record.id, record.resource_note]);

  useEffect(() => () => {
    if (contentSavedTimerRef.current !== null) window.clearTimeout(contentSavedTimerRef.current);
  }, []);

  // 编辑器高度跟随内容伸缩，避免固定高度出现内部滚动条截断正文。
  // 加 2px 余量：分数缩放下 scrollHeight 取整可能略小于实际内容，
  // 否则会浮现一条内部滚动条（滚动统一交给主窗口页面层级）。
  useEffect(() => {
    const el = contentEditorRef.current;
    if (!el) return;
    const syncHeight = () => {
      // 同备注输入框：面板隐藏时 scrollHeight 为 0，跳过防止压扁。
      if (el.clientWidth === 0) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
    };
    syncHeight();
    window.addEventListener("resize", syncHeight);
    return () => window.removeEventListener("resize", syncHeight);
  }, [contentDraft, contentEditing]);




  // 超长文本回退态的兜底动作：用系统默认程序打开文件（阅读/编辑皆宜）。
  const handleOpenExternal = () => {
    if (!externalTextPath) return;
    setOpenExternalFailed(false);
    openResourceFile(externalTextPath).catch(() => setOpenExternalFailed(true));
  };

  // 改动记录（版本历史）子系统收口于 useResourceVersionHistory：
  // 面板开关/列表拉取/预览与还原/清空与 toast 自持，记录与列表刷新、
  // 已保存基准经参数注入。
  const {
    historyOpen,
    setHistoryOpen,
    versions,
    previewEntry,
    setPreviewEntry,
    historyBusy,
    historyToast,
    historyAnchorRef,
    formatVersionTime,
    toggleHistory,
    handleClearVersions,
    handlePreviewVersion,
    handleBackToCurrent,
    handleRestoreVersion,
  } = useResourceVersionHistory({
    externalTextPath,
    record,
    onRecordUpdated,
    setSavedContent,
    setContentSaveError,
  });

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

  // 侧栏分组 pill 的面包屑段（拆分规则见 buildResourceGroupCrumbs）；
  // 完整路径始终通过 pill 的 title 悬停查看。
  const groupCrumbItems = useMemo(
    () => (record.resource_folder ? buildResourceGroupCrumbs(record.resource_folder) : null),
    [record.resource_folder],
  );

  // 正文取材子系统（媒体 URL 解析/全文整读与截断回退/分段预览）
  // 收口于 useDetailContentSource。
  const {
    segments,
    textContent,
    errorReason,
    mediaSource,
    fullTextContent,
  } = useDetailContentSource({
    kind,
    record,
    resourcePath,
    mediaVersion,
    externalTextPath,
    textReloadKey,
  });
  const title = getResourceTitle(record, kind, recordLocale);

  const renameable = isResourceTitleRenameable(record) && !hideResourceOps;
  // 标题编辑基于文件名：文件记录的路径在 content/resource_path，文本资源记录的
  // 路径只在 resource_path（content 是正文）。
  const titlePath = record.type === "file" || record.type === "image"
    ? getResourcePath(record)
    : record.resource_path || "";
  const { stem: currentStem, extension: titleExtension } = splitResourceFileName(
    getResourceFileName(titlePath),
  );


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
  // 与版本预览态暂离（预览的是历史快照，偏移对当前文件无意义），退出后
  // 随文本重载重新校验。
  const annotationsActive =
    Boolean(externalTextPath) && !textDetailTruncated && !contentEditing && !previewEntry
    && !hideResourceOps;
  // 标注子系统：划选换算/工具条/标注列表/toast 收口于 useResourceAnnotations；
  // 激活态、记录、取材全文、文本分块与 stage 容器经参数注入。
  const {
    annotations,
    annSelection,
    setAnnSelection,
    annFeedback,
    toolbarRef,
    annotatedChunks,
    handleStageMouseUp,
    applyAnnotation,
    clearAnnotationsInRange,
    copySelectedText,
    removeOneAnnotation,
    clearAllAnnotations,
    jumpToAnnotation,
  } = useResourceAnnotations({
    annotationsActive,
    recordId: record.id,
    recordNote: record.resource_note,
    textContent,
    contentEditing,
    textChunks,
    stageRef,
  });



  // 滚动进度条子系统：几何推导/thumb 拖拽/滚动与内容高度监听、
  // 页面滚动容器解析（findPageScroller 供 backToTop 与查找替换）
  // 收口于 useDetailScrollThumb；stage 容器经参数注入。
  const {
    findPageScroller,
    setMainElRef,
    scrollTrackRef,
    scrollThumbRef,
    handleTrackPointerDown,
  } = useDetailScrollThumb({ stageRef });

  // 详情页自身不滚动，滚动发生在窗口内容容器（祖先节点）上；
  // 用统一 hook 解析该滚动容器，下滑后显示「回到顶部」按钮。
  const pageRef = useRef<HTMLDivElement | null>(null);
  const backToTop = useBackToTop({ resolveContainer: findPageScroller });


  // 正文编辑面向有文件承载的文本资源（不含内嵌图片）：取材与保存目标
  // 都是文件本身，文件是全文的唯一事实来源。
  // 编辑目标与取材同源：一律指向 backing 文件（domain 判定已校验文本扩展名）。
  const textEditPath = kind === "text" ? externalTextPath : null;
  // 全文加载后截断不再是唯一编辑门槛：正文过大同样不适合应用内编辑，
  // 用系统应用修改文件，改动经监听与媒体版本机制同步回来。闸门与写入
  // 侧（write_resource_text_content 的 ensure_capped_file，1 MiB =
  // 1024 × 1024 字节）同值同口径——字符数口径对中文会放宽约 3 倍，
  // 1～3 MB 的中文文件会「进得去编辑、存不回去」。文件大小缺失时退回
  // 字符数估算。
  // 编辑目标的形态分派（2026-11-14 用户定案：编辑完全复用资源库详情页
  // 交互，双击进入页内编辑态、不弹窗）：资源形态取材与保存都是 backing
  // 文件；record 形态（主窗口剪切板/快捷输入）编辑目标是记录正文本身
  // （数据库文本/链接），保存经 onSaveContent 注入，文件类记录保持只读
  // （文件语义归资源库，主窗口纯展示预览）。
  const contentEditable = !record.has_images
    && fullTextContent !== null
    && !textDetailTruncated
    && (record.resource_file_size ?? fullTextContent.length) <= 1024 * 1024
    && (hideResourceOps
      ? onSaveContent !== undefined && recordTextEditable(record)
      : Boolean(textEditPath));
  // 正文加载完成后把当前内容作为「已保存」基准，进入编辑态时以此为草稿初值。
  useEffect(() => {
    if (fullTextContent === null) return;
    setSavedContent(fullTextContent);
  }, [fullTextContent]);
  const contentDirty = contentDraft.trim() !== savedContent.trim();

  // 查找替换子系统（匹配定位/查找条跟随/逐个与全部替换）收口于
  // useResourceFindReplace；编辑态与 refs 经参数注入。
  const {
    findOpen,
    setFindOpen,
    findQuery,
    findReplaceText,
    setFindReplaceText,
    findCaseSensitive,
    findIndex,
    findBarPos,
    findMatches,
    goToFindMatch,
    handleFindQueryChange,
    handleFindCaseSensitiveChange,
    handleFindReplaceCurrent,
    handleFindReplaceAll,
  } = useResourceFindReplace({
    contentEditing,
    contentDraft,
    setContentDraft,
    setContentSaveError,
    stageRef,
    contentEditorRef,
    findPageScroller,
  });

  const startContentEdit = () => {
    setContentDraft(fullTextContent ?? "");
    setContentSaved(false);
    setContentSaveError(null);
    setPreviewEntry(null);
    setContentEditing(true);
  };

  const cancelContentEdit = () => {
    setContentEditing(false);
    setContentDraft("");
    setContentSaveError(null);
  };

  const handleSaveContent = async () => {
    if (contentSaving || !contentDirty) return;
    // record 形态：保存经调用方注入的通道（剪切板 update_clipboard_record_
    // content / 快捷输入 update_phrase），成功后按资源库同节奏反馈
    // （「已保存」toast + onRecordUpdated 刷新列表，列表重载触发正文
    // 重新取材，savedContent 随新全文刷新）。
    if (hideResourceOps) {
      if (!onSaveContent) return;
      setContentSaving(true);
      setContentSaveError(null);
      try {
        await onSaveContent(record, contentDraft);
        setContentEditing(false);
        setContentDraft("");
        setSavedContent(contentDraft);
        setContentSaved(true);
        if (contentSavedTimerRef.current !== null) window.clearTimeout(contentSavedTimerRef.current);
        contentSavedTimerRef.current = window.setTimeout(() => {
          setContentSaved(false);
          contentSavedTimerRef.current = null;
        }, 2200);
        onRecordUpdated(record);
      } catch (error) {
        setContentSaveError(typeof error === "string" ? error : "");
      } finally {
        setContentSaving(false);
      }
      return;
    }
    if (!textEditPath) return;
    setContentSaving(true);
    setContentSaveError(null);
    try {
      const saved = await invoke<{ content: string; record_type?: string }>(
        "write_resource_text_content",
        {
          path: textEditPath,
          content: contentDraft,
          // 外部发现的记录（resource_managed=false）也传 id：改动记录按
          // record_id 记版，外部资源编辑后历史面板才有版本可看；后端归一
          // UPDATE 对已是文件承载形态的外部记录是幂等空操作。
          id: record.id,
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
          <span>{backLabel ?? t("resources.backToLibrary")}</span>
        </button>
        <div className="resource-detail-actions">
          {kind === "text" && !contentEditing && !previewEntry && (
            <button
              type="button"
              className="resource-secondary-button"
              onClick={() => {
                // 旧正文的划选区间对新内容可能失效，刷新即清。
                setAnnSelection(null);
                setTextReloadKey((key) => key + 1);
              }}
            >
              {Icons.refresh}
              <span>{t("resources.refreshContent")}</span>
            </button>
          )}
          {contentEditable && !hideResourceOps && !contentEditing && (
            <span
              className="text-history-anchor"
              ref={historyAnchorRef}
              onKeyDown={(event) => {
                // Esc 分层：面板开着先关面板，且不触发页面级返回。
                if (event.key === "Escape" && historyOpen) {
                  event.preventDefault();
                  event.stopPropagation();
                  setHistoryOpen(false);
                }
              }}
            >
              <button
                type="button"
                className={`resource-secondary-button${historyOpen ? " active" : ""}`}
                onClick={toggleHistory}
                aria-haspopup="dialog"
                aria-expanded={historyOpen}
              >
                {Icons.recent}
                <span>{t("resources.textHistory")}</span>
              </button>
              {historyOpen && (
                <div className="text-history-pop" role="dialog" aria-label={t("resources.textHistory")}>
                  <div className="text-history-head">
                    <span>{t("resources.textHistory")}</span>
                    <button
                      type="button"
                      className="text-history-clear"
                      disabled={historyBusy || versions === null || versions.length === 0}
                      onClick={() => void handleClearVersions()}
                    >
                      {t("resources.textHistoryClear")}
                    </button>
                  </div>
                  <div className="text-history-list">
                    {versions === null ? (
                      <div className="text-history-empty">{t("common.loading")}</div>
                    ) : versions.length === 0 ? (
                      <div className="text-history-empty">{t("resources.textHistoryEmpty")}</div>
                    ) : (
                      versions.map((version) => {
                        const previewing = previewEntry?.version.id === version.id;
                        const current = version.id === versions[0].id;
                        return (
                          <div
                            key={version.id}
                            role="button"
                            tabIndex={0}
                            className={`text-history-item${previewing ? " previewing" : ""}${current ? " current" : ""}`}
                            onClick={() => {
                              if (current) handleBackToCurrent();
                              else handlePreviewVersion(version);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                if (current) handleBackToCurrent();
                                else handlePreviewVersion(version);
                              }
                            }}
                          >
                            <span className="text-history-dot" />
                            <span className="text-history-body">
                              <span className="text-history-time">
                                {formatVersionTime(version.createdAt)}
                              </span>
                              <span className="text-history-meta">
                                {formatResourceFileSize(version.byteSize)}
                                {" · "}
                                {t(textVersionSourceKey(version.source))}
                              </span>
                            </span>
                            {(previewing || current) && (
                              <span className={`text-history-badge${previewing ? " previewing" : ""}`}>
                                {previewing
                                  ? t("resources.versionPreviewBadge")
                                  : t("resources.versionCurrent")}
                              </span>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                  <div className="text-history-foot">{t("resources.textHistoryHint")}</div>
                </div>
              )}
            </span>
          )}
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
          {record.resource_missing && onTrace && (
            <button
              type="button"
              className="resource-primary-button"
              onClick={() => onTrace(record)}
            >
              {Icons.search}
              <span>{t("resources.traceFile")}</span>
            </button>
          )}
          {revealPath && (
            <button
              type="button"
              className="resource-secondary-button"
              onClick={() => void revealResourceFile(revealPath).catch(() => {})}
              disabled={Boolean(record.resource_missing)}
              title={record.resource_missing ? t("resources.openLocationMissingDisabled") : undefined}
            >
              {Icons.folderOpen}
              <span>{t("resources.openLocation")}</span>
            </button>
          )}
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
          // 版本预览态双击不进入编辑（预览的是历史快照，不是当前正文）。
          if (previewEntry) return;
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
          {/* record 形态（主窗口剪切板/快捷输入）不渲染标题块：标题是
              正文首行的重复展示，正文区直接开始（信息面板保留元数据）。 */}
          {!hideResourceOps && (
          <span className="resource-detail-kind">{typeLabel(kind)}</span>
          )}
          {!hideResourceOps &&
            (renameDraft === null ? (
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
                      void commitRename(currentStem);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      cancelRename();
                    }
                  }}
                  onBlur={() => void commitRename(currentStem)}
                />
                {titleExtension && (
                  <span className="resource-detail-title-extension">{titleExtension}</span>
                )}
                {renameError && (
                  <span className="resource-detail-title-error" role="alert">{renameError}</span>
                )}
              </div>
            ))}
          {!hideResourceOps && (
            <p className="resource-detail-subtitle">
              {typeLabel(kind)} · {record.source_app || t("resources.localSource")}
            </p>
          )}
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
            ) : previewEntry ? (
              // 改动记录的版本只读预览：展示历史快照并给出还原入口。
              // 还原走正文写入通道且当前内容自动先存一版，无需确认框。
              <div className="resource-detail-text-body">
                <div className="resource-version-banner" role="note">
                  <span className="resource-version-banner-text">
                    {t("resources.versionPreview", {
                      time: formatVersionTime(previewEntry.version.createdAt),
                    })}
                  </span>
                  <button
                    type="button"
                    className="resource-secondary-button resource-version-restore"
                    disabled={historyBusy}
                    onClick={() => void handleRestoreVersion()}
                  >
                    {t("resources.versionRestore")}
                  </button>
                  <button
                    type="button"
                    className="resource-secondary-button"
                    disabled={historyBusy}
                    onClick={() => setPreviewEntry(null)}
                  >
                    {t("resources.versionExitPreview")}
                  </button>
                </div>
                <div className="resource-detail-text-chunks">
                  {splitTextChunks(previewEntry.content).map((chunk, index) => (
                    <pre
                      key={index}
                      className="resource-detail-text-chunk"
                      style={{
                        containIntrinsicSize: `auto calc(${Math.ceil(chunk.length / CHUNK_CHARS_PER_LINE)} * 1.9em)`,
                      }}
                    >
                      {chunk}
                    </pre>
                  ))}
                </div>
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
                {/* 嵌套路径按层级拆成可收缩的面包屑小段：空间不足时前面
                    的层级先压缩成省略号，最深一层（分组身份）最后才截断；
                    嵌套超过 4 层时中段收起为一个「…」，完整路径悬停可见。 */}
                <span
                  className="resource-group-pill-name"
                  title={record.resource_folder
                    ? formatResourceFolderPath(record.resource_folder)
                    : undefined}
                >
                  {groupCrumbItems
                    ? groupCrumbItems.map((crumb, index) => (
                        <Fragment key={`${index}-${crumb.text}`}>
                          {index > 0 && (
                            <span className="resource-group-crumb-sep" aria-hidden="true">/</span>
                          )}
                          <span className={crumb.more ? "resource-group-crumb-more" : "resource-group-crumb"}>
                            {crumb.text}
                          </span>
                        </Fragment>
                      ))
                    : (
                      <span className="resource-group-crumb">{t("resources.ungrouped")}</span>
                    )}
                </span>
                <button type="button" onClick={() => onMoveRecord(record)}>
                  {t("resources.move")}
                </button>
              </span>
            </div>
          )}
          {!hideResourceOps && (
          <div className="resource-note-block">
            <label className="resource-note-label" htmlFor="resource-note-input">
              {t("resources.note")}
            </label>
            <textarea
              id="resource-note-input"
              ref={noteInputRef}
              className="resource-note-input"
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
                  className="ui-btn"
                  onClick={() => void handleSaveNote()}
                  disabled={noteSaving}
                >
                  {noteSaving ? t("common.saving") : t("common.save")}
                </button>
              )}
            </div>
          </div>
          )}
        </aside>
      </main>
      {historyToast && (
        <div className="resource-history-toast" role="status">
          {historyToast}
        </div>
      )}
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
