// 领域层：资源文本标注——类型、CRUD 出口、锚文本校验与分段渲染。
// 数据模型见后端 resource_annotations 表（字符偏移锚定 + 锚文本校验）。
import { invoke } from "@tauri-apps/api/core";

export type AnnotationKind =
  | "hl-y"
  | "hl-g"
  | "hl-b"
  | "hl-o"
  | "hl-p"
  | "bold"
  | "underline";

const ANNOTATION_KINDS: AnnotationKind[] = [
  "hl-y",
  "hl-g",
  "hl-b",
  "hl-o",
  "hl-p",
  "bold",
  "underline",
];

export interface ResourceAnnotation {
  id: string;
  recordId: string;
  start: number;
  length: number;
  kind: AnnotationKind;
  anchorText: string;
  createdAt: string;
  /** 文件内容与锚文本失配（文件被外部修改/编辑保存后偏移漂移）。 */
  stale?: boolean;
}

interface RawAnnotation {
  id: string;
  record_id: string;
  start_offset: number;
  length: number;
  kind: string;
  anchor_text: string;
  created_at: string;
}

function fromRaw(raw: RawAnnotation): ResourceAnnotation {
  return {
    id: raw.id,
    recordId: raw.record_id,
    start: raw.start_offset,
    length: raw.length,
    kind: raw.kind as AnnotationKind,
    anchorText: raw.anchor_text,
    createdAt: raw.created_at,
  };
}

export function fetchResourceAnnotations(recordId: string): Promise<ResourceAnnotation[]> {
  return invoke<RawAnnotation[]>("get_resource_annotations", { recordId }).then((list) =>
    list.map(fromRaw),
  );
}

export function addResourceAnnotation(
  recordId: string,
  start: number,
  length: number,
  kind: AnnotationKind,
  anchorText: string,
): Promise<ResourceAnnotation> {
  return invoke<RawAnnotation>("add_resource_annotation", {
    recordId,
    startOffset: start,
    length,
    kind,
    anchorText,
  }).then(fromRaw);
}

export function removeResourceAnnotation(id: string): Promise<boolean> {
  return invoke<boolean>("remove_resource_annotation", { id });
}

export function removeResourceAnnotationsInRange(
  recordId: string,
  start: number,
  length: number,
): Promise<number> {
  return invoke<number>("remove_resource_annotations_in_range", {
    recordId,
    startOffset: start,
    length,
  });
}

export function clearResourceAnnotations(recordId: string): Promise<number> {
  return invoke<number>("clear_resource_annotations", { recordId });
}

/** 锚文本校验：正文与标注的锚文本失配即置 stale（文件被外部改动后
 * 偏移可能漂移）。stale 标注不参与渲染，仅在标记面板中如实标注。 */
export function validateAnnotations(
  text: string,
  list: ResourceAnnotation[],
): ResourceAnnotation[] {
  return list.map((a) => {
    const matches =
      a.start >= 0
        && a.start + a.length <= text.length
        && text.slice(a.start, a.start + a.length) === a.anchorText;
    return matches ? { ...a, stale: false } : { ...a, stale: true };
  });
}

/** 渲染分段：一段正文文本与其上的（未失效）标注 → 原子段序列。
 * 区间端点切分后每段聚合全部覆盖它的标注类型；kinds 为空即纯文本。
 * 各段 text 顺序拼接与输入严格相等。 */
export interface AnnotationSegment {
  text: string;
  kinds: AnnotationKind[];
  annId?: string;
}

export function buildAnnotatedSegments(
  text: string,
  annotations: ResourceAnnotation[],
): AnnotationSegment[] {
  const active = annotations.filter(
    (a) => !a.stale && ANNOTATION_KINDS.includes(a.kind) && a.length > 0,
  );
  if (active.length === 0) return [{ text, kinds: [] }];
  const points = new Set<number>([0, text.length]);
  for (const a of active) {
    points.add(Math.max(0, Math.min(a.start, text.length)));
    points.add(Math.max(0, Math.min(a.start + a.length, text.length)));
  }
  const cuts = [...points].sort((x, y) => x - y);
  const segments: AnnotationSegment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const s = cuts[i], e = cuts[i + 1];
    if (e <= s) continue;
    const covers = active.filter((a) => a.start <= s && a.start + a.length >= e);
    segments.push({
      text: text.slice(s, e),
      kinds: covers.map((a) => a.kind),
      annId: covers[0]?.id,
    });
  }
  return segments;
}

/** 全文标注 → 某个分块（全局偏移 [chunkStart, chunkStart + chunkLength)）
 * 内的标注：裁剪到块内并把起点平移为块内偏移。分块渲染时每块独立
 * 调 buildAnnotatedSegments 前先经此变换。 */
export function annotationsForChunk(
  annotations: ResourceAnnotation[],
  chunkStart: number,
  chunkLength: number,
): ResourceAnnotation[] {
  const chunkEnd = chunkStart + chunkLength;
  const shifted: ResourceAnnotation[] = [];
  for (const a of annotations) {
    if (a.stale) continue;
    const s = Math.max(a.start, chunkStart);
    const e = Math.min(a.start + a.length, chunkEnd);
    if (e <= s) continue;
    shifted.push({ ...a, start: s - chunkStart, length: e - s });
  }
  return shifted;
}
