// 工程画布删除语义与成员装入（自 ProjectCanvas.tsx 组件体零改动搬移，
// 2026-11-03 引擎拆分阶段 11d）：工具条与 Delete 键共用的节点删除分流、
// 撤销快照、键盘 Delete/Backspace/Ctrl+C/V/Z 与 applyMemberPick 落账。
import { useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { EpisodeOverview, ProjectNodeLink } from "../../../../stores/projectStore";
import { ENTITY_PORTS } from "./usePorts";
import type { CanvasNote, EntityPh, EntityPhKind, InfoGroup, NodeGroup, PendingLink, Pos, PromptPh, ScriptPh } from "../types";
import type { MemberPickT } from "../layers/dialogTypes";

type ProjectLinkKind = ProjectNodeLink["from_kind"];
type ProjectLinkPort = ProjectNodeLink["to_port"];

export function useDeleteOps(deps: {
  notes: CanvasNote[];
  setNotes: Dispatch<SetStateAction<CanvasNote[]>>;
  persistNotes(next: CanvasNote[]): void;
  entityPhs: EntityPh[];
  persistEntityPhs(next: EntityPh[]): void;
  scriptPhs: ScriptPh[];
  persistScriptPhs(next: ScriptPh[]): void;
  promptPhs: PromptPh[];
  persistPromptPhs(next: PromptPh[]): void;
  pendingLinks: PendingLink[];
  persistPendingLinks(next: PendingLink[]): void;
  infoGroups: InfoGroup[];
  persistInfoGroups(next: InfoGroup[]): void;
  infoNodePos(key: string): Pos;
  infoOffsets: Record<string, Pos>;
  persistInfoOffsets(next: Record<string, Pos>): void;
  nodeGroups: NodeGroup[];
  persistNodeGroups(next: NodeGroup[]): void;
  selKeys: string[];
  setSelection(keys: string[]): void;
  memberPick: MemberPickT | null;
  setMemberPick: Dispatch<SetStateAction<MemberPickT | null>>;
  detailFor: unknown;
  setDetailFor(d: unknown): void;
  pickerFor: unknown;
  episodeId: string;
  overview: EpisodeOverview | null;
  unlinkNode(
    kind: ProjectLinkKind, id: string, segmentId: string, port: string, ownerKey?: string,
  ): unknown;
  linkNode(
    episodeId: string, kind: ProjectLinkKind, id: string,
    segmentId: string, port: ProjectLinkPort, ownerKey?: string,
  ): unknown;
  associateEntities(kind: string, ids: string[]): unknown;
  unlinkEntityLinks(kind: string, entityId: string, ownerKey?: string): unknown;
  groupWiredPorts(group: InfoGroup): Array<{ to_segment: string; to_port: string }>;
  removeSegment(id: string): unknown;
  deleteShot(shotId: string): unknown;
  setEpisodeCharacters(episodeId: string, ids: string[]): unknown;
  setEpisodeLocations(episodeId: string, ids: string[]): unknown;
  setEpisodeProps(episodeId: string, ids: string[]): unknown;
  setEpisodeOutput(episodeId: string, key: string | null): unknown;
  copySelection(): void;
  pasteClipboard(): void;
  runUndo(): void;
  pushUndo(action: unknown): void;
  memberFrame(key: string): { x: number; y: number; w: number; h: number } | null;
  updateEpisode(episodeId: string, patch: { title: string; status: string; script_path?: string }): unknown;
  dropPendingLinksOf(key: string): void;
  vpRef: { current: HTMLDivElement | null };
  addMenu: unknown;
  wireDraft: unknown;
  locationPickOpen: boolean;
  sceneForm: unknown;
  shotForm: unknown;
  deleteSceneTarget: unknown;
  scriptPickOpen: boolean;
  setPromptPickOpen(open: boolean): void;
  setPromptPickQuery(q: string): void;
  setPulseKeys(next: string[]): void;
  spawnAnchorRef: { current: { wx: number; wy: number; used: number; snapshot?: string[] } | null };
  groupingRef: { current: boolean };
  promptPickTarget: string | null;
  setPromptPickTarget(t: string | null): void;
}) {
  const {
    notes, setNotes, persistNotes, entityPhs, persistEntityPhs, scriptPhs,
    persistScriptPhs, promptPhs, persistPromptPhs, pendingLinks,
    persistPendingLinks, infoGroups, persistInfoGroups, infoNodePos,
    infoOffsets, persistInfoOffsets, nodeGroups, persistNodeGroups, selKeys,
    setSelection, memberPick, setMemberPick, detailFor, setDetailFor,
    pickerFor, episodeId, overview, unlinkNode, linkNode,
    associateEntities, unlinkEntityLinks, groupWiredPorts,
    removeSegment, deleteShot, setEpisodeCharacters,
    setEpisodeLocations, setEpisodeProps, setEpisodeOutput, copySelection,
    pasteClipboard, runUndo, pushUndo, memberFrame,
    groupingRef, promptPickTarget, setPromptPickTarget,
    updateEpisode, dropPendingLinksOf,
    vpRef, addMenu, wireDraft, locationPickOpen, sceneForm, shotForm,
    deleteSceneTarget, scriptPickOpen, setPromptPickOpen, setPromptPickQuery,
    setPulseKeys, spawnAnchorRef,
  } = deps;
  const { t } = useTranslation();

  // ── 节点删除（工具条与 Delete 键共用同一套语义）──
  // 资料实体节点：解除连线 + 移出本集关联（实体保留在库里，可再关联）。
  const removeInfoEntity = useCallback(
    async (kind: EntityPhKind, entityId: string) => {
      if (!episodeId || !overview) return;
      await unlinkEntityLinks(kind, entityId);
      const episode = overview.episode;
      if (kind === "character") await setEpisodeCharacters(episodeId, (episode.character_ids ?? []).filter((id) => id !== entityId));
      else if (kind === "location") await setEpisodeLocations(episodeId, (episode.location_ids ?? []).filter((id) => id !== entityId));
      else await setEpisodeProps(episodeId, (episode.prop_ids ?? []).filter((id) => id !== entityId));
    },
    [episodeId, overview, setEpisodeCharacters, setEpisodeLocations, setEpisodeProps, unlinkEntityLinks],
  );
  // 组节点：解散分组（成员实体与连线保留，自动回到默认单实体节点）。
  const removeGroup = useCallback(
    (groupId: string) => {
      persistInfoGroups(infoGroups.filter((g) => g.id !== groupId));
    },
    [infoGroups, persistInfoGroups],
  );
  // 主剧本节点：解除挂接（剧本文件留在库内），提示词连线一并清理；
  // 删除后彻底从画布移除（空纸片走 removeScriptPh，互不相干）。
  const detachScript = useCallback(async () => {
    const episode = overview?.episode;
    if (!episodeId || !episode?.script_path) return;
    const rows = (overview?.node_links ?? []).filter((l) => l.from_kind === "script");
    for (const row of rows) await unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port);
    await updateEpisode(episodeId, { title: episode.title, status: episode.status, script_path: "" });
  }, [episodeId, overview, unlinkNode, updateEpisode]);
  // 剧本纸片：从画布移除纸片记录、位置记忆与暂存线（不影响本集剧本）。
  const removeScriptPh = useCallback(
    (phId: string) => {
      const key = `script:${phId}`;
      const next = { ...infoOffsets };
      delete next[key];
      persistInfoOffsets(next);
      persistScriptPhs(scriptPhs.filter((item) => item.id !== phId));
      dropPendingLinksOf(key);
    },
    [scriptPhs, infoOffsets, persistScriptPhs, persistInfoOffsets, dropPendingLinksOf],
  );
  // 提示词纸片：移除纸片、位置记忆与暂存线。
  const removePromptPh = useCallback(
    (phId: string) => {
      const key = `prompt:${phId}`;
      const next = { ...infoOffsets };
      delete next[key];
      persistInfoOffsets(next);
      persistPromptPhs(promptPhs.filter((item) => item.id !== phId));
      dropPendingLinksOf(key);
    },
    [promptPhs, infoOffsets, persistPromptPhs, persistInfoOffsets, dropPendingLinksOf],
  );
  // 提示词选择：把选中的提示词 id 写回目标纸片。
  const handlePromptPick = useCallback(
    (promptId: string) => {
      const target = promptPickTarget;
      setPromptPickOpen(false);
      setPromptPickTarget(null);
      if (!target || !target.startsWith("prompt:")) return;
      const phId = target.slice(7);
      if (!promptPhs.some((item) => item.id === phId)) return;
      persistPromptPhs(promptPhs.map((item) => (item.id === phId ? { ...item, promptId } : item)));
    },
    [promptPickTarget, promptPhs, persistPromptPhs, setPromptPickOpen, setPromptPickTarget],
  );
  const closePromptPick = useCallback(() => {
    setPromptPickOpen(false);
    setPromptPickTarget(null);
    setPromptPickQuery("");
  }, [setPromptPickOpen, setPromptPickTarget, setPromptPickQuery]);
  // 空白资料占位：删除占位并清掉它拖动过的位置记忆与暂存线。
  const removeEntityPh = useCallback(
    (phId: string) => {
      const next = { ...infoOffsets };
      delete next[`eph:${phId}`];
      persistInfoOffsets(next);
      persistEntityPhs(entityPhs.filter((item) => item.id !== phId));
      dropPendingLinksOf(`eph:${phId}`);
    },
    [entityPhs, infoOffsets, persistEntityPhs, persistInfoOffsets, dropPendingLinksOf],
  );
  // ── 键盘：Delete/Backspace 删除选中节点（与各节点工具条同一套语义；
  // 镜头卡有确认对话框，走同一确认流程）；Ctrl+C/V 复制粘贴选中组；
  // Ctrl+Z 撤销。输入框聚焦或任一弹层打开时不响应。 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      // 面板保挂载：资源页被 display:none 隐藏（用户在剪切板等其他顶级区）
      // 时不响应，否则别处按 Delete/Backspace 会隔着隐藏面板删掉工程选中。
      if (!vpRef.current || vpRef.current.offsetParent === null) return;
      if (
        detailFor || pickerFor || memberPick || addMenu || wireDraft ||
        scriptPickOpen || locationPickOpen || sceneForm || shotForm ||
        deleteSceneTarget
      ) {
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === "c") {
          copySelection();
          return;
        }
        if (k === "v") {
          void pasteClipboard();
          return;
        }
        if (k === "z") {
          e.preventDefault();
          // 恢复出的资料节点不是「新加载」：先清掉可能残留的出生锚点，
          // 免得恢复的节点被锚点重新定位、偏离删除前的原位。
          spawnAnchorRef.current = null;
          runUndo();
          return;
        }
        if (k === "g") {
          // 打组 / 解组（ComfyUI Group）：选中若干节点 → 组框自适应包围
          // 盒；选中恰好是某组全部成员 → 解组。成员从其他组移出（互斥）。
          e.preventDefault();
          if (groupingRef.current) return;
          groupingRef.current = true;
          window.setTimeout(() => {
            groupingRef.current = false;
          }, 0);
          if (selKeys.length === 0) return;
          // 先剪枝：成员已被删除的组清掉死成员（空组丢弃），保证解组
          // 判定与组框都基于存活成员。
          const pruned = nodeGroups
            .map((g) => ({ ...g, members: g.members.filter((key) => memberFrame(key) !== null) }))
            .filter((g) => g.members.length > 0);
          const fullGroup = pruned.find(
            (g) => g.members.length === selKeys.length && selKeys.every((key) => g.members.includes(key)),
          );
          if (fullGroup) {
            persistNodeGroups(pruned.filter((g) => g.id !== fullGroup.id));
          } else {
            const kept = pruned
              .map((g) => ({ ...g, members: g.members.filter((key) => !selKeys.includes(key)) }))
              .filter((g) => g.members.length > 0);
            persistNodeGroups([
              ...kept,
              { id: `ng${Date.now()}${Math.floor(Math.random() * 1e4)}`, label: t("project.canvas.nodeGroup"), members: [...selKeys] },
            ]);
          }
          return;
        }
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (selKeys.length === 0) return;
      e.preventDefault();
      // 可完整恢复的删除（便签/空白占位/剧本纸片）先抓原对象与暂存线，
      // 整批删除记一条撤销；恢复时原样还原（含线）。
      const restore: {
        notes?: CanvasNote[];
        ephs?: { id: string; kind: EntityPhKind; x: number; y: number }[];
        scriptPhs?: { id: string; path: string }[];
        scriptOffsets?: { key: string; pos: Pos }[];
        promptPhs?: PromptPh[];
        promptOffsets?: { key: string; pos: Pos }[];
        pending?: PendingLink[];
      } = {};
      for (const key of selKeys) {
        if (key === "output") {
          if (episodeId) void setEpisodeOutput(episodeId, null);
        } else if (key.startsWith("shot:")) {
          void deleteShot(key.slice(5));
        } else if (key.startsWith("note:")) {
          const removed = notes.find((item) => item.id === key.slice(5));
          setNotes((prev) => {
            const next = prev.filter((item) => item.id !== key.slice(5));
            persistNotes(next);
            return next;
          });
          if (removed) (restore.notes ??= []).push(removed);
        } else if (key.startsWith("segment:")) {
          void removeSegment(key.slice(8));
        } else if (key.startsWith("eph:")) {
          const removed = entityPhs.find((item) => item.id === key.slice(4));
          const dropped = pendingLinks.filter((l) => l.fromKey === key);
          removeEntityPh(key.slice(4));
          if (removed) (restore.ephs ??= []).push(removed);
          if (dropped.length) (restore.pending ??= []).push(...dropped);
        } else if (key.startsWith("grp:")) {
          removeGroup(key.slice(4));
        } else if (key === "script") {
          void detachScript();
        } else if (key.startsWith("script:")) {
          const removed = scriptPhs.find((item) => item.id === key.slice(7));
          const dropped = pendingLinks.filter((l) => l.fromKey === key);
          // 无论纸片是否拖动过都按解析位置还原（拖过的=覆盖位置，
          // 没拖过的=当前网格位），撤销后回到删除前的原位。
          const phPos = infoNodePos(key);
          removeScriptPh(key.slice(7));
          if (removed) (restore.scriptPhs ??= []).push(removed);
          if (phPos) (restore.scriptOffsets ??= []).push({ key, pos: phPos });
          if (dropped.length) (restore.pending ??= []).push(...dropped);
        } else if (key.startsWith("prompt:")) {
          const removed = promptPhs.find((item) => item.id === key.slice(7));
          const dropped = pendingLinks.filter((l) => l.fromKey === key);
          const phPos = infoNodePos(key);
          removePromptPh(key.slice(7));
          if (removed) (restore.promptPhs ??= []).push(removed);
          if (phPos) (restore.promptOffsets ??= []).push({ key, pos: phPos });
          if (dropped.length) (restore.pending ??= []).push(...dropped);
        } else if (key.startsWith("char:") || key.startsWith("loc:") || key.startsWith("prop:")) {
          const kind: EntityPhKind = key.startsWith("char:") ? "character" : key.startsWith("loc:") ? "location" : "prop";
          void removeInfoEntity(kind, key.slice(key.indexOf(":") + 1));
        }
      }
      if (restore.notes || restore.ephs || restore.scriptPhs || restore.promptPhs || restore.pending) {
        pushUndo({
          type: "restore", notes: restore.notes,
          ephs: restore.ephs, scriptPhs: restore.scriptPhs, pending: restore.pending,
          scriptOffsets: restore.scriptOffsets, promptPhs: restore.promptPhs, promptOffsets: restore.promptOffsets,
        });
      }
      setSelection([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    selKeys, detailFor, pickerFor, memberPick, addMenu, wireDraft, scriptPickOpen, locationPickOpen,
    sceneForm, shotForm, deleteSceneTarget, episodeId, notes, entityPhs, scriptPhs, promptPhs, infoOffsets, infoNodePos,
    setEpisodeOutput, deleteShot, setNotes, persistNotes, removeSegment,
    removeEntityPh, removeGroup, detachScript, removeScriptPh, removePromptPh, removeInfoEntity, setSelection,
    copySelection, pasteClipboard, runUndo, pushUndo, nodeGroups, persistNodeGroups, t,
    pendingLinks, memberFrame, groupingRef, spawnAnchorRef, vpRef,
  ]);
  // 成员装入面板（多选 + 装入确认）：eph 加载 / 组追加裁剪 / 默认节点转组。
  const applyMemberPick = useCallback(async () => {
    const pick = memberPick;
    if (!pick || !episodeId) return;
    setMemberPick(null);
    // 成员可在多个组复用（同一角色可同时挂上多个片段，如同主角出场于
    // 上下两个片段），不做组间互斥过滤。
    const pending = pick.pending;
    const groupIdOf = () => `g${Date.now()}${Math.floor(Math.random() * 1e4)}`;
    // 概览整刷（associateEntities → selectEpisode 先置空 overview）会令画布
    // 卸载重挂，重挂后的按集状态读自 localStorage。因此画布层落账（位置/
    // 组/占位/暂存线）与转正连线必须全部发生在刷新之前，且连线要逐条等
    // 落库完成——否则重挂读到旧账：占位与暂存线成幽灵残影（伪连接）、
    // 组节点落回网格旧位。
    if (pick.mode === "eph") {
      const ph = entityPhs.find((p) => p.id === pick.ephId);
      if (!ph || pending.length === 0) return;
      const groupId = groupIdOf();
      const pos = infoNodePos(`eph:${ph.id}`);
      const nextOffsets = { ...infoOffsets, [`grp:${groupId}`]: pos };
      delete nextOffsets[`eph:${ph.id}`];
      persistInfoOffsets(nextOffsets);
      persistEntityPhs(entityPhs.filter((p) => p.id !== ph.id));
      persistInfoGroups([...infoGroups, { id: groupId, kind: pick.kind, members: [...pending] }]);
      // 占位节点的暂存线随加载转正：组内每个成员各落一条 node_link
      // （owner 记组身份，组删线/找组口按此精确匹配）。转正落到资料口
      // 时先顶掉口上既有来源——占位在口上挂着，实体加载后正式接上，
      // 原来占着这个口的其他来源被替换（后连顶先连）。顶掉的既有线
      // （他人正式行 + 他人暂存线）在这里一次性合并删除：同块逐口调用
      // displace 的话，多次 persistPendingLinks 基于同一闭包旧值会互相
      // 覆盖。
      const ephKey = `eph:${ph.id}`;
      const myPending = pendingLinks.filter((l) => l.fromKey === ephKey);
      myPending.forEach((l) => {
        if (!ENTITY_PORTS.has(l.toPort)) return;
        (overview?.node_links ?? [])
          .filter((row) => row.to_segment === l.toSegmentId && row.to_port === l.toPort)
          .forEach((row) => {
            void unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port, row.owner_key);
          });
      });
      const displacedStale = pendingLinks.filter(
        (l) =>
          l.fromKey !== ephKey &&
          ENTITY_PORTS.has(l.toPort) &&
          myPending.some((m) => m.toSegmentId === l.toSegmentId && m.toPort === l.toPort),
      );
      if (displacedStale.length) {
        persistPendingLinks(pendingLinks.filter((l) => !displacedStale.includes(l)));
      }
      for (const l of myPending) {
        for (const memberId of pending) {
          await linkNode(episodeId, pick.kind, memberId, l.toSegmentId, l.toPort as ProjectNodeLink["to_port"], `grp:${groupId}`);
        }
      }
      if (myPending.length) persistPendingLinks(pendingLinks.filter((l) => l.fromKey !== ephKey));
      await associateEntities(pick.kind, pending);
      setPulseKeys([`grp:${groupId}`]);
      setDetailFor({ kind: "info", group: pick.kind, sourceKey: `grp:${groupId}`, scope: "current" });
      return;
    }
    if (pick.mode === "grp") {
      const group = infoGroups.find((g) => g.id === pick.groupId);
      if (!group) return;
      const additions = pending.filter((id) => !group.members.includes(id));
      const removals = group.members.filter((id) => !pending.includes(id));
      const wired = groupWiredPorts(group);
      for (const id of additions) {
        for (const w of wired) await linkNode(episodeId, pick.kind, id, w.to_segment, w.to_port as ProjectNodeLink["to_port"], `grp:${group.id}`);
      }
      // 面板勾掉的成员 = 从本组移除：只删本组名下的线，成员在其他组
      // 的连线保留（共享复用）。
      for (const id of removals) await unlinkEntityLinks(pick.kind, id, `grp:${group.id}`);
      persistInfoGroups(infoGroups.map((g) => (g.id === group.id ? { ...g, members: [...pending] } : g)));
      await associateEntities(pick.kind, additions);
      return;
    }
    // convert：默认单实体节点继续装入 → 升级为组节点（原位；primary 已有
    // 连线随归属解析自动归到组名下，新成员自动接入同样片段口）。
    const srcId = pick.sourceKey.slice((pick.kind === "character" ? "char:" : pick.kind === "location" ? "loc:" : "prop:").length);
    if (pending.length <= 1 || !pending.includes(srcId)) return;
    const groupId = groupIdOf();
    const pos = infoNodePos(pick.sourceKey);
    const nextOffsets = { ...infoOffsets, [`grp:${groupId}`]: pos };
    delete nextOffsets[pick.sourceKey];
    persistInfoOffsets(nextOffsets);
    persistInfoGroups([...infoGroups, { id: groupId, kind: pick.kind, members: [...pending] }]);
    const wiredRows = (overview?.node_links ?? []).filter((l) => l.from_kind === pick.kind && l.from_id === srcId);
    const seen = new Set<string>();
    for (const row of wiredRows) {
      const k = `${row.to_segment}|${row.to_port}`;
      if (seen.has(k)) continue;
      seen.add(k);
      for (const id of pending) {
        if (id !== srcId) await linkNode(episodeId, pick.kind, id, row.to_segment, row.to_port, `grp:${groupId}`);
      }
    }
    await associateEntities(pick.kind, pending);
    setDetailFor({ kind: "info", group: pick.kind, sourceKey: `grp:${groupId}`, scope: "current" });
  }, [
    memberPick, episodeId, entityPhs, infoNodePos, infoOffsets, persistInfoOffsets, persistEntityPhs,
    infoGroups, persistInfoGroups, associateEntities, groupWiredPorts, linkNode, overview,
    unlinkEntityLinks, pendingLinks, persistPendingLinks, unlinkNode,
    setDetailFor, setMemberPick, setPulseKeys,
  ]);

  return {
    removeInfoEntity,
    removeGroup,
    detachScript,
    removeScriptPh,
    removePromptPh,
    removeEntityPh,
    handlePromptPick,
    closePromptPick,
    applyMemberPick,
  };
}
