import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord } from "../../types";
import { useClipboardStore } from "../../stores/clipboardStore";
import { Icons } from "../../components/Icons";
import { HighlightText } from "../../components/HighlightText";
import { loadClipboardPreviewSegments } from "../../utils/contentPreview";
import type { RadialPreviewSegment } from "../../utils/radialPreview";
import {
  formatResourceBitrate,
  formatResourceDuration,
  formatResourceFileSize,
  formatResourceFolderPath,
  getResourceFileName,
  getResourcePath,
  getResourceTitle,
  inferResourceMediaKind,
  isResourceTitleRenameable,
  resolveResourceMediaUrl,
  splitResourceFileName,
  type ResourceMediaKind,
} from "./resourceUtils";
import {
  ResourceImage,
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
  const updateResourceNote = useClipboardStore((state) => state.updateResourceNote);
  const kind = inferResourceMediaKind(record);
  const resourcePath = getResourcePath(record);
  const [segments, setSegments] = useState<RadialPreviewSegment[] | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [error, setError] = useState(false);
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
  const [contentSaveError, setContentSaveError] = useState(false);
  const contentSavedTimerRef = useRef<number | null>(null);
  const externalTextPath = kind === "text" && record.type === "file"
    ? resourcePath
    : null;
  const noteDirty = noteDraft.trim() !== savedNote;

  useEffect(() => {
    setMediaMeta({});
    setNoteDraft(record.resource_note ?? "");
    setSavedNote(record.resource_note ?? "");
    setNoteSaved(false);
    setNoteError(false);
    setRenameDraft(null);
    setRenameError(null);
    setContentEditing(false);
    setContentSaved(false);
    setContentSaveError(false);
  }, [record.id, record.resource_note]);

  useEffect(() => () => {
    if (noteSavedTimerRef.current !== null) window.clearTimeout(noteSavedTimerRef.current);
    if (contentSavedTimerRef.current !== null) window.clearTimeout(contentSavedTimerRef.current);
  }, []);

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
        resolveResourceMediaUrl(resourcePath)
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
      invoke<string>("read_resource_text_preview", { path: externalTextPath })
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

    loadClipboardPreviewSegments(record)
      .then((next) => {
        if (!cancelled) setSegments(next);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [externalTextPath, kind, record, resourcePath]);

  const title = getResourceTitle(record, kind);

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

  // 正文编辑仅面向纯文本资源（不含内嵌图片）：文件承载文本是事实来源，
  // 数据库记录的 content 在保存时与文件同步。
  const textEditPath = kind === "text"
    ? (record.type === "file" ? externalTextPath : record.resource_path || null)
    : null;
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

  const startContentEdit = () => {
    setContentDraft(fullTextContent ?? "");
    setContentSaved(false);
    setContentSaveError(false);
    setContentEditing(true);
  };

  const cancelContentEdit = () => {
    setContentEditing(false);
    setContentDraft("");
    setContentSaveError(false);
  };

  const handleSaveContent = async () => {
    if (!textEditPath || contentSaving || !contentDirty) return;
    setContentSaving(true);
    setContentSaveError(false);
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
        content: saved.content,
        ...(saved.record_type === "text" || saved.record_type === "link"
          ? { type: saved.record_type }
          : null),
      });
    } catch {
      setContentSaveError(true);
    } finally {
      setContentSaving(false);
    }
  };

  return (
    <div className="resource-detail-page">
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
          {contentSaveError && <span className="resource-content-error" role="alert">{t("resources.contentSaveFailed")}</span>}
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

      <main className="resource-detail-body">
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
          <div className={`resource-detail-stage resource-detail-stage-${kind}`}>
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
              />
            ) : kind === "image" ? (
              <ResourceImage
                path={resourcePath}
                alt={title}
                className="resource-segment-image"
                onMetadata={({ width, height }) => setMediaMeta({ width, height })}
              />
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
                className="resource-detail-text-editor"
                autoFocus
                value={contentDraft}
                maxLength={1_000_000}
                disabled={contentSaving}
                aria-label={t("resources.editContent")}
                onChange={(event) => {
                  setContentDraft(event.target.value);
                  setContentSaveError(false);
                }}
                onKeyDown={(event) => {
                  // Escape 只退出编辑（放弃改动），不触发页面级返回。
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelContentEdit();
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
    </div>
  );
}
