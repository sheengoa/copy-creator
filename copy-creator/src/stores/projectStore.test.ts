// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const { useProjectStore } = await import("./projectStore");

const showA = {
  id: "show-a",
  name: "山海食肆",
  note: "",
  episode_count: 2,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const episode1 = {
  id: "ep-1",
  show_id: "show-a",
  number: 1,
  title: "开业大吉",
  status: "done",
  script_path: "山海食肆/01_开业大吉.md",
  character_ids: [],
  shot_count: 4,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const episode2 = {
  ...episode1,
  id: "ep-2",
  number: 2,
  title: "灶王令失踪",
  status: "storyboard",
};

function resetStore() {
  useProjectStore.setState({
    view: "file",
    shows: [],
    showsLoading: false,
    currentShowId: null,
    episodes: [],
    currentEpisodeId: null,
    overview: null,
    overviewLoading: false,
  });
  window.localStorage.clear();
}

describe("projectStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetStore();
  });

  it("loadShows 恢复存储的选中剧并选中第一集", async () => {
    window.localStorage.setItem("project_current_show", "show-a");
    invokeMock.mockImplementation((command: string) => {
      if (command === "project_list_shows") return Promise.resolve([showA]);
      if (command === "project_list_episodes") return Promise.resolve([episode1, episode2]);
      if (command === "project_get_episode_overview") return Promise.resolve({ episode: episode1 });
      return Promise.resolve([]);
    });

    await useProjectStore.getState().loadShows();

    expect(useProjectStore.getState().currentShowId).toBe("show-a");
    expect(useProjectStore.getState().currentEpisodeId).toBe("ep-1");
    expect(invokeMock).toHaveBeenCalledWith("project_list_episodes", { showId: "show-a" });
  });

  it("存储的剧已不存在时回退到第一部", async () => {
    window.localStorage.setItem("project_current_show", "deleted-show");
    invokeMock.mockImplementation((command: string) => {
      if (command === "project_list_shows") return Promise.resolve([showA]);
      if (command === "project_list_episodes") return Promise.resolve([episode1]);
      if (command === "project_get_episode_overview") return Promise.resolve({ episode: episode1 });
      return Promise.resolve([]);
    });

    await useProjectStore.getState().loadShows();

    expect(useProjectStore.getState().currentShowId).toBe("show-a");
  });

  it("createShow 走 project_create_show 并带空名拦截在后端", async () => {
    invokeMock.mockResolvedValue(showA);
    const created = await useProjectStore.getState().createShow("新剧");

    expect(invokeMock).toHaveBeenCalledWith("project_create_show", { name: "新剧" });
    expect(created?.id).toBe("show-a");
  });

  it("updateEpisode 以 camelCase 参数路由 script_path", async () => {
    invokeMock.mockResolvedValue(undefined);
    await useProjectStore.getState().updateEpisode("ep-2", {
      title: "灶王令失踪",
      status: "generating",
      script_path: "山海食肆/02.md",
    });

    expect(invokeMock).toHaveBeenCalledWith("project_update_episode", {
      id: "ep-2",
      title: "灶王令失踪",
      status: "generating",
      scriptPath: "山海食肆/02.md",
    });
  });

  it("selectEpisode 的迟到响应不覆盖新选中（防旧数据闪现）", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    invokeMock.mockImplementation((command: string) => {
      if (command === "project_get_episode_overview") {
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      }
      return Promise.resolve([]);
    });

    const first = useProjectStore.getState().selectEpisode("ep-1");
    const second = useProjectStore.getState().selectEpisode("ep-2");
    // 新请求先返回并落位；旧请求的迟到响应随后到达。
    resolvers[1]({ episode: episode2 });
    resolvers[0]({ episode: episode1 });
    await Promise.all([first, second]);

    expect(useProjectStore.getState().overview?.episode.id).toBe("ep-2");
    expect(useProjectStore.getState().currentEpisodeId).toBe("ep-2");
  });

  it("setView 持久化到 localStorage", () => {
    useProjectStore.getState().setView("project");
    expect(window.localStorage.getItem("resource_view_mode")).toBe("project");
    expect(useProjectStore.getState().view).toBe("project");
  });

  it("文件视图下 refresh 不触发任何后端调用", async () => {
    useProjectStore.setState({ view: "file", currentShowId: "show-a" });
    await useProjectStore.getState().refresh();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
