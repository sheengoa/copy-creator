// @vitest-environment jsdom
// 守护测试：查找替换条的历史面板与交换按钮。历史为两窗口共享的全局
// 能力，这里钉住渲染契约与记录时机：点击条目回填两输入框、替换动作
// 落历史（持久化 + 广播）、Esc 先关面板再关条、交换对调两输入框。
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const { invokeMock, emitMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  emitMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: emitMock,
  listen: vi.fn(),
}));

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../i18n";
import FindReplaceBar from "../components/FindReplaceBar";
import { useSettingsStore } from "../stores/settingsStore";
import { serializeFindHistory, type FindHistoryEntry } from "../utils/findHistory";

// vitest 未开 globals，testing-library 的自动清理不生效，需手动卸载。
afterEach(cleanup);

type BarProps = Parameters<typeof FindReplaceBar>[0];

function renderBar(overrides: Partial<BarProps> = {}) {
  const props: BarProps = {
    query: "",
    replacement: "",
    caseSensitive: false,
    matchCount: 0,
    matchIndex: -1,
    onQueryChange: () => {},
    onReplacementChange: () => {},
    onCaseSensitiveChange: () => {},
    onNext: () => {},
    onPrev: () => {},
    onReplaceCurrent: () => {},
    onReplaceAll: () => {},
    onClose: () => {},
    ...overrides,
  };
  render(<FindReplaceBar {...props} />);
  return props;
}

const seedHistory = (entries: FindHistoryEntry[]) => {
  useSettingsStore.setState({ findReplaceHistory: entries });
  // 面板展开会经 get_setting 重读最新历史（跨窗口陈旧防护），把存储侧
  // 打成与 store 一致，避免刷新覆盖测试种子。
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "get_setting") return Promise.resolve(serializeFindHistory(entries));
    return Promise.resolve(undefined);
  });
};

describe("FindReplaceBar 历史面板", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    emitMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    emitMock.mockResolvedValue(undefined);
    seedHistory([]);
  });

  it("时钟按钮展开面板时经 get_setting 拉取最新历史（陈旧快照防护）", async () => {
    // store 只有启动期快照，存储侧已有其他窗口写入的更新条目。
    seedHistory([]);
    const stored: FindHistoryEntry[] = [{ query: "别的窗口刚替换的词", replacement: "新值", replaced: true }];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_setting") return Promise.resolve(JSON.stringify(stored));
      return Promise.resolve(undefined);
    });

    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "查找替换历史" }));

    await waitFor(() => {
      expect(screen.getByText("别的窗口刚替换的词")).not.toBeNull();
    });
    expect(screen.getByText("新值")).not.toBeNull();
  });

  it("refresh 在途期间发生本地变更时丢弃过期快照，不回写覆盖", async () => {
    seedHistory([{ query: "a", replacement: "", replaced: false }]);
    let resolveGetSetting: (value: string) => void = () => {};
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_setting") {
        return new Promise<string>((resolve) => {
          resolveGetSetting = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    renderBar({ query: "", matchCount: 0, matchIndex: -1 });
    fireEvent.click(screen.getByRole("button", { name: "查找替换历史" }));
    // refresh 尚在途，用户先做了一次本地记录
    fireEvent.keyDown(screen.getByPlaceholderText("查找"), { key: "Enter" });
    resolveGetSetting(JSON.stringify([{ query: "存储侧的旧词", replacement: "", replaced: false }]));

    await waitFor(() => {
      expect(useSettingsStore.getState().findReplaceHistory[0]?.query).toBe("a");
    });
    // 存储侧旧词不得回写覆盖本地新记录
    expect(useSettingsStore.getState().findReplaceHistory.map((e) => e.query)).toEqual(["a"]);
  });

  it("时钟按钮展开面板，条目按「查找过/替换过」形态渲染", () => {
    seedHistory([
      { query: "旧地址", replacement: "新地址", replaced: true },
      { query: "TODO", replacement: "", replaced: false },
    ]);
    renderBar();

    fireEvent.click(screen.getByRole("button", { name: "查找替换历史" }));

    expect(screen.getByRole("listbox", { name: "查找替换历史" })).not.toBeNull();
    expect(screen.getByText("旧地址")).not.toBeNull();
    expect(screen.getByText("新地址")).not.toBeNull();
    expect(screen.getByText("替换过")).not.toBeNull();
    expect(screen.getByText("TODO")).not.toBeNull();
    expect(screen.getByText("查找过")).not.toBeNull();
  });

  it("点击条目回填两个输入框并收起面板", () => {
    seedHistory([{ query: "旧地址", replacement: "新地址", replaced: true }]);
    const queryChange = vi.fn();
    const replacementChange = vi.fn();
    renderBar({ onQueryChange: queryChange, onReplacementChange: replacementChange });

    fireEvent.click(screen.getByRole("button", { name: "查找替换历史" }));
    fireEvent.click(screen.getByText("旧地址"));

    expect(queryChange).toHaveBeenCalledWith("旧地址");
    expect(replacementChange).toHaveBeenCalledWith("新地址");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("点击仅查找条目回填查找词并清空替换框", () => {
    seedHistory([{ query: "TODO", replacement: "", replaced: false }]);
    const queryChange = vi.fn();
    const replacementChange = vi.fn();
    renderBar({ query: "占位", replacement: "旧值", onQueryChange: queryChange, onReplacementChange: replacementChange });

    fireEvent.click(screen.getByRole("button", { name: "查找替换历史" }));
    fireEvent.click(screen.getByText("TODO"));

    expect(queryChange).toHaveBeenCalledWith("TODO");
    expect(replacementChange).toHaveBeenCalledWith("");
  });

  it("删除该条只移除对应条目并持久化", async () => {
    seedHistory([
      { query: "a", replacement: "", replaced: false },
      { query: "b", replacement: "", replaced: false },
    ]);
    renderBar();

    fireEvent.click(screen.getByRole("button", { name: "查找替换历史" }));
    fireEvent.click(screen.getAllByRole("button", { name: "删除该条" })[0]);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_setting", {
        key: "find_replace_history",
        value: serializeFindHistory([{ query: "b", replacement: "", replaced: false }]),
      });
    });
    expect(useSettingsStore.getState().findReplaceHistory.map((e) => e.query)).toEqual(["b"]);
  });

  it("清空历史后展示空态并持久化空列表", async () => {
    seedHistory([{ query: "a", replacement: "", replaced: false }]);
    renderBar();

    fireEvent.click(screen.getByRole("button", { name: "查找替换历史" }));
    fireEvent.click(screen.getByText("清空历史"));

    expect(screen.getByText("暂无历史")).not.toBeNull();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_setting", {
        key: "find_replace_history",
        value: "[]",
      });
    });
  });
});

describe("FindReplaceBar 历史记录时机", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    emitMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    emitMock.mockResolvedValue(undefined);
    seedHistory([]);
  });
  it("查找框内 Enter 触达下一个并记录查找词", async () => {
    const next = vi.fn();
    renderBar({ query: "abc", matchCount: 2, matchIndex: 0, onNext: next });

    fireEvent.keyDown(screen.getByPlaceholderText("查找"), { key: "Enter" });

    expect(next).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(useSettingsStore.getState().findReplaceHistory).toEqual([
        { query: "abc", replacement: "", replaced: false },
      ]);
    });
  });

  it("点「替换」执行替换并记录查找词 + 替换值对", async () => {
    const replaceCurrent = vi.fn();
    renderBar({ query: "a", replacement: "A", matchCount: 3, matchIndex: 0, onReplaceCurrent: replaceCurrent });

    fireEvent.click(screen.getByRole("button", { name: "替换" }));

    expect(replaceCurrent).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(useSettingsStore.getState().findReplaceHistory).toEqual([
        { query: "a", replacement: "A", replaced: true },
      ]);
    });
    expect(emitMock).toHaveBeenCalledWith("find-replace-history-changed", {
      entries: [{ query: "a", replacement: "A", replaced: true }],
    });
  });

  it("点「全部替换」记录替换对", async () => {
    const replaceAll = vi.fn();
    renderBar({ query: "a", replacement: "", matchCount: 2, matchIndex: 0, onReplaceAll: replaceAll });

    fireEvent.click(screen.getByRole("button", { name: "全部替换" }));

    expect(replaceAll).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(useSettingsStore.getState().findReplaceHistory).toEqual([
        { query: "a", replacement: "", replaced: true },
      ]);
    });
  });

  it("仅查找过的条目被替换后升级为替换对", async () => {
    seedHistory([{ query: "a", replacement: "", replaced: false }]);
    renderBar({ query: "a", replacement: "A", matchCount: 1, matchIndex: 0 });

    fireEvent.click(screen.getByRole("button", { name: "替换" }));

    await waitFor(() => {
      expect(useSettingsStore.getState().findReplaceHistory).toEqual([
        { query: "a", replacement: "A", replaced: true },
      ]);
    });
  });

  it("连按 Enter 导航只落一次历史（重复条目不再写库）", async () => {
    const next = vi.fn();
    renderBar({ query: "abc", matchCount: 2, matchIndex: 0, onNext: next });

    const queryInput = screen.getByPlaceholderText("查找");
    fireEvent.keyDown(queryInput, { key: "Enter" });
    await waitFor(() => {
      expect(useSettingsStore.getState().findReplaceHistory).toHaveLength(1);
    });
    fireEvent.keyDown(queryInput, { key: "Enter" });
    fireEvent.keyDown(queryInput, { key: "Enter" });

    expect(next).toHaveBeenCalledTimes(3);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_setting", expect.objectContaining({ key: "find_replace_history" }));
    });
    const persistCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "set_setting" && (cmd && true),
    );
    expect(persistCalls).toHaveLength(1);
  });
});

describe("FindReplaceBar Esc 分层与交换", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    emitMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    emitMock.mockResolvedValue(undefined);
    seedHistory([]);
  });

  it("Esc 先关历史面板，再按一次才关闭查找条", () => {
    seedHistory([{ query: "a", replacement: "", replaced: false }]);
    const close = vi.fn();
    renderBar({ onClose: close });

    fireEvent.click(screen.getByRole("button", { name: "查找替换历史" }));
    const bar = screen.getByRole("search");
    fireEvent.keyDown(bar, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.keyDown(bar, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("交换按钮对调查找与替换内容", () => {
    const queryChange = vi.fn();
    const replacementChange = vi.fn();
    renderBar({ query: "a", replacement: "A", onQueryChange: queryChange, onReplacementChange: replacementChange });

    fireEvent.click(screen.getByRole("button", { name: "交换查找与替换内容" }));

    expect(queryChange).toHaveBeenCalledWith("A");
    expect(replacementChange).toHaveBeenCalledWith("a");
  });

  it("两个输入框都为空时交换按钮禁用", () => {
    renderBar({ query: "", replacement: "" });

    expect(
      (screen.getByRole("button", { name: "交换查找与替换内容" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
