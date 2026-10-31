import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

let progressHandler: ((e: { payload: unknown }) => void) | null = null;

import {
  useCanvasStore,
  type CanvasConnection,
  type CanvasGraph,
  type CanvasNode,
  type CanvasSummary,
} from "./canvasStore";

const makeSummary = (overrides: Partial<CanvasSummary> = {}): CanvasSummary => ({
  id: "c1",
  name: "画布一",
  viewport_x: 0,
  viewport_y: 0,
  viewport_k: 1,
  groups: [],
  created_at: "2026-10-31T00:00:00Z",
  updated_at: "2026-10-31T00:00:00Z",
  node_count: 0,
  connection_count: 0,
  ...overrides,
});

const makeNode = (overrides: Partial<CanvasNode> = {}): CanvasNode => ({
  id: "n1",
  canvas_id: "c1",
  type: "text",
  title: "",
  pos_x: 0,
  pos_y: 0,
  width: null,
  height: null,
  metadata: { kind: "text", content: "" },
  resource_path: "",
  created_at: "2026-10-31T00:00:00Z",
  updated_at: "2026-10-31T00:00:00Z",
  ...overrides,
});

const makeConn = (overrides: Partial<CanvasConnection> = {}): CanvasConnection => ({
  id: "w1",
  canvas_id: "c1",
  from_node: "n1",
  to_node: "n2",
  created_at: "2026-10-31T00:00:00Z",
  ...overrides,
});

describe("canvasStore 画布域 wiring", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    useCanvasStore.setState({
      canvases: [],
      activeCanvasId: null,
      nodes: [],
      connections: [],
      groups: [],
      genProgress: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loadCanvases 拉取列表", async () => {
    const list = [makeSummary(), makeSummary({ id: "c2", name: "画布二" })];
    invokeMock.mockResolvedValue(list);

    await useCanvasStore.getState().loadCanvases();

    expect(invokeMock).toHaveBeenCalledWith("canvas_list");
    expect(useCanvasStore.getState().canvases).toEqual(list);
  });

  it("openCanvas 装载图谱", async () => {
    const graph: CanvasGraph = {
      canvas: {
        id: "c1",
        name: "画布一",
        viewport_x: 10,
        viewport_y: 20,
        viewport_k: 1.5,
        groups: [{ id: "g1", label: "组", members: ["n1"] }],
        created_at: "",
        updated_at: "",
      },
      nodes: [makeNode()],
      connections: [makeConn()],
    };
    invokeMock.mockResolvedValue(graph);

    await useCanvasStore.getState().openCanvas("c1");

    expect(invokeMock).toHaveBeenCalledWith("canvas_get", { canvasId: "c1" });
    const state = useCanvasStore.getState();
    expect(state.activeCanvasId).toBe("c1");
    expect(state.nodes).toHaveLength(1);
    expect(state.connections).toHaveLength(1);
    expect(state.groups).toEqual([{ id: "g1", label: "组", members: ["n1"] }]);
  });

  it("createCanvas 刷新列表并打开新画布", async () => {
    const created = makeSummary({ id: "new" });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "canvas_create") return Promise.resolve(created);
      if (cmd === "canvas_list") return Promise.resolve([created]);
      return Promise.resolve(undefined);
    });

    const canvas = await useCanvasStore.getState().createCanvas("新画布");

    expect(invokeMock).toHaveBeenCalledWith("canvas_create", { name: "新画布" });
    expect(canvas?.id).toBe("new");
    expect(useCanvasStore.getState().activeCanvasId).toBe("new");
    expect(useCanvasStore.getState().canvases).toHaveLength(1);
  });

  it("createNode 以 camelCase 参数落库并插入本地", async () => {
    const node = makeNode({ id: "n9", type: "image" });
    invokeMock.mockResolvedValue(node);
    useCanvasStore.setState({ activeCanvasId: "c1", nodes: [] });

    const result = await useCanvasStore.getState().createNode({
      canvasId: "c1",
      nodeType: "image",
      posX: 100,
      posY: 200,
    });

    expect(invokeMock).toHaveBeenCalledWith("canvas_create_node", {
      canvasId: "c1",
      nodeType: "image",
      title: "",
      posX: 100,
      posY: 200,
      width: null,
      height: null,
      resourcePath: "",
      metadata: "",
    });
    expect(result?.id).toBe("n9");
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
  });

  it("deleteNode 本地移除节点并清掉两端连线", async () => {
    useCanvasStore.setState({
      activeCanvasId: "c1",
      nodes: [makeNode({ id: "n1" }), makeNode({ id: "n2" })],
      connections: [makeConn(), makeConn({ id: "w2", from_node: "n2", to_node: "n1" })],
    });

    await useCanvasStore.getState().deleteNode("n1");

    expect(invokeMock).toHaveBeenCalledWith("canvas_delete_node", { id: "n1" });
    const state = useCanvasStore.getState();
    expect(state.nodes.map((n) => n.id)).toEqual(["n2"]);
    expect(state.connections).toEqual([]);
  });

  it("connect 同 id upsert：同源重复返回既有行不重复", async () => {
    const existing = makeConn();
    invokeMock.mockResolvedValue(existing);
    useCanvasStore.setState({
      activeCanvasId: "c1",
      connections: [existing],
    });

    await useCanvasStore.getState().connect("c1", "n1", "n2");

    expect(invokeMock).toHaveBeenCalledWith("canvas_connect", {
      canvasId: "c1",
      fromNode: "n1",
      toNode: "n2",
    });
    expect(useCanvasStore.getState().connections).toHaveLength(1);
  });

  it("rewire 合并语义：移除被移动的线，落上返回的既有线", async () => {
    const moved = makeConn({ id: "w-move", from_node: "n1", to_node: "n3" });
    const existing = makeConn({ id: "w-existing", from_node: "n1", to_node: "n2" });
    invokeMock.mockResolvedValue(existing);
    useCanvasStore.setState({
      activeCanvasId: "c1",
      connections: [moved, existing],
    });

    await useCanvasStore.getState().rewire("w-move", "n2");

    expect(invokeMock).toHaveBeenCalledWith("canvas_rewire", { id: "w-move", toNode: "n2" });
    const connections = useCanvasStore.getState().connections;
    expect(connections.map((c) => c.id)).toEqual(["w-existing"]);
  });

  it("setGroups 本地即时更新并全量落库（打组/解组）", async () => {
    useCanvasStore.setState({
      activeCanvasId: "c1",
      activeCanvas: makeSummary(),
      groups: [],
    });

    const next = [{ id: "g1", label: "组", members: ["n1", "n2"] }];
    await useCanvasStore.getState().setGroups("c1", next);

    expect(invokeMock).toHaveBeenCalledWith("canvas_set_groups", {
      id: "c1",
      groups: JSON.stringify(next),
    });
    expect(useCanvasStore.getState().groups).toEqual(next);
    expect(useCanvasStore.getState().activeCanvas?.groups).toEqual(next);
  });

  it("视口防抖：连续设置只落最后一次", async () => {
    vi.useFakeTimers();
    useCanvasStore.getState().setViewport("c1", 10, 20, 1);
    useCanvasStore.getState().setViewport("c1", 30, 40, 1.5);

    await vi.advanceTimersByTimeAsync(300);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("canvas_set_viewport", {
      id: "c1",
      x: 30,
      y: 40,
      k: 1.5,
    });
  });

  it("布局防抖：同节点后写覆盖先写，按画布分组一次提交", async () => {
    vi.useFakeTimers();
    useCanvasStore.getState().saveLayout("c1", [
      { id: "n1", pos_x: 1, pos_y: 1, width: null, height: null },
      { id: "n2", pos_x: 2, pos_y: 2, width: null, height: null },
    ]);
    useCanvasStore.getState().saveLayout("c1", [
      { id: "n1", pos_x: 9, pos_y: 9, width: 300, height: 200 },
    ]);
    useCanvasStore.getState().saveLayout("c2", [
      { id: "n3", pos_x: 5, pos_y: 5, width: null, height: null },
    ]);

    await vi.advanceTimersByTimeAsync(400);

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenCalledWith("canvas_save_layout", {
      canvasId: "c1",
      nodes: [
        { id: "n1", pos_x: 9, pos_y: 9, width: 300, height: 200 },
        { id: "n2", pos_x: 2, pos_y: 2, width: null, height: null },
      ],
    });
    expect(invokeMock).toHaveBeenCalledWith("canvas_save_layout", {
      canvasId: "c2",
      nodes: [{ id: "n3", pos_x: 5, pos_y: 5, width: null, height: null }],
    });
  });

  it("bindCanvasEvents 首次注册事件、重复调用不增订", () => {
    const before = listenMock.mock.calls.length;
    useCanvasStore.getState().bindCanvasEvents();
    const afterFirst = listenMock.mock.calls.length;
    useCanvasStore.getState().bindCanvasEvents();
    const afterSecond = listenMock.mock.calls.length;
    // 首次进入本文件时绑定两类事件；模块级单例跨用例共享，重复调用不增订。
    expect(afterSecond).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThanOrEqual(before + 2);
    expect(listenMock.mock.calls.some(([name]) => name === "canvas-changed")).toBe(true);
    const found = listenMock.mock.calls.find(([name]) => name === "canvas-generation-progress");
    progressHandler = (found?.[1] as (e: { payload: unknown }) => void) ?? null;
    expect(progressHandler).toBeTypeOf("function");
  });

  it("updateNode 以返回行替换本地节点", async () => {
    const updated = makeNode({ title: "新标题", metadata: { kind: "text", content: "正文" } });
    invokeMock.mockResolvedValue(updated);
    useCanvasStore.setState({ activeCanvasId: "c1", nodes: [makeNode()] });

    await useCanvasStore.getState().updateNode("n1", { title: "新标题" });

    expect(invokeMock).toHaveBeenCalledWith("canvas_update_node", {
      id: "n1",
      title: "新标题",
      metadata: null,
      resourcePath: null,
    });
    expect(useCanvasStore.getState().nodes[0].title).toBe("新标题");
  });

  it("commitLayout 本地即时合并并进入防抖落盘", async () => {
    vi.useFakeTimers();
    useCanvasStore.setState({
      activeCanvasId: "c1",
      nodes: [makeNode({ id: "n1", pos_x: 0, pos_y: 0 })],
    });

    useCanvasStore.getState().commitLayout("c1", [
      { id: "n1", pos_x: 50, pos_y: 60, width: 300, height: 200 },
    ]);

    // 松手即落位（不等防抖窗口）。
    const [node] = useCanvasStore.getState().nodes;
    expect(node.pos_x).toBe(50);
    expect(node.width).toBe(300);

    await vi.advanceTimersByTimeAsync(400);
    expect(invokeMock).toHaveBeenCalledWith("canvas_save_layout", {
      canvasId: "c1",
      nodes: [{ id: "n1", pos_x: 50, pos_y: 60, width: 300, height: 200 }],
    });
  });

  it("generateImage 发起后建进度条目", async () => {
    invokeMock.mockResolvedValue({ requestId: "req-1", status: "generating" });
    const imageNode = makeNode({
      id: "img1",
      type: "image",
      metadata: { kind: "image", params: { model: "", size: "", count: 3 }, status: "idle", error: "", images: [] },
    });
    useCanvasStore.setState({ activeCanvasId: "c1", nodes: [imageNode] });

    const requestId = await useCanvasStore.getState().generateImage("c1", "img1");

    expect(requestId).toBe("req-1");
    expect(invokeMock).toHaveBeenCalledWith("ai_generate_image", { canvasId: "c1", nodeId: "img1" });
    const progress = useCanvasStore.getState().genProgress["img1"];
    expect(progress).toMatchObject({ requestId: "req-1", total: 3, received: 0, errors: 0 });
  });

  it("generateImage 发起失败上抛（无提示词来源等）", async () => {
    invokeMock.mockRejectedValue("没有提示词来源");
    const imageNode = makeNode({ id: "img1", type: "image" });
    useCanvasStore.setState({ activeCanvasId: "c1", nodes: [imageNode] });

    await expect(useCanvasStore.getState().generateImage("c1", "img1")).rejects.toThrow();
    expect(useCanvasStore.getState().genProgress["img1"]).toBeUndefined();
  });

  it("进度事件逐格更新 previews 与计数", () => {
    const handler = progressHandler;
    useCanvasStore.setState({
      genProgress: {
        img1: { canvasId: "c1", requestId: "req-1", total: 2, received: 0, errors: 0, previews: {} },
      },
    });

    if (!handler) throw new Error("progress handler not captured");
    handler({ payload: { requestId: "req-1", nodeId: "img1", slot: 0, dataUrl: "data:image/png;base64,AA" } });
    handler({ payload: { requestId: "req-1", nodeId: "img1", slot: 1, error: "boom" } });

    const progress = useCanvasStore.getState().genProgress["img1"];
    expect(progress.received).toBe(1);
    expect(progress.errors).toBe(1);
    expect(progress.previews[0]).toBe("data:image/png;base64,AA");
  });

  it("openCanvas 裁剪掉已结束节点的进度条目", async () => {
    const doneNode = makeNode({
      id: "img1",
      type: "image",
      metadata: { kind: "image", params: { model: "", size: "", count: 1 }, status: "done", error: "", images: [] },
    });
    const graph: CanvasGraph = {
      canvas: { id: "c1", name: "画布一", viewport_x: 0, viewport_y: 0, viewport_k: 1, groups: [], created_at: "", updated_at: "" },
      nodes: [doneNode],
      connections: [],
    };
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "canvas_get" ? Promise.resolve(graph) : Promise.resolve([]),
    );
    useCanvasStore.setState({
      genProgress: { img1: { canvasId: "c1", requestId: "r", total: 1, received: 1, errors: 0, previews: {} } },
    });

    await useCanvasStore.getState().openCanvas("c1");

    expect(useCanvasStore.getState().genProgress).toEqual({});
  });

  it("openCanvas 保留其他画布在途生成的进度条目", async () => {
    // 画布 c1 无任何节点；后台画布 c2 的 img1 仍在生成——条目必须保留，
    // 否则切回 c2 丢进度与取消按钮，节点按钮还会重新可点（并发二次生成）。
    const graph: CanvasGraph = {
      canvas: { id: "c1", name: "画布一", viewport_x: 0, viewport_y: 0, viewport_k: 1, groups: [], created_at: "", updated_at: "" },
      nodes: [],
      connections: [],
    };
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "canvas_get" ? Promise.resolve(graph) : Promise.resolve([]),
    );
    useCanvasStore.setState({
      genProgress: {
        img1: { canvasId: "c2", requestId: "r", total: 2, received: 1, errors: 0, previews: { 0: "data:1" } },
      },
    });

    await useCanvasStore.getState().openCanvas("c1");

    expect(useCanvasStore.getState().genProgress).toEqual({
      img1: { canvasId: "c2", requestId: "r", total: 2, received: 1, errors: 0, previews: { 0: "data:1" } },
    });
  });

  it("openCanvas 丢弃本画布查无此节点的残留条目", async () => {
    const graph: CanvasGraph = {
      canvas: { id: "c1", name: "画布一", viewport_x: 0, viewport_y: 0, viewport_k: 1, groups: [], created_at: "", updated_at: "" },
      nodes: [],
      connections: [],
    };
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "canvas_get" ? Promise.resolve(graph) : Promise.resolve([]),
    );
    useCanvasStore.setState({
      genProgress: {
        ghost: { canvasId: "c1", requestId: "r", total: 1, received: 0, errors: 0, previews: {} },
      },
    });

    await useCanvasStore.getState().openCanvas("c1");

    expect(useCanvasStore.getState().genProgress).toEqual({});
  });

  it("deleteCanvas 取消该画布在途生成并清理条目", async () => {
    useCanvasStore.setState({
      genProgress: {
        a: { canvasId: "c1", requestId: "r1", total: 1, received: 0, errors: 0, previews: {} },
        b: { canvasId: "c2", requestId: "r2", total: 1, received: 0, errors: 0, previews: {} },
      },
    });
    invokeMock.mockResolvedValue(undefined);

    await useCanvasStore.getState().deleteCanvas("c1");

    expect(invokeMock).toHaveBeenCalledWith("ai_cancel_generation", { requestId: "r1" });
    expect(invokeMock).not.toHaveBeenCalledWith("ai_cancel_generation", { requestId: "r2" });
    expect(useCanvasStore.getState().genProgress).toEqual({
      b: { canvasId: "c2", requestId: "r2", total: 1, received: 0, errors: 0, previews: {} },
    });
  });
});
