// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../i18n";
import { type CanvasNode, useCanvasStore } from "../../../stores/canvasStore";
import { SaveMediaBody } from "./SaveMediaBody";
import { SaveRuntimeCtx, type SaveRuntime } from "./saveRuntimeCtx";
import { SaveTargetPanel } from "./SaveTargetPanel";
import type { NodeProps } from "./types";

// 保存目标内嵌配置面板（2026-11-10 用户定案「从节点扩展出来，确定后
// 收起，不显乱」）：面板渲染在节点目标行下方（非悬浮层，无定位推算），
// 收起走标题行 × / Esc / 点节点外；确定写详情（setSaveTargetDetails）。

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

invokeMock.mockImplementation(async (cmd: string) => {
  if (cmd === "get_resource_groups") {
    return [
      {
        name: "",
        path: "",
        count: 3,
        children: [
          { name: "方案图", path: "方案图", count: 8, children: [] },
          { name: "参考素材", path: "参考素材", count: 5, children: [] },
        ],
      },
    ];
  }
  return null;
});

const makeNode = (overrides: Partial<CanvasNode> = {}): CanvasNode => ({
  id: "sv1",
  canvas_id: "c1",
  type: "save_image",
  title: "",
  pos_x: 0,
  pos_y: 0,
  width: null,
  height: null,
  metadata: {
    kind: "save_image",
    status: "",
    error: "",
    target: "",
    saved_path: "",
    auto_target: "library",
    auto_dir: "",
    auto_state: "",
    auto_error: "",
    auto_fingerprint: "",
  },
  resource_path: "",
  created_at: "",
  updated_at: "",
  ...overrides,
});

const makeRuntime = (overrides: Partial<SaveRuntime> = {}): SaveRuntime => ({
  setSaveAutoTarget: vi.fn(),
  setSaveTargetDetails: vi.fn(),
  clearSaveAutoTarget: vi.fn(),
  pickSaveAutoDir: vi.fn(async () => {}),
  retrySaveAuto: vi.fn(),
  ...overrides,
});

const services = {
  pickMedia: vi.fn(),
  clearMedia: vi.fn(),
  upstream: vi.fn(() => null),
  locateNode: vi.fn(),
  revealNode: vi.fn(),
} as unknown as NodeProps["services"];

afterEach(() => {
  cleanup();
  invokeMock.mockClear();
});

describe("SaveTargetPanel", () => {
  it("库目标渲染分组树（未分组计数行 + 分组），名称初值取自节点", async () => {
    const onClose = vi.fn();
    render(
      <SaveRuntimeCtx.Provider value={makeRuntime()}>
        <SaveTargetPanel node={makeNode({ metadata: { kind: "save_image", status: "", error: "", target: "", saved_path: "", auto_target: "library", auto_name: "产品截图", auto_group: "" } })} onClose={onClose} />
      </SaveRuntimeCtx.Provider>,
    );
    await waitFor(() => expect(screen.getByText("方案图")).toBeTruthy());
    expect(screen.getByText("未分组")).toBeTruthy();
    expect(screen.getByDisplayValue("产品截图")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("选分组后确定：写详情（组名 + 裁剪后的基名）并收起", async () => {
    const setSaveTargetDetails = vi.fn();
    const onClose = vi.fn();
    const runtime = makeRuntime({ setSaveTargetDetails });
    render(
      <SaveRuntimeCtx.Provider value={runtime}>
        <SaveTargetPanel node={makeNode()} onClose={onClose} />
      </SaveRuntimeCtx.Provider>,
    );
    await waitFor(() => expect(screen.getByText("方案图")).toBeTruthy());
    fireEvent.click(screen.getByText("方案图"));
    const input = screen.getByPlaceholderText("留空使用产物原名") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  产品截图  " } });
    fireEvent.click(screen.getByText("确定"));
    expect(setSaveTargetDetails).toHaveBeenCalledWith("sv1", "方案图", "产品截图");
    expect(onClose).toHaveBeenCalled();
  });

  it("恢复默认清空名称与分组（未分组重新选中）", async () => {
    const runtime = makeRuntime();
    render(
      <SaveRuntimeCtx.Provider value={runtime}>
        <SaveTargetPanel node={makeNode({ metadata: { kind: "save_image", status: "", error: "", target: "", saved_path: "", auto_target: "library", auto_name: "旧名", auto_group: "方案图" } })} onClose={vi.fn()} />
      </SaveRuntimeCtx.Provider>,
    );
    await waitFor(() => expect(screen.getByText("方案图")).toBeTruthy());
    fireEvent.click(screen.getByText("恢复默认"));
    const input = screen.getByPlaceholderText("留空使用产物原名") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(screen.getByText("未分组").closest("button")?.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("方案图").closest("button")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("指定路径目标：目录提示行内联重选目录，确定传空分组", async () => {
    const pickSaveAutoDir = vi.fn(async () => {});
    const setSaveTargetDetails = vi.fn();
    const onClose = vi.fn();
    render(
      <SaveRuntimeCtx.Provider value={makeRuntime({ pickSaveAutoDir, setSaveTargetDetails })}>
        <SaveTargetPanel
          node={makeNode({ metadata: { kind: "save_video", status: "", error: "", target: "", saved_path: "", auto_target: "dir", auto_dir: "D:\\out", auto_name: "" } })}
          onClose={onClose}
        />
      </SaveRuntimeCtx.Provider>,
    );
    expect(screen.getByText("目录由系统选择器指定：D:\\out")).toBeTruthy();
    expect(screen.queryByText("保存到分组")).toBeNull();
    // 目录提示行内联「重选目录」→ 弹系统选目录并收起
    fireEvent.click(screen.getByText("重选目录"));
    expect(pickSaveAutoDir).toHaveBeenCalledWith("sv1");
    expect(onClose).toHaveBeenCalled();
    fireEvent.click(screen.getByText("确定"));
    expect(setSaveTargetDetails).toHaveBeenCalledWith("sv1", "", "");
  });

  it("指定路径面板底部「改用保存到资源库…」：切回库目标并收起（模式互换对称入口）", () => {
    const setSaveAutoTarget = vi.fn();
    const onClose = vi.fn();
    render(
      <SaveRuntimeCtx.Provider value={makeRuntime({ setSaveAutoTarget })}>
        <SaveTargetPanel
          node={makeNode({ metadata: { kind: "save_video", status: "", error: "", target: "", saved_path: "", auto_target: "dir", auto_dir: "D:\\out", auto_name: "" } })}
          onClose={onClose}
        />
      </SaveRuntimeCtx.Provider>,
    );
    fireEvent.click(screen.getByText("改用保存到资源库…"));
    expect(setSaveAutoTarget).toHaveBeenCalledWith("sv1", "library", "");
    expect(onClose).toHaveBeenCalled();
  });

  it("标题行 × 收起：只调 onClose 不写详情", async () => {
    const setSaveTargetDetails = vi.fn();
    const onClose = vi.fn();
    render(
      <SaveRuntimeCtx.Provider value={makeRuntime({ setSaveTargetDetails })}>
        <SaveTargetPanel node={makeNode()} onClose={onClose} />
      </SaveRuntimeCtx.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(setSaveTargetDetails).not.toHaveBeenCalled();
  });

  it("Esc 收起且不写详情", () => {
    const onClose = vi.fn();
    render(
      <SaveRuntimeCtx.Provider value={makeRuntime()}>
        <SaveTargetPanel node={makeNode()} onClose={onClose} />
      </SaveRuntimeCtx.Provider>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点节点外收起；面板内与宿主节点内的点击不收", () => {
    const onClose = vi.fn();
    const { container } = render(
      <div className="canvas-main">
        <div className="pc-node">
          <SaveRuntimeCtx.Provider value={makeRuntime()}>
            <SaveTargetPanel node={makeNode()} onClose={onClose} />
          </SaveRuntimeCtx.Provider>
        </div>
        <div className="outside-probe" />
      </div>,
    );
    // 面板内点击不收
    fireEvent.mouseDown(screen.getByRole("region", { name: "保存目标" }));
    expect(onClose).not.toHaveBeenCalled();
    // 宿主节点内点击不收（目标行 toggle 自理）
    fireEvent.mouseDown(container.querySelector(".pc-node")!);
    expect(onClose).not.toHaveBeenCalled();
    // 节点外点击收起
    fireEvent.mouseDown(container.querySelector(".outside-probe")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("分组树上滚轮被 WheelGate 截留：不冒泡到画布（缩放不受扰动）", () => {
    const { container } = render(
      <div className="pc-node">
        <SaveRuntimeCtx.Provider value={makeRuntime()}>
          <SaveTargetPanel node={makeNode()} onClose={vi.fn()} />
        </SaveRuntimeCtx.Provider>
      </div>,
    );
    let bubbledToRoot = 0;
    const rootListener = () => {
      bubbledToRoot += 1;
    };
    container.addEventListener("wheel", rootListener);
    const tree = container.querySelector(".fc-save-panel-tree")!;
    // 树上滚轮：WheelGate stopPropagation 截留，不冒到容器
    fireEvent.wheel(tree, { deltaY: 120 });
    expect(bubbledToRoot).toBe(0);
    // 对照：面板其他区域（如名称输入）滚轮照常冒泡（画布手势域自己裁决）
    fireEvent.wheel(container.querySelector(".fc-save-panel-input")!, { deltaY: 120 });
    expect(bubbledToRoot).toBe(1);
    container.removeEventListener("wheel", rootListener);
  });

  it("节点窄于面板理想宽：展开时自动加宽到 246（commitLayout 只改 width）", () => {
    const saveLayout = vi.fn();
    const node = makeNode({ canvas_id: "c1" });
    const prev = useCanvasStore.getState();
    // 守护按 store 最新节点快照拼布局 entry：先注入节点
    useCanvasStore.setState({ saveLayout, nodes: [node] });
    try {
      // jsdom offsetWidth 恒 0 < 246 → 必触发守护
      render(
        <div className="canvas-main">
          <div className="pc-node">
            <SaveRuntimeCtx.Provider value={makeRuntime()}>
              <SaveTargetPanel node={node} onClose={vi.fn()} />
            </SaveRuntimeCtx.Provider>
          </div>
        </div>,
      );
      expect(saveLayout).toHaveBeenCalledWith("c1", [
        { id: "sv1", pos_x: 0, pos_y: 0, width: 246, height: null },
      ]);
    } finally {
      useCanvasStore.setState(prev);
    }
  });

  it("节点足够宽（280）：展开不动布局", () => {
    const saveLayout = vi.fn();
    const node = makeNode({ canvas_id: "c1" });
    const prev = useCanvasStore.getState();
    // 守护读 offsetWidth（布局像素，视图缩放下不误判）：mock 宿主 280 ≥ 250
    useCanvasStore.setState({ saveLayout, nodes: [node] });
    const offsetSpy = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("pc-node") ? 280 : 0;
    });
    try {
      render(
        <div className="canvas-main">
          <div className="pc-node">
            <SaveRuntimeCtx.Provider value={makeRuntime()}>
              <SaveTargetPanel node={node} onClose={vi.fn()} />
            </SaveRuntimeCtx.Provider>
          </div>
        </div>,
      );
      expect(saveLayout).not.toHaveBeenCalled();
    } finally {
      offsetSpy.mockRestore();
      useCanvasStore.setState(prev);
    }
  });
});

describe("SaveMediaBody 目标行与面板展开", () => {
  // 目标行在「目标已设」分支：upstream 非空才渲染（空 paths=等待产物态）。
  const connectedServices = { ...services, upstream: vi.fn(() => ({ paths: ["cache/x.png"] })) } as unknown as NodeProps["services"];

  it("目标已设时显示分组 · 名称（名称空=默认原名），点行展开面板再点收起（toggle）", async () => {
    const runtime = makeRuntime();
    render(
      <SaveRuntimeCtx.Provider value={runtime}>
        <SaveMediaBody
          node={makeNode({ metadata: { kind: "save_image", status: "", error: "", target: "", saved_path: "", auto_target: "library", auto_group: "方案图", auto_name: "产品截图" } })}
          selected={false}
          pulsing={false}
          autoHeight={false}
          scale={1}
          services={connectedServices}
        />
      </SaveRuntimeCtx.Provider>,
    );
    const row = screen.getByRole("button", { name: "保存目标" });
    expect(row.textContent).toContain("方案图 · 产品截图");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByRole("region", { name: "保存目标" })).toBeTruthy());
    expect(row.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(row);
    await waitFor(() => expect(screen.queryByRole("region", { name: "保存目标" })).toBeNull());
    expect(row.getAttribute("aria-expanded")).toBe("false");
  });

  it("确定后面板收起且详情落库（节点恢复原状的完整闭环）", async () => {
    const setSaveTargetDetails = vi.fn();
    render(
      <SaveRuntimeCtx.Provider value={makeRuntime({ setSaveTargetDetails })}>
        <SaveMediaBody
          node={makeNode()}
          selected={false}
          pulsing={false}
          autoHeight={false}
          scale={1}
          services={connectedServices}
        />
      </SaveRuntimeCtx.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "保存目标" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "保存目标" })).toBeTruthy());
    fireEvent.click(screen.getByText("确定"));
    expect(setSaveTargetDetails).toHaveBeenCalledWith("sv1", "", "");
    await waitFor(() => expect(screen.queryByRole("region", { name: "保存目标" })).toBeNull());
  });

  it("名称未设时目标行弱化显示默认原名", () => {
    render(
      <SaveRuntimeCtx.Provider value={makeRuntime()}>
        <SaveMediaBody
          node={makeNode()}
          selected={false}
          pulsing={false}
          autoHeight={false}
          scale={1}
          services={connectedServices}
        />
      </SaveRuntimeCtx.Provider>,
    );
    const row = screen.getByRole("button", { name: "保存目标" });
    expect(row.textContent).toContain("未分组 · 默认原名");
  });

  it("指定路径目标行显示目录路径", () => {
    render(
      <SaveRuntimeCtx.Provider value={makeRuntime()}>
        <SaveMediaBody
          node={makeNode({ type: "save_video", metadata: { kind: "save_video", status: "", error: "", target: "", saved_path: "", auto_target: "dir", auto_dir: "D:\\out\\成片" } })}
          selected={false}
          pulsing={false}
          autoHeight={false}
          scale={1}
          services={connectedServices}
        />
      </SaveRuntimeCtx.Provider>,
    );
    const row = screen.getByRole("button", { name: "保存目标" });
    expect(row.textContent).toContain("D:\\out\\成片");
  });
});
