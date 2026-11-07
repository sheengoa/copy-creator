// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { ProjectDetailWindow, type DetailWindowOps } from "../pages/ResourcePage/ProjectShell/DetailWindow";
import type { ProjectCharacter } from "../stores/projectStore";
import { useProjectStore } from "../stores/projectStore";

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
    setImageBindings: vi.fn(),
    saveProfile: vi.fn(),
    openDetail: vi.fn(),
    loadEntity: vi.fn(),
    removeLink: vi.fn(),
    attachEntities: vi.fn(),
    openPromptPick: vi.fn(),
    openScriptPick: vi.fn(),
    nodeFaces: {},
    addNodeFace: vi.fn(),
    removeNodeFace: vi.fn(),
    backTarget: null,
    goBack: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

describe("DetailWindow", () => {
  it("形象卡首屏 30 张 + 点击显示剩余续载一批（30/批，104 总量）", () => {
    render(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-2" }}
        ops={makeOps()}
      />,
    );
    // 默认「当前」视角（本夹具无头像为空态），切「全部」验分页。
    fireEvent.click(screen.getByText("全部"));
    expect(document.querySelectorAll(".pdetail-face").length).toBe(30);
    expect(screen.getByText(/显示剩余 74/)).toBeTruthy();
    // 点「显示剩余」续载一批。
    fireEvent.click(screen.getByText(/显示剩余 74/));
    expect(document.querySelectorAll(".pdetail-face").length).toBe(60);
    expect(screen.getByText(/显示剩余 44/)).toBeTruthy();
  });

  it("形象卡：头像并入展示且计数与实际一致（不再出现共 0 张下有图）", () => {
    render(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-2" }}
        ops={makeOps({ characters: [{ ...baseCharacter, reference_paths: "[]", avatar_path: "avatars/kawayi.png" }] })}
      />,
    );
    expect(document.querySelectorAll(".pdetail-face").length).toBe(1);
    expect(screen.getByText("共 1 张")).toBeTruthy();
    // 头像卡不在 reference_paths 内：不提供移除。
    expect(screen.queryByText("移除")).toBeNull();
  });

  it("视角切换：默认「当前」只显示节点所用形象（头像/主图），切「全部」看全量，换实体重置", () => {
    const { rerender } = render(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-2" }}
        ops={makeOps({ characters: [{ ...baseCharacter, avatar_path: "avatars/k.png", reference_paths: JSON.stringify(["refs/a.png", "refs/b.png"]) }] })}
      />,
    );
    // 默认当前（恢复旧详情窗语义）：仅节点显示的头像 1 张，计数与实际一致。
    expect((screen.getByText("当前") as HTMLButtonElement).classList.contains("is-active")).toBe(true);
    expect(document.querySelectorAll(".pdetail-face").length).toBe(1);
    expect(screen.getByText("共 1 张")).toBeTruthy();
    // 切「全部」：头像排首位 + 2 张参考图 = 3 张（段头总数 + 组头计数各一次）。
    fireEvent.click(screen.getByText("全部"));
    expect((screen.getByText("全部") as HTMLButtonElement).classList.contains("is-active")).toBe(true);
    expect(document.querySelectorAll(".pdetail-face").length).toBe(3);
    expect(screen.getAllByText("共 3 张").length).toBe(2);
    // 换实体重置回「当前」；新实体无头像 → 空态。
    rerender(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-3" }}
        ops={makeOps({ characters: [{ ...baseCharacter, id: "char-3", reference_paths: JSON.stringify(["refs/a.png"]) }] })}
      />,
    );
    expect((screen.getByText("当前") as HTMLButtonElement).classList.contains("is-active")).toBe(true);
    expect(document.querySelectorAll(".pdetail-face").length).toBe(0);
    expect(screen.getByText("共 0 张")).toBeTruthy();
    expect(screen.getByText("暂无内容")).toBeTruthy();
  });

  it("全部视角=本集实体分组：当前实体排首，组头各自计数，跨实体编辑路由到所属实体", () => {
    const setImageBindings = vi.fn();
    const other: ProjectCharacter = {
      ...baseCharacter,
      id: "char-9",
      name: "卡哇伊",
      bio: "另一角色",
      avatar_path: "avatars/kww.png",
      reference_paths: JSON.stringify(["refs/k1.png"]),
    };
    render(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-2" }}
        ops={makeOps({
          setImageBindings,
          nodeLinks: [
            { id: "nl-1", from_kind: "character", from_id: "char-2", to_segment: "seg-1", to_port: "character", owner_key: "" },
            { id: "nl-2", from_kind: "character", from_id: "char-9", to_segment: "seg-1", to_port: "character", owner_key: "" },
          ],
          characters: [{ ...baseCharacter, reference_paths: JSON.stringify(["refs/a.png"]) }, other],
        })}
      />,
    );
    // 当前视角：仅本节点头像一张（char-2 无头像 → 空态）。切「全部」→
    // 本集两实体各一组，当前实体排首；段头计数 = 两实体图集总数 3。
    fireEvent.click(screen.getByText("全部"));
    const headers = [...document.querySelectorAll(".pdetail-facegroup-name")].map((el) => el.textContent);
    expect(headers).toEqual(["老周", "卡哇伊"]);
    expect(screen.getByText("共 3 张")).toBeTruthy();
    expect(screen.getAllByText("添加形象").length).toBe(2);
    expect(document.querySelectorAll(".pdetail-face").length).toBe(3);
    // 跨实体编辑：点卡哇伊组首卡「独立」→ 预填数据路由到 char-9（而非
    // 当前窗口实体 char-2），证明每张卡写入各自实体的库数据。
    const kwwSeg = document.querySelectorAll(".pdetail-face")[1].querySelectorAll(".pdetail-seg-btn");
    fireEvent.click(kwwSeg[1]);
    expect(setImageBindings).toHaveBeenCalledWith("character", "char-9", [
      { path: "avatars/kww.png", name: "卡哇伊", voice_path: "", bio: "另一角色", prompt: "", time_hint: "" },
    ]);
  });

  it("当前视角添加形象：弹本实体形象集点选即加，留在当前视角不切走（用户定案「当前是当前的」）", () => {
    const addNodeFace = vi.fn();
    render(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-2", nodeKey: "eph:p1" }}
        ops={makeOps({
          addNodeFace,
          characters: [{ ...baseCharacter, avatar_path: "avatars/k.png", reference_paths: JSON.stringify(["refs/a.png"]) }],
        })}
      />,
    );
    // 当前视角：头像兜底 1 张；点「添加形象」弹节点形象挑选（列实体形象
    // 集中未加入的——refs/a.png，头像恒显示不列）。
    fireEvent.click(screen.getByText("添加形象"));
    expect(screen.getByText(/从该角色已有的形象中点选/)).toBeTruthy();
    const picker1 = document.querySelector(".pdetail-attach");
    expect(picker1?.textContent).toContain("a.png");
    expect(picker1?.textContent).not.toContain("k.png");
    // 点选 → addNodeFace 路由 + 面板关 + 视角仍「当前」（不切走）。
    fireEvent.click(screen.getByText("a.png"));
    expect(addNodeFace).toHaveBeenCalledWith("eph:p1", "refs/a.png");
    expect(document.querySelector(".pdetail-attach")).toBeNull();
    expect((screen.getByText("当前") as HTMLButtonElement).classList.contains("is-active")).toBe(true);
    expect(screen.queryByText("本集全部角色")).toBeNull();
  });

  it("节点形象挑选面板排除已加入的：重复添加在面板层就不出现", () => {
    render(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-2", nodeKey: "eph:p1" }}
        ops={makeOps({
          nodeFaces: { "eph:p1": ["refs/a.png"] },
          characters: [{ ...baseCharacter, avatar_path: "avatars/k.png", reference_paths: JSON.stringify(["refs/a.png", "refs/b.png"]) }],
        })}
      />,
    );
    fireEvent.click(screen.getByText("添加形象"));
    // refs/a.png 已在节点选用集 → 面板只列 refs/b.png。
    const picker2 = document.querySelector(".pdetail-attach");
    expect(picker2?.textContent).not.toContain("a.png");
    expect(picker2?.textContent).toContain("b.png");
  });

  it("节点选用形象在当前视角陈列（头像兜底首张）+「移出本节点」路由且头像不可移出", () => {
    const removeNodeFace = vi.fn();
    render(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-2", nodeKey: "eph:p1" }}
        ops={makeOps({
          removeNodeFace,
          nodeFaces: { "eph:p1": ["refs/a.png", "refs/b.png"] },
          characters: [{ ...baseCharacter, avatar_path: "avatars/k.png", reference_paths: JSON.stringify(["refs/a.png", "refs/b.png"]) }],
        })}
      />,
    );
    // 当前视角 = 头像 + 选用 2 张 = 3 卡；计数与实际一致。
    expect(document.querySelectorAll(".pdetail-face").length).toBe(3);
    expect(screen.getByText("共 3 张")).toBeTruthy();
    // 移出钮：头像卡没有；选用卡有，点击路由 removeNodeFace（不动库）。
    const faces = [...document.querySelectorAll(".pdetail-face")];
    expect(faces[0].querySelector(".pdetail-face-foot")?.textContent).not.toContain("移出本节点");
    const removes = faces[1].querySelectorAll(".pdetail-face-foot .pdetail-voice-act.is-danger");
    fireEvent.click(removes[0]);
    expect(removeNodeFace).toHaveBeenCalledWith("eph:p1", "refs/a.png");
  });

  it("无来源节点（输入卡跳转）：当前视角退化为头像单卡只读，无添加入口", () => {
    render(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-2" }}
        ops={makeOps({ characters: [{ ...baseCharacter, avatar_path: "avatars/k.png", reference_paths: JSON.stringify(["refs/a.png"]) }] })}
      />,
    );
    expect(document.querySelectorAll(".pdetail-face").length).toBe(1);
    expect(screen.queryByText("添加形象")).toBeNull();
  });

  it("无形象图条目禁点：面板行显示「无形象图」，点击不触发添加", () => {
    useProjectStore.setState({
      characters: [
        { ...baseCharacter, reference_paths: "[]" },
        { ...baseCharacter, id: "char-empty", name: "无图角色", avatar_path: "", reference_paths: "[]" },
      ],
    });
    const setReferences = vi.fn();
    try {
      render(
        <ProjectDetailWindow
          target={{ kind: "info", group: "character", sourceKey: "char:char-2" }}
          ops={makeOps({ setReferences, characters: [{ ...baseCharacter, avatar_path: "avatars/k.png", reference_paths: "[]" }, { ...baseCharacter, id: "char-empty", name: "无图角色", avatar_path: "", reference_paths: "[]" }] })}
        />,
      );
      // 无 nodeKey 的窗口自身无添加入口——切到「全部」走实体级添加（库面
      // 板）验证禁点仍生效。
      fireEvent.click(screen.getByText("全部"));
      const addBtn = [...document.querySelectorAll(".pdetail-ref-add")].find((b) => b.textContent?.includes("添加形象"));
      fireEvent.click(addBtn as HTMLElement);
      // 无头像条目 tag = 「无形象图」且整卡禁点。
      expect(screen.getByText("无形象图")).toBeTruthy();
      const emptyCard = [...document.querySelectorAll(".project-library-card")].find((c) => c.textContent?.includes("无图角色"));
      fireEvent.click(emptyCard as HTMLElement);
      expect(setReferences).not.toHaveBeenCalled();
      // 面板保持打开（无效点击不关闭，用户可继续选有图条目）。
      expect(document.querySelector(".project-dialog-overlay")).toBeTruthy();
    } finally {
      useProjectStore.setState({ characters: [] });
    }
  });

  it("默认区音色两态：空态只给更换入口；有音色给播放件与清除", () => {
    const ops = makeOps({ characters: [{ ...baseCharacter, reference_paths: "[]" }] });
    const { rerender } = render(
      <ProjectDetailWindow target={{ kind: "info", group: "character", sourceKey: "char:char-2" }} ops={ops} />,
    );
    expect(screen.getByText("未设置音色")).toBeTruthy();
    rerender(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-2" }}
        ops={{ ...ops, characters: [{ ...baseCharacter, reference_paths: "[]", voice_path: "tones/laozhou.wav" }] }}
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

  it("形象管理：段头「添加形象」开选择浮层；移除路由 setReferences 过滤；独立开关预填默认", () => {
    const setReferences = vi.fn();
    const setImageBindings = vi.fn();
    const refs = ["refs/a.png", "refs/b.png"];
    render(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-2" }}
        ops={makeOps({ setReferences, setImageBindings, characters: [{ ...baseCharacter, reference_paths: JSON.stringify(refs) }] })}
      />,
    );
    // 默认「当前」视角无头像为空态，切「全部」验形象管理流。
    fireEvent.click(screen.getByText("全部"));
    // 跟随默认态：名称镜像实体名、人设镜像默认（禁用）；胶囊停在「跟随」。
    expect(document.querySelectorAll(".pdetail-face").length).toBe(2);
    const firstName = document.querySelector(".pdetail-face .pdetail-f-input") as HTMLInputElement;
    expect(firstName.disabled).toBe(true);
    expect(firstName.value).toBe("老周");
    const firstBio = document.querySelector(".pdetail-face .pdetail-f textarea") as HTMLTextAreaElement;
    expect(firstBio.disabled).toBe(true);
    expect(firstBio.value).toBe("沉稳寡言的老周");
    const faceSeg = document.querySelectorAll(".pdetail-face")[0].querySelectorAll(".pdetail-seg-btn");
    expect(faceSeg[0].classList.contains("is-active")).toBe(true);
    // 点「独立」→ setImageBindings 预填默认数据（名称带入实体名）。
    fireEvent.click(faceSeg[1]);
    expect(setImageBindings).toHaveBeenCalledWith("character", "char-2", [
      { path: "refs/a.png", name: "老周", voice_path: "", bio: "沉稳寡言的老周", prompt: "", time_hint: "" },
    ]);
    // 逐张移除：整体覆写路由（首张 a.png 被过滤）。
    const removeButtons = screen.getAllByText("移除");
    expect(removeButtons.length).toBe(2);
    fireEvent.click(removeButtons[0]);
    expect(setReferences).toHaveBeenCalledWith("character", "char-2", ["refs/b.png"]);
    // 「添加形象」弹对应库面板（用户定案：条目自带名称/人设，不再弹文件框）。
    fireEvent.click(screen.getByText("添加形象"));
    expect(document.querySelector(".project-dialog-overlay")).toBeTruthy();
    const panelTitle = document.querySelector(".project-library-panel h4")?.textContent ?? "";
    expect(panelTitle).toContain("选择角色形象");
    expect(screen.queryByText("添加参考图")).toBeNull();
  });

  it("独立形象：编辑失焦提交绑定；音色清除路由空 voice_path；关闭开关移除条目", () => {
    const setImageBindings = vi.fn();
    const setVoice = vi.fn();
    const bindings = [{ path: "refs/a.png", name: "睡衣", voice_path: "v.wav", bio: "形象一人设", prompt: "", time_hint: "" }];
    render(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-2" }}
        ops={makeOps({
          setImageBindings,
          setVoice,
          characters: [{ ...baseCharacter, reference_paths: JSON.stringify(["refs/a.png", "refs/b.png"]), image_bindings: JSON.stringify(bindings), voice_path: "tone.wav" }],
        })}
      />,
    );
    // 默认「当前」视角无头像为空态，切「全部」验独立绑定流。
    fireEvent.click(screen.getByText("全部"));
    // a 独立（可编辑、预载绑定值）；b 跟随默认（禁用）。
    const tas = [...document.querySelectorAll(".pdetail-face textarea")] as HTMLTextAreaElement[];
    expect(tas.length).toBe(4);
    expect(tas[0].value).toBe("形象一人设");
    expect(tas[0].disabled).toBe(false);
    expect(tas[2].disabled).toBe(true);
    // 编辑 a 的人设 → 失焦提交整体覆写（b 无条目不落列表）。
    fireEvent.change(tas[0], { target: { value: "改过的人设" } });
    fireEvent.blur(tas[0]);
    expect(setImageBindings).toHaveBeenCalledWith("character", "char-2", [
      { path: "refs/a.png", name: "睡衣", voice_path: "v.wav", bio: "改过的人设", prompt: "", time_hint: "" },
    ]);
    // 独立形象的音色清除 → 绑定条目 voice_path 置空（不动实体级默认）。
    const clears = screen.getAllByText("删除");
    fireEvent.click(clears[0]);
    expect(setImageBindings).toHaveBeenCalledWith("character", "char-2", [
      { path: "refs/a.png", name: "睡衣", voice_path: "", bio: "形象一人设", prompt: "", time_hint: "" },
    ]);
    // 点回「跟随」→ 条目移除（回跟随默认）。
    const aSeg = document.querySelectorAll(".pdetail-face")[0].querySelectorAll(".pdetail-seg-btn");
    expect(aSeg[1].classList.contains("is-active")).toBe(true);
    fireEvent.click(aSeg[0]);
    expect(setImageBindings).toHaveBeenCalledWith("character", "char-2", []);
    // 跟随形象的清除指向实体级默认（setVoice），不走绑定。
    fireEvent.click(clears[1]);
    expect(setVoice).toHaveBeenCalledWith("char-2", "");
    expect(setImageBindings).toHaveBeenCalledTimes(3);
  });

  it("默认区编辑：人设失焦路由 saveProfile（Shell 按类保留其它字段落库）", () => {
    const saveProfile = vi.fn();
    render(
      <ProjectDetailWindow
        target={{ kind: "info", group: "character", sourceKey: "char:char-2" }}
        ops={makeOps({ saveProfile, characters: [{ ...baseCharacter, reference_paths: "[]" }] })}
      />,
    );
    const tas = [...document.querySelectorAll(".pdetail-default textarea")] as HTMLTextAreaElement[];
    expect(tas.length).toBe(2);
    expect(tas[0].value).toBe("沉稳寡言的老周");
    fireEvent.change(tas[0], { target: { value: "新默认人设" } });
    fireEvent.blur(tas[0]);
    expect(saveProfile).toHaveBeenCalledWith("character", "char-2", "新默认人设", "");
  });

  it("场景形象卡：reference_paths 数组多图全展示，旧单张 ref_path 并入；无音色行只有人设/提示词", () => {
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
    // 默认「当前」视角=节点显示的旧主图 1 张，切「全部」验全量陈列。
    fireEvent.click(screen.getByText("全部"));
    // 旧主图并入首 + 数组两张 = 3 张形象卡全展示（场景无音色行）。
    expect(document.querySelectorAll(".pdetail-face").length).toBe(3);
    expect(document.querySelectorAll(".pdetail-face .pdetail-voice").length).toBe(0);
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
