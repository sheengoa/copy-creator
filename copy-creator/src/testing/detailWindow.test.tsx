// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { ProjectDetailWindow, type DetailWindowOps } from "../pages/ResourcePage/ProjectShell/DetailWindow";
import type { ProjectCharacter } from "../stores/projectStore";

// 详情窗守卫（工程视图节点化阶段 D6）：参考图 30/批懒加载分页与续载、
// 音色行两态、片段输入分组与逐项移除、批量挂靠确认路由。

const baseCharacter: ProjectCharacter = {
  id: "char-2",
  name: "老周",
  role_tag: "配角",
  bio: "沉稳寡言的老周",
  prompt: "",
  avatar_path: "",
  reference_paths: JSON.stringify(Array.from({ length: 104 }, (_, i) => `refs/${i + 1}.png`)),
  voice_path: "",
  created_at: "",
  updated_at: "",
};

function makeOps(overrides: Partial<DetailWindowOps> = {}): DetailWindowOps {
  return {
    libraryRoot: "",
    overview: null,
    segments: [],
    nodeLinks: [],
    pendingLinks: [],
    characters: [baseCharacter],
    locations: [],
    props: [],
    prompts: [],
    promptPhs: [],
    scriptPhs: [],
    setVoice: vi.fn(),
    setAvatar: vi.fn(),
    setReferences: vi.fn(),
    openDetail: vi.fn(),
    loadEntity: vi.fn(),
    removeLink: vi.fn(),
    attachEntities: vi.fn(),
    openPromptPick: vi.fn(),
    openScriptPick: vi.fn(),
    backTarget: null,
    goBack: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

describe("DetailWindow", () => {
  it("参考图首屏 30 张 + 滚动续载一批（30/批，104 总量）", () => {
    render(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-2" }}
        ops={makeOps()}
      />,
    );
    const grid = document.querySelector(".pdetail-refgrid") as HTMLElement;
    expect(grid.children.length).toBe(30);
    expect(screen.getByText(/剩余 74/)).toBeTruthy();
    // jsdom 无布局：滚动量读数全 0，任意 scroll 事件即满足「到底」条件，
    // 恰好用于驱动续载分支。
    fireEvent.scroll(grid);
    expect(grid.children.length).toBe(60);
    expect(screen.getByText(/剩余 44/)).toBeTruthy();
  });

  it("参考图大图列表：头像并入展示且计数与实际一致（不再出现共 0 张下有图）", () => {
    render(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-2" }}
        ops={makeOps({ characters: [{ ...baseCharacter, reference_paths: "[]", avatar_path: "avatars/kawayi.png" }] })}
      />,
    );
    expect(document.querySelectorAll(".pdetail-refgrid .pdetail-refcard-img").length).toBe(1);
    expect(screen.getByText("共 1 张")).toBeTruthy();
    expect(screen.queryByText("无参考图")).toBeNull();
  });

  it("音色行两态：空态只给更换入口；有音色给播放件与清除", () => {
    const ops = makeOps();
    const { rerender } = render(
      <ProjectDetailWindow target={{ kind: "info", group: "character", sourceKey: "char:char-2" }} ops={ops} />,
    );
    expect(screen.getByText("未设置音色")).toBeTruthy();
    rerender(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-2" }}
        ops={{ ...ops, characters: [{ ...baseCharacter, voice_path: "tones/laozhou.wav" }] }}
      />,
    );
    expect(screen.getByText("laozhou.wav")).toBeTruthy();
  });

  it("片段输入按口分组展示，删除=右上角图标且确认后才路由 removeLink", () => {
    const removeLink = vi.fn();
    render(
      <ProjectDetailWindow
        target={{ kind: "segment", id: "seg-1" }}
        ops={makeOps({
          removeLink,
          segments: [
            { id: "seg-1", episode_id: "e1", asset_id: null, sort_order: 0, note: "", canvas_x: null, canvas_y: null, created_at: "", updated_at: "" },
          ],
          nodeLinks: [
            { id: "nl-1", from_kind: "character", from_id: "char-2", to_segment: "seg-1", to_port: "character", owner_key: "" },
            { id: "nl-g1", from_kind: "location", from_id: "loc-1", to_segment: "seg-1", to_port: "location", owner_key: "grp:g1" },
          ],
          // 无图实体各占一张占位卡，聚焦确认流本身。
          characters: [{ ...baseCharacter, reference_paths: "[]" }],
        })}
      />,
    );
    expect(screen.getByText("老周")).toBeTruthy();
    // 删除键弱化为右上角悬浮图标（不再有「移除」文字大按钮）。
    expect(screen.queryByText("移除")).toBeNull();
    const xs = () => document.querySelectorAll(".pdetail-incard-x");
    expect(xs().length).toBe(2);
    // 首击只弹确认框，不直接移除。
    fireEvent.click(xs()[0]);
    expect(removeLink).not.toHaveBeenCalled();
    expect(screen.getByText(/确定将「老周」从本片段移除/)).toBeTruthy();
    fireEvent.click(document.querySelector(".dialog-btn.save") as HTMLElement);
    expect(removeLink).toHaveBeenCalledWith(
      expect.objectContaining({ pending: false, fromKey: "char-2", toSegment: "seg-1", toPort: "character", ownerKey: "", rowId: "nl-1" }),
    );
    // 组卡（资料组）同样先确认再移除（mock ops 不真删，图标位次不变）。
    fireEvent.click(xs()[1]);
    fireEvent.click(document.querySelector(".dialog-btn.save") as HTMLElement);
    expect(removeLink).toHaveBeenCalledWith(
      expect.objectContaining({ pending: false, fromKey: "loc-1", toSegment: "seg-1", toPort: "location", ownerKey: "grp:g1", rowId: "nl-g1" }),
    );
  });

  it("输入卡一图一卡：实体逐张参考图各成一卡，点击卡片路由 openDetail 展开实体窗", () => {
    const openDetail = vi.fn();
    render(
      <ProjectDetailWindow
        target={{ kind: "segment", id: "seg-1" }}
        ops={makeOps({
          openDetail,
          segments: [
            { id: "seg-1", episode_id: "e1", asset_id: null, sort_order: 0, note: "", canvas_x: null, canvas_y: null, created_at: "", updated_at: "" },
          ],
          nodeLinks: [
            { id: "nl-1", from_kind: "character", from_id: "char-2", to_segment: "seg-1", to_port: "character", owner_key: "" },
          ],
          characters: [{ ...baseCharacter, avatar_path: "avatars/laozhou.png", reference_paths: JSON.stringify(["refs/a.png", "refs/b.png"]) }],
        })}
      />,
    );
    // 一图一卡：头像 + 2 张参考图 = 3 张独立卡（不再挤在一张卡内）。
    expect(document.querySelectorAll(".pdetail-incard").length).toBe(3);
    expect(document.querySelectorAll(".pdetail-incard-img").length).toBe(3);
    fireEvent.click(document.querySelector(".pdetail-incard-view") as HTMLElement);
    expect(openDetail).toHaveBeenCalledWith({ kind: "info", group: "character", sourceKey: "char:char-2" });
  });

  it("输入卡图集与实体窗对称：头像排首位并入参考图，多图各成一卡不落占位", () => {
    render(
      <ProjectDetailWindow
        target={{ kind: "segment", id: "seg-1" }}
        ops={makeOps({
          segments: [
            { id: "seg-1", episode_id: "e1", asset_id: null, sort_order: 0, note: "", canvas_x: null, canvas_y: null, created_at: "", updated_at: "" },
          ],
          nodeLinks: [
            { id: "nl-1", from_kind: "character", from_id: "char-2", to_segment: "seg-1", to_port: "character", owner_key: "" },
          ],
          characters: [{ ...baseCharacter, avatar_path: "avatars/kawayi.png", reference_paths: JSON.stringify(["refs/cat.png"]) }],
        })}
      />,
    );
    // 头像 + 1 张参考图 = 2 张独立卡（实体窗「共 2 张」的对称展示），且
    // 不落图标占位；src 为懒加载异步属性，jsdom 断言不了，顺序在浏览器
    // 实机核对。
    expect(document.querySelectorAll(".pdetail-incard").length).toBe(2);
    expect(document.querySelectorAll(".pdetail-incard-img").length).toBe(2);
    expect(document.querySelector(".pdetail-incard-fallback")).toBeNull();
  });

  it("输入卡跳转后头部显示返回键，点击路由 goBack 跳回上一窗", () => {
    const goBack = vi.fn();
    const backTarget = { kind: "segment" as const, id: "seg-1" };
    const { rerender } = render(
      <ProjectDetailWindow target={{ kind: "info", group: "character", sourceKey: "char:char-2" }} ops={makeOps({ backTarget, goBack })} />,
    );
    expect(screen.getByTitle("返回")).toBeTruthy();
    fireEvent.click(screen.getByTitle("返回"));
    expect(goBack).toHaveBeenCalledTimes(1);
    // 无返回目标（画布双击直接打开）不渲染返回键。
    rerender(<ProjectDetailWindow target={{ kind: "info", group: "character", sourceKey: "char:char-2" }} ops={makeOps()} />);
    expect(screen.queryByTitle("返回")).toBeNull();
  });

  it("参考图管理：段头「添加参考图」开选择浮层，选图路由 setReferences 追加；移除路由过滤后覆写", () => {
    const setReferences = vi.fn();
    const refs = ["refs/a.png", "refs/b.png"];
    render(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-2" }}
        ops={makeOps({ setReferences, characters: [{ ...baseCharacter, reference_paths: JSON.stringify(refs) }] })}
      />,
    );
    // 逐张移除：整体覆写路由（首张 a.png 被过滤）。
    const removeButtons = screen.getAllByText("移除");
    expect(removeButtons.length).toBe(2);
    fireEvent.click(removeButtons[0]);
    expect(setReferences).toHaveBeenCalledWith("character", "char-2", ["refs/b.png"]);
    // 添加浮层打开（jsdom 下 portal 渲染选择器遮罩）。
    fireEvent.click(screen.getByText("添加参考图"));
    expect(document.querySelector(".project-dialog-overlay")).toBeTruthy();
  });

  it("场景/道具参考图集：reference_paths 数组多图全展示，旧单张 ref_path 并入", () => {
    const setReferences = vi.fn();
    render(
      <ProjectDetailWindow
        target={{ kind: "info", group: "location", sourceKey: "loc:loc-9" }}
        ops={makeOps({
          setReferences,
          locations: [{ id: "loc-9", name: "天台", int_ext: "", time_hint: "", bio: "", prompt: "", ref_path: "refs/main.png", reference_paths: JSON.stringify(["refs/2.png", "refs/3.png"]), created_at: "", updated_at: "" }],
        })}
      />,
    );
    // 旧主图并入首 + 数组两张 = 3 张全展示。
    expect(document.querySelectorAll(".pdetail-refgrid .pdetail-refcard-img").length).toBe(3);
    const removeButtons = screen.getAllByText("移除");
    fireEvent.click(removeButtons[2]);
    expect(setReferences).toHaveBeenCalledWith("location", "loc-9", ["refs/main.png", "refs/2.png"]);
  });

  it("批量挂靠：勾选后确认按 {kind, id} 逐条路由 attachEntities", () => {
    const attachEntities = vi.fn();
    render(
      <ProjectDetailWindow
        target={{ kind: "segment", id: "seg-1" }}
        ops={makeOps({
          attachEntities,
          segments: [
            { id: "seg-1", episode_id: "e1", asset_id: null, sort_order: 0, note: "", canvas_x: null, canvas_y: null, created_at: "", updated_at: "" },
          ],
          props: [{ id: "prop-9", name: "旧怀表", bio: "", prompt: "", ref_path: "", created_at: "", updated_at: "" }],
        })}
      />,
    );
    fireEvent.click(screen.getByText("批量挂靠（可多选）"));
    fireEvent.click(screen.getByText("道具"));
    fireEvent.click(screen.getByText("旧怀表"));
    fireEvent.click(screen.getByText(/挂靠 1 项/));
    expect(attachEntities).toHaveBeenCalledWith("seg-1", "prop", [{ kind: "prop", id: "prop-9" }]);
  });

  it("提示词纸片详情：标题+全文只读展示，更换提示词路由 openPromptPick", () => {
    const openPromptPick = vi.fn();
    render(
      <ProjectDetailWindow
        target={{ kind: "promptPh", id: "ph-1" }}
        ops={makeOps({
          openPromptPick,
          prompts: [{ id: "p-1", title: "末班车氛围", content: "地铁车厢内，冷白灯光闪烁。", category: "scene", file_path: "", created_at: "", updated_at: "" }],
          promptPhs: [{ id: "ph-1", promptId: "p-1", x: 0, y: 0 }],
        })}
      />,
    );
    expect(screen.getByText("末班车氛围")).toBeTruthy();
    expect(screen.getByText(/地铁车厢内，冷白灯光闪烁。/)).toBeTruthy();
    fireEvent.click(screen.getByText("更换提示词"));
    expect(openPromptPick).toHaveBeenCalledWith("prompt:ph-1");
  });

  it("空提示词纸片详情：空态展示，钉底「选择提示词」路由 openPromptPick（双击统一出窗）", () => {
    const openPromptPick = vi.fn();
    render(
      <ProjectDetailWindow
        target={{ kind: "promptPh", id: "ph-2" }}
        ops={makeOps({ openPromptPick, promptPhs: [{ id: "ph-2", promptId: "", x: 0, y: 0 }] })}
      />,
    );
    expect(screen.getByText("尚未选择提示词 · 点下方按钮从库中选择")).toBeTruthy();
    fireEvent.click(screen.getByText("选择提示词"));
    expect(openPromptPick).toHaveBeenCalledWith("prompt:ph-2");
  });

  it("剧本纸片详情：空态给「挂接剧本」；已挂接显示文件名与「更换剧本」路由 openScriptPick", () => {
    const openScriptPick = vi.fn();
    const { rerender } = render(
      <ProjectDetailWindow
        target={{ kind: "scriptPh", key: "script:sp-1" }}
        ops={makeOps({ openScriptPick, scriptPhs: [{ id: "sp-1", path: "" }] })}
      />,
    );
    expect(screen.getByText("尚未挂接剧本 · 点下方按钮选择文件")).toBeTruthy();
    fireEvent.click(screen.getByText("挂接剧本"));
    expect(openScriptPick).toHaveBeenCalledWith("script:sp-1");
    rerender(
      <ProjectDetailWindow
        target={{ kind: "scriptPh", key: "script:sp-1" }}
        ops={makeOps({ openScriptPick, scriptPhs: [{ id: "sp-1", path: "scripts/第一集剧本.txt" }] })}
      />,
    );
    expect(screen.getByText("第一集剧本.txt")).toBeTruthy();
    fireEvent.click(screen.getByText("更换剧本"));
    expect(openScriptPick).toHaveBeenCalledWith("script:sp-1");
  });

  it("成片卡详情：output_asset_id 命中散素材时展示名称，未产出给空态", () => {
    // ResourceVideoPoster 的懒加载观察器 jsdom 未实现，桩掉即可。
    class IOStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as { IntersectionObserver?: unknown }).IntersectionObserver = IOStub;
    const { rerender } = render(<ProjectDetailWindow target={{ kind: "output" }} ops={makeOps()} />);
    expect(screen.getByText("本集尚未挂出成片 · 片段产出后在此汇总")).toBeTruthy();
    rerender(
      <ProjectDetailWindow
        target={{ kind: "output" }}
        ops={makeOps({
          overview: {
            episode: { id: "e1", output_asset_id: "a-1" },
            loose_assets: [{ id: "a-1", file_path: "final/ep1.mp4", kind: "video", name: "第一集成片", shot_id: "", episode_id: "e1", gen_from_asset: "", gen_from_prompt: "", gen_params: "", audio_role: "", missing: false, canvas_x: null, canvas_y: null, created_at: "", updated_at: "" }],
            characters: [], locations: [], props: [], scenes: [], links: [], segments: [], node_links: [],
          },
        } as never)}
      />,
    );
    // 标题与视频角标各展示一次资产名。
    expect(screen.getAllByText("第一集成片").length).toBe(2);
  });
});
