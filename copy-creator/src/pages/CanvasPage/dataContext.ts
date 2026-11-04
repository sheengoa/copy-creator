import { createContext, useContext } from "react";
import {
  useCanvasStore,
  type CanvasConnection,
  type CanvasGroup,
  type CanvasLayoutEntry,
  type CanvasNode,
} from "../../stores/canvasStore";

// 画布几何层数据源（工程视图节点化 2026-11-05 阶段 A）：把手势/撤销/剪贴板/
// 视口等引擎共用的几何读写从 canvasStore 直连抽成 Context 注入。自由画布
// 挂默认实现（逐方法转发 canvasStore，行为零变化）；工程视图（阶段 B）挂
// 工程 provider（overview 派生 + node_links/工程表落点），两画布共用同一
// 套节点基座与手势引擎。生成运行时与画布管理不在此列——它们是自由画布
// 专属层（genProgress/cancelGeneration 等仍留在各自模块直连）。
// 无组件模块（配合使用方内联 <CanvasDataContext.Provider>；拆文件为满足
// react-refresh 组件文件纯组件导出约定，同 genRuntimeCtx.ts 惯例）。

/** 建节点入参（canvasId 由 provider 闭包携带；nodeType 放宽为 string——
 *  工程作用域注册自己的类型 id，默认实现内部再收窄）。 */
export interface CanvasNodeCreateInput {
  nodeType: string;
  title?: string;
  posX: number;
  posY: number;
  width?: number | null;
  height?: number | null;
  resourcePath?: string;
  /** 原始 metadata JSON；空串 = 后端按类型给默认值。 */
  metadata?: string;
}

/** 节点内容补丁（位置走 saveLayout/commitLayout，不在此列）。 */
export interface CanvasNodePatch {
  title?: string;
  metadata?: string;
  resourcePath?: string;
}

export interface CanvasDataApi {
  /** 作用域（工程视图节点化 2026-11-05）：建节点菜单/文件拖入分发按它
   *  过滤节点 def 的 scope，两画布完全互斥；缺省实现 = "free"。 */
  scope: "free" | "project";
  // ── 读（快照；响应式订阅见下方三个 use*） ──
  nodes(): CanvasNode[];
  connections(): CanvasConnection[];
  groups(): CanvasGroup[];
  /** 初始视口（无记录 = null，视图引擎回退出厂默认）。 */
  viewport(): { x: number; y: number; k: number } | null;
  // ── 节点几何与内容 ──
  createNode(input: CanvasNodeCreateInput): Promise<CanvasNode | null>;
  updateNode(id: string, patch: CanvasNodePatch): Promise<void>;
  deleteNode(id: string): Promise<void>;
  /** 拖动/缩放中的防抖批量落盘。 */
  saveLayout(entries: CanvasLayoutEntry[]): void;
  /** 松手后的提交（本地即时合并 + 防抖落盘）。 */
  commitLayout(entries: CanvasLayoutEntry[]): void;
  // ── 连线 ──
  connect(from: string, to: string, toPort: string): Promise<CanvasConnection | null>;
  /** 摘线换目标（含换口）。 */
  rewire(id: string, to: string, toPort: string): Promise<CanvasConnection | null>;
  /** 切线/顶掉旧线。 */
  deleteConnection(id: string): Promise<void>;
  // ── 组与视口 ──
  setGroups(groups: CanvasGroup[]): Promise<void>;
  setViewport(x: number, y: number, k: number): void;
  // ── 响应式读（渲染层订阅；api 对象随作用域稳定，可在组件顶层照常调用） ──
  useNodes(): CanvasNode[];
  useConnections(): CanvasConnection[];
  useGroups(): CanvasGroup[];
}

export const CanvasDataContext = createContext<CanvasDataApi | null>(null);

/** 取当前画布数据源。未挂 provider = 装配错误，直接抛出暴露接线问题。 */
export function useCanvasData(): CanvasDataApi {
  const value = useContext(CanvasDataContext);
  if (!value) throw new Error("CanvasDataContext 缺失：画布组件必须在数据源 Provider 内渲染");
  return value;
}

// 响应式读固定绑 canvasStore（模块级定义，引用稳定不随 provider 重建）。
const useStoreNodes = () => useCanvasStore((s) => s.nodes);
const useStoreConnections = () => useCanvasStore((s) => s.connections);
const useStoreGroups = () => useCanvasStore((s) => s.groups);

/** 默认实现（自由画布）：逐方法转发 canvasStore，canvasId 烤入闭包。 */
export function createStoreCanvasData(canvasId: string): CanvasDataApi {
  return {
    scope: "free",
    nodes: () => useCanvasStore.getState().nodes,
    connections: () => useCanvasStore.getState().connections,
    groups: () => useCanvasStore.getState().groups,
    viewport: () => {
      const c = useCanvasStore.getState().activeCanvas;
      return c && c.id === canvasId
        ? { x: c.viewport_x, y: c.viewport_y, k: c.viewport_k }
        : null;
    },
    createNode: (input) =>
      useCanvasStore.getState().createNode({ ...input, nodeType: input.nodeType as CanvasNode["type"], canvasId }),
    updateNode: (id, patch) => useCanvasStore.getState().updateNode(id, patch),
    deleteNode: (id) => useCanvasStore.getState().deleteNode(id),
    saveLayout: (entries) => useCanvasStore.getState().saveLayout(canvasId, entries),
    commitLayout: (entries) => useCanvasStore.getState().commitLayout(canvasId, entries),
    connect: (from, to, toPort) => useCanvasStore.getState().connect(canvasId, from, to, toPort),
    rewire: (id, to, toPort) => useCanvasStore.getState().rewire(id, to, toPort),
    deleteConnection: (id) => useCanvasStore.getState().deleteConnection(id),
    setGroups: (groups) => useCanvasStore.getState().setGroups(canvasId, groups),
    setViewport: (x, y, k) => useCanvasStore.getState().setViewport(canvasId, x, y, k),
    useNodes: useStoreNodes,
    useConnections: useStoreConnections,
    useGroups: useStoreGroups,
  };
}
