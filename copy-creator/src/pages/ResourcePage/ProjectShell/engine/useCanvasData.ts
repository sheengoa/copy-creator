// 工程画布数据层（自 ProjectCanvas.tsx 组件体零改动搬移，2026-11-03
// 引擎拆分阶段 11d）：按集 localStorage 状态（资料框/成片/便签/剧本与
// 提示词纸片/空白占位/资料组/尺寸/位置覆盖层）、addMenu 与选择器开关、
// 布局派生（layout/infoNodes/infoPos）、选中态。返回值供手势引擎、
// 端口语义、渲染层使用。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scriptFileLabel } from "../../../../domain/projectView";
import { useTranslation } from "react-i18next";
import type {
  EpisodeOverview,
  ProjectCharacter,
  ProjectLocation,
  ProjectNodeLink,
  ProjectProp,
  ProjectScene,
  ProjectSegment,
} from "../../../../stores/projectStore";
import { buildLayout, CARD_GAP, FRAME_PAD_TOP, FRAME_PAD_X, INFO_H, INFO_W, OUTPUT_H, OUTPUT_W, SCRIPT_W, SEG_H, SEG_W, WORLD_MARGIN } from "../layout";
import {
  EMPTY_ENTITY_PHS,
  EMPTY_INFO_GROUPS,
  EMPTY_INFO_OFFSETS,
  EMPTY_NOTES,
  EMPTY_PROMPT_PHS,
  EMPTY_SIZES,
  EMPTY_SCRIPT_PHS,
  parsePromptPhs,
  parseScriptPhs,
} from "../types";
import type { CanvasInfo, CanvasNote, EntityPh, EntityPhKind, InfoGroup, PendingLink, Pos, PosMap, PromptPh, ScriptPh, WireBox } from "../types";
import { usePerEpisodeStorage } from "../../usePerEpisodeStorage";

/** addMenu 状态（双击空白/拖线到空白的节点选择框）。 */
export interface AddMenuState {
  sx: number;
  sy: number;
  wx: number;
  wy: number;
  wire?: {
    fromKey: string;
    fromDir: "out" | "in";
    fromType?: string;
    fromAccepts?: string[];
    fromPortId?: string;
  };
  detached?: { pendings: PendingLink[]; rows: ProjectNodeLink[] };
}

export function useCanvasData(deps: {
  episodeId: string;
  overview: EpisodeOverview | null;
  scenes: ProjectScene[];
  segments: ProjectSegment[];
  castCharacters: ProjectCharacter[];
  episodeLocations: ProjectLocation[];
  episodeProps: ProjectProp[];
  characters: ProjectCharacter[];
  locations: ProjectLocation[];
  props: ProjectProp[];
  loadPrompts(): unknown;
  loadCharacters(): unknown;
  loadLocations(): unknown;
  loadProps(): unknown;
  saveCanvasLayout(payload: {
    assets: { id: string; x: number | null; y: number | null; w: number | null }[];
    shots: { id: string; x: number | null; y: number | null }[];
    scenes: { id: string; x: number | null; y: number | null }[];
    segments?: { id: string; x: number; y: number }[];
  }): unknown;
}) {
  const {
    episodeId, overview, scenes, segments, castCharacters, episodeLocations,
    episodeProps, characters, locations, props, loadPrompts, loadCharacters,
    loadLocations, loadProps, saveCanvasLayout,
  } = deps;
  const { t } = useTranslation();

  // ── 资料框位置（localStorage 按集） ──
  // ── 资料框位置：按集记 localStorage（拖标签牌挪动整个资料框）──
  const [infoFramePos, setInfoFramePos, saveInfoFramePos] = usePerEpisodeStorage<Pos | null>(episodeId, "info", null);

  // ── 成片输出节点位置（localStorage 按集；默认挂世界右侧居中） ──
  const [outputPos, setOutputPos, saveOutputPos] = usePerEpisodeStorage<Pos | null>(episodeId, "output", null);

  // 选中状态（selRef 供鼠标事件同步读取，setSelKeys 驱动渲染）；位置
  // 批量写入 / 撤销栈等下层机制都依赖它，故提前声明。
  const [selKeys, setSelKeys] = useState<string[]>([]);
  const selRef = useRef<string[]>([]);
  const setSelection = useCallback((keys: string[]) => {
    selRef.current = keys;
    setSelKeys(keys);
  }, []);

  // ── 便签节点（ComfyUI Note 的对应物）：文本与位置按集记 localStorage ──
  const [notes, setNotes, persistNotes] = usePerEpisodeStorage<CanvasNote[]>(episodeId, "notes", EMPTY_NOTES);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  // 切集（含刷新瞬态）退出便签编辑态：编辑中的草稿属于旧集。
  useEffect(() => {
    setEditingNoteId(null);
  }, [episodeId]);
  const addNote = useCallback(
    (x: number, y: number) => {
      const note: CanvasNote = {
        id: `n${Date.now()}${Math.floor(Math.random() * 1e4)}`,
        text: "",
        x,
        y,
      };
      persistNotes([...notes, note]);
      return note.id;
    },
    [notes, persistNotes],
  );

  // ── 双击空白添加节点（ComfyUI 搜索框的对应物）；拖线到空白松手也
  // 弹出本菜单，创建的节点自动接上那条线（wire 字段） ──
  const [addMenu, setAddMenu] = useState<{
    sx: number;
    sy: number;
    wx: number;
    wy: number;
    wire?: {
      fromKey: string;
      fromDir: "out" | "in";
      fromType?: string;
      fromAccepts?: string[];
      fromPortId?: string;
    };
    // 摘线到空白弹出的菜单：被摘的线（隐藏态）。菜单创建节点后转接并
    // 删旧行；取消（点空白/Esc）则整组断开（discardDetachedWire）；
    // 建出的节点接不回线（无口）才放回原口。
    detached?: { pendings: PendingLink[]; rows: ProjectNodeLink[] };
  } | null>(null);
  const [addMenuQuery, setAddMenuQuery] = useState("");
  // 资料关联面板开关（挂产出走片段详情窗口，见 detailFor）。
  const [locationPickOpen, setLocationPickOpen] = useState(false);
  // 挂剧本：双击空纸片从库选文件（两段式与其他节点统一）。
  const [scriptPickOpen, setScriptPickOpen] = useState(false);
  // 本次挂接的目标节点 key："script" = 主剧本重挂；"script:<id>" = 剧本纸片。
  const [scriptPickTarget, setScriptPickTarget] = useState<string | null>(null);
  // 剧本纸片（多实例，与其他节点统一）：添加菜单每次放一个空纸片，双击
  // 从库选文件。本集还没剧本时，首个挂接的文件「转正」为主剧本节点
  // （script_path 落库、自动接入全部片段）；其余纸片独立持文件、只存在
  // 于画布层——剧本连线在后端以集为锚（from_id 必须是集 id），纸片的
  // 连线走画布暂存线，不入库。
  const scriptPhsKey = `project_canvas_scriptphs_${episodeId}`;
  const scriptNodeKey = `project_canvas_scriptnode_${episodeId}`;
  const [scriptPhs, , persistScriptPhs] = usePerEpisodeStorage<ScriptPh[]>(
    episodeId, "scriptphs", EMPTY_SCRIPT_PHS, parseScriptPhs,
  );
  const addScriptPh = useCallback(() => {
    persistScriptPhs([
      ...scriptPhs,
      { id: `sph${Date.now()}${Math.floor(Math.random() * 1e4)}`, path: "" },
    ]);
  }, [scriptPhs, persistScriptPhs]);
  // 旧版「空主剧本」标志迁移：标志在且本集没挂剧本时补一个空纸片，迁移
  // 完移除旧键（避免删光纸片后被复活）。直接读存储而非 state，绕开加载
  // 时序竞争。
  const scriptLegacyMigratedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!episodeId || !overview) return;
    if (scriptLegacyMigratedRef.current === episodeId) return;
    scriptLegacyMigratedRef.current = episodeId;
    let legacy: boolean;
    try {
      legacy = window.localStorage.getItem(scriptNodeKey) === "1";
    } catch {
      legacy = false;
    }
    if (!legacy) return;
    try {
      window.localStorage.removeItem(scriptNodeKey);
    } catch {
      // 忽略。
    }
    if (overview.episode.script_path) return; // 已挂接：主剧本节点照旧渲染。
    let existing: { id: string; path: string }[];
    try {
      existing = JSON.parse(window.localStorage.getItem(scriptPhsKey) ?? "[]");
    } catch {
      existing = [];
    }
    if (Array.isArray(existing) && existing.length > 0) return;
    persistScriptPhs([{ id: `sph${Date.now()}${Math.floor(Math.random() * 1e4)}`, path: "" }]);
  }, [episodeId, overview, scriptNodeKey, scriptPhsKey, persistScriptPhs]);

  // ── 提示词纸片（多实例）：添加菜单每次放一个空纸片，双击从提示词库
  // 选一条；连线走画布暂存线（提示词是画布层记忆，不入库）。 ──
  const [promptPhs, , persistPromptPhs] = usePerEpisodeStorage<PromptPh[]>(
    episodeId, "promptphs", EMPTY_PROMPT_PHS, parsePromptPhs,
  );
  const addPromptPh = useCallback(
    (x: number, y: number) => {
      const id = `pph${Date.now()}${Math.floor(Math.random() * 1e4)}`;
      persistPromptPhs([...promptPhs, { id, promptId: "", x, y }]);
      return id;
    },
    [promptPhs, persistPromptPhs],
  );
  // 双击空纸片弹提示词选择：目标节点 key（"prompt:<id>"）。
  const [promptPickOpen, setPromptPickOpen] = useState(false);
  const [promptPickTarget, setPromptPickTarget] = useState<string | null>(null);
  const [promptPickQuery, setPromptPickQuery] = useState("");
  // 纸片标题要显示已选提示词的名字：切集时刷新提示词库。
  useEffect(() => {
    if (!episodeId) return;
    void loadPrompts();
  }, [episodeId, loadPrompts]);

  // ── 空白资料占位节点（菜单选 角色/场景/道具 即创建，创建时绝不弹
  // 挑选面板；双击节点从详情窗加载实体，加载后原位变成实体节点）：
  // 按集存 localStorage ──
  const [entityPhs, , persistEntityPhs] = usePerEpisodeStorage<EntityPh[]>(
    episodeId, "entityph", EMPTY_ENTITY_PHS,
  );
  const addEntityPh = useCallback(
    (kind: EntityPhKind, x: number, y: number) => {
      const id = `e${Date.now()}${Math.floor(Math.random() * 1e4)}`;
      persistEntityPhs([
        ...entityPhs,
        { id, kind, x, y },
      ]);
      return id;
    },
    [entityPhs, persistEntityPhs],
  );

  // ── 资料组节点（一个节点装多个同类实体，一条线接入片段——线的含义
  // = 片段要用组内全部成员）：按集存 localStorage。成员在组间互斥；
  // 未被组认领的集关联实体仍各自渲染为默认单实体节点，旧数据零迁移。 ──
  const [infoGroups, , persistInfoGroups] = usePerEpisodeStorage<InfoGroup[]>(
    episodeId, "infogroups", EMPTY_INFO_GROUPS,
  );
  // 组成员自愈：实体已不存在（库里被删）时从组里剔除，避免僵尸认领
  // 挡住后续同名 id 的实体入集。存在性按全局库判定而非集关联（概览）：
  // 「装入」先写组、后 associateEntities 关联实体，两者之间概览尚未
  // 带出新成员——凭集级列表会把这个空档误判成「成员已删」整组误删
  // （裸占位装入没有暂存线转正的逐条 IPC 推刷新，空档必然出现）。
  // 某个全局库尚未拉取时跳过该类组的判定，拉到后 effect 重跑再补判。
  useEffect(() => {
    if (!overview) return;
    const exists = (kind: EntityPhKind, id: string) =>
      (kind === "character" ? characters : kind === "location" ? locations : props).some(
        (e) => e.id === id,
      );
    let changed = false;
    const next = infoGroups
      .map((g) => {
        const pool = g.kind === "character" ? characters : g.kind === "location" ? locations : props;
        if (pool.length === 0) return g;
        const members = g.members.filter((id) => exists(g.kind, id));
        if (members.length === g.members.length) return g;
        changed = true;
        return { ...g, members };
      })
      .filter((g) => g.members.length > 0);
    if (changed) persistInfoGroups(next);
  }, [overview, infoGroups, characters, locations, props, persistInfoGroups]);

  // 全局三库兜底加载：组节点成员解析与组自愈按全局库判定存在性，
  // 未拉取时（画布直达、没开过库面板）判定退化成空。列表轻量，
  // 每次画布挂载拉一次（ref 守卫，概览整刷重挂不重复触发）。
  const libsLoadedRef = useRef(false);
  useEffect(() => {
    if (libsLoadedRef.current) return;
    libsLoadedRef.current = true;
    void loadCharacters();
    void loadLocations();
    void loadProps();
  }, [loadCharacters, loadLocations, loadProps]);

  // ── 布局与位置（state 驱动渲染） ──
  const layout = useMemo(() => buildLayout(scenes), [scenes]);

  // 资料节点（出场角色/出场场景/出镜道具/剧本）：默认每个集关联实体
  // 一个节点；被组认领的实体不再单独渲染，组节点以照片堆放呈现成员
  // （首位成员大图 + 其余成员图边），高度与单实体节点相同。
  const infoNodes = useMemo(() => {
    const list: CanvasInfo[] = [];
    const claimed = new Set(infoGroups.flatMap((g) => g.members));
    castCharacters
      .filter((character) => !claimed.has(character.id))
      .forEach((character) => {
        list.push({
          key: `char:${character.id}`, kind: "character", name: character.name,
          avatarPath: character.avatar_path, textPath: "", w: INFO_W, h: INFO_H,
        });
      });
    episodeLocations
      .filter((location) => !claimed.has(location.id))
      .forEach((location) => {
        list.push({
          key: `loc:${location.id}`, kind: "location", name: location.name,
          avatarPath: location.ref_path, textPath: "", w: INFO_W, h: INFO_H,
        });
      });
    episodeProps
      .filter((prop) => !claimed.has(prop.id))
      .forEach((prop) => {
        list.push({ key: `prop:${prop.id}`, kind: "prop", name: prop.name, avatarPath: prop.ref_path, textPath: "", w: INFO_W, h: INFO_H });
      });
    infoGroups.forEach((group) => {
      // 只统计仍存在的成员：按集关联 ∪ 全局库判定（entitiesOfKind 同
      // 规则，此处提前内联）。只按集关联判定时，装入的关联落库失败/
      // 未整刷回来会把整组判成 0 成员而整节点消失（幽灵组），全局库
      // 兜底保住可见性。
      const episodeList =
        group.kind === "character" ? castCharacters : group.kind === "location" ? episodeLocations : episodeProps;
      const globalList = group.kind === "character" ? characters : group.kind === "location" ? locations : props;
      const members = group.members.filter(
        (id) => episodeList.some((e) => e.id === id) || globalList.some((e) => e.id === id),
      );
      if (members.length === 0) return;
      list.push({
        // 标题只留 ×N：类型名在标题条左侧常显，重复会读成「角色 角色 ×2」。
        key: `grp:${group.id}`, kind: group.kind, name: `×${members.length}`,
        avatarPath: "", textPath: "", w: INFO_W, h: INFO_H,
      });
    });
    if (overview?.episode.script_path) {
      list.push({
        key: "script", kind: "script", name: scriptFileLabel(overview.episode.script_path),
        avatarPath: "", textPath: overview.episode.script_path, w: SCRIPT_W, h: INFO_H + 40,
      });
    }
    // 剧本纸片（多实例）：空纸片显示「未挂接」，双击从库选文件；本集没
    // 剧本时首个挂接的文件转正为主剧本节点（见 handleScriptPick）。
    scriptPhs.forEach((ph) => {
      list.push({
        key: `script:${ph.id}`, kind: "script",
        name: ph.path ? scriptFileLabel(ph.path) : t("project.canvas.scriptUntitled"),
        avatarPath: "", textPath: ph.path, w: SCRIPT_W, h: INFO_H + 40,
      });
    });
    return list;
  }, [castCharacters, episodeLocations, episodeProps, characters, locations, props, infoGroups, overview, scriptPhs, t]);

  const infoPos = useMemo(() => {
    const frame = infoFramePos ?? { x: WORLD_MARGIN, y: layout.worldH + 48 };
    const map: Record<string, Pos> = {};
    infoNodes.forEach((node, index) => {
      map[node.key] = {
        x: frame.x + FRAME_PAD_X + (index % 3) * (INFO_W + CARD_GAP),
        y: frame.y + FRAME_PAD_TOP + Math.floor(index / 3) * (INFO_H + CARD_GAP),
      };
    });
    return { frame, map };
  }, [infoNodes, infoFramePos, layout.worldH]);

  const [pos, setPos] = useState<PosMap>({ cards: layout.cardPos });
  useEffect(() => {
    setPos({ cards: layout.cardPos });
  }, [layout]);

  // 成片输出节点盒：默认挂世界右侧居中，位置按集记忆。
  const outputBox: WireBox | null = useMemo(() => {
    if (!overview) return null;
    const p = outputPos ?? {
      x: layout.worldW + 80,
      y: Math.max(WORLD_MARGIN, layout.worldH / 2 - OUTPUT_H / 2),
    };
    return { x: p.x, y: p.y, w: OUTPUT_W, h: OUTPUT_H };
  }, [overview, outputPos, layout]);

  // 片段位置：canvas 存储之外叠本地实时层；默认在成片节点左侧按拼接序
  // 排成一列（工作流读向：剧本 → 片段列 → 成片）。
  const [segPos, setSegPos] = useState<Record<string, Pos>>({});
  useEffect(() => {
    setSegPos((prev) => {
      const next: Record<string, Pos> = {};
      const baseX = (outputBox?.x ?? layout.worldW + 260) - SEG_W - 160;
      segments.forEach((segment, index) => {
        next[segment.id] = prev[segment.id] ?? {
          x: segment.canvas_x ?? baseX,
          // 纵向间距 520 与模板两排阵型同基准：片段左侧一组占位高约两排，
          // 260 的旧间距会让相邻两组的占位相交。
          y: segment.canvas_y ?? WORLD_MARGIN + INFO_H + index * 520,
        };
      });
      return next;
    });
  }, [segments, outputBox, layout.worldW]);
  const persistSegments = useCallback(
    (next: Record<string, Pos>) => {
      void saveCanvasLayout({
        assets: [],
        shots: [],
        scenes: [],
        segments: Object.entries(next).map(([id, p]) => ({ id, x: p.x, y: p.y })),
      });
    },
    [saveCanvasLayout],
  );

  // ── 节点尺寸（ComfyUI 式右下角手柄拖拽）：按集存 localStorage 覆盖层，
  // 只记录改过的节点，渲染时未记录的回默认尺寸；线锚点由节点实测跟随。
  // 键名带版本号：sizes2（2026-11-06 默认宽统一 208）——旧 sizes 记的是
  // 旧默认时代的拖动覆盖（资料节点普遍为看清图拖大），统一默认后整体
  // 作废一次，换键即换血；位置记忆（infonodes）不受影响。 ──
  const [nodeSizes, setNodeSizes, persistSizes] = usePerEpisodeStorage<Record<string, { w: number; h: number }>>(
    episodeId, "sizes2", EMPTY_SIZES,
  );
  const sizeOfNode = useCallback(
    (key: string): { w: number; h: number } | null => {
      const over = nodeSizes[key];
      if (key === "output") {
        return { w: over?.w ?? OUTPUT_W, h: over?.h ?? OUTPUT_H };
      }
      if (key.startsWith("shot:")) {
        const card = layout.cards.find((c) => c.key === key);
        if (!card) return null;
        return { w: over?.w ?? card.w, h: over?.h ?? card.h };
      }
      if (key.startsWith("segment:")) {
        return { w: over?.w ?? SEG_W, h: over?.h ?? SEG_H };
      }
      if (key.startsWith("eph:")) {
        return { w: over?.w ?? INFO_W, h: over?.h ?? INFO_H };
      }
      // 提示词纸片：独立渲染块（不在 infoNodes），默认尺寸与剧本纸片一致。
      if (key.startsWith("prompt:")) {
        return { w: over?.w ?? SCRIPT_W, h: over?.h ?? INFO_H + 40 };
      }
      // 资料节点（角色/场景/道具/组/剧本）：默认用网格尺寸。
      const info = infoNodes.find((item) => item.key === key);
      if (info) return { w: over?.w ?? info.w, h: over?.h ?? info.h };
      // 便签无固定默认尺寸（内容自适应），只在拖过之后有值。
      if (key.startsWith("note:")) return over ?? null;
      return null;
    },
    [nodeSizes, layout, infoNodes],
  );

  // ── 资料节点（角色/场景/道具/剧本）自由位置：默认仍在资料框网格，
  // 拖动后按节点绝对位置记忆——框退化为背景分组框，节点不再被钉死。 ──
  const [infoOffsets, setInfoOffsets, persistInfoOffsets] = usePerEpisodeStorage<Record<string, Pos>>(
    episodeId, "infonodes", EMPTY_INFO_OFFSETS,
  );
  const persistCards = useCallback(
    (nextCards: Record<string, Pos>) => {
      const entries = Object.entries(nextCards);
      void saveCanvasLayout({
        assets: [],
        shots: entries.map(([id, p]) => ({ id, x: p.x, y: p.y })),
        scenes: [],
      });
    },
    [saveCanvasLayout],
  );
  const infoNodePos = useCallback(
    (key: string): Pos => {
      if (infoOffsets[key]) return infoOffsets[key];
      // 空白资料占位节点：默认落创建点（拖动后同样走 infoOffsets）。
      if (key.startsWith("eph:")) {
        const ph = entityPhs.find((item) => `eph:${item.id}` === key);
        if (ph) return { x: ph.x, y: ph.y };
      }
      // 提示词纸片：同空白占位，默认落创建点。
      if (key.startsWith("prompt:")) {
        const ph = promptPhs.find((item) => `prompt:${item.id}` === key);
        if (ph) return { x: ph.x, y: ph.y };
      }
      return infoPos.map[key];
    },
    [infoOffsets, infoPos, entityPhs, promptPhs],
  );

  // 节点首次出现的位置永久钉住（用户定案「只要不是我拖动的，节点位置
  // 绝对不动」）：实体增删引发的网格重排不再移动已有节点；新节点以当
  // 次网格槽位为初始位置写入记忆，此后永不变。
  useEffect(() => {
    const missing: Record<string, Pos> = {};
    for (const node of infoNodes) {
      if (infoOffsets[node.key]) continue;
      missing[node.key] = infoPos.map[node.key];
    }
    if (Object.keys(missing).length > 0) {
      persistInfoOffsets({ ...infoOffsets, ...missing });
    }
  }, [infoNodes, infoOffsets, infoPos, persistInfoOffsets]);

  // 占位装入实体：占位节点从画布消失、实体节点以新 key 出现，把占位的
  // 当前位置转交给实体节点（否则新 key 无记忆会跳回资料框网格——用户
  // 实测「装入后节点位置变了」）。占位拖过用记忆值，没拖过用创建点。
  // 两条铁律（2026-11-07 根治）：
  // ① 目标实体节点已在画布（重复装入同一实体）→ 直接跳过：一实体一节点，
  //    绝不把已有节点拖到占位处（用户实测「两个节点合并到一起」）。
  // ② 否则强制写，不用「已有记忆即跳过」：首现钉住 effect 在实机时序下
  //    可能抢先给新 key 钉了网格槽位，旧跳过逻辑会让转交失效 → 装入后
  //    节点跳格（用户实测「节点就会跑」）。转交必须赢，配合 Shell 在关联
  //    落库前先转交，钉住 effect 无从抢跑。
  const adoptInfoOffset = useCallback(
    (fromKey: string, toKey: string) => {
      if (infoNodes.some((n) => n.key === toKey)) return;
      const from =
        infoOffsets[fromKey] ??
        (() => {
          const ph = entityPhs.find((item) => `eph:${item.id}` === fromKey);
          return ph ? { x: ph.x, y: ph.y } : undefined;
        })();
      if (!from) return;
      persistInfoOffsets({ ...infoOffsets, [toKey]: from });
    },
    [infoNodes, infoOffsets, entityPhs, persistInfoOffsets],
  );


  return {
    infoFramePos, setInfoFramePos, saveInfoFramePos,
    adoptInfoOffset,
    outputPos, setOutputPos, saveOutputPos,
    selKeys, selRef, setSelection,
    notes, setNotes, persistNotes, editingNoteId, setEditingNoteId, noteDraft, setNoteDraft, addNote,
    addMenu, setAddMenu, addMenuQuery, setAddMenuQuery,
    locationPickOpen, setLocationPickOpen,
    scriptPickOpen, setScriptPickOpen, scriptPickTarget, setScriptPickTarget,
    scriptPhs, persistScriptPhs, addScriptPh,
    promptPhs, persistPromptPhs, addPromptPh,
    promptPickOpen, setPromptPickOpen, promptPickTarget, setPromptPickTarget, promptPickQuery, setPromptPickQuery,
    entityPhs, persistEntityPhs, addEntityPh,
    infoGroups, persistInfoGroups,
    layout, infoNodes, infoPos,
    pos, setPos,
    outputBox,
    segPos, setSegPos, persistSegments,
    nodeSizes, setNodeSizes, persistSizes, sizeOfNode,
    infoOffsets, setInfoOffsets, persistInfoOffsets,
    persistCards, infoNodePos,
  };
}
