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
    setVoice: vi.fn(),
    setAvatar: vi.fn(),
    loadEntity: vi.fn(),
    removeLink: vi.fn(),
    attachEntities: vi.fn(),
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

  it("片段输入按口分组展示，逐项移除路由 removeLink（组认领线带行 id）", () => {
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
          characters: [baseCharacter],
        })}
      />,
    );
    expect(screen.getByText("老周")).toBeTruthy();
    const removeButtons = screen.getAllByText("移除");
    expect(removeButtons.length).toBe(2);
    fireEvent.click(removeButtons[0]);
    expect(removeLink).toHaveBeenCalledWith(
      expect.objectContaining({ pending: false, fromKey: "char-2", toSegment: "seg-1", toPort: "character", ownerKey: "", rowId: "nl-1" }),
    );
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
    fireEvent.click(screen.getByText(/批量挂靠/));
    fireEvent.click(screen.getByText("道具"));
    fireEvent.click(screen.getByText("旧怀表"));
    fireEvent.click(screen.getByText(/挂靠 1 项/));
    expect(attachEntities).toHaveBeenCalledWith("seg-1", "prop", [{ kind: "prop", id: "prop-9" }]);
  });
});
