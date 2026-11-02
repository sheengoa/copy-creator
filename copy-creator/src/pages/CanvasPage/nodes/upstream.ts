import type { CanvasConnection, CanvasNode } from "../../../stores/canvasStore";
import { NODE_DEFS } from "./registry";
import type { MediaKind, UpstreamMedia } from "./types";

// 上游媒体解析（预览/保存/合集/生成输入收集共用）：聚合按 def.aggregate
// 查表（gen_image 主图置顶、load_text 提供文本，缺省走 resource_path 软
// 路径——视频工具产物也走该缺省）；生成前提与就绪钩子（def.ready）查表。

/** 单节点产物聚合（查询层缺省：resource_path 非空即单路径）。 */
export function aggregateOf(from: CanvasNode): UpstreamMedia {
  return (
    NODE_DEFS[from.type].aggregate?.(from) ?? {
      paths: from.resource_path ? [from.resource_path] : [],
      text: "",
    }
  );
}

/** 入线第一根的上游节点（预览/保存节点都是单入口）。 */
export function upstreamNodeOf(
  nodes: CanvasNode[],
  connections: CanvasConnection[],
  nodeId: string,
): CanvasNode | undefined {
  const conn = connections.find((c) => c.to_node === nodeId);
  return conn ? nodes.find((n) => n.id === conn.from_node) : undefined;
}

/** 上游产物聚合。null 严格表示「没有上游连接」；连了但暂无产物（生成
 *  中 / 未生成 / 加载节点还没选文件）返回空 paths，供占位文案区分
 *  「未连接上游」与「已连接，等待产物」。 */
export function upstreamMediaOf(
  nodes: CanvasNode[],
  connections: CanvasConnection[],
  nodeId: string,
): UpstreamMedia | null {
  const from = upstreamNodeOf(nodes, connections, nodeId);
  if (!from) return null;
  return aggregateOf(from);
}

/** 生成前提校验（用户定案）：文本口已连非空文本 + 输出口已连保存/预览；
 *  图像口（参考图）可选。文本来源可以是文本合集（有成员即视为就绪，
 *  空内容成员由后端聚合时跳过）。返回缺失清单供按钮旁提示。就绪判定
 *  查 def.ready（文本源与保存节点各自声明）。 */
export function genReadinessOf(
  nodes: CanvasNode[],
  connections: CanvasConnection[],
  node: CanvasNode,
  t: (key: string) => string,
): string[] {
  const missing: string[] = [];
  const textConn = connections.some((c) => {
    if (c.to_node !== node.id || c.to_port !== "text") return false;
    const from = nodes.find((n) => n.id === c.from_node);
    if (!from) return false;
    return NODE_DEFS[from.type].ready?.(from, connections) ?? false;
  });
  if (!textConn) missing.push(t("canvas.genMissingText"));
  const outConn = connections.some((c) => c.from_node === node.id);
  if (!outConn) missing.push(t("canvas.genMissingOut"));
  // 输出口连的是保存节点时，须先设好自动保存目标（用户定案：未设目标
  // 生成直接拦下提醒，而非发起后再补救）。
  const saveTargetsMissing = connections
    .filter((c) => c.from_node === node.id)
    .map((c) => nodes.find((n) => n.id === c.to_node))
    .some((down) => {
      if (!down) return false;
      const def = NODE_DEFS[down.type];
      return !!def.ready && !def.ready(down, connections);
    });
  if (saveTargetsMissing) missing.push(t("canvas.saveAutoMissing"));
  return missing;
}

export interface CollectionItem {
  connId: string;
  from: CanvasNode;
  kind: MediaKind;
  path: string;
  label: string;
}

/** 合集成员按用户排序（metadata.order，重排进行时用 orderOverride 草稿）
 *  展开；未登记的新连线按连线创建时间补尾。成员取值查 def.aggregate：
 *  文本合集取 text，图像/视频合集取首路径（生成节点即主产物）。 */
export function collectionItemsOf(
  nodes: CanvasNode[],
  connections: CanvasConnection[],
  node: CanvasNode,
  orderOverride: string[] | null,
  t: (key: string) => string,
): CollectionItem[] {
  const meta = node.metadata;
  if (meta.kind !== "collection_image" && meta.kind !== "collection_text" && meta.kind !== "collection_video") return [];
  const conns = connections
    .filter((c) => c.to_node === node.id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const byFrom = new Map(conns.map((c) => [c.from_node, c]));
  const order = orderOverride ?? meta.order;
  const orderedIds: string[] = [];
  for (const id of order) {
    if (byFrom.has(id) && !orderedIds.includes(id)) orderedIds.push(id);
  }
  for (const c of conns) {
    if (!orderedIds.includes(c.from_node)) orderedIds.push(c.from_node);
  }
  const kind: MediaKind = NODE_DEFS[node.type].ports.out?.mediaKind ?? "text";
  return orderedIds
    .map((fromId) => {
      const conn = byFrom.get(fromId);
      const from = nodes.find((n) => n.id === fromId);
      if (!conn || !from) return null;
      const media = aggregateOf(from);
      if (kind === "text") {
        const content = media.text.trim();
        return { connId: conn.id, from, kind, path: "", label: content || t("canvas.collectionItemEmpty") };
      }
      const path = media.paths[0] ?? "";
      return { connId: conn.id, from, kind, path, label: path.split(/[\\/]/).pop() ?? "" };
    })
    .filter((x): x is CollectionItem => x !== null);
}
