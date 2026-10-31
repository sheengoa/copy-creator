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

  it("bindCanvasEvents 幂等订阅 canvas-changed", () => {
    useCanvasStore.getState().bindCanvasEvents();
    useCanvasStore.getState().bindCanvasEvents();

    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock).toHaveBeenCalledWith("canvas-changed", expect.any(Function));
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
    });
    expect(useCanvasStore.getState().nodes[0].title).toBe("新标题");
  });
});
