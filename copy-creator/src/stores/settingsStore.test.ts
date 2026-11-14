import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { parseMaxRecords, useSettingsStore } from "./settingsStore";

describe("settingsStore 主题与隐私设置 wiring", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    emitMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    emitMock.mockResolvedValue(undefined);
    useSettingsStore.setState({
      themeMode: "light",
      resolvedTheme: "light",
      clipboardPaused: false,
      clipboardMaxRecords: 0,
      clipboardExclusions: "",
      autoHideOnBlur: false,
      findReplaceHistory: [],
    });
  });

  it("setThemeMode 持久化并广播原始偏好，system 解析为亮色", async () => {
    await useSettingsStore.getState().setThemeMode("system");

    expect(invokeMock).toHaveBeenCalledWith("set_setting", { key: "theme", value: "system" });
    expect(emitMock).toHaveBeenCalledWith("theme-changed", { theme: "system" });
    const state = useSettingsStore.getState();
    expect(state.themeMode).toBe("system");
    // 测试环境无 matchMedia，system 解析为亮色（theme.test.ts 已钉住解析语义）。
    expect(state.resolvedTheme).toBe("light");
  });

  it("toggleTheme 从当前解析值取反色落为显式偏好", async () => {
    useSettingsStore.setState({ themeMode: "light", resolvedTheme: "light" });
    await useSettingsStore.getState().toggleTheme();

    expect(invokeMock).toHaveBeenCalledWith("set_setting", { key: "theme", value: "dark" });
    expect(useSettingsStore.getState().resolvedTheme).toBe("dark");
  });

  it("setClipboardPaused 持久化并广播暂停事件（payload 与托盘侧一致）", async () => {
    await useClipboardPausedToggle(true);

    expect(invokeMock).toHaveBeenCalledWith("set_setting", {
      key: "clipboard_paused",
      value: "1",
    });
    expect(emitMock).toHaveBeenCalledWith("clipboard-pause-changed", { paused: true });
  });

  it("setClipboardMaxRecords 持久化为字符串档位", async () => {
    await useSettingsStore.getState().setClipboardMaxRecords(2000);

    expect(invokeMock).toHaveBeenCalledWith("set_setting", {
      key: "clipboard_max_records",
      value: "2000",
    });
  });

  it("setAutoHideOnBlur 以 1/0 持久化", async () => {
    await useSettingsStore.getState().setAutoHideOnBlur(true);

    expect(invokeMock).toHaveBeenCalledWith("set_setting", {
      key: "auto_hide_on_blur",
      value: "1",
    });
  });

  it("setFindReplaceHistory 函数式更新并持久化广播", async () => {
    useSettingsStore.setState({
      findReplaceHistory: [{ query: "a", replacement: "", replaced: false }],
    });

    await useSettingsStore.getState().setFindReplaceHistory((prev) =>
      prev.map((item) =>
        item.query === "a" ? { query: "a", replacement: "A", replaced: true } : item,
      ),
    );

    const entries = [{ query: "a", replacement: "A", replaced: true }];
    expect(useSettingsStore.getState().findReplaceHistory).toEqual(entries);
    expect(invokeMock).toHaveBeenCalledWith("set_setting", {
      key: "find_replace_history",
      value: JSON.stringify(entries),
    });
    expect(emitMock).toHaveBeenCalledWith("find-replace-history-changed", { entries });
  });

  it("setFindReplaceHistory 同引用视为无变化，跳过写库与广播", async () => {
    const entries = [{ query: "a", replacement: "", replaced: false }];
    useSettingsStore.setState({ findReplaceHistory: entries });

    await useSettingsStore.getState().setFindReplaceHistory((prev) => prev);

    expect(invokeMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().findReplaceHistory).toBe(entries);
  });

  it("doLoadSettings 解析 find_replace_history 存储串", async () => {
    const entries = [{ query: "x", replacement: "y", replaced: true }];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_all_settings") {
        return Promise.resolve({ find_replace_history: JSON.stringify(entries) });
      }
      if (cmd === "is_autostart_enabled") return Promise.resolve(false);
      return Promise.resolve(undefined);
    });

    await useSettingsStore.getState().doLoadSettings();

    expect(useSettingsStore.getState().findReplaceHistory).toEqual(entries);
  });

  it("doLoadSettings 对畸形的 find_replace_history 存储串回退空历史", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_all_settings") {
        return Promise.resolve({ find_replace_history: "{oops" });
      }
      if (cmd === "is_autostart_enabled") return Promise.resolve(false);
      return Promise.resolve(undefined);
    });

    await useSettingsStore.getState().doLoadSettings();

    expect(useSettingsStore.getState().findReplaceHistory).toEqual([]);
  });
});

async function useClipboardPausedToggle(enabled: boolean) {
  await useSettingsStore.getState().setClipboardPaused(enabled);
}

describe("parseMaxRecords", () => {
  it("非法/缺失/非正数一律不限（0）", () => {
    expect(parseMaxRecords(undefined)).toBe(0);
    expect(parseMaxRecords("")).toBe(0);
    expect(parseMaxRecords("abc")).toBe(0);
    expect(parseMaxRecords("-5")).toBe(0);
  });

  it("合法档位原样保留", () => {
    expect(parseMaxRecords("500")).toBe(500);
    expect(parseMaxRecords("10000")).toBe(10000);
  });
});

const baseChannel = {
  id: "ch-1",
  name: "鬼鬼",
  protocol: "openai" as const,
  baseUrl: "https://relay.example.com",
  apiKeyPreview: "sk-…",
  apiKeySet: true,
  model: "gpt-image-2",
  price: 0.07,
  currency: "$",
  enabled: true,
  status: "normal" as const,
  lastError: "",
  lastLatencyMs: null,
  lastTestedAt: "",
  cooldownUntilMs: 0,
  sortOrder: 0,
  proxy: "",
};

describe("testAiChannel 结果回写", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    useSettingsStore.setState({ aiChannels: [{ ...baseChannel }] });
  });

  it("命令级失败写入 lastError 供行首红点展示，不动延迟与测试时间", async () => {
    invokeMock.mockRejectedValue("Command ai_test_channel not found");

    const result = await useSettingsStore.getState().testAiChannel("ch-1");

    expect(result).toEqual({ ok: false, error: "Command ai_test_channel not found" });
    const channel = useSettingsStore.getState().aiChannels.find((c) => c.id === "ch-1");
    expect(channel?.lastError).toBe("Command ai_test_channel not found");
    expect(channel?.lastLatencyMs).toBeNull();
    expect(channel?.lastTestedAt).toBe("");
    expect(channel?.status).toBe("normal");
  });

  it("成功回写延迟与测试时间并清掉旧错误", async () => {
    invokeMock.mockResolvedValue({ ok: true, latencyMs: 888 });
    useSettingsStore.setState({
      aiChannels: [{ ...baseChannel, lastError: "旧错误" }],
    });

    const result = await useSettingsStore.getState().testAiChannel("ch-1");

    expect(result).toEqual({ ok: true, latencyMs: 888 });
    const channel = useSettingsStore.getState().aiChannels.find((c) => c.id === "ch-1");
    expect(channel?.lastLatencyMs).toBe(888);
    expect(channel?.lastTestedAt).not.toBe("");
    expect(channel?.lastError).toBe("");
    expect(channel?.status).toBe("normal");
  });

  it("HTTP 失败写入错误信息，延迟与测试时间保持原值", async () => {
    invokeMock.mockResolvedValue({ ok: false, error: "余额不足" });
    useSettingsStore.setState({
      aiChannels: [{ ...baseChannel, lastLatencyMs: 500, lastTestedAt: "2026-01-01T00:00:00.000Z" }],
    });

    const result = await useSettingsStore.getState().testAiChannel("ch-1");

    expect(result).toEqual({ ok: false, error: "余额不足" });
    const channel = useSettingsStore.getState().aiChannels.find((c) => c.id === "ch-1");
    expect(channel?.lastError).toBe("余额不足");
    expect(channel?.lastLatencyMs).toBe(500);
    expect(channel?.lastTestedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("restoreAiChannel 手动恢复", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("清自动停用/错误文案/限流冷却，不动启用开关与测速记录", async () => {
    useSettingsStore.setState({
      aiChannels: [
        {
          ...baseChannel,
          enabled: true,
          status: "auto_disabled" as const,
          lastError: "认证失败",
          cooldownUntilMs: Date.now() + 300_000,
          lastLatencyMs: 888,
          lastTestedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    await useSettingsStore.getState().restoreAiChannel("ch-1");

    expect(invokeMock).toHaveBeenCalledWith("restore_ai_channel", { id: "ch-1" });
    const channel = useSettingsStore.getState().aiChannels.find((c) => c.id === "ch-1");
    expect(channel?.status).toBe("normal");
    expect(channel?.lastError).toBe("");
    expect(channel?.cooldownUntilMs).toBe(0);
    expect(channel?.enabled).toBe(true);
    expect(channel?.lastLatencyMs).toBe(888);
  });

  it("命令级失败回滚重载（不留在乐观态）", async () => {
    // 仅恢复命令失败；随后 loadAiChannels 的 list_ai_channels 正常返回
    // 服务端状态（乐观态被回读覆盖）。
    invokeMock.mockRejectedValueOnce("Command restore_ai_channel not found");
    invokeMock.mockResolvedValue([{ ...baseChannel, lastError: "认证失败" }]);
    useSettingsStore.setState({
      aiChannels: [{ ...baseChannel, status: "auto_disabled" as const, lastError: "认证失败" }],
    });

    await useSettingsStore.getState().restoreAiChannel("ch-1");

    expect(invokeMock).toHaveBeenCalledWith("restore_ai_channel", { id: "ch-1" });
    expect(invokeMock).toHaveBeenCalledWith("list_ai_channels");
    const channel = useSettingsStore.getState().aiChannels.find((c) => c.id === "ch-1");
    expect(channel?.status).toBe("normal");
    // 服务端 lastError 仍在 → 回滚生效（乐观清空被回读覆盖）
    expect(channel?.lastError).toBe("认证失败");
  });
});

describe("渠道代理字段透传", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([{ ...baseChannel, proxy: "http://127.0.0.1:7890" }]);
  });

  it("createAiChannel 把 proxy 原样传给命令，返回列表回填 state", async () => {
    await useSettingsStore.getState().createAiChannel({
      name: "官方",
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-new",
      model: "gpt-image-1",
      price: null,
      currency: "$",
      proxy: "http://127.0.0.1:7890",
    });

    expect(invokeMock).toHaveBeenCalledWith("create_ai_channel", {
      name: "官方",
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-new",
      model: "gpt-image-1",
      price: null,
      currency: "$",
      proxy: "http://127.0.0.1:7890",
    });
    expect(useSettingsStore.getState().aiChannels[0]?.proxy).toBe("http://127.0.0.1:7890");
  });

  it("updateAiChannel 空串 = 清除渠道级代理（回退全局默认）", async () => {
    invokeMock.mockResolvedValue([{ ...baseChannel, proxy: "" }]);
    useSettingsStore.setState({ aiChannels: [{ ...baseChannel, proxy: "http://old:1" }] });

    await useSettingsStore.getState().updateAiChannel("ch-1", {
      name: baseChannel.name,
      protocol: "openai",
      baseUrl: baseChannel.baseUrl,
      apiKey: null,
      model: baseChannel.model,
      price: 0.07,
      currency: "$",
      proxy: "",
    });

    expect(invokeMock).toHaveBeenCalledWith("update_ai_channel", expect.objectContaining({ id: "ch-1", proxy: "" }));
    expect(useSettingsStore.getState().aiChannels[0]?.proxy).toBe("");
  });

  it("saveAiSettings 以 ai_proxy 键走 set_settings_batch 并同步本地", async () => {
    invokeMock.mockResolvedValue(undefined);

    await useSettingsStore.getState().saveAiSettings({ aiProxy: "socks5://127.0.0.1:7891" });

    expect(invokeMock).toHaveBeenCalledWith("set_settings_batch", {
      settings: { ai_proxy: "socks5://127.0.0.1:7891" },
    });
    expect(useSettingsStore.getState().aiProxy).toBe("socks5://127.0.0.1:7891");
  });
});
