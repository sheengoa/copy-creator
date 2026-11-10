// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../i18n";
import { type CanvasNode } from "../../../stores/canvasStore";
import { SaveMediaBody } from "./SaveMediaBody";
import { SaveRuntimeCtx, type SaveRuntime } from "./saveRuntimeCtx";
import { SaveTargetPopover } from "./SaveTargetPopover";
import type { NodeProps } from "./types";

// 保存目标配置浮层与节点目标行（2026-11-10 用户定案）：目标已设的
// 保存节点显示「分组 · 名称」目标行，点开浮层可改库内分组与保存基名；
// 确定写详情（setSaveTargetDetails），指定路径目标显示目录提示并可重选。

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
} as unknown as NodeProps["services"];

afterEach(() => {
  cleanup();
  invokeMock.mockClear();
});

describe("SaveTargetPopover", () => {
  it("库目标渲染分组树（未分组计数行 + 分组），名称初值取自节点", async () => {
    const onClose = vi.fn();
    render(
      <SaveRuntimeCtx.Provider value={makeRuntime()}>
        <SaveTargetPopover node={makeNode({ metadata: { kind: "save_image", status: "", error: "", target: "", saved_path: "", auto_target: "library", auto_name: "产品截图", auto_group: "" } })} onClose={onClose} />
      </SaveRuntimeCtx.Provider>,
    );
    await waitFor(() => expect(screen.getByText("方案图")).toBeTruthy());
    expect(screen.getByText("未分组")).toBeTruthy();
    expect(screen.getByDisplayValue("产品截图")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("选分组后确定：写详情（组名 + 裁剪后的基名）并关闭", async () => {
    const setSaveTargetDetails = vi.fn();
    const onClose = vi.fn();
    const runtime = makeRuntime({ setSaveTargetDetails });
    render(
      <SaveRuntimeCtx.Provider value={runtime}>
        <SaveTargetPopover node={makeNode()} onClose={onClose} />
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
        <SaveTargetPopover node={makeNode({ metadata: { kind: "save_image", status: "", error: "", target: "", saved_path: "", auto_target: "library", auto_name: "旧名", auto_group: "方案图" } })} onClose={vi.fn()} />
      </SaveRuntimeCtx.Provider>,
    );
    await waitFor(() => expect(screen.getByText("方案图")).toBeTruthy());
    fireEvent.click(screen.getByText("恢复默认"));
    const input = screen.getByPlaceholderText("留空使用产物原名") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(screen.getByText("未分组").closest("button")?.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("方案图").closest("button")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("指定路径目标：显示目录提示，确定传空分组，可重选目录", async () => {
    const pickSaveAutoDir = vi.fn(async () => {});
    const setSaveTargetDetails = vi.fn();
    const onClose = vi.fn();
    render(
      <SaveRuntimeCtx.Provider value={makeRuntime({ pickSaveAutoDir, setSaveTargetDetails })}>
        <SaveTargetPopover
          node={makeNode({ metadata: { kind: "save_video", status: "", error: "", target: "", saved_path: "", auto_target: "dir", auto_dir: "D:\\out", auto_name: "" } })}
          onClose={onClose}
        />
      </SaveRuntimeCtx.Provider>,
    );
    expect(screen.getByText("目录由系统选择器指定：D:\\out")).toBeTruthy();
    expect(screen.queryByText("保存到分组")).toBeNull();
    fireEvent.click(screen.getByText("重新选择目录…"));
    expect(pickSaveAutoDir).toHaveBeenCalledWith("sv1");
    expect(onClose).toHaveBeenCalled();
    fireEvent.click(screen.getByText("确定"));
    expect(setSaveTargetDetails).toHaveBeenCalledWith("sv1", "", "");
  });
});

describe("SaveMediaBody 目标行", () => {
  // 目标行在「目标已设」分支：upstream 非空才渲染（空 paths=等待产物态）。
  const connectedServices = { ...services, upstream: vi.fn(() => ({ paths: ["cache/x.png"] })) } as unknown as NodeProps["services"];

  it("目标已设时显示分组 · 名称（名称空=默认原名），点行开浮层", async () => {
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
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
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
