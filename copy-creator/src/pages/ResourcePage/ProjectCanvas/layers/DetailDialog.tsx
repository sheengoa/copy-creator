// 工程画布节点详情窗口组装（自 ProjectCanvas.tsx 组件体 detailDialog
// IIFE 零改动搬移，2026-11-03 引擎拆分阶段 11d；fork 对齐点按原注释保
// 持）：按 detailFor 分派 预览 + 信息 + 动作 条目，动作直改数据经
// props 注入的 setter 落库。
import { Icons } from "../../../../components/Icons";
import { useTranslation } from "react-i18next";
import type { Dispatch, SetStateAction } from "react";
import { openResourceFile } from "../../../../domain/mediaAssets";
import {
  characterAvatarInitial,
  characterAvatarPaletteIndex,
  joinLibraryPath,
  promptCategoryKey,
  scriptFileLabel,
} from "../../../../domain/projectView";
import type {
  EpisodeOverview,
  ProjectAsset,
  ProjectCharacter,
  ProjectLocation,
  ProjectPrompt,
  ProjectProp,
  ProjectSegment,
} from "../../../../stores/projectStore";
import ProjectNodeDetailDialog, { type NodeDetailEntry } from "../../ProjectNodeDetailDialog";
import { ResourceImage, ResourceVideoPoster } from "../../ResourceMedia";
import { TextPaperBody } from "../TextPaperBody";
import { NODE_ACCENTS } from "../colors";
import type { DetailForArg, SetDetailFor } from "./NodeExtras";
import type { MemberPickT } from "./dialogTypes";
import type { EntityPhKind, InfoGroup, PromptPh, EntityPh, ScriptPh } from "../types";

/** 节点详情窗口：双击节点的独立窗口（预览 + 信息 + 上传/库选）。 */
export function DetailDialog({
  detailFor, detailError, overview, libraryRoot, segments, scriptPhs,
  infoGroups, promptPhs, entityPhs, prompts,
  castCharacters, episodeLocations, episodeProps, entitiesOfKind, setPromptPickTarget,
  kindTextOf, setMemberPick, closeDetail, attachSegmentFromLibrary,
  uploadViaImport, handleLocate, removeGroupMember, addGroupMember,
  setScriptPickTarget, setScriptPickOpen, setPickerFor, setPromptPickOpen, setDetailFor,
}: {
  detailFor: DetailForArg | null;
  detailError: string;
  overview: EpisodeOverview | null;
  libraryRoot: string;
  segments: ProjectSegment[];
  scriptPhs: ScriptPh[];
  infoGroups: InfoGroup[];
  promptPhs: PromptPh[];
  entityPhs: EntityPh[];
  prompts: ProjectPrompt[];
  castCharacters: ProjectCharacter[];
  episodeLocations: ProjectLocation[];
  episodeProps: ProjectProp[];
  entitiesOfKind(kind: EntityPhKind): Array<{ id: string; name: string; avatar_path?: string; ref_path?: string }>;
  setPromptPickTarget: Dispatch<SetStateAction<string | null>>;
  kindTextOf(kind: EntityPhKind): string;
  setMemberPick: Dispatch<SetStateAction<MemberPickT | null>>;
  closeDetail(): void;
  attachSegmentFromLibrary(segmentId: string, file: { filePath: string; kind: string; name: string }): void;
  uploadViaImport(after: (file: { filePath: string; kind: string; name: string }) => void): Promise<void>;
  handleLocate(asset: ProjectAsset): void;
  removeGroupMember(groupId: string, entityId: string): unknown;
  addGroupMember(groupId: string, entityId: string): unknown;
  setScriptPickTarget: Dispatch<SetStateAction<string | null>>;
  setScriptPickOpen: Dispatch<SetStateAction<boolean>>;
  setPickerFor: Dispatch<SetStateAction<`segment:${string}` | null>>;
  setPromptPickOpen: Dispatch<SetStateAction<boolean>>;
  setDetailFor: SetDetailFor;
}) {
  const { t } = useTranslation();
  if (!detailFor || !overview) return null;
  const fileHint = (relative: string) => joinLibraryPath(libraryRoot, relative);
  // 某类资源（character/location/prop）已连到哪些片段（#序号）。
  const linkedSegmentLabel = (kind: string, id: string) => {
    const segIds = overview.node_links
      .filter((l) => l.from_kind === kind && l.from_id === id)
      .map((l) => l.to_segment);
    const labels = segments
      .map((segment, index) => ({ id: segment.id, label: `#${index + 1}` }))
      .filter(({ id }) => segIds.includes(id))
      .map(({ label }) => label);
    return labels.length > 0 ? labels.join("、") : "—";
  };
  // 「当前」集合：与某片段直连的该类资源；或与来源资源共片段的同 类资源（无则退为来源自身）。
  const linkedToSegment = (kind: string, segId: string) =>
    overview.node_links.filter((l) => l.to_segment === segId && l.from_kind === kind).map((l) => l.from_id);
  const kindLabelOf = (group: "characters" | "locations" | "props") =>
    t(group === "characters" ? "project.canvas.typeCharacter" : group === "locations" ? "project.canvas.typeLocation" : "project.canvas.typeProp");
  const scopeLabelsOf = (group: EntityPhKind) => ({
    current: t(
      group === "character"
        ? "project.canvas.scopeCurrentChars"
        : group === "location"
          ? "project.canvas.scopeCurrentLocs"
          : "project.canvas.scopeCurrentProps",
    ),
    all: t(
      group === "character"
        ? "project.canvas.scopeAllChars"
        : group === "location"
          ? "project.canvas.scopeAllLocs"
          : "project.canvas.scopeAllProps",
    ),
  });
  const avatarPreview = (name: string, path: string | null, fallback: React.ReactNode) =>
    path ? (
      <ResourceImage path={fileHint(path)} alt={name} className="pc-detail-img" />
    ) : (
      <span className={`pc-detail-ava pc-ava-p${characterAvatarPaletteIndex(name)}`}>{fallback}</span>
    );

  if (detailFor.kind === "promptPh") {
    const ph = promptPhs.find((item) => item.id === detailFor.id);
    if (!ph) return null;
    const prompt = prompts.find((item) => item.id === ph.promptId);
    return (
      <ProjectNodeDetailDialog
        title={prompt ? prompt.title : t("project.canvas.promptUntitled")}
        accent={NODE_ACCENTS.prompt}
        error={detailError}
        entries={[{
          key: `prompt:${ph.id}`,
          title: prompt ? prompt.title : t("project.canvas.promptUntitled"),
          badge: t("project.canvas.typePrompt"),
          preview: prompt ? (
            <div className="pc-detail-prompt">{prompt.content}</div>
          ) : (
            <div className="pc-detail-preview-empty">{Icons.file}{t("project.canvas.promptEmpty")}</div>
          ),
          info: prompt?.category
            ? [{ label: t("project.prompt.field.category"), value: t(promptCategoryKey(prompt.category)) }]
            : [],
          actions: (
            <button
              type="button"
              className="pc-detail-btn"
              onClick={() => {
                setDetailFor(null);
                setPromptPickTarget(`prompt:${ph.id}`);
                setPromptPickOpen(true);
              }}
            >
              {Icons.resources}{t("project.canvas.promptReselect")}
            </button>
          ),
        }]}
        onClose={closeDetail}
      />
    );
  }
  if (detailFor.kind === "segment") {
    const segment = segments.find((item) => item.id === detailFor.id);
    if (!segment) return null;
    const segIndex = segments.indexOf(segment) + 1;
    const { chars, locs, props } = detailFor.scopes;
    const linkedCharIds = linkedToSegment("character", segment.id);
    const linkedLocIds = linkedToSegment("location", segment.id);
    const linkedPropIds = linkedToSegment("prop", segment.id);
    const segEntries = {
      characters: (chars === "current" ? castCharacters.filter((c) => linkedCharIds.includes(c.id)) : castCharacters).map((character) => ({
        key: `char:${character.id}`,
        title: character.name,
        badge: kindLabelOf("characters"),
        preview: avatarPreview(character.name, character.avatar_path, characterAvatarInitial(character.name)),
        info: [{ label: t("project.canvas.detailLinks"), value: linkedSegmentLabel("character", character.id) }],
      })),
      locations: (locs === "current" ? episodeLocations.filter((l) => linkedLocIds.includes(l.id)) : episodeLocations).map((location) => ({
        key: `loc:${location.id}`,
        title: location.name,
        badge: kindLabelOf("locations"),
        preview: avatarPreview(location.name, location.ref_path, Icons.resources),
        info: [{ label: t("project.canvas.detailLinks"), value: linkedSegmentLabel("location", location.id) }],
      })),
      props: (props === "current" ? episodeProps.filter((p) => linkedPropIds.includes(p.id)) : episodeProps).map((prop) => ({
        key: `prop:${prop.id}`,
        title: prop.name,
        badge: kindLabelOf("props"),
        preview: avatarPreview(prop.name, prop.ref_path, Icons.star),
        info: [{ label: t("project.canvas.detailLinks"), value: linkedSegmentLabel("prop", prop.id) }],
      })),
    };
    const setSegScope = (part: "chars" | "locs" | "props", scope: "current" | "all") =>
      setDetailFor({ kind: "segment", id: segment.id, scopes: { ...detailFor.scopes, [part]: scope } });
    const startAttach = (file: { filePath: string; kind: string; name: string }) => attachSegmentFromLibrary(segment.id, file);
    return (
      <ProjectNodeDetailDialog
        title={segment.note || `${t("project.canvas.segName")} #${segIndex}`}
        accent={NODE_ACCENTS.segment}
        error={detailError}
        count={segEntries.characters.length + segEntries.locations.length + segEntries.props.length}
        sections={[
          {
            key: "chars",
            title: kindLabelOf("characters"),
            scope: chars,
            scopeLabels: scopeLabelsOf("character"),
            onScopeChange: (scope) => setSegScope("chars", scope),
            entries: segEntries.characters,
          },
          {
            key: "locs",
            title: kindLabelOf("locations"),
            scope: locs,
            scopeLabels: scopeLabelsOf("location"),
            onScopeChange: (scope) => setSegScope("locs", scope),
            entries: segEntries.locations,
          },
          {
            key: "props",
            title: kindLabelOf("props"),
            scope: props,
            scopeLabels: scopeLabelsOf("prop"),
            onScopeChange: (scope) => setSegScope("props", scope),
            entries: segEntries.props,
          },
        ]}
        extra={(
          <div className="pc-detail-extra">
            <div className="pc-detail-extra-head">{t("project.canvas.segAttach")}</div>
            {segment.asset && (
              <div className="pc-detail-extra-body">
                <div className="pc-detail-video small">
                  <ResourceVideoPoster
                    path={fileHint(segment.asset.file_path)}
                    version={segment.asset.updated_at}
                    fallbackLabel={segment.asset.name || segment.asset.file_path}
                  />
                </div>
                <div className="pc-detail-extra-info">
                  <b>{segment.asset.name || segment.asset.file_path}</b>
                  <small>{segment.asset.file_path}</small>
                  <button type="button" className="pc-detail-btn" onClick={() => handleLocate(segment.asset as ProjectAsset)}>
                    {Icons.externalLink}{t("project.canvas.openFile")}
                  </button>
                </div>
              </div>
            )}
            {/* 挂产出动作常驻：已有产出时可再次上传/库选直接更换。 */}
            <div className="pc-detail-extra-actions">
              <button type="button" className="pc-detail-btn primary" onClick={() => void uploadViaImport(startAttach)}>
                {Icons.add}{t("project.canvas.detailUpload")}
              </button>
              <button type="button" className="pc-detail-btn" onClick={() => setPickerFor(`segment:${segment.id}`)}>
                {Icons.resources}{t("project.canvas.detailPickLibrary")}
              </button>
            </div>
          </div>
        )}
        onClose={closeDetail}
      />
    );
  }
  if (detailFor.kind === "entityPh") {
    const ph = entityPhs.find((item) => item.id === detailFor.id);
    if (!ph) return null;
    const kindLabel = kindTextOf(ph.kind);
    const openBind = () => setMemberPick({ mode: "eph", ephId: ph.id, kind: ph.kind, pending: [] });
    return (
      <ProjectNodeDetailDialog
        title={kindLabel}
        accent={NODE_ACCENTS[ph.kind] ?? "#94a3b8"}
        error={detailError}
        entries={[{
          key: `eph:${ph.id}`,
          title: t("project.canvas.ephUnloaded"),
          badge: kindLabel,
          preview: (
            <button type="button" className="pc-detail-drop" onClick={openBind}>
              {ph.kind === "character" ? Icons.clipboard : ph.kind === "location" ? Icons.resources : Icons.star}
              {t("project.canvas.ephPickHint")}
            </button>
          ),
          info: [{ label: t("project.canvas.detailStatus"), value: t("project.canvas.ephUnloaded") }],
          actions: (
            <button type="button" className="pc-detail-btn primary" onClick={openBind}>
              {Icons.resources}{t("project.canvas.ephLoad")}
            </button>
          ),
        }]}
        onClose={closeDetail}
      />
    );
  }
  if (detailFor.kind === "info") {
    const { group, sourceKey, scope } = detailFor;
    const srcId = sourceKey.slice(sourceKey.indexOf(":") + 1);
    const isGroup = sourceKey.startsWith("grp:");
    const grp = isGroup ? infoGroups.find((g) => `grp:${g.id}` === sourceKey) : null;
    const kindLabel = kindTextOf(group);
    const entities = entitiesOfKind(group);
    const members = grp ? grp.members : [srcId];
    const scopeList = scope === "current" ? entities.filter((e) => members.includes(e.id)) : entities;
    const entries: NodeDetailEntry[] = scopeList.map((entity) => {
      const isMember = members.includes(entity.id);
      const refPath = group === "character" ? (entity as { avatar_path: string }).avatar_path : (entity as { ref_path: string }).ref_path;
      let actions: React.ReactNode;
      if (isGroup && grp) {
        actions = isMember ? (
          <button type="button" className="pc-detail-btn" onClick={() => void removeGroupMember(grp.id, entity.id)}>
            {Icons.close}{t("project.canvas.detailRemoveMember")}
          </button>
        ) : (
          <button type="button" className="pc-detail-btn primary" onClick={() => void addGroupMember(grp.id, entity.id)}>
            {Icons.add}{t("project.canvas.detailAddMember")}
          </button>
        );
      }
      return {
        key: `${group}:${entity.id}`,
        title: entity.name,
        badge: kindLabel,
        preview: avatarPreview(entity.name, refPath, group === "prop" ? Icons.star : characterAvatarInitial(entity.name)),
        info: [{ label: t("project.canvas.detailLinks"), value: linkedSegmentLabel(group, entity.id) }],
        actions,
      };
    });
    // 继续装入：多选库面板 + 装入确认。默认节点装入第二个成员即升级
    // 为组节点（原位、连线随归属解析自动归组）。
    const openMemberPanel = () => {
      setMemberPick(
        grp
          ? { mode: "grp", groupId: grp.id, kind: group, pending: [...grp.members] }
          : { mode: "convert", sourceKey, kind: group, pending: [srcId] },
      );
    };
    return (
      <ProjectNodeDetailDialog
        title={isGroup && grp ? `${kindLabel} ×${grp.members.length}` : kindLabel}
        accent={NODE_ACCENTS[group] ?? "#94a3b8"}
        entries={entries}
        scope={scope}
        scopeLabels={scopeLabelsOf(group)}
        onScopeChange={(next) => setDetailFor({ kind: "info", group, sourceKey, scope: next })}
        extra={(
          <div className="pc-detail-extra">
            <div className="pc-detail-extra-head">{t("project.canvas.detailAddMore")}</div>
            <div className="pc-detail-extra-actions">
              <button type="button" className="pc-detail-btn primary" onClick={openMemberPanel}>
                {Icons.add}{t("project.canvas.detailAdd", { kind: kindLabel })}
              </button>
            </div>
          </div>
        )}
        onClose={closeDetail}
      />
    );
  }
  // script：单文件窗口（文本预览 + 路径 + 打开）。主剧本节点读本集
  // script_path；剧本纸片读自己的文件（重新挂接也只换纸片的文件）。
  const scriptPh = detailFor.phId ? scriptPhs.find((item) => item.id === detailFor.phId) : null;
  const scriptPath = scriptPh ? scriptPh.path : overview.episode.script_path;
  if (!scriptPath) return null;
  const scriptName = scriptFileLabel(scriptPath);
  return (
    <ProjectNodeDetailDialog
      title={scriptName}
      accent={NODE_ACCENTS.script}
      entries={[{
        key: "script",
        title: scriptName,
        badge: t("project.canvas.typeScript"),
        preview: <TextPaperBody path={fileHint(scriptPath)} name={scriptName} lines={16} />,
        info: [{ label: t("project.canvas.detailPath"), value: scriptPath }],
        actions: (
          <>
            <button type="button" className="pc-detail-btn" onClick={() => void openResourceFile(fileHint(scriptPath))}>
              {Icons.externalLink}{t("project.canvas.openFile")}
            </button>
            {/* 重新挂接：换库内其他文件（窗口保持打开，重选后条目就地
                刷新；节点留在原位；主剧本换的是本集剧本，纸片只换自己）。 */}
            <button
              type="button"
              className="pc-detail-btn"
              onClick={() => {
                setScriptPickTarget(scriptPh ? `script:${scriptPh.id}` : "script");
                setScriptPickOpen(true);
              }}
            >
              {Icons.link}{t("project.canvas.detailRelinkScript")}
            </button>
          </>
        ),
      }]}
      onClose={closeDetail}
    />
  );
}
