// 工程画布组操作与画布层机制（自 ProjectCanvas.tsx 组件体零改动搬移，
// 2026-11-03 引擎拆分阶段 11d）：多选组拖快照/批量写入/落盘、占位暂存
// 连线、素材存量清理、节点分组框、撤销栈与复制粘贴、新节点出生锚点。
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EpisodeOverview } from "../../../../stores/projectStore";
import { EMPTY_PENDING_LINKS, parsePendingLinks } from "../types";
import { EMPTY_NODE_GROUPS } from "../types";
import type {
  CanvasNote, EntityPh, EntityPhKind, NodeGroup, PendingLink, Pos, PosMap, PromptPh, ScriptPh, WireBox,
} from "../types";
import { usePerEpisodeStorage } from "../../usePerEpisodeStorage";

export function useGroupOps(deps: {
  selRef: { current: string[] };
  pos: PosMap;
  segPos: Record<string, Pos>;
  infoOffsets: Record<string, Pos>;
  notes: CanvasNote[];
  outputBox: WireBox | null;
  infoNodePos(key: string): Pos;
  setPos: React.Dispatch<React.SetStateAction<PosMap>>;
  setSegPos: React.Dispatch<React.SetStateAction<Record<string, Pos>>>;
  setNotes: React.Dispatch<React.SetStateAction<CanvasNote[]>>;
  setInfoOffsets: React.Dispatch<React.SetStateAction<Record<string, Pos>>>;
  setOutputPos: React.Dispatch<React.SetStateAction<Pos | null>>;
  persistCards(nextCards: Record<string, Pos>): void;
  persistSegments(next: Record<string, Pos>): void;
  persistNotes(next: CanvasNote[]): void;
  persistInfoOffsets(next: Record<string, Pos>): void;
  saveOutputPos(next: Pos | null): void;
  episodeId: string;
  overview: EpisodeOverview | null;
  infoNodes: import("../types").CanvasInfo[];
  entityPhs: EntityPh[];
  persistEntityPhs(next: EntityPh[]): void;
  scriptPhs: ScriptPh[];
  persistScriptPhs(next: ScriptPh[]): void;
  promptPhs: PromptPh[];
  persistPromptPhs(next: PromptPh[]): void;
  saveCanvasLayout(payload: {
    assets: { id: string; x: number | null; y: number | null; w: number | null }[];
    shots: { id: string; x: number | null; y: number | null }[];
    scenes: { id: string; x: number | null; y: number | null }[];
    segments?: { id: string; x: number; y: number }[];
  }): unknown;
  setSelection(keys: string[]): void;
  sizeOfNode(key: string): { w: number; h: number } | null;
  setNodeSizes: React.Dispatch<React.SetStateAction<Record<string, { w: number; h: number }>>>;
  persistSizes(next: Record<string, { w: number; h: number }>): void;
  removeSegment(id: string): unknown;
  addNote(x: number, y: number): string;
  addEntityPh(kind: string, x: number, y: number): string;
  addSegment(episodeId: string): Promise<{ id: string } | null>;
}) {
  const {
    selRef, pos, segPos, infoOffsets, notes, outputBox, infoNodePos, setPos, setSegPos,
    setNotes, setInfoOffsets, setOutputPos, persistCards, persistSegments,
    persistNotes, persistInfoOffsets, saveOutputPos, episodeId, overview,
    infoNodes, entityPhs, persistEntityPhs, scriptPhs, persistScriptPhs,
    promptPhs, persistPromptPhs, saveCanvasLayout, setSelection,
    sizeOfNode, addNote, addEntityPh, addSegment,
    setNodeSizes, persistSizes, removeSegment,
  } = deps;

  // ── 多选组拖 / 位置批量写入 / 复制粘贴 / 撤销栈 ──
  // 选中组快照：全部选中节点（世界坐标）。任一成员位置未知则返回 null
  // （调用方退回单节点行为）。minCount 控制最少成员数（组拖 2、复制 1）。
  interface GroupMember { key: string; x: number; y: number }
  const groupSnapshot = useCallback(
    (minCount = 2): GroupMember[] | null => {
      const sel = selRef.current;
      if (sel.length < minCount) return null;
      const members: GroupMember[] = [];
      for (const key of sel) {
        let p: Pos | undefined;
        if (key.startsWith("shot:")) p = pos.cards[key.slice(5)];
        else if (key.startsWith("segment:")) p = segPos[key.slice(8)];
        else if (key.startsWith("note:")) {
          const note = notes.find((item) => item.id === key.slice(5));
          p = note ? { x: note.x, y: note.y } : undefined;
        } else if (key === "output") {
          p = outputBox ? { x: outputBox.x, y: outputBox.y } : undefined;
        } else {
          p = infoNodePos(key);
        }
        if (!p) return null;
        members.push({ key, x: p.x, y: p.y });
      }
      return members;
    },
    [pos, segPos, notes, outputBox, infoNodePos, selRef],
  );
  // 批量写入各成员的绝对位置（组拖实时移动与撤销恢复共用）。
  const moveGroupTo = useCallback((members: GroupMember[]) => {
    const at = new Map(members.map((m) => [m.key, { x: m.x, y: m.y }]));
    const pick = (prefix: string) => members.filter((m) => m.key.startsWith(prefix));
    const cards = pick("shot:");
    if (cards.length) {
      setPos((prev) => ({
        cards: { ...prev.cards, ...Object.fromEntries(cards.map((m) => [m.key.slice(5), at.get(m.key)!])) },
      }));
    }
    const segs = pick("segment:");
    if (segs.length) setSegPos((prev) => ({ ...prev, ...Object.fromEntries(segs.map((m) => [m.key.slice(8), at.get(m.key)!])) }));
    const noteSel = pick("note:");
    if (noteSel.length) {
      const map = new Map(noteSel.map((m) => [m.key.slice(5), at.get(m.key)!]));
      setNotes((prev) => prev.map((item) => (map.has(item.id) ? { ...item, ...map.get(item.id)! } : item)));
    }
    const infos = members.filter((m) => !/^(shot|segment|note):/.test(m.key) && m.key !== "output");
    if (infos.length) setInfoOffsets((prev) => ({ ...prev, ...Object.fromEntries(infos.map((m) => [m.key, at.get(m.key)!])) }));
    const out = at.get("output");
    if (out) setOutputPos(out);
    // hook 返回的 setter 是 useState 稳定引用，列出不引发重建。
  }, [setInfoOffsets, setNotes, setOutputPos, setPos, setSegPos]);
  // 批量位置落盘（组拖松手与撤销恢复共用）：各切片合并后走对应持久化。
  const persistPositions = useCallback(
    (members: GroupMember[]) => {
      const round = (m: GroupMember) => ({ x: Math.round(m.x), y: Math.round(m.y) });
      const by = (prefix: string) => members.filter((m) => m.key.startsWith(prefix));
      const cards = Object.fromEntries(by("shot:").map((m) => [m.key.slice(5), round(m)]));
      const segs = Object.fromEntries(by("segment:").map((m) => [m.key.slice(8), round(m)]));
      if (Object.keys(cards).length) persistCards({ ...pos.cards, ...cards });
      if (Object.keys(segs).length) persistSegments({ ...segPos, ...segs });
      const noteMap = new Map(by("note:").map((m) => [m.key.slice(5), round(m)]));
      if (noteMap.size) persistNotes(notes.map((item) => (noteMap.has(item.id) ? { ...item, ...noteMap.get(item.id)! } : item)));
      const infos = members.filter((m) => !/^(shot|segment|note):/.test(m.key) && m.key !== "output");
      if (infos.length) persistInfoOffsets({ ...infoOffsets, ...Object.fromEntries(infos.map((m) => [m.key, round(m)])) });
      const out = members.find((m) => m.key === "output");
      if (out) saveOutputPos(round(out));
    },
    [pos, segPos, notes, infoOffsets, persistCards, persistSegments, persistNotes, persistInfoOffsets, saveOutputPos],
  );
  // ── 占位节点的暂存连线（pendingLinks）──
  // 空白资料占位/提示词/剧本纸片还没接入正式连线时，连到片段口的线
  // 先记在画布层（localStorage 按集）；占位加载实体后转正为 node_link；
  // 提示词/剧本纸片不转正（画布层即最终形态）。
  const [pendingLinks, , persistPendingLinks] = usePerEpisodeStorage<PendingLink[]>(
    episodeId, "pendinglinks", EMPTY_PENDING_LINKS, parsePendingLinks,
  );
  const dropPendingLinksOf = useCallback(
    (fromKey: string) => persistPendingLinks(pendingLinks.filter((l) => l.fromKey !== fromKey)),
    [pendingLinks, persistPendingLinks],
  );

  // ── 存量清理：素材节点（占位与散件）已整体移除。老画布遗留的素材
  // 占位（localStorage）、其暂存线与 DB 里的素材连线（from_kind='asset'）
  // 打开本集时清一次；此后已无任何创建入口，清理幂等无害。 ──
  const assetLinksCleanedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!episodeId) return;
    // 素材占位暂存线：直改存储（不经 state——切集首帧 state 可能还是
    // 上一集的旧值，写回会污染本集）；加载侧另有 parse 过滤兜底。
    try {
      const key = `project_canvas_pendinglinks_${episodeId}`;
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as PendingLink[];
        if (Array.isArray(parsed)) {
          const kept = parsed.filter((l) => l && !String(l.fromKey ?? "").startsWith("placeholder:"));
          if (kept.length !== parsed.length) window.localStorage.setItem(key, JSON.stringify(kept));
        }
      }
    } catch {
      // 存储不可用：无碍，加载侧 parse 已兜底。
    }
  }, [episodeId]);
  useEffect(() => {
    if (!episodeId || !overview) return;
    if (assetLinksCleanedRef.current === episodeId) return;
    assetLinksCleanedRef.current = episodeId;
    try {
      window.localStorage.removeItem(`project_canvas_placeholders_${episodeId}`);
    } catch {
      // 存储不可用：无碍，占位已无渲染入口。
    }
    void invoke("project_cleanup_asset_links", { episodeId }).catch(() => {
      // 清理失败不阻断画布：素材连线已无渲染入口，下次打开再试。
      assetLinksCleanedRef.current = null;
    });
  }, [episodeId, overview]);

  // ── 节点分组（Ctrl+G，ComfyUI Group 的对应物）──
  // 选中一个或多个节点打组成框（框自适应成员包围盒）；拖组框标题整组
  // 移动（复用组拖管线）；选中整组再按 Ctrl+G 解组。按集存 localStorage。
  const [nodeGroups, , persistNodeGroups] = usePerEpisodeStorage<NodeGroup[]>(
    episodeId, "nodegroups", EMPTY_NODE_GROUPS,
  );
  // 成员当前包围盒（世界坐标；节点已删除则 null，渲染与包围盒计算时
  // 自动剔除——组员被删后框随之收缩）。
  const memberFrame = useCallback(
    (key: string): { x: number; y: number; w: number; h: number } | null => {
      let p: Pos | undefined;
      if (key.startsWith("shot:")) p = pos.cards[key.slice(5)];
      else if (key.startsWith("segment:")) p = segPos[key.slice(8)];
      else if (key.startsWith("note:")) {
        const note = notes.find((item) => item.id === key.slice(5));
        p = note ? { x: note.x, y: note.y } : undefined;
      } else if (key === "output") {
        p = outputBox ? { x: outputBox.x, y: outputBox.y } : undefined;
      } else {
        p = infoNodePos(key);
      }
      if (!p) return null;
      const size = sizeOfNode(key);
      return {
        x: p.x,
        y: p.y,
        w: size?.w ?? (key.startsWith("note:") ? 172 : 100),
        h: size?.h ?? (key.startsWith("note:") ? 96 : 60),
      };
    },
    [pos, segPos, notes, outputBox, infoNodePos, sizeOfNode],
  );

  // 撤销栈：移动（单/组）、缩放、粘贴、可完整恢复的删除（便签/空白占位）。
  // 镜头/片段等后端实体的删除涉及连线与挂接，无法无损重建，不入栈。
  type UndoAction =
    | { type: "move"; entries: GroupMember[] }
    | { type: "resize"; key: string; size: { w: number; h: number } | null; pos?: Pos }
    | { type: "paste"; keys: string[] }
    | {
        type: "restore";
        notes?: CanvasNote[];
        ephs?: { id: string; kind: EntityPhKind; x: number; y: number }[];
        scriptPhs?: { id: string; path: string }[];
        // 剧本纸片的位置在 infoOffsets（不在纸片对象上），删除时一并抓取。
        scriptOffsets?: { key: string; pos: Pos }[];
        promptPhs?: PromptPh[];
        // 提示词纸片同款：拖动过的位置在 infoOffsets，删除时一并抓取。
        promptOffsets?: { key: string; pos: Pos }[];
        // 被删占位的暂存线随删除一并清除，撤销恢复时一并还原。
        pending?: PendingLink[];
      };
  const undoStackRef = useRef<UndoAction[]>([]);
  const pushUndo = useCallback((action: UndoAction) => {
    undoStackRef.current.push(action);
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
  }, []);
  const runUndo = useCallback(() => {
    if (undoingRef.current) return;
    undoingRef.current = true;
    try {
      const action = undoStackRef.current.pop();
      if (!action) return;
      if (action.type === "move") {
        moveGroupTo(action.entries);
        persistPositions(action.entries);
      } else if (action.type === "resize") {
        setNodeSizes((prev) => {
          const next = { ...prev };
          if (action.size) next[action.key] = action.size;
          else delete next[action.key];
          persistSizes(next);
          return next;
        });
        if (action.pos) {
          moveGroupTo([{ key: action.key, ...action.pos }]);
          persistPositions([{ key: action.key, ...action.pos }]);
        }
      } else if (action.type === "paste") {
        const noteIds = new Set(action.keys.filter((k) => k.startsWith("note:")).map((k) => k.slice(5)));
        const ephIds = new Set(action.keys.filter((k) => k.startsWith("eph:")).map((k) => k.slice(4)));
        if (noteIds.size) persistNotes(notes.filter((item) => !noteIds.has(item.id)));
        if (ephIds.size) persistEntityPhs(entityPhs.filter((item) => !ephIds.has(item.id)));
        for (const key of action.keys) {
          if (key.startsWith("segment:")) void removeSegment(key.slice(8));
        }
        setSelection([]);
      } else if (action.type === "restore") {
        if (action.notes?.length) persistNotes([...notes, ...action.notes]);
        if (action.ephs?.length) persistEntityPhs([...entityPhs, ...action.ephs]);
        if (action.scriptPhs?.length) persistScriptPhs([...scriptPhs, ...action.scriptPhs]);
        if (action.promptPhs?.length) persistPromptPhs([...promptPhs, ...action.promptPhs]);
        if (action.scriptOffsets?.length || action.promptOffsets?.length) {
          persistInfoOffsets({
            ...infoOffsets,
            ...Object.fromEntries([...(action.scriptOffsets ?? []), ...(action.promptOffsets ?? [])].map((item) => [item.key, item.pos])),
          });
        }
        if (action.pending?.length) persistPendingLinks([...pendingLinks, ...action.pending]);
      }
    } finally {
      // 撤销里的后端动作（片段删除）是异步的，锁放到下一宏任务才放开。
      window.setTimeout(() => {
        undoingRef.current = false;
      }, 0);
    }
  }, [moveGroupTo, persistPositions, persistSizes, notes, entityPhs, scriptPhs, promptPhs, infoOffsets, persistNotes, persistEntityPhs, persistScriptPhs, persistPromptPhs, persistInfoOffsets, persistPendingLinks, pendingLinks, removeSegment, setSelection, setNodeSizes]);
  // 复制 / 粘贴（Ctrl+C/V）：画布私有节点可复制（便签/空白资料占位/片段）。
  // 镜头卡、资料实体节点是库实体的画布投影（一实体一节点），复制语义
  // 不成立，不参与。粘贴整组出现在原组右下 28px 处、组内相对位置保持，
  // 粘贴后选中新组（可整体拖走 / Ctrl+Z 撤销）。
  type ClipItem =
    | { kind: "note"; text: string; dx: number; dy: number }
    | { kind: "eph"; phKind: EntityPhKind; dx: number; dy: number }
    | { kind: "segment"; dx: number; dy: number };
  const clipRef = useRef<{ items: ClipItem[]; ax: number; ay: number } | null>(null);
  // 防重入：StrictMode 开发态会双挂载键盘监听，一次 Ctrl+V 触发两次
  // 粘贴、一次 Ctrl+Z 连撤两级、一次 Ctrl+G 建组又解组；同步锁保证
  // 首个调用独占直到完成。
  const pastingRef = useRef(false);
  const undoingRef = useRef(false);
  const groupingRef = useRef(false);
  const copySelection = useCallback(() => {
    const members = groupSnapshot(1);
    if (!members) return;
    const ax = Math.min(...members.map((m) => m.x));
    const ay = Math.min(...members.map((m) => m.y));
    const items: ClipItem[] = [];
    for (const m of members) {
      const dx = m.x - ax;
      const dy = m.y - ay;
      if (m.key.startsWith("note:")) {
        const note = notes.find((item) => item.id === m.key.slice(5));
        if (note) items.push({ kind: "note", text: note.text, dx, dy });
      } else if (m.key.startsWith("eph:")) {
        const ph = entityPhs.find((item) => item.id === m.key.slice(4));
        if (ph) items.push({ kind: "eph", phKind: ph.kind, dx, dy });
      } else if (m.key.startsWith("segment:")) {
        items.push({ kind: "segment", dx, dy });
      }
    }
    if (items.length === 0) return;
    clipRef.current = { items, ax, ay };
  }, [groupSnapshot, notes, entityPhs]);
  const pasteClipboard = useCallback(async () => {
    if (pastingRef.current) return;
    pastingRef.current = true;
    try {
      const clip = clipRef.current;
      if (!clip || clip.items.length === 0) return;
      const ax = clip.ax + 28;
      const ay = clip.ay + 28;
      const newKeys: string[] = [];
      for (const item of clip.items) {
        const x = Math.round(ax + item.dx);
        const y = Math.round(ay + item.dy);
        if (item.kind === "note") {
          newKeys.push(`note:${addNote(x, y)}`);
        } else if (item.kind === "eph") {
          newKeys.push(`eph:${addEntityPh(item.phKind, x, y)}`);
        } else {
          const segment = await addSegment(episodeId);
          if (segment) {
            await saveCanvasLayout({ assets: [], shots: [], scenes: [], segments: [{ id: segment.id, x, y }] });
            newKeys.push(`segment:${segment.id}`);
          }
        }
      }
      if (newKeys.length === 0) return;
      setSelection(newKeys);
      pushUndo({ type: "paste", keys: newKeys });
    } finally {
      pastingRef.current = false;
    }
  }, [addNote, addEntityPh, addSegment, episodeId, saveCanvasLayout, setSelection, pushUndo]);

  // ── 新节点出生锚点：任何「加载」动作（添加菜单挑实体/挂剧本/详情窗
  // 添加）在触发瞬间记录世界坐标，概览刷新后新出现的资料节点直接出生
  // 在那里并脉冲高亮——节点必须出现在用户视线（鼠标）附近，而不是默默
  // 落到资料框网格里让人以为加载失败。同一次面板连选多个时按 28px 错开。 ──
  const spawnAnchorRef = useRef<{ wx: number; wy: number; used: number; snapshot?: string[] } | null>(null);
  const [pulseKeys, setPulseKeys] = useState<string[]>([]);
  // 脉冲高亮 2.4s 后自动退场（effect 驱动，不用 timer ref——ref 会让
  // 传递触底函数的写法被 react-hooks/refs 拦下）。
  useEffect(() => {
    if (pulseKeys.length === 0) return;
    const timer = window.setTimeout(() => setPulseKeys([]), 2400);
    return () => window.clearTimeout(timer);
  }, [pulseKeys]);
  const armSpawnAt = useCallback(
    (wx: number, wy: number) => {
      // 武装时带上「当前存在节点集合」快照：锚点消费 effect 的首跑
      // （prevInfoKeysRef 尚为 null——刚重挂、整页刷新或首次进画布）会
      // 整体跳过 fresh 判定，武装进来的锚点将永远等不到消费，新节点
      // 全部落回资料框网格。effect 侧以快照兜底首跑的 prev，此后新增
      // 的节点才能被识别为 fresh。
      spawnAnchorRef.current = { wx, wy, used: 0, snapshot: infoNodes.map((node) => node.key) };
    },
    [infoNodes],
  );
  const prevInfoKeysRef = useRef<string[] | null>(null);
  useEffect(() => {
    // 概览刷新途中 selectEpisode 会先置空（infoNodes 短暂为空）：这个
    // 空档不是「节点删光了」，跳过——否则刷新后所有节点都会被误判为
    // 新出生，锚点也会在空档里被误消耗。
    if (infoNodes.length === 0) return;
    const anchor = spawnAnchorRef.current;
    const prev = prevInfoKeysRef.current ?? anchor?.snapshot ?? null;
    prevInfoKeysRef.current = infoNodes.map((node) => node.key);
    if (!prev || !anchor) return;
    const fresh = infoNodes.filter((node) => !prev.includes(node.key));
    if (fresh.length === 0) return;
    const next = { ...infoOffsets };
    const marks: string[] = [];
    fresh.forEach((node, index) => {
      const step = anchor.used + index;
      next[node.key] = { x: Math.round(anchor.wx + step * 28), y: Math.round(anchor.wy + step * 28) };
      marks.push(node.key);
    });
    anchor.used += fresh.length;
    persistInfoOffsets(next);
    setPulseKeys(marks);
  }, [infoNodes, infoOffsets, persistInfoOffsets]);

  return {
    groupSnapshot,
    moveGroupTo,
    persistPositions,
    pendingLinks,
    persistPendingLinks,
    dropPendingLinksOf,
    nodeGroups,
    persistNodeGroups,
    memberFrame,
    pushUndo,
    runUndo,
    groupingRef,
    copySelection,
    pasteClipboard,
    armSpawnAt,
    spawnAnchorRef,
    pulseKeys,
    setPulseKeys,
  };
}
