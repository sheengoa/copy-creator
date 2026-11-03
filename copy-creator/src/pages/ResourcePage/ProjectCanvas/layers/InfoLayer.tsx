// 工程画布节点分组框 + 资料框层（自 ProjectCanvas.tsx 渲染区零改动
// 搬运，2026-11-03 引擎拆分阶段 11c；fork 对齐点按原注释保持）。
import { Icons } from "../../../../components/Icons";
import { useTranslation } from "react-i18next";
import { joinLibraryPath } from "../../../../domain/projectView";
import { ResourceImage } from "../../ResourceMedia";
import { TextPaperBody } from "../TextPaperBody";
import { NODE_ACCENTS } from "../colors";
import type { CanvasInfo, EntityPhKind, InfoGroup, NodeGroup, Pos } from "../types";

/** 节点分组框（Ctrl+G）：框自适应成员包围盒，渲染在节点层之下。 */
export function NodeGroupsLayer({
  nodeGroups, memberFrame,
}: {
  nodeGroups: NodeGroup[];
  memberFrame(key: string): { x: number; y: number; w: number; h: number } | null;
}) {
  return (
    <>
{/* 节点分组框（Ctrl+G）：框自适应成员包围盒，渲染在节点层之下；
    拖标题条整组移动（复用组拖管线），组员被删后框随之收缩。 */}
{nodeGroups.map((group) => {
  const frames = group.members
    .map((key) => memberFrame(key))
    .filter((f): f is { x: number; y: number; w: number; h: number } => f !== null);
  if (frames.length === 0) return null;
  const pad = 14;
  const left = Math.min(...frames.map((f) => f.x)) - pad;
  const top = Math.min(...frames.map((f) => f.y)) - pad - 18;
  const right = Math.max(...frames.map((f) => f.x + f.w)) + pad;
  const bottom = Math.max(...frames.map((f) => f.y + f.h)) + pad;
  return (
    <div
      key={group.id}
      data-group={group.id}
      className="pc-nodegroup"
      style={{ left, top, width: right - left, height: bottom - top }}
    >
      <div className="pc-nodegroup-label">{group.label}</div>
    </div>
  );
})}
    </>
  );
}

/** 资料框：角色/场景/道具/剧本实体节点 + 组节点照片堆放。 */
export function InfoNodesLayer({
  infoNodes, infoGroups, infoNodePos, sizeOfNode, nodeSizes, pulseKeys, selKeys,
  portBar, resizeHandle, libraryRoot, entitiesOfKind, entityRefOf, photoMainOf,
  openInfoDetail, removeGroup, detachScript, removeScriptPh, removeInfoEntity,
}: {
  infoNodes: CanvasInfo[];
  infoGroups: InfoGroup[];
  infoNodePos(key: string): Pos;
  sizeOfNode(key: string): { w: number; h: number } | null;
  nodeSizes: Record<string, { w: number; h: number }>;
  pulseKeys: string[];
  selKeys: string[];
  portBar(key: string): React.ReactNode;
  resizeHandle: React.ReactNode;
  libraryRoot: string;
  entitiesOfKind(kind: EntityPhKind): Array<{ id: string; name: string; avatar_path?: string; ref_path?: string }>;
  entityRefOf(kind: EntityPhKind, entity: { avatar_path?: string; ref_path?: string }): string;
  photoMainOf(name: string, refPath: string): React.ReactNode;
  openInfoDetail(node: { kind: string; key: string; textPath?: string }): void;
  removeGroup(groupId: string): void;
  detachScript(): unknown;
  removeScriptPh(phId: string): void;
  removeInfoEntity(kind: EntityPhKind, entityId: string): unknown;
}) {
  const { t } = useTranslation();
  return (
    <>
{infoNodes.map((node) => {
  const p = infoNodePos(node.key);
  const nodeSize = sizeOfNode(node.key);
  const resized = Boolean(nodeSizes[node.key]);
  return (
    <div
      key={node.key}
      data-key={node.key}
      className={`pc-node pc-info${resized ? " pc-resized" : ""}${pulseKeys.includes(node.key) ? " pc-spawn" : ""}${selKeys.includes(node.key) ? " pc-selected" : ""}`}
      style={{
        left: p.x, top: p.y,
        width: nodeSize?.w ?? node.w,
        height: resized ? nodeSize?.h : undefined,
        minHeight: resized ? undefined : nodeSize && nodeSize.h !== node.h ? nodeSize.h : undefined,
        ["--node-accent" as string]: NODE_ACCENTS[node.kind] ?? "#94a3b8",
      } as React.CSSProperties}
    >
      <div className="pc-node-head">
        <span className="pc-node-kind">
          {t(
            node.kind === "character"
              ? "project.canvas.typeCharacter"
              : node.kind === "location"
                ? "project.canvas.typeLocation"
                : node.kind === "prop"
                  ? "project.canvas.typeProp"
                  : "project.canvas.typeScript",
          )}
        </span>
        <b className="pc-node-title">{node.name}</b>
      </div>
      {portBar(node.key)}
      <div className="pc-info-body">
        {node.key.startsWith("grp:") ? (
          // 组节点：照片堆放——首位成员的大图在上，其余成员的图
          // 边向右堆（层数上限 2，更多成员看标题 ×N 与详情窗成员
          // 列表）；成员已不可解析时退化为普通照片卡。
          (() => {
            const members = (infoGroups.find((g) => `grp:${g.id}` === node.key)?.members ?? [])
              .map((id) => {
                const kind = node.kind as EntityPhKind;
                const entity = entitiesOfKind(kind).find((e) => e.id === id) as
                  | { id: string; name: string; avatar_path?: string; ref_path?: string }
                  | undefined;
                return entity
                  ? { id, name: entity.name, ref: entityRefOf(kind, entity) }
                  : null;
              })
              .filter((m): m is { id: string; name: string; ref: string } => m !== null);
            const stack = members.slice(1, 3);
            const main = members[0];
            if (!main) return null;
            return (
              <div className={`pc-photo${stack.length > 0 ? " has-stack" : ""}`}>
                {stack.map((member, index) => (
                  <span key={member.id} className={`pc-photo-layer l${index + 1}`}>
                    {member.ref ? (
                      <ResourceImage
                        path={joinLibraryPath(libraryRoot, member.ref)}
                        alt=""
                        className="pc-photo-img"
                      />
                    ) : null}
                  </span>
                ))}
                <div className={`pc-photo-main${main.ref ? "" : " pc-photo-empty"}`}>
                  {photoMainOf(main.name, main.ref)}
                </div>
              </div>
            );
          })()
        ) : node.kind === "script" ? (
          node.textPath ? (
            <div className="pc-info-script">
              <TextPaperBody path={joinLibraryPath(libraryRoot, node.textPath)} name={node.name} lines={5} adaptive={resized} />
            </div>
          ) : (
            // 剧本两段式：空节点（未挂文件），双击从库选文件。
            <div className="pc-info-body pc-eph-body">
              {Icons.file}
              <span>{t("project.canvas.scriptEmpty")}</span>
            </div>
          )
        ) : (
          <div className="pc-photo">
            <div className={`pc-photo-main${node.avatarPath ? "" : " pc-photo-empty"}`}>
              {photoMainOf(node.name, node.avatarPath)}
            </div>
          </div>
        )}
      </div>
      <span className="pc-node-tools">
        <button type="button" data-tooltip={t("project.canvas.view")} onClick={() => openInfoDetail(node)}>
          {Icons.expand}
        </button>
        <button
          type="button"
          data-tooltip={t("common.delete")}
          className="danger"
          onClick={() => {
            if (node.key.startsWith("grp:")) removeGroup(node.key.slice(4));
            else if (node.key === "script") void detachScript();
            else if (node.kind === "script") removeScriptPh(node.key.slice(7));
            else void removeInfoEntity(node.kind as EntityPhKind, node.key.slice(node.key.indexOf(":") + 1));
          }}
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
