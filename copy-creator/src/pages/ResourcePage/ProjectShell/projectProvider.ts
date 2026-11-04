import type { CanvasConnection, CanvasNode } from "../../../stores/canvasStore";
import type {
  EpisodeOverview,
  ProjectPrompt,
  ProjectSegment,
} from "../../../stores/projectStore";
import type { CanvasDataApi } from "../../CanvasPage/dataContext";
import type { CanvasLayoutEntry } from "../../../stores/canvasStore";
import type { CanvasLayout, CanvasNote, EntityPhKind, InfoGroup, NodeGroup, PromptPh, ScriptPh } from "../ProjectCanvas/types";
import { INFO_H, INFO_W, OUTPUT_W, SCRIPT_W, SEG_H, SEG_W } from "../ProjectCanvas/layout";

// 工程视图几何层数据源（工程视图节点化 2026-11-05 阶段 B，方案 §1.3）：
// CanvasDataApi 的工程实现——节点=工程库 overview 派生（镜头卡/资料/片段/
// 成片/纸片/便签，节点 id 沿用旧画布 key，位置/尺寸记忆层各归其主），
// 位置落盘分流 persistCards/persistSegments/persistInfoOffsets/notes/
// output，内容删除分流工程库操作。连线落库（六口/顶掉/暂存线）在阶段 C
// 接入，B 阶段为 no-op。无组件模块。

export interface ProjectCanvasDataDeps {
  episodeId: string;
  overview: EpisodeOverview | null;
  segments: ProjectSegment[];
  /** 布局与位置状态（useCanvasData 引擎钩子产出）。 */
  layout: CanvasLayout;
  infoNodes: Array<{ key: string; kind: string; name: string; w: number; h: number }>;
  pos: { cards: Record<string, { x: number; y: number }> };
  segPos: Record<string, { x: number; y: number }>;
  infoOffsets: Record<string, { x: number; y: number }>;
  outputBox: { x: number; y: number; w: number; h: number } | null;
  nodeSizes: Record<string, { w: number; h: number }>;
  infoNodePos(key: string): { x: number; y: number };
  sizeOfNode(key: string): { w: number; h: number } | null;
  /** 按集画布内容（useCanvasData）。 */
  entityPhs: Array<{ id: string; kind: EntityPhKind; x: number; y: number }>;
  scriptPhs: ScriptPh[];
  promptPhs: PromptPh[];
  notes: CanvasNote[];
  infoGroups: InfoGroup[];
  prompts: ProjectPrompt[];
  /** 派生节点与分组（Shell useMemo，响应式读的来源）。 */
  nodes: CanvasNode[];
  nodeGroups: NodeGroup[];
  /** 状态写入。 */
  setPos: (updater: (prev: { cards: Record<string, { x: number; y: number }> }) => { cards: Record<string, { x: number; y: number }> }) => void;
  setSegPos: (updater: (prev: Record<string, { x: number; y: number }>) => Record<string, { x: number; y: number }>) => void;
  setInfoOffsets: (updater: (prev: Record<string, { x: number; y: number }>) => Record<string, { x: number; y: number }>) => void;
  setNodeSizes: (next: Record<string, { w: number; h: number }>) => void;
  setNotes: (updater: (prev: CanvasNote[]) => CanvasNote[]) => void;
  /** 落盘。 */
  persistCards(nextCards: Record<string, { x: number; y: number }>): void;
  persistSegments(next: Record<string, { x: number; y: number }>): void;
  persistInfoOffsets(next: Record<string, { x: number; y: number }>): void;
  persistSizes(next: Record<string, { w: number; h: number }>): void;
  persistNotes(next: CanvasNote[]): void;
  persistEntityPhs(next: Array<{ id: string; kind: EntityPhKind; x: number; y: number }>): void;
  persistScriptPhs(next: ScriptPh[]): void;
  persistPromptPhs(next: PromptPh[]): void;
  persistInfoGroups(next: InfoGroup[]): void;
  persistNodeGroups(next: NodeGroup[]): void;
  saveOutputPos(next: { x: number; y: number }): void;
  /** 建节点。 */
  addNote(x: number, y: number): string;
  addEntityPh(kind: EntityPhKind, x: number, y: number): string;
  addScriptPh(): void;
  addPromptPh(x: number, y: number): string;
  addSegment(episodeId: string): Promise<ProjectSegment | null>;
  /** 工程库操作。 */
  deleteShot(shotId: string): void;
  removeSegment(id: string): void;
  setEpisodeOutput(episodeId: string, key: string | null): void;
  setEpisodeCharacters(episodeId: string, ids: string[]): void;
  setEpisodeLocations(episodeId: string, ids: string[]): void;
  setEpisodeProps(episodeId: string, ids: string[]): void;
  updateEpisode(patch: { title: string; status: EpisodeOverview["episode"]["status"]; script_path: string }): void;
  /** 空状态文案（i18n 由 Shell 传入，模块层不触 i18n）。 */
  ephTitle: string;
  promptUntitled: string;
}

const recordNode = (
  id: string,
  type: string,
  title: string,
  p: { x: number; y: number },
  width: number | null,
  height: number | null,
  episodeId: string,
  metadata: Record<string, unknown> = {},
): CanvasNode => ({
  id,
  canvas_id: episodeId,
  type: type as CanvasNode["type"],
  title,
  pos_x: p.x,
  pos_y: p.y,
  width,
  height,
  metadata: metadata as CanvasNode["metadata"],
  resource_path: "",
  created_at: "",
  updated_at: "",
});

/** overview 派生节点集（Shell useMemo 引用；响应式读的数组来源）。 */
export function buildProjectNodes(deps: ProjectCanvasDataDeps): CanvasNode[] {
  const {
    episodeId, segments, layout, infoNodes, pos, segPos, outputBox,
    nodeSizes, sizeOfNode, infoNodePos, entityPhs, promptPhs,
    notes, prompts, ephTitle, promptUntitled,
  } = deps;
  const list: CanvasNode[] = [];

  // 镜头卡（含素材网格；输出口图/视频随素材切换，metadata 带判定）。
  for (const card of layout.cards) {
    const p = pos.cards[card.shot.id] ?? { x: 0, y: 0 };
    const sz = sizeOfNode(card.key);
    list.push(
      recordNode(
        card.key,
        "shot",
        card.shot.description || "",
        p,
        sz?.w ?? card.w,
        nodeSizes[card.key]?.h ?? null,
        episodeId,
        { kind: "shot", shotId: card.shot.id, sceneId: card.sceneId, hasVideo: card.shot.assets.some((a) => a.kind === "video") },
      ),
    );
  }
  // 片段（默认位置未落 segPos 前不渲染——与旧渲染层一致）。
  segments.forEach((segment, index) => {
    const p = segPos[segment.id];
    if (!p) return;
    const key = `segment:${segment.id}`;
    list.push(
      recordNode(
        key,
        "segment",
        segment.note || `#${index + 1}`,
        p,
        sizeOfNode(key)?.w ?? SEG_W,
        nodeSizes[key]?.h ?? null,
        episodeId,
        { kind: "segment", segmentId: segment.id },
      ),
    );
  });
  // 资料节点：单实体（char:/loc:/prop:）、组（grp:）、主剧本与剧本纸片。
  for (const info of infoNodes) {
    const type = info.kind === "script" ? "scriptPaper" : info.kind;
    list.push(
      recordNode(
        info.key,
        type,
        info.name,
        infoNodePos(info.key),
        sizeOfNode(info.key)?.w ?? info.w,
        nodeSizes[info.key]?.h ?? null,
        episodeId,
        { kind: info.kind },
      ),
    );
  }
  // 空白资料占位（角色/场景/道具，菜单创建）。
  for (const ph of entityPhs) {
    const key = `eph:${ph.id}`;
    list.push(
      recordNode(
        key,
        ph.kind,
        ephTitle,
        infoNodePos(key),
        sizeOfNode(key)?.w ?? INFO_W,
        nodeSizes[key]?.h ?? null,
        episodeId,
        { kind: ph.kind },
      ),
    );
  }
  // 剧本纸片（含在 infoNodes：主剧本 + script:<phid> 纸片，键沿用旧层）。
  // 提示词纸片（多实例）。
  for (const ph of promptPhs) {
    const key = `prompt:${ph.id}`;
    const prompt = prompts.find((item) => item.id === ph.promptId);
    list.push(
      recordNode(
        key,
        "promptPaper",
        prompt ? prompt.title : promptUntitled,
        infoNodePos(key),
        sizeOfNode(key)?.w ?? SCRIPT_W,
        nodeSizes[key]?.h ?? null,
        episodeId,
        { kind: "prompt" },
      ),
    );
  }
  // 成片输出节点（overview 存在即渲染）。
  if (outputBox) {
    list.push(
      recordNode(
        "output",
        "output",
        "",
        outputBox,
        sizeOfNode("output")?.w ?? OUTPUT_W,
        nodeSizes.output?.h ?? null,
        episodeId,
        { kind: "output" },
      ),
    );
  }
  // 便签（scope both，走自由画布 NoteBody；位置/文本按集 localStorage）。
  for (const note of notes) {
    const key = `note:${note.id}`;
    const over = nodeSizes[key];
    list.push(
      recordNode(
        key,
        "note",
        "",
        { x: note.x, y: note.y },
        over?.w ?? 220,
        over?.h ?? null,
        episodeId,
        { kind: "note", content: note.text },
      ),
    );
  }
  return list;
}

/** 工程数据源：逐方法映射 CanvasDataApi（方案 §1.3 语义表）。 */
export function buildProjectCanvasApi(deps: ProjectCanvasDataDeps): CanvasDataApi {
  const { episodeId } = deps;
  // 布局提交（拖动/缩放共用）：尺寸落 nodeSizes、位置按前缀分流。
  const commitEntries = (entries: CanvasLayoutEntry[]) => {
    // 尺寸（双非空 = 拖过手柄）落 nodeSizes；位置按 key 前缀分流到
    // 各自的记忆层（镜头卡/片段=工程表、资料与纸片=按集 infoOffsets、
    // 便签=按集 notes、成片=按集 output）。
    const sizeEntries = entries.filter((e) => e.width != null && e.height != null);
    if (sizeEntries.length > 0) {
      const merged = { ...deps.nodeSizes };
      for (const e of sizeEntries) merged[e.id] = { w: e.width as number, h: e.height as number };
      deps.setNodeSizes(merged);
      deps.persistSizes(merged);
    }
    const shotUpdates: Record<string, { x: number; y: number }> = {};
    const segUpdates: Record<string, { x: number; y: number }> = {};
    const infoUpdates: Record<string, { x: number; y: number }> = {};
    const noteUpdates: Record<string, { x: number; y: number }> = {};
    let outputUpdate: { x: number; y: number } | null = null;
    for (const e of entries) {
      const p = { x: e.pos_x, y: e.pos_y };
      if (e.id === "output") outputUpdate = p;
      else if (e.id.startsWith("shot:")) shotUpdates[e.id.slice(5)] = p;
      else if (e.id.startsWith("segment:")) segUpdates[e.id.slice(8)] = p;
      else if (e.id.startsWith("note:")) noteUpdates[e.id.slice(5)] = p;
      else infoUpdates[e.id] = p;
    }
    if (Object.keys(shotUpdates).length > 0) {
      deps.setPos((prev) => ({ ...prev, cards: { ...prev.cards, ...shotUpdates } }));
      deps.persistCards({ ...deps.pos.cards, ...shotUpdates });
    }
    if (Object.keys(segUpdates).length > 0) {
      deps.setSegPos((prev) => ({ ...prev, ...segUpdates }));
      deps.persistSegments({ ...deps.segPos, ...segUpdates });
    }
    if (Object.keys(infoUpdates).length > 0) {
      deps.setInfoOffsets((prev) => ({ ...prev, ...infoUpdates }));
      deps.persistInfoOffsets({ ...deps.infoOffsets, ...infoUpdates });
    }
    if (Object.keys(noteUpdates).length > 0) {
      const next = deps.notes.map((n) => (noteUpdates[n.id] ? { ...n, x: noteUpdates[n.id].x, y: noteUpdates[n.id].y } : n));
      deps.setNotes(() => next);
      deps.persistNotes(next);
    }
    if (outputUpdate) deps.saveOutputPos(outputUpdate);
  };
  return {
    scope: "project",
    nodes: () => deps.nodes,
    connections: (): CanvasConnection[] => [],
    groups: () => deps.nodeGroups,
    viewport: () => {
      try {
        const raw = window.localStorage.getItem(`project_canvas_view_${episodeId}`);
        if (!raw) return { x: 24, y: 12, k: 0.85 };
        const parsed = JSON.parse(raw) as { x: number; y: number; scale: number };
        return { x: parsed.x, y: parsed.y, k: parsed.scale };
      } catch {
        return { x: 24, y: 12, k: 0.85 };
      }
    },
    createNode: async (input) => {
      const x = input.posX;
      const y = input.posY;
      switch (input.nodeType) {
        case "note": {
          const id = deps.addNote(x, y);
          return recordNode(`note:${id}`, "note", "", { x, y }, 220, null, episodeId, { kind: "note", content: "" });
        }
        case "segment": {
          const created = await deps.addSegment(episodeId);
          if (!created) return null;
          // 新片段先落到出生点（后续拖动走 commitLayout 记忆）。
          deps.setSegPos((prev) => ({ ...prev, [created.id]: { x, y } }));
          return recordNode(`segment:${created.id}`, "segment", created.note || "", { x, y }, SEG_W, SEG_H, episodeId, {
            kind: "segment",
            segmentId: created.id,
          });
        }
        case "character":
        case "location":
        case "prop": {
          const id = deps.addEntityPh(input.nodeType, x, y);
          return recordNode(`eph:${id}`, input.nodeType, deps.ephTitle, { x, y }, INFO_W, INFO_H, episodeId, { kind: input.nodeType });
        }
        case "promptPaper": {
          const id = deps.addPromptPh(x, y);
          return recordNode(`prompt:${id}`, "promptPaper", deps.promptUntitled, { x, y }, SCRIPT_W, null, episodeId, { kind: "prompt" });
        }
        default:
          // 双保险：工程作用域拒收自由画布类型（scope 过滤之外的第二道）。
          return null;
      }
    },
    updateNode: async (id, patch) => {
      // 便签文本（NoteBody 落库）：metadata JSON 解析回按集 notes。
      if (id.startsWith("note:") && patch.metadata != null) {
        try {
          const meta = JSON.parse(patch.metadata) as { content?: string };
          const nid = id.slice(5);
          const next = deps.notes.map((n) => (n.id === nid ? { ...n, text: meta.content ?? "" } : n));
          deps.setNotes(() => next);
          deps.persistNotes(next);
        } catch {
          // 形状异常忽略。
        }
      }
    },
    deleteNode: async (id) => {
      if (id.startsWith("note:")) {
        const nid = id.slice(5);
        const next = deps.notes.filter((n) => n.id !== nid);
        deps.setNotes(() => next);
        deps.persistNotes(next);
        return;
      }
      if (id.startsWith("shot:")) {
        deps.deleteShot(id.slice(5));
        return;
      }
      if (id.startsWith("segment:")) {
        deps.removeSegment(id.slice(8));
        return;
      }
      if (id.startsWith("eph:")) {
        deps.persistEntityPhs(deps.entityPhs.filter((p) => p.id !== id.slice(4)));
        return;
      }
      if (id.startsWith("prompt:")) {
        deps.persistPromptPhs(deps.promptPhs.filter((p) => p.id !== id.slice(7)));
        return;
      }
      if (id.startsWith("script:")) {
        deps.persistScriptPhs(deps.scriptPhs.filter((p) => p.id !== id.slice(7)));
        return;
      }
      if (id === "script") {
        // 主剧本摘除：清集上的剧本路径（纸片与暂存线语义阶段 C 接全）。
        const episode = deps.overview?.episode;
        if (episode) {
          deps.updateEpisode({ title: episode.title, status: episode.status, script_path: "" });
        }
        return;
      }
      if (id.startsWith("grp:")) {
        const gid = id.slice(4);
        deps.persistInfoGroups(deps.infoGroups.filter((g) => g.id !== gid));
        return;
      }
      if (id.startsWith("char:") || id.startsWith("loc:") || id.startsWith("prop:")) {
        const sep = id.indexOf(":");
        const kind = id.slice(0, sep) as "char" | "loc" | "prop";
        const eid = id.slice(sep + 1);
        if (kind === "char") deps.setEpisodeCharacters(episodeId, deps.overview?.episode.character_ids?.filter((v) => v !== eid) ?? []);
        else if (kind === "loc") deps.setEpisodeLocations(episodeId, deps.overview?.episode.location_ids?.filter((v) => v !== eid) ?? []);
        else deps.setEpisodeProps(episodeId, deps.overview?.episode.prop_ids?.filter((v) => v !== eid) ?? []);
        return;
      }
      if (id === "output") {
        deps.setEpisodeOutput(episodeId, null);
        return;
      }
    },
    saveLayout: commitEntries,
    commitLayout: commitEntries,
    connect: async () => {
      // 连线落库（六口/顶掉/暂存线/组认领）在阶段 C 接入。
      return null;
    },
    rewire: async () => null,
    deleteConnection: async () => {},
    setGroups: async (groups) => deps.persistNodeGroups(groups),
    setViewport: (x, y, k) => {
      try {
        window.localStorage.setItem(`project_canvas_view_${episodeId}`, JSON.stringify({ x, y, scale: k }));
      } catch {
        // 存储不可用：仅不记忆视口。
      }
    },
    useNodes: () => deps.nodes,
    useConnections: (): CanvasConnection[] => [],
    useGroups: () => deps.nodeGroups,
  };
}
