import { readResourceTextPreview } from "../../domain/mediaAssets";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord } from "../../types";
import { useResourceStore } from "../../stores/clipboardStore";
import { Icons } from "../../components/Icons";
import { BackToTopButton } from "../../components/BackToTop";
import { useBackToTop } from "../../hooks/useBackToTop";
import { HighlightText } from "../../components/HighlightText";
import { ImageLightbox } from "../../components/ImageLightbox";
import FindReplaceBar from "../../components/FindReplaceBar";
import { findMatchPositions } from "../../utils/findReplace";
import { loadRecordPreviewSegments, type RadialPreviewSegment } from "../../domain/preview";
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
  const [textContent, setTextContent] = useState<string | null>(null);
  const [error, setError] = useState(false);
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
    let node: HTMLElement | null = pageRef.current?.parentElement ?? null;
    while (node && node !== document.body) {
      const overflowY = window.getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") break;
      node = node.parentElement;
    }
    return node;
  }, []);
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
    setSegments(null);
    setTextContent(null);
    setError(false);
    setMediaSource(null);
    if (kind === "video" || kind === "audio" || kind === "file" || kind === "image") {
      if (kind === "video" || kind === "audio") {
        resolveResourceMediaUrl(resourcePath, mediaVersion)
          .then((url) => {
            if (!cancelled) setMediaSource(url);
          })
          .catch(() => {
            if (!cancelled) setError(true);
          });
      }
      return () => {
        cancelled = true;
      };
    }

    if (externalTextPath) {
      readResourceTextPreview(externalTextPath)
        .then((content) => {
          if (!cancelled) setTextContent(content);
        })
        .catch(() => {
          if (!cancelled) setError(true);
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
      .catch(() => {
        if (!cancelled) setError(true);
      });
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
  const contentReady = externalTextPath ? textDetailReady : detailReady;

  // 正文编辑面向有文件承载的文本资源（不含内嵌图片）：取材与保存目标
  // 都是文件本身，文件是全文的唯一事实来源。
  // 编辑目标与取材同源：一律指向 backing 文件（domain 判定已校验文本扩展名）。
  const textEditPath = kind === "text" ? externalTextPath : null;
  const fullTextContent = useMemo(() => {
    if (externalTextPath) return textContent;
    if (!segments) return null;
    return segments
      .filter((segment): segment is Extract<RadialPreviewSegment, { type: "text" }> =>
        segment.type === "text")
      .map((segment) => segment.content)
      .join("\n");
  }, [externalTextPath, segments, textContent]);
  const contentEditable = Boolean(textEditPath) && !record.has_images && fullTextContent !== null;
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
          // 任意空白（含内容框外的页面空白）保存修改；文本区内双击
          // 保留原生选词。标题双击是重命名，信息面板是备注编辑，均排除。
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
          if (contentDirty && !contentSaving) void handleSaveContent();
        }}
      >
        <section className="resource-detail-main" aria-busy={!(externalTextPath ? textDetailReady : detailReady) && !error}>
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
            {error ? (
              <div className="resource-detail-error" role="alert">
                <strong>{t("resources.detailError")}</strong>
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
              <pre className="resource-segment-text resource-detail-text-file">
                <HighlightText text={textContent || ""} />
              </pre>
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
