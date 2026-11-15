// 详情页信息侧栏（独立展示组件）：基本信息表、标注列表面板、
// 所属分组面包屑（可选移动入口）、备注面板。
// 自 ResourceDetailPage.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）。
// 状态与操作回调全部经 props 注入（页面持权，组件纯展示）；
// ANN_ICONS 同时供正文划选工具条使用，自此处导出。

import { Fragment } from "react";
import { ANN_ICONS } from "./annotationIcons";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord } from "../../types";
import type { ResourceAnnotation } from "../../domain/annotations";
import type { ResourceMediaKind } from "../../domain/mediaKind";
import { formatResourceFileSize } from "./resourceUtils";
import { formatResourceFolderPath } from "../../domain/groups";
import { type ResourceGroupCrumb } from "./resourceUtils";



export function DetailInfoPanel({
  kind,
  record,
  typeLabel,
  mediaMetaRows,
  groupCrumbItems,
  annotationsActive,
  annotations,
  fullTextContent,
  jumpToAnnotation,
  removeOneAnnotation,
  clearAllAnnotations,
  onMoveRecord,
  hideResourceOps,
  noteDraft,
  setNoteDraft,
  noteDirty,
  noteSaving,
  noteSaved,
  noteError,
  setNoteError,
  noteInputRef,
  handleSaveNote,
}: {
  kind: ResourceMediaKind;
  record: ClipboardRecord;
  typeLabel: (kind: ResourceMediaKind) => string;
  mediaMetaRows: { label: string; value: string }[];
  groupCrumbItems: ResourceGroupCrumb[] | null;
  annotationsActive: boolean;
  annotations: ResourceAnnotation[];
  fullTextContent: string | null;
  jumpToAnnotation: (id: string) => void;
  removeOneAnnotation: (id: string) => void;
  clearAllAnnotations: () => void;
  onMoveRecord?: (record: ClipboardRecord) => void;
  hideResourceOps: boolean;
  noteDraft: string;
  setNoteDraft: (draft: string) => void;
  noteDirty: boolean;
  noteSaving: boolean;
  noteSaved: boolean;
  noteError: boolean;
  setNoteError: (error: boolean) => void;
  noteInputRef: React.RefObject<HTMLTextAreaElement | null>;
  handleSaveNote: () => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
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
  );
}
