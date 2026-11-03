// 工程画布杂项节点层（自 ProjectCanvas.tsx 渲染区零改动搬运，2026-11-03
// 引擎拆分阶段 11c；fork 对齐点按原注释保持）：空白资料占位、提示词纸片、
// 片段节点、成片输出节点与便签。portBar/resizeHandle 由主文件注入。
import { Icons } from "../../../../components/Icons";
import { useTranslation } from "react-i18next";
import type { Dispatch, SetStateAction } from "react";
import type { ProjectPrompt, ProjectSegment } from "../../../../stores/projectStore";
import { joinLibraryPath } from "../../../../domain/projectView";
import { ResourceVideoPoster } from "../../ResourceMedia";
import { NODE_ACCENTS } from "../colors";
import { INFO_W, SCRIPT_W, SEG_H, SEG_W } from "../layout";
import type { CanvasNote, EntityPh, EntityPhKind, Pos, PromptPh, WireBox } from "../types";

type DetailScope = "current" | "all";
/** 详情窗口目标（与主文件 detailFor state 同构，见 ProjectCanvas.tsx）。 */
export type DetailForState =
  | { kind: "entityPh"; id: string }
  | { kind: "promptPh"; id: string }
  | { kind: "segment"; id: string; scopes: { chars: DetailScope; locs: DetailScope; props: DetailScope } }
  | { kind: "info"; group: EntityPhKind; sourceKey: string; scope: DetailScope }
  | { kind: "script"; phId?: string };
export type SetDetailFor = Dispatch<SetStateAction<DetailForState | null>>;

/** 空白资料占位节点：菜单创建（角色/场景/道具），双击从详情窗加载实体。 */
export function EntityPhNodes({
  entityPhs, infoNodePos, sizeOfNode, nodeSizes, selKeys, portBar, resizeHandle,
  setDetailFor, removeEntityPh,
}: {
  entityPhs: EntityPh[];
  infoNodePos(key: string): Pos;
  sizeOfNode(key: string): { w: number; h: number } | null;
  nodeSizes: Record<string, { w: number; h: number }>;
  selKeys: string[];
  portBar(key: string): React.ReactNode;
  resizeHandle: React.ReactNode;
  setDetailFor: SetDetailFor;
  removeEntityPh(id: string): void;
}) {
  const { t } = useTranslation();
  return (
    <>
{/* 空白资料占位节点：菜单创建（角色/场景/道具），双击从详情窗
    加载实体，加载后原位变成实体节点 */}
{entityPhs.map((ph) => {
  const key = `eph:${ph.id}`;
  const p = infoNodePos(key);
  const phSize = sizeOfNode(key);
  const resized = Boolean(nodeSizes[key]);
  const label = t(
    ph.kind === "character"
      ? "project.canvas.typeCharacter"
      : ph.kind === "location"
        ? "project.canvas.typeLocation"
        : "project.canvas.typeProp",
  );
  return (
    <div
      key={key}
      data-key={key}
      className={`pc-node pc-info pc-eph${resized ? " pc-resized" : ""}${selKeys.includes(key) ? " pc-selected" : ""}`}
      style={{
        left: p.x, top: p.y,
        width: phSize?.w ?? INFO_W,
        height: resized ? phSize?.h : undefined,
        minHeight: resized ? undefined : phSize?.h,
        ["--node-accent" as string]: NODE_ACCENTS[ph.kind] ?? "#94a3b8",
      } as React.CSSProperties}
    >
      <div className="pc-node-head">
        <span className="pc-node-kind">{label}</span>
        <b className="pc-node-title">{t("project.canvas.ephTitle")}</b>
      </div>
      {portBar(key)}
      <div className="pc-info-body pc-eph-body">
        {ph.kind === "character" ? Icons.clipboard : ph.kind === "location" ? Icons.resources : Icons.star}
        <span>{t("project.canvas.ephHint")}</span>
      </div>
      <span className="pc-node-tools">
        <button type="button" data-tooltip={t("project.canvas.view")} onClick={() => setDetailFor({ kind: "entityPh", id: ph.id })}>
          {Icons.expand}
        </button>
        <button
          type="button"
          data-tooltip={t("common.delete")}
          className="danger"
          onClick={() => removeEntityPh(ph.id)}
        >
          {Icons.delete}
        </button>
      </span>
      {resizeHandle}
    </div>
  );
})}

    </>
  );
}

/** 提示词纸片：双击空纸片从提示词库选一条，内容直接显示在纸片上。 */
export function PromptPhNodes({
  promptPhs, prompts, infoNodePos, sizeOfNode, nodeSizes, selKeys, portBar,
  resizeHandle, setPromptPickTarget, setPromptPickOpen, setDetailFor, removePromptPh,
}: {
  promptPhs: PromptPh[];
  prompts: ProjectPrompt[];
  infoNodePos(key: string): Pos;
  sizeOfNode(key: string): { w: number; h: number } | null;
  nodeSizes: Record<string, { w: number; h: number }>;
  selKeys: string[];
  portBar(key: string): React.ReactNode;
  resizeHandle: React.ReactNode;
  setPromptPickTarget(t: string): void;
  setPromptPickOpen(open: boolean): void;
  setDetailFor: SetDetailFor;
  removePromptPh(id: string): void;
}) {
  const { t } = useTranslation();
  return (
    <>
{/* 提示词纸片：双击空纸片从提示词库选一条，内容直接显示在纸片上 */}
{promptPhs.map((ph) => {
  const key = `prompt:${ph.id}`;
  const p = infoNodePos(key);
  const phSize = sizeOfNode(key);
  const resized = Boolean(nodeSizes[key]);
  const prompt = prompts.find((item) => item.id === ph.promptId);
  const openPrompt = () => {
    if (!ph.promptId) {
      setPromptPickTarget(key);
      setPromptPickOpen(true);
    } else {
      setDetailFor({ kind: "promptPh", id: ph.id });
    }
  };
  return (
    <div
      key={key}
      data-key={key}
      className={`pc-node pc-info pc-eph${resized ? " pc-resized" : ""}${selKeys.includes(key) ? " pc-selected" : ""}`}
      style={{
        left: p.x, top: p.y,
        width: phSize?.w ?? SCRIPT_W,
        height: resized ? phSize?.h : undefined,
        // 未缩放时高度自适应内容（与剧本纸片一致），缩放后用记录值。
        ["--node-accent" as string]: NODE_ACCENTS.prompt,
      } as React.CSSProperties}
    >
      <div className="pc-node-head">
        <span className="pc-node-kind">{t("project.canvas.typePrompt")}</span>
        <b className="pc-node-title">{prompt ? prompt.title : t("project.canvas.promptUntitled")}</b>
      </div>
      {portBar(key)}
      {prompt ? (
        <div className="pc-prompt-text">{prompt.content}</div>
      ) : (
        <div className="pc-info-body pc-eph-body">
          {Icons.file}
          <span>{t("project.canvas.promptEmpty")}</span>
        </div>
      )}
      <span className="pc-node-tools">
        <button type="button" data-tooltip={t("project.canvas.view")} onClick={openPrompt}>
          {Icons.expand}
        </button>
        <button
          type="button"
          data-tooltip={t("common.delete")}
          className="danger"
          onClick={() => removePromptPh(ph.id)}
        >
          {Icons.delete}
        </button>
      </span>
      {resizeHandle}
    </div>
  );
})}

    </>
  );
}

/** 片段节点：AI 分段生成的视频分段，按拼接序汇入本集成片。 */
export function SegmentNodes({
  segments, segPos, sizeOfNode, nodeSizes, selKeys, portBar, resizeHandle,
  libraryRoot, moveSegment, setDetailFor, removeSegment,
}: {
  segments: ProjectSegment[];
  segPos: Record<string, Pos>;
  sizeOfNode(key: string): { w: number; h: number } | null;
  nodeSizes: Record<string, { w: number; h: number }>;
  selKeys: string[];
  portBar(key: string): React.ReactNode;
  resizeHandle: React.ReactNode;
  libraryRoot: string;
  moveSegment(id: string, dir: number): unknown;
  setDetailFor: SetDetailFor;
  removeSegment(id: string): unknown;
}) {
  const { t } = useTranslation();
  return (
    <>
{/* 片段节点：AI 分段生成的视频分段，按拼接序汇入本集成片 */}
{segments.map((segment, index) => {
  const p = segPos[segment.id];
  if (!p) return null;
  const key = `segment:${segment.id}`;
  const segSize = sizeOfNode(key);
  const resized = Boolean(nodeSizes[key]);
  return (
    <div
      key={segment.id}
      data-key={key}
      className={`pc-node pc-segment${resized ? " pc-resized" : ""}${selKeys.includes(key) ? " pc-selected" : ""}`}
      style={{
        left: p.x, top: p.y, width: segSize?.w ?? SEG_W,
        height: resized ? segSize?.h : undefined,
        // 存量高度语义是节点总高：用 minHeight 兜底，缩小不裁切内容。
        minHeight: resized ? undefined : segSize && segSize.h !== SEG_H ? segSize.h : undefined,
        ["--node-accent" as string]: NODE_ACCENTS.segment,
      } as React.CSSProperties}
    >
      <div className="pc-node-head">
        <span className="pc-node-kind">{t("project.canvas.segName")}</span>
        <b className="pc-node-title">{segment.note || `#${index + 1}`}</b>
      </div>
      <div className="pc-seg-ports">{portBar(key)}</div>
      {segment.asset ? (
          <button
            type="button"
            className={`pc-seg-thumb${segment.asset.missing ? " is-missing" : ""}`}
            title={segment.asset.missing ? t("project.asset.fileMissing") : segment.asset.name}
            data-asset={segment.asset.id}
          >
            <ResourceVideoPoster
              path={joinLibraryPath(libraryRoot, segment.asset.file_path)}
              version={segment.asset.updated_at}
              fallbackLabel={segment.asset.name || segment.asset.file_path}
            />
            <span className="pc-thumb-play">{Icons.play}</span>
          </button>
        ) : (
          <div className="pc-seg-empty">
            {Icons.link}
            {t("project.canvas.segEmpty")}
          </div>
        )}
      <span className="pc-node-tools">
        <button
          type="button"
          data-tooltip={t("project.canvas.segMoveUp")}
          onClick={() => void moveSegment(segment.id, -1)}
        >
          {Icons.chevronUp}
        </button>
        <button
          type="button"
          data-tooltip={t("project.canvas.segMoveDown")}
          onClick={() => void moveSegment(segment.id, 1)}
        >
          {Icons.chevronDown}
        </button>
        <button
          type="button"
          data-tooltip={t("project.canvas.segAttach")}
          onClick={() => setDetailFor({ kind: "segment", id: segment.id, scopes: { chars: "current", locs: "current", props: "current" } })}
        >
          {Icons.file}
        </button>
        <button
          type="button"
          data-tooltip={t("common.delete")}
          className="danger"
          onClick={() => void removeSegment(segment.id)}
        >
          {Icons.delete}
        </button>
      </span>
      {resizeHandle}
    </div>
  );
})}

    </>
  );
}

/** 成片输出节点：本集工作流的总输出口（拖卡体挪位，按集记忆）。 */
export function OutputNode({
  outputBox, segments, outputSourceLabel, episodeId, sizeOfNode, nodeSizes,
  selKeys, portBar, resizeHandle, setEpisodeOutput,
}: {
  outputBox: WireBox | null;
  segments: ProjectSegment[];
  outputSourceLabel: string | null;
  episodeId: string;
  sizeOfNode(key: string): { w: number; h: number } | null;
  nodeSizes: Record<string, { w: number; h: number }>;
  selKeys: string[];
  portBar(key: string): React.ReactNode;
  resizeHandle: React.ReactNode;
  setEpisodeOutput(episodeId: string, key: string | null): unknown;
}) {
  const { t } = useTranslation();
  return (
    <>
{/* 成片输出节点：本集工作流的总输出口（拖卡体挪位，按集记忆） */}
{outputBox && (
  <div
    data-key="output"
    className={`pc-node pc-outnode${nodeSizes.output ? " pc-resized" : ""}${selKeys.includes("output") ? " pc-selected" : ""}`}
    style={{
      left: outputBox.x, top: outputBox.y,
      width: sizeOfNode("output")?.w ?? outputBox.w,
      height: nodeSizes.output ? sizeOfNode("output")?.h : undefined,
      minHeight: nodeSizes.output ? undefined : sizeOfNode("output")?.h,
      ["--node-accent" as string]: NODE_ACCENTS.output,
    } as React.CSSProperties}
  >
    <div className="pc-node-head">
      <span className="pc-node-kind">{t("project.canvas.outputNode")}</span>
    </div>
    <div className="pc-outnode-body">
      <span className="pc-outnode-icon">{Icons.clapperboard}</span>
      <small>
        {segments.length > 0
          ? t("project.canvas.outputSummary", { count: segments.length })
          : (outputSourceLabel ?? t("project.canvas.outputEmpty"))}
      </small>
    </div>
    <div className="pc-seg-ports">{portBar("output")}</div>
    <span className="pc-node-tools">
      <button
        type="button"
        data-tooltip={t("project.canvas.remove")}
        className="danger"
        onClick={() => {
          if (episodeId) void setEpisodeOutput(episodeId, null);
        }}
      >
        {Icons.delete}
      </button>
    </span>
    {resizeHandle}
  </div>
)}

    </>
  );
}

/** 便签节点：双击编辑、拖动挪位、按集记 localStorage。 */
export function NoteNodes({
  notes, selKeys, sizeOfNode, resizeHandle, editingNoteId, noteDraft, setNoteDraft,
  setEditingNoteId, persistNotes,
}: {
  notes: CanvasNote[];
  selKeys: string[];
  sizeOfNode(key: string): { w: number; h: number } | null;
  resizeHandle: React.ReactNode;
  editingNoteId: string | null;
  noteDraft: string;
  setNoteDraft(text: string): void;
  setEditingNoteId(id: string | null): void;
  persistNotes(notes: CanvasNote[]): void;
}) {
  const { t } = useTranslation();
  return (
    <>
{/* 便签节点：双击编辑、拖动挪位、按集记 localStorage */}
{notes.map((note) => (
  <div
    key={note.id}
    data-note={note.id}
    className={`pc-note${selKeys.includes(`note:${note.id}`) ? " pc-selected" : ""}`}
    style={{
      left: note.x, top: note.y,
      width: sizeOfNode(`note:${note.id}`)?.w,
      height: sizeOfNode(`note:${note.id}`)?.h,
    }}
  >
    {editingNoteId === note.id ? (
      <textarea
        className="pc-note-input"
        autoFocus
        value={noteDraft}
        onChange={(event) => setNoteDraft(event.target.value)}
        onBlur={() => {
          persistNotes(
            notes.map((item) =>
              item.id === note.id ? { ...item, text: noteDraft.trim() } : item,
            ),
          );
          setEditingNoteId(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setEditingNoteId(null);
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
      />
    ) : (
      <div className="pc-note-body">
        {note.text || <i>{t("project.canvas.noteEmpty")}</i>}
      </div>
    )}
    <span className="pc-note-tools">
      <button
        type="button"
        data-tooltip={t("common.edit")}
        onClick={() => {
          setEditingNoteId(note.id);
          setNoteDraft(note.text);
        }}
      >
        {Icons.edit}
      </button>
      <button
        type="button"
        data-tooltip={t("common.delete")}
        className="danger"
        onClick={() => persistNotes(notes.filter((item) => item.id !== note.id))}
      >
        {Icons.close}
      </button>
    </span>
    {resizeHandle}
  </div>
))}
    </>
  );
}
