// 工程画布详情窗动作集（自 ProjectCanvas.tsx 组件体零改动搬移，
// 2026-11-03 引擎拆分阶段 11d）：本机上传入库、打开文件定位、组员移除
// 与追加（连线语义 = 组内全部成员，见 groupWiredPorts）。
import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openResourceFile } from "../../../../domain/mediaAssets";
import { joinLibraryPath } from "../../../../domain/projectView";
import type { ProjectAsset, ProjectNodeLink } from "../../../../stores/projectStore";
import { INFO_W } from "../layout";
import type { InfoGroup, Pos } from "../types";

export function useDetailActions(deps: {
  libraryRoot: string;
  setDetailError(err: string): void;
  episodeId: string;
  infoGroups: InfoGroup[];
  persistInfoGroups(next: InfoGroup[]): void;
  infoOffsets: Record<string, Pos>;
  persistInfoOffsets(next: Record<string, Pos>): void;
  infoNodePos(key: string): Pos;
  unlinkEntityLinks(kind: string, entityId: string, ownerKey?: string): unknown;
  groupWiredPorts(group: InfoGroup): Array<{ to_segment: string; to_port: string }>;
  linkNode(
    episodeId: string, kind: ProjectNodeLink["from_kind"], id: string,
    segmentId: string, port: ProjectNodeLink["to_port"], ownerKey?: string,
  ): unknown;
  associateEntities(kind: string, ids: string[]): unknown;
}) {
  const {
    libraryRoot, setDetailError, episodeId, infoGroups, persistInfoGroups,
    infoOffsets, persistInfoOffsets, infoNodePos, unlinkEntityLinks,
    groupWiredPorts, linkNode, associateEntities,
  } = deps;

  // 详情窗口动作：本机上传（选文件 → 复制入库 → 回调挂接；与库选择器
  // 的导入同一条链路）。
  const uploadViaImport = async (after: (file: { filePath: string; kind: string; name: string }) => void) => {
    setDetailError("");
    try {
      const { path } = await invoke<{ path: string }>("select_resource_trace_file");
      const file = await invoke<{ file_path: string; kind: string; name: string }>(
        "import_resource_file",
        { sourcePath: path },
      );
      after({ filePath: file.file_path, kind: file.kind, name: file.name });
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : String(error));
    }
  };
  const handleLocate = useCallback(
    (asset: ProjectAsset) => {
      void openResourceFile(joinLibraryPath(libraryRoot, asset.file_path));
    },
    [libraryRoot],
  );
  const removeGroupMember = useCallback(
    async (groupId: string, entityId: string) => {
      const group = infoGroups.find((g) => g.id === groupId);
      if (!group) return;
      // 只删本组名下的线：共享语义下同一实体可同时在其他组，那些组的
      // 连线不受影响（见 unlinkEntityLinks 的 owner 范围删除）。
      await unlinkEntityLinks(group.kind, entityId, `grp:${groupId}`);
      const members = group.members.filter((m) => m !== entityId);
      persistInfoGroups(
        members.length
          ? infoGroups.map((g) => (g.id === groupId ? { ...g, members } : g))
          : infoGroups.filter((g) => g.id !== groupId),
      );
      // 被移除的实体回到默认单实体节点，出生在组旁看得见的位置。
      const pos = infoNodePos(`grp:${groupId}`);
      persistInfoOffsets({
        ...infoOffsets,
        [`${group.kind === "character" ? "char" : group.kind === "location" ? "loc" : "prop"}:${entityId}`]: {
          x: Math.round(pos.x + INFO_W + 24),
          y: Math.round(pos.y),
        },
      });
    },
    [infoGroups, infoNodePos, infoOffsets, persistInfoGroups, persistInfoOffsets, unlinkEntityLinks],
  );
  const addGroupMember = useCallback(
    async (groupId: string, entityId: string) => {
      const group = infoGroups.find((g) => g.id === groupId);
      if (!group || group.members.includes(entityId)) return;
      // 连线与组员落账先于概览整刷（重挂读 localStorage，见 applyMemberPick）。
      // 组口按本组 owner 名下的线取（共享成员的他组线不算本组的口）。
      const wired = groupWiredPorts(group);
      for (const w of wired) await linkNode(episodeId, group.kind, entityId, w.to_segment, w.to_port as ProjectNodeLink["to_port"], `grp:${groupId}`);
      persistInfoGroups(infoGroups.map((g) => (g.id === groupId ? { ...g, members: [...g.members, entityId] } : g)));
      await associateEntities(group.kind, [entityId]);
    },
    [infoGroups, associateEntities, groupWiredPorts, linkNode, episodeId, persistInfoGroups],
  );

  return { uploadViaImport, handleLocate, removeGroupMember, addGroupMember };
}
