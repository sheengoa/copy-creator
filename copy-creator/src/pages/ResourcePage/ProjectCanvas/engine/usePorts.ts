// 工程画布端口语义与色通道（自 ProjectCanvas.tsx 组件体零改动搬移，
// 2026-11-03 引擎拆分阶段 11d）：单槽位顶掉、片段输入口去重连线、
// 节点接口表、实体类型色、key 解析与「拖线到空白建节点自动接回」。
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  EpisodeOverview,
  ProjectNodeLink,
  ProjectScene,
} from "../../../../stores/projectStore";
import { PORT_COLORS, REF_ACCEPTS } from "../colors";
import type { EntityPh, InfoGroup, PendingLink } from "../types";

/** 单槽位端口集合：角色/场景/道具（顶掉语义适用范围）。 */
export const ENTITY_PORTS = new Set(["character", "location", "prop"]);

export function usePorts(deps: {
  overview: EpisodeOverview | null;
  unlinkNode(
    kind: ProjectNodeLink["from_kind"], id: string,
    segmentId: string, port: string, ownerKey?: string,
  ): unknown;
  pendingLinks: PendingLink[];
  persistPendingLinks(next: PendingLink[]): void;
  nodeLinks: ProjectNodeLink[];
  ownerKeyOfLink(link: ProjectNodeLink): string;
  scenes: ProjectScene[];
  infoGroups: InfoGroup[];
  entityPhs: EntityPh[];
  episodeId: string;
  linkNode(
    episodeId: string, kind: ProjectNodeLink["from_kind"], id: string,
    segmentId: string, port: ProjectNodeLink["to_port"], ownerKey?: string,
  ): unknown;
  setEpisodeOutput(episodeId: string, key: string | null): unknown;
}) {
  const {
    overview, unlinkNode, pendingLinks, persistPendingLinks, nodeLinks,
    ownerKeyOfLink, scenes, infoGroups, entityPhs, episodeId, linkNode,
    setEpisodeOutput,
  } = deps;
  const { t } = useTranslation();

  // ── 口的唯一来源：顶掉语义 ──
  // 角色/场景/道具口是单槽位：新来源落上时整条断开既有线（后连替换
  // 先连，而不是拒绝或并存）。一个"来源"= 一个承载节点（单实体或组）：
  // 组线整条断开（组内成员行全部删除），占位/纸片的暂存线一并清。
  // keep 排除"正要落上的来源自己"的行（放回原口/转正保留自身）。
  // 剧本口、提示词口、其他口维持多来源语义，不参与顶掉。
  const entityPorts = ENTITY_PORTS;
  const displacePortLinks = useCallback(
    (segId: string, port: string, keep?: {
      /** 保留的正式行 id（摘线转移时自己拿走的行）。 */
      rows?: Set<string>;
      /** 保留的暂存线（在手待转移的线）。 */
      pendings?: PendingLink[];
      /** 保留某来源节点的全部暂存线（占位转正时保留自己）。 */
      pendingFromKey?: string;
    }) => {
      if (!ENTITY_PORTS.has(port)) return;
      (overview?.node_links ?? [])
        .filter((l) => l.to_segment === segId && l.to_port === port && !keep?.rows?.has(l.id))
        .forEach((row) => {
          void unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port, row.owner_key);
        });
      const stale = pendingLinks.filter(
        (l) =>
          l.toSegmentId === segId &&
          l.toPort === port &&
          !keep?.pendings?.includes(l) &&
          l.fromKey !== keep?.pendingFromKey,
      );
      if (stale.length) persistPendingLinks(pendingLinks.filter((l) => !stale.includes(l)));
    },
    [overview, unlinkNode, pendingLinks, persistPendingLinks],
  );

  // 片段输入口连线：按承载节点去重——组内多个成员各自落的 node_link
  // 在画布上只画一条线（线的含义 = 组内全部成员接入；删线 = 全部断开）。
  // 去重按发出节点（owner）分桶：同一实体被多个组认领时，各组的线各自
  // 画在各自节点上，互不合并。
  const segWires = useMemo(() => {
    const list: { key: string; fromKey: string; links: typeof nodeLinks }[] = [];
    const index = new Map<string, number>();
    nodeLinks.forEach((link) => {
      const fromKey = ownerKeyOfLink(link);
      const dedup = `${fromKey}|${link.to_segment}|${link.to_port}`;
      const at = index.get(dedup);
      if (at !== undefined) {
        list[at].links.push(link);
        return;
      }
      index.set(dedup, list.length);
      list.push({ key: `segwire-${link.id}`, fromKey, links: [link] });
    });
    return list;
  }, [nodeLinks, ownerKeyOfLink]);

  // 节点接口（ComfyUI 式）：输入口列在左缘、输出口在右缘，口带名称与
  // 数据类型；类型不兼容的连线在拖拽与落下时都会被拒绝。
  // 片段节点是核心生成单元：六输入口（角色/场景/道具/提示词/剧本/其他）+
  // 片段视频输出口。兼容分三档：角色/场景/道具同为图片类可互相穿插；
  // 剧本与提示词同为文本类可互相穿插；「其他」口不限类型全兼容。
  // 口 id 沿用历史：port "script" 即剧本口（存量剧本连线落此口），
  // port "prompt" 为提示词口。
  const portsOf = useCallback(
    (key: string): { ins: { id: string; label: string; accepts: string[] }[]; out?: { label: string; type: string } } => {
      if (key.startsWith("segment:")) {
        return {
          ins: [
            { id: "character", label: t("project.canvas.typeCharacter"), accepts: ["image"] },
            { id: "location", label: t("project.canvas.typeLocation"), accepts: ["image"] },
            { id: "prop", label: t("project.canvas.typeProp"), accepts: ["image"] },
            { id: "prompt", label: t("project.canvas.typePrompt"), accepts: ["prompt", "text"] },
            { id: "script", label: t("project.canvas.typeScript"), accepts: ["text", "prompt"] },
            { id: "other", label: t("project.canvas.typeOther"), accepts: ["image", "video", "audio", "file", "text", "prompt"] },
          ],
          out: { label: t("project.canvas.portSegment"), type: "video" },
        };
      }
      if (key === "output") {
        return { ins: [{ id: "in", label: t("project.canvas.portFinal"), accepts: ["video"] }] };
      }
      if (key.startsWith("shot:")) {
        const shot = scenes.flatMap((s) => s.shots).find((item) => item.id === key.slice(5));
        if (!shot) return { ins: [] };
        const hasVideo = shot.assets.some((a) => a.kind === "video");
        return {
          ins: [{ id: "in", label: t("project.canvas.portRef"), accepts: REF_ACCEPTS }],
          out: { label: t(hasVideo ? "project.canvas.portFootage" : "project.canvas.typeImage"), type: hasVideo ? "video" : "image" },
        };
      }
      // 空白资料占位（未加载的角色/场景/道具）：与加载后的实体节点同款
      // 参考图输出口——节点一上画布就能接入工作流，加载实体后暂存线转正。
      if (key.startsWith("eph:")) {
        return { ins: [], out: { label: t("project.canvas.portRefImg"), type: "image" } };
      }
      // 提示词纸片：输出口为提示词类型（青色），接片段「提示词」口。
      if (key.startsWith("prompt:")) {
        return { ins: [], out: { label: t("project.canvas.typePrompt"), type: "prompt" } };
      }
      if (key === "script" || key.startsWith("script:")) {
        return { ins: [], out: { label: t("project.canvas.typeScript"), type: "text" } };
      }
      if (key.startsWith("char:") || key.startsWith("loc:") || key.startsWith("prop:") || key.startsWith("grp:")) {
        return { ins: [], out: { label: t("project.canvas.portRefImg"), type: "image" } };
      }
      return { ins: [] };
    },
    [scenes, t],
  );

  // ── 实体类型色通道：资料节点（角色/场景/道具，含空白占位与组）的
  // 输出口与连线颜色跟片段对应输入口同色（角色粉/场景绿/道具橙），
  // 与提示词青、剧本橙对齐——此前这些节点按数据类型取色（image=绿）
  // 全部挤成绿色。返回 null = 非资料来源，回退数据类型色（素材/镜头
  // /片段线维持原配色）。兼容性判定仍走 image 数据类型，互不影响。
  const nodeWireColorOf = useCallback(
    (key: string): string | null => {
      if (key.startsWith("char:")) return PORT_COLORS.character;
      if (key.startsWith("loc:")) return PORT_COLORS.location;
      if (key.startsWith("prop:")) return PORT_COLORS.prop;
      if (key.startsWith("grp:")) {
        const kind = infoGroups.find((g) => `grp:${g.id}` === key)?.kind;
        return kind ? PORT_COLORS[kind] : null;
      }
      if (key.startsWith("eph:")) {
        const kind = entityPhs.find((p) => `eph:${p.id}` === key)?.kind;
        return kind ? PORT_COLORS[kind] : null;
      }
      if (key === "script" || key.startsWith("script:")) return PORT_COLORS.script;
      if (key.startsWith("prompt:")) return PORT_COLORS.prompt;
      return null;
    },
    [infoGroups, entityPhs],
  );

  // 画布节点 key → node_link 来源（片段输入口连线的落库形态）。
  const nodeKeyParts = useCallback(
    (key: string): { kind: ProjectNodeLink["from_kind"]; id: string } | null => {
      if (key.startsWith("char:")) return { kind: "character", id: key.slice(5) };
      if (key.startsWith("loc:")) return { kind: "location", id: key.slice(4) };
      if (key.startsWith("prop:")) return { kind: "prop", id: key.slice(5) };
      if (key.startsWith("segment:")) return { kind: "segment", id: key.slice(8) };
      if (key.startsWith("shot:")) return { kind: "shot", id: key.slice(5) };
      if (key === "script") return { kind: "script", id: episodeId };
      return null;
    },
    [episodeId],
  );

  // 「拖线到空白 → 创建节点」后自动把新节点接上那条线（ComfyUI 行为）。
  const autoConnectNewNode = useCallback(
    (
      newKey: string,
      wire:
        | {
            fromKey: string;
            fromDir: "out" | "in";
            fromType?: string;
            fromAccepts?: string[];
            fromPortId?: string;
          }
        | null
        | undefined,
    ) => {
      if (!wire) return;
      const [outKey, inKey] = wire.fromDir === "in" ? [newKey, wire.fromKey] : [wire.fromKey, newKey];
      if (inKey === "output") {
        if (outKey.startsWith("shot:")) void setEpisodeOutput(episodeId, outKey);
        return;
      }
      if (inKey.startsWith("segment:")) {
        const fromType = wire.fromType ?? portsOf(outKey).out?.type;
        // 反拖（从片段输入口拖出到空白建节点）：线回到出发的那个口——
        // 用户拿着的是「通往这个口」的线，不是「通往第一个兼容口」的线；
        // 口仍需兼容来源类型（拖出去的线换了个不兼容的新源则放不回）。
        // 正拖或无口记录时按数据类型找第一个兼容口。
        const port =
          (wire.fromDir === "in" && wire.fromPortId
            ? portsOf(inKey).ins.find(
                (item) => item.id === wire.fromPortId && (!fromType || item.accepts.includes(fromType)),
              )
            : undefined) ??
          portsOf(inKey).ins.find((item) =>
            fromType ? item.accepts.includes(fromType) : false,
          );
        if (!port) return;
        if (outKey.startsWith("script:")) {
          // 剧本纸片的连线不入库（后端剧本连线以集为锚），落画布暂存线。
          const segId = inKey.slice(8);
          displacePortLinks(segId, port.id, { pendingFromKey: outKey });
          persistPendingLinks([
            ...pendingLinks.filter((l) => !(l.fromKey === outKey && l.toSegmentId === segId && l.toPort === port.id)),
            { fromKey: outKey, toSegmentId: segId, toPort: port.id },
          ]);
          return;
        }
        const source = nodeKeyParts(outKey);
        if (!source) {
          // 空白资料/提示词纸片源没有库身份（nodeKeyParts 解析不出）：
          // 正式线无处可落，改记画布暂存线，加载实体后照常转正（提示词
          // 纸片始终画布层记忆，暂存线即最终形态）。反拖落到已有他人线
          // 的资料口＝新来源占口，顶掉既有线（保留自己的暂存线）。
          const segId = inKey.slice(8);
          if (outKey.startsWith("eph:") || outKey.startsWith("prompt:")) {
            displacePortLinks(segId, port.id, { pendingFromKey: outKey });
            persistPendingLinks([
              ...pendingLinks.filter((l) => !(l.fromKey === outKey && l.toSegmentId === segId && l.toPort === port.id)),
              { fromKey: outKey, toSegmentId: segId, toPort: port.id },
            ]);
          }
          return;
        }
        void linkNode(
          episodeId,
          source.kind,
          source.id,
          inKey.slice(8),
          port.id as ProjectNodeLink["to_port"],
        );
        return;
      }
    },
    [episodeId, nodeKeyParts, portsOf, linkNode, setEpisodeOutput, pendingLinks, persistPendingLinks, displacePortLinks],
  );


  return {
    entityPorts,
    displacePortLinks,
    segWires,
    portsOf,
    nodeWireColorOf,
    nodeKeyParts,
    autoConnectNewNode,
  };
}
