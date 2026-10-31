import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// 画布域（自由生图工作流）：与 Rust db/canvas.rs 的 serde 结构一一对应。
// 连线语义（方案 v2）：多入线、按类型分组累积，UNIQUE 仅防同源重复平行线。

export type CanvasNodeType = "text" | "image" | "ref" | "note";

export interface ImageGenParams {
  model: string;
  size: string;
  count: number;
}

export type ImageNodeStatus = "idle" | "generating" | "done" | "error";

export interface GeneratedImage {
  width: number;
  height: number;
  bytes: number;
  resource_path: string;
  primary: boolean;
}

export type NodeMeta =
  | { kind: "text"; content: string }
  | { kind: "note"; content: string }
  | { kind: "ref" }
  | {
      kind: "image";
      params: ImageGenParams;
      status: ImageNodeStatus;
      error: string;
      images: GeneratedImage[];
    };

/** 节点分组（Ctrl+G，ComfyUI Group 对应物）：与 Rust CanvasNodeGroup
 *  一一对应。框无独立坐标——渲染时自适应成员包围盒，成员删除由前端
 *  剪枝（写回时机：下次打组/解组）。 */
export interface CanvasGroup {
  id: string;
  label: string;
  members: string[];
}

/** 画布库条目（含节点/连线计数聚合）。 */
export interface CanvasSummary {
  id: string;
  name: string;
  viewport_x: number;
  viewport_y: number;
  viewport_k: number;
  groups: CanvasGroup[];
  created_at: string;
  updated_at: string;
  node_count: number;
  connection_count: number;
}

/** 画布本体行（图谱内不带计数）。 */
export interface CanvasRecord {
  id: string;
  name: string;
  viewport_x: number;
  viewport_y: number;
  viewport_k: number;
  groups: CanvasGroup[];
  created_at: string;
  updated_at: string;
}

export interface CanvasNode {
  id: string;
  canvas_id: string;
  type: CanvasNodeType;
  title: string;
  pos_x: number;
  pos_y: number;
  width: number | null;
  height: number | null;
  metadata: NodeMeta;
  resource_path: string;
  created_at: string;
  updated_at: string;
}

export interface CanvasConnection {
  id: string;
  canvas_id: string;
  from_node: string;
  to_node: string;
  created_at: string;
}

export interface CanvasGraph {
  canvas: CanvasRecord;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
}

/** 布局批量落盘条目（width/height 可空 = 未摆放过）。 */
export interface CanvasLayoutEntry {
  id: string;
  pos_x: number;
  pos_y: number;
  width: number | null;
  height: number | null;
}

/** 生成进度（逐张回传）：按节点记录槽位预览与完成数。canvasId 供切画布
 *  保留后台进度与删画布时取消在途任务。 */
export interface GenerationProgress {
  canvasId: string;
  requestId: string;
  total: number;
  received: number;
  errors: number;
  previews: Record<number, string>;
}

interface CanvasState {
  /** 画布列表（后端按 updated_at 倒序）。 */
  canvases: CanvasSummary[];
  /** 当前打开的画布 id（null = 未打开）。 */
  activeCanvasId: string | null;
  /** 当前画布本体行（视口恢复的来源）。 */
  activeCanvas: CanvasRecord | null;
  /** 当前画布的节点与连线（图谱随 activeCanvasId 装载）。 */
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  /** 当前画布的节点分组（Ctrl+G 打组/解组，画布级全量替换）。 */
  groups: CanvasGroup[];
  /** 进行中的生成（方案 3.4 逐张回传）：节点 id → 槽位进度。 */
  genProgress: Record<string, GenerationProgress>;

  loadCanvases: () => Promise<void>;
  openCanvas: (id: string) => Promise<void>;
  createCanvas: (name?: string) => Promise<CanvasSummary | null>;
  renameCanvas: (id: string, name: string) => Promise<void>;
  deleteCanvas: (id: string) => Promise<void>;
  /** 视口防抖落盘：随滚动高频调用，内部合并为最后一次。 */
  setViewport: (id: string, x: number, y: number, k: number) => void;
  createNode: (input: {
    canvasId: string;
    nodeType: CanvasNodeType;
    title?: string;
    posX: number;
    posY: number;
    width?: number | null;
    height?: number | null;
    resourcePath?: string;
    /** 原始 metadata JSON；空串 = 后端按类型给默认值。 */
    metadata?: string;
  }) => Promise<CanvasNode | null>;
  updateNode: (
    id: string,
    patch: { title?: string; metadata?: string; resourcePath?: string },
  ) => Promise<void>;
  /** 布局防抖批量落盘：同节点后写覆盖先写，按画布分组一次提交。 */
  saveLayout: (canvasId: string, entries: CanvasLayoutEntry[]) => void;
  /** 拖拽/缩放松手后的提交：本地即时合并 + 防抖落盘。 */
  commitLayout: (canvasId: string, entries: CanvasLayoutEntry[]) => void;
  deleteNode: (id: string) => Promise<void>;
  /** 分组整体写入（打组/解组）：本地即时更新 + 后端全量替换。 */
  setGroups: (id: string, groups: CanvasGroup[]) => Promise<void>;
  connect: (canvasId: string, fromNode: string, toNode: string) => Promise<CanvasConnection | null>;
  /** 摘线换目标：后端合并语义下返回行 id 可能不同于入参 id。 */
  rewire: (id: string, toNode: string) => Promise<CanvasConnection | null>;
  deleteConnection: (id: string) => Promise<void>;
  /** 发起生成：返回 requestId 供取消；前端禁用/提示由调用方据返回与状态处理。 */
  generateImage: (canvasId: string, nodeId: string) => Promise<string | null>;
  cancelGeneration: (requestId: string) => Promise<void>;
  /** 画布域事件订阅（幂等）：canvas-changed 时刷新列表与当前图谱。 */
  bindCanvasEvents: () => void;
}

// ── 防抖批量落盘（模块级，跨实例共享） ─────────────────────

const VIEWPORT_DEBOUNCE_MS = 300;
const LAYOUT_DEBOUNCE_MS = 400;

let viewportTimer: ReturnType<typeof setTimeout> | null = null;
const viewportPending = new Map<string, { id: string; x: number; y: number; k: number }>();

let layoutTimer: ReturnType<typeof setTimeout> | null = null;
const layoutPending = new Map<
  string,
  CanvasLayoutEntry & { canvasId: string }
>();

const flushViewport = () => {
  viewportTimer = null;
  const pending = [...viewportPending.values()];
  viewportPending.clear();
  for (const item of pending) {
    invoke("canvas_set_viewport", { id: item.id, x: item.x, y: item.y, k: item.k }).catch((e) =>
      console.error("Failed to save canvas viewport:", e),
    );
  }
};

const flushLayout = () => {
  layoutTimer = null;
  const byCanvas = new Map<string, CanvasLayoutEntry[]>();
  for (const { canvasId, ...entry } of layoutPending.values()) {
    const list = byCanvas.get(canvasId) ?? [];
    list.push(entry);
    byCanvas.set(canvasId, list);
  }
  layoutPending.clear();
  for (const [canvasId, nodes] of byCanvas) {
    invoke("canvas_save_layout", { canvasId, nodes }).catch((e) =>
      console.error("Failed to save canvas layout:", e),
    );
  }
};

// ── 事件订阅（窗口级单例） ─────────────────────────────────

let canvasEventsBound = false;

export const useCanvasStore = create<CanvasState>((set, get) => ({
  canvases: [],
  activeCanvasId: null,
  activeCanvas: null,
  nodes: [],
  connections: [],
  groups: [],
  genProgress: {},

  loadCanvases: async () => {
    try {
      const canvases = await invoke<CanvasSummary[]>("canvas_list");
      set({ canvases });
    } catch (e) {
      console.error("Failed to load canvases:", e);
    }
  },

  openCanvas: async (id) => {
    try {
      const graph = await invoke<CanvasGraph>("canvas_get", { canvasId: id });
      set({
        activeCanvasId: id,
        activeCanvas: graph.canvas,
        nodes: graph.nodes,
        connections: graph.connections,
        groups: graph.canvas.groups,
      });
      // 进度条目清理：节点仍在生成中→保留；不在当前图谱（其他画布的在途
      // 生成）→保留，切回来进度与取消按钮都还在；已在图谱但状态脱离
      // generating→丢弃（最终结果随图谱刷新到达）；条目归属本画布却查无
      // 此节点→丢弃（删除残留）。之前一刀切只留当前图谱的条目，切画布会
      // 掐掉后台生成的进度显示，还让图片节点按钮重新可点、能对同一节点
      // 并发二次生成（重复计费）。
      const stillGenerating: Record<string, GenerationProgress> = {};
      for (const [nodeId, progress] of Object.entries(get().genProgress)) {
        const node = graph.nodes.find((n) => n.id === nodeId);
        if (!node) {
          if (progress.canvasId !== id) stillGenerating[nodeId] = progress;
          continue;
        }
        if (node.metadata.kind === "image" && node.metadata.status === "generating") {
          stillGenerating[nodeId] = progress;
        }
      }
      set({ genProgress: stillGenerating });
    } catch (e) {
      console.error("Failed to open canvas:", e);
    }
  },

  createCanvas: async (name) => {
    try {
      const canvas = await invoke<CanvasSummary>("canvas_create", { name: name ?? "" });
      await get().loadCanvases();
      set({ activeCanvasId: canvas.id, activeCanvas: canvas, nodes: [], connections: [], groups: [] });
      return canvas;
    } catch (e) {
      console.error("Failed to create canvas:", e);
      return null;
    }
  },

  renameCanvas: async (id, name) => {
    try {
      await invoke("canvas_rename", { id, name });
      await get().loadCanvases();
    } catch (e) {
      console.error("Failed to rename canvas:", e);
    }
  },

  deleteCanvas: async (id) => {
    try {
      // 先取消该画布全部在途生成再删：任务继续跑会照常入库产物、
      // 落库 UPDATE 落在已删除的行上静默失效。
      const remaining: Record<string, GenerationProgress> = {};
      for (const [nodeId, progress] of Object.entries(get().genProgress)) {
        if (progress.canvasId === id) {
          void get().cancelGeneration(progress.requestId);
        } else {
          remaining[nodeId] = progress;
        }
      }
      set({ genProgress: remaining });
      await invoke("canvas_delete", { id });
      if (get().activeCanvasId === id) {
        set({ activeCanvasId: null, activeCanvas: null, nodes: [], connections: [], groups: [] });
      }
      await get().loadCanvases();
    } catch (e) {
      console.error("Failed to delete canvas:", e);
    }
  },

  setViewport: (id, x, y, k) => {
    viewportPending.set(id, { id, x, y, k });
    if (viewportTimer) clearTimeout(viewportTimer);
    viewportTimer = setTimeout(flushViewport, VIEWPORT_DEBOUNCE_MS);
  },

  createNode: async (input) => {
    try {
      const node = await invoke<CanvasNode>("canvas_create_node", {
        canvasId: input.canvasId,
        nodeType: input.nodeType,
        title: input.title ?? "",
        posX: input.posX,
        posY: input.posY,
        width: input.width ?? null,
        height: input.height ?? null,
        resourcePath: input.resourcePath ?? "",
        metadata: input.metadata ?? "",
      });
      if (get().activeCanvasId === node.canvas_id) {
        set({ nodes: [...get().nodes, node] });
      }
      return node;
    } catch (e) {
      console.error("Failed to create canvas node:", e);
      return null;
    }
  },

  updateNode: async (id, patch) => {
    try {
      const node = await invoke<CanvasNode>("canvas_update_node", {
        id,
        title: patch.title ?? null,
        metadata: patch.metadata ?? null,
        resourcePath: patch.resourcePath ?? null,
      });
      set({
        nodes: get().nodes.map((item) => (item.id === node.id ? node : item)),
      });
    } catch (e) {
      console.error("Failed to update canvas node:", e);
    }
  },

  saveLayout: (canvasId, entries) => {
    for (const entry of entries) {
      layoutPending.set(entry.id, { ...entry, canvasId });
    }
    if (layoutTimer) clearTimeout(layoutTimer);
    layoutTimer = setTimeout(flushLayout, LAYOUT_DEBOUNCE_MS);
  },

  commitLayout: (canvasId, entries) => {
    // 本地先合并（拖拽松手即落位，不等防抖窗口），再走防抖落盘。
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    set({
      nodes: get().nodes.map((node) => {
        const entry = byId.get(node.id);
        return entry
          ? { ...node, pos_x: entry.pos_x, pos_y: entry.pos_y, width: entry.width, height: entry.height }
          : node;
      }),
    });
    get().saveLayout(canvasId, entries);
  },

  deleteNode: async (id) => {
    try {
      await invoke("canvas_delete_node", { id });
      // 连线两端 FK 级联，本地同步清掉两端引用。
      set({
        nodes: get().nodes.filter((node) => node.id !== id),
        connections: get().connections.filter(
          (conn) => conn.from_node !== id && conn.to_node !== id,
        ),
      });
    } catch (e) {
      console.error("Failed to delete canvas node:", e);
    }
  },

  connect: async (canvasId, fromNode, toNode) => {
    try {
      const conn = await invoke<CanvasConnection>("canvas_connect", {
        canvasId,
        fromNode,
        toNode,
      });
      set({
        // 同 id upsert：同源重复时后端返回既有行。
        connections: [
          ...get().connections.filter((item) => item.id !== conn.id),
          conn,
        ],
      });
      return conn;
    } catch (e) {
      console.error("Failed to connect canvas nodes:", e);
      return null;
    }
  },

  rewire: async (id, toNode) => {
    try {
      const conn = await invoke<CanvasConnection>("canvas_rewire", { id, toNode });
      if (conn.id === id) {
        set({
          connections: get().connections.map((item) => (item.id === id ? conn : item)),
        });
      } else {
        // 合并语义：被移动的线已删，返回既有线——移旧上新。
        set({
          connections: [
            ...get().connections.filter((item) => item.id !== id && item.id !== conn.id),
            conn,
          ],
        });
      }
      return conn;
    } catch (e) {
      console.error("Failed to rewire canvas connection:", e);
      return null;
    }
  },

  deleteConnection: async (id) => {
    try {
      await invoke("canvas_delete_connection", { id });
      set({ connections: get().connections.filter((item) => item.id !== id) });
    } catch (e) {
      console.error("Failed to delete canvas connection:", e);
    }
  },

  setGroups: async (id, groups) => {
    set({ groups });
    if (get().activeCanvas?.id === id) {
      set({ activeCanvas: { ...get().activeCanvas!, groups } });
    }
    try {
      await invoke("canvas_set_groups", { id, groups: JSON.stringify(groups) });
    } catch (e) {
      console.error("Failed to save canvas groups:", e);
    }
  },

  generateImage: async (canvasId, nodeId) => {
    // 发起失败（无提示词来源/未配置模型等）：错误原样上抛给面板展示。
    const result = await invoke<{ requestId: string; total?: number }>("ai_generate_image", {
      canvasId,
      nodeId,
    });
    // 发起即建进度条目（后端在 generating 落库后也发 canvas-changed，
    // openCanvas 的裁剪会保留仍 generating 的条目）。
    const node = get().nodes.find((n) => n.id === nodeId);
    const total = node?.metadata.kind === "image" ? node.metadata.params.count : 1;
    set({
      genProgress: {
        ...get().genProgress,
        [nodeId]: {
          canvasId,
          requestId: result.requestId,
          total: Math.max(1, total),
          received: 0,
          errors: 0,
          previews: {},
        },
      },
    });
    return result.requestId;
  },

  cancelGeneration: async (requestId) => {
    try {
      await invoke("ai_cancel_generation", { requestId });
    } catch (e) {
      console.error("Failed to cancel generation:", e);
    }
  },

  bindCanvasEvents: () => {
    if (canvasEventsBound) return;
    canvasEventsBound = true;
    void listen("canvas-changed", () => {
      void get().loadCanvases();
      const active = get().activeCanvasId;
      if (active) void get().openCanvas(active);
    });
    // 逐张回传（方案 3.4）：slot 完成/失败即更新进度条目，节点体即时补格。
    void listen<{ requestId: string; nodeId: string; slot: number; dataUrl?: string; error?: string }>(
      "canvas-generation-progress",
      (event) => {
        const { nodeId, slot, dataUrl, error } = event.payload;
        const prev = get().genProgress[nodeId];
        if (!prev) return;
        const previews = { ...prev.previews };
        if (dataUrl) previews[slot] = dataUrl;
        set({
          genProgress: {
            ...get().genProgress,
            [nodeId]: {
              ...prev,
              previews,
              received: prev.received + (dataUrl ? 1 : 0),
              errors: prev.errors + (error ? 1 : 0),
            },
          },
        });
      },
    );
  },
}));
