// 工程域 store（AI 视频制作）：资源页工程视图的剧/集状态与 CRUD 对接。
// 后端实体与命令见 src-tauri/src/db/project.rs；view 与选中项持久化到
// localStorage，重开窗口回到上次的视图与位置。
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type ResourceViewMode = "file" | "project";

export type ProjectEpisodeStatus = "none" | "script" | "storyboard" | "generating" | "done";

export interface ProjectShow {
  id: string;
  name: string;
  note: string;
  episode_count: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectEpisode {
  id: string;
  show_id: string;
  number: number;
  title: string;
  status: ProjectEpisodeStatus;
  script_path: string;
  character_ids: string[];
  shot_count: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectCharacter {
  id: string;
  name: string;
  role_tag: string;
  bio: string;
  prompt: string;
  avatar_path: string;
  episode_ref_count?: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectLocation {
  id: string;
  name: string;
  int_ext: string;
  time_hint: string;
  bio: string;
  prompt: string;
  ref_path: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectProp {
  id: string;
  name: string;
  bio: string;
  prompt: string;
  ref_path: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectAsset {
  id: string;
  file_path: string;
  kind: string;
  name: string;
  shot_id: string;
  episode_id: string;
  gen_from_asset: string;
  gen_from_prompt: string;
  created_at: string;
  updated_at: string;
}

export interface EpisodeOverview {
  episode: ProjectEpisode;
  characters: ProjectCharacter[];
  scenes: Array<Record<string, unknown>>;
  loose_assets: ProjectAsset[];
}

interface ProjectStoreState {
  view: ResourceViewMode;
  shows: ProjectShow[];
  showsLoading: boolean;
  currentShowId: string | null;
  episodes: ProjectEpisode[];
  currentEpisodeId: string | null;
  overview: EpisodeOverview | null;
  overviewLoading: boolean;
  characters: ProjectCharacter[];
  locations: ProjectLocation[];
  props: ProjectProp[];

  setView: (view: ResourceViewMode) => void;
  loadShows: () => Promise<void>;
  selectShow: (showId: string) => Promise<void>;
  createShow: (name: string) => Promise<ProjectShow | null>;
  renameShow: (id: string, name: string) => Promise<void>;
  deleteShow: (id: string) => Promise<void>;
  createEpisode: (showId: string, title: string) => Promise<ProjectEpisode | null>;
  updateEpisode: (
    id: string,
    patch: { title: string; status: ProjectEpisodeStatus; script_path: string },
  ) => Promise<void>;
  deleteEpisode: (id: string) => Promise<void>;
  selectEpisode: (episodeId: string) => Promise<void>;
  /** 后端 project-changed 事件后的整体重取：保持当前选中位置不变。 */
  refresh: () => Promise<void>;

  loadCharacters: () => Promise<void>;
  saveCharacter: (
    payload: { id?: string; name: string; role_tag: string; bio: string; prompt: string; avatar_path: string },
  ) => Promise<boolean>;
  deleteCharacter: (id: string) => Promise<void>;

  loadLocations: () => Promise<void>;
  saveLocation: (
    payload: { id?: string; name: string; int_ext: string; time_hint: string; bio: string; prompt: string; ref_path: string },
  ) => Promise<boolean>;
  deleteLocation: (id: string) => Promise<void>;

  loadProps: () => Promise<void>;
  saveProp: (
    payload: { id?: string; name: string; bio: string; prompt: string; ref_path: string },
  ) => Promise<boolean>;
  deleteProp: (id: string) => Promise<void>;

  /** 集关联角色：整组替换（后端 delete + 批量插入），随后刷新概览。 */
  setEpisodeCharacters: (episodeId: string, characterIds: string[]) => Promise<void>;
}

const VIEW_STORAGE_KEY = "resource_view_mode";
const SHOW_STORAGE_KEY = "project_current_show";
const EPISODE_STORAGE_KEY = "project_current_episode";

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式等存储不可用场景：仅退化为不记忆，不影响功能。
  }
}

function initialView(): ResourceViewMode {
  return readStored(VIEW_STORAGE_KEY) === "project" ? "project" : "file";
}

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  view: initialView(),
  shows: [],
  showsLoading: false,
  currentShowId: null,
  episodes: [],
  currentEpisodeId: null,
  overview: null,
  overviewLoading: false,
  characters: [],
  locations: [],
  props: [],

  setView: (view) => {
    writeStored(VIEW_STORAGE_KEY, view);
    set({ view });
  },

  loadShows: async () => {
    set({ showsLoading: true });
    try {
      const shows = await invoke<ProjectShow[]>("project_list_shows");
      const storedShow = readStored(SHOW_STORAGE_KEY);
      const currentShowId =
        shows.some((show) => show.id === storedShow) || (storedShow === null && shows.length > 0)
          ? storedShow ?? shows[0].id
          : (shows[0]?.id ?? null);
      set({ shows, currentShowId });
      if (currentShowId) {
        await get().selectShow(currentShowId);
      } else {
        set({ episodes: [], currentEpisodeId: null, overview: null });
      }
    } catch (error) {
      console.error("project_list_shows failed:", error);
      set({ shows: [], currentShowId: null, episodes: [], currentEpisodeId: null, overview: null });
    } finally {
      set({ showsLoading: false });
    }
  },

  selectShow: async (showId) => {
    set({ currentShowId: showId, episodes: [], currentEpisodeId: null, overview: null });
    writeStored(SHOW_STORAGE_KEY, showId);
    try {
      const episodes = await invoke<ProjectEpisode[]>("project_list_episodes", { showId });
      const storedEpisode = readStored(EPISODE_STORAGE_KEY);
      const currentEpisodeId = episodes.some((e) => e.id === storedEpisode)
        ? storedEpisode
        : (episodes[0]?.id ?? null);
      set({ episodes, currentEpisodeId });
      writeStored(EPISODE_STORAGE_KEY, currentEpisodeId);
      if (currentEpisodeId) {
        await get().selectEpisode(currentEpisodeId);
      }
    } catch (error) {
      console.error("project_list_episodes failed:", error);
      set({ episodes: [], currentEpisodeId: null });
    }
  },

  createShow: async (name) => {
    try {
      const created = await invoke<ProjectShow>("project_create_show", { name });
      await get().refresh();
      return created;
    } catch (error) {
      console.error("project_create_show failed:", error);
      return null;
    }
  },

  renameShow: async (id, name) => {
    try {
      await invoke("project_rename_show", { id, name });
      await get().refresh();
    } catch (error) {
      console.error("project_rename_show failed:", error);
    }
  },

  deleteShow: async (id) => {
    try {
      await invoke("project_delete_show", { id });
      const wasCurrent = get().currentShowId === id;
      await get().loadShows();
      if (!wasCurrent) {
        // 删除非当前剧无需切位；loadShows 已按存储的选中恢复。
        return;
      }
      writeStored(SHOW_STORAGE_KEY, get().currentShowId);
      writeStored(EPISODE_STORAGE_KEY, get().currentEpisodeId);
    } catch (error) {
      console.error("project_delete_show failed:", error);
    }
  },

  createEpisode: async (showId, title) => {
    try {
      const created = await invoke<ProjectEpisode>("project_create_episode", { showId, title });
      const episodes = await invoke<ProjectEpisode[]>("project_list_episodes", { showId });
      set({ episodes, currentEpisodeId: created.id });
      writeStored(EPISODE_STORAGE_KEY, created.id);
      await get().selectEpisode(created.id);
      return created;
    } catch (error) {
      console.error("project_create_episode failed:", error);
      return null;
    }
  },

  updateEpisode: async (id, patch) => {
    try {
      await invoke("project_update_episode", {
        id,
        title: patch.title,
        status: patch.status,
        scriptPath: patch.script_path,
      });
      await get().refresh();
    } catch (error) {
      console.error("project_update_episode failed:", error);
    }
  },

  deleteEpisode: async (id) => {
    try {
      await invoke("project_delete_episode", { id });
      await get().refresh();
    } catch (error) {
      console.error("project_delete_episode failed:", error);
    }
  },

  selectEpisode: async (episodeId) => {
    set({ currentEpisodeId: episodeId, overview: null, overviewLoading: true });
    writeStored(EPISODE_STORAGE_KEY, episodeId);
    try {
      const overview = await invoke<EpisodeOverview>("project_get_episode_overview", {
        episodeId,
      });
      // 请求期间可能已切走：以最新选中为准，避免旧数据闪现。
      if (get().currentEpisodeId !== episodeId) return;
      set({ overview, overviewLoading: false });
    } catch (error) {
      if (get().currentEpisodeId !== episodeId) return;
      console.error("project_get_episode_overview failed:", error);
      set({ overview: null, overviewLoading: false });
    }
  },

  refresh: async () => {
    const { currentShowId, currentEpisodeId, view } = get();
    // 文件视图下没有工程数据在屏，等切到工程视图时 loadShows 全量取。
    if (view !== "project") return;
    try {
      const shows = await invoke<ProjectShow[]>("project_list_shows");
      const nextShowId = shows.some((s) => s.id === currentShowId)
        ? currentShowId
        : (shows[0]?.id ?? null);
      set({ shows, currentShowId: nextShowId });
      writeStored(SHOW_STORAGE_KEY, nextShowId);
      if (!nextShowId) {
        set({ episodes: [], currentEpisodeId: null, overview: null });
        return;
      }
      const episodes = nextShowId === currentShowId
        ? await invoke<ProjectEpisode[]>("project_list_episodes", { showId: nextShowId })
        : [];
      const nextEpisodeId = episodes.some((e) => e.id === currentEpisodeId)
        ? currentEpisodeId
        : (episodes[0]?.id ?? null);
      // 换剧时走 selectShow 的完整恢复（含存储回写）；同剧则仅刷新集列表
      // 与概览，保住当前选中。
      if (nextShowId !== currentShowId) {
        await get().selectShow(nextShowId);
        return;
      }
      set({ episodes, currentEpisodeId: nextEpisodeId });
      writeStored(EPISODE_STORAGE_KEY, nextEpisodeId);
      if (nextEpisodeId) await get().selectEpisode(nextEpisodeId);
      else set({ overview: null });
    } catch (error) {
      console.error("project refresh failed:", error);
    }
  },

  // ── 全局三库 ─────────────────────────────────────────────
  // 列表按需拉取（面板打开/关联时），project-changed 事件经 refresh 只
  // 刷新剧集侧；三库列表的即时一致性由保存/删除后本域重拉保证。

  loadCharacters: async () => {
    try {
      set({ characters: await invoke<ProjectCharacter[]>("project_list_characters") });
    } catch (error) {
      console.error("project_list_characters failed:", error);
    }
  },

  saveCharacter: async (payload) => {
    // Tauri 参数自动 camelCase 化：role_tag/... → roleTag/...。
    const args = {
      name: payload.name,
      roleTag: payload.role_tag,
      bio: payload.bio,
      prompt: payload.prompt,
      avatarPath: payload.avatar_path,
    };
    try {
      if (payload.id) {
        await invoke("project_update_character", { id: payload.id, ...args });
      } else {
        await invoke("project_create_character", args);
      }
      await get().loadCharacters();
      // 人设与形象图的改动会体现在集概览的出场角色行里。
      const { currentEpisodeId } = get();
      if (currentEpisodeId) await get().selectEpisode(currentEpisodeId);
      return true;
    } catch (error) {
      console.error("save character failed:", error);
      return false;
    }
  },

  deleteCharacter: async (id) => {
    try {
      await invoke("project_delete_character", { id });
      await get().loadCharacters();
      const { currentEpisodeId } = get();
      if (currentEpisodeId) await get().selectEpisode(currentEpisodeId);
    } catch (error) {
      console.error("project_delete_character failed:", error);
    }
  },

  loadLocations: async () => {
    try {
      set({ locations: await invoke<ProjectLocation[]>("project_list_locations") });
    } catch (error) {
      console.error("project_list_locations failed:", error);
    }
  },

  saveLocation: async (payload) => {
    const args = {
      name: payload.name,
      intExt: payload.int_ext,
      timeHint: payload.time_hint,
      bio: payload.bio,
      prompt: payload.prompt,
      refPath: payload.ref_path,
    };
    try {
      if (payload.id) {
        await invoke("project_update_location", { id: payload.id, ...args });
      } else {
        await invoke("project_create_location", args);
      }
      await get().loadLocations();
      return true;
    } catch (error) {
      console.error("save location failed:", error);
      return false;
    }
  },

  deleteLocation: async (id) => {
    try {
      await invoke("project_delete_location", { id });
      await get().loadLocations();
    } catch (error) {
      console.error("project_delete_location failed:", error);
    }
  },

  loadProps: async () => {
    try {
      set({ props: await invoke<ProjectProp[]>("project_list_props") });
    } catch (error) {
      console.error("project_list_props failed:", error);
    }
  },

  saveProp: async (payload) => {
    const args = {
      name: payload.name,
      bio: payload.bio,
      prompt: payload.prompt,
      refPath: payload.ref_path,
    };
    try {
      if (payload.id) {
        await invoke("project_update_prop", { id: payload.id, ...args });
      } else {
        await invoke("project_create_prop", args);
      }
      await get().loadProps();
      return true;
    } catch (error) {
      console.error("save prop failed:", error);
      return false;
    }
  },

  deleteProp: async (id) => {
    try {
      await invoke("project_delete_prop", { id });
      await get().loadProps();
    } catch (error) {
      console.error("project_delete_prop failed:", error);
    }
  },

  setEpisodeCharacters: async (episodeId, characterIds) => {
    try {
      await invoke("project_set_episode_characters", { episodeId, characterIds });
      // 保存后概览重取即拿到最新出场角色与统计。
      await get().selectEpisode(episodeId);
      await get().loadCharacters();
    } catch (error) {
      console.error("project_set_episode_characters failed:", error);
    }
  },
}));
