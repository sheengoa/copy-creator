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

export interface ProjectShot {
  id: string;
  scene_id: string;
  episode_id: string;
  description: string;
  dialogue: string;
  character_ids: string[];
  prop_ids: string[];
  assets: ProjectAsset[];
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectScene {
  id: string;
  episode_id: string;
  location_id: string;
  heading: string;
  note: string;
  shot_count: number;
  location: ProjectLocation | null;
  shots: ProjectShot[];
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectPrompt {
  id: string;
  title: string;
  content: string;
  category: string;
  file_path: string;
  created_at: string;
  updated_at: string;
}

export interface EpisodeOverview {
  episode: ProjectEpisode;
  characters: ProjectCharacter[];
  scenes: ProjectScene[];
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
  prompts: ProjectPrompt[];
  locateRequest: { path: string; token: number } | null;

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

  saveScene: (payload: {
    id?: string;
    episodeId: string;
    heading: string;
    locationId: string;
    note: string;
  }) => Promise<boolean>;
  deleteScene: (id: string) => Promise<void>;
  saveShot: (payload: {
    id?: string;
    sceneId: string;
    description: string;
    dialogue: string;
  }) => Promise<boolean>;
  deleteShot: (id: string) => Promise<void>;
  /** 镜头出镜角色 / 道具：整组替换。 */
  setShotCharacters: (shotId: string, characterIds: string[]) => Promise<void>;
  setShotProps: (shotId: string, propIds: string[]) => Promise<void>;

  /** 把资源库文件挂进工程（集级散件或指定镜头）；同文件重复挂靠改写
   *  归属。filePath 为相对库根路径。 */
  linkAsset: (payload: {
    filePath: string;
    kind: string;
    name: string;
    episodeId: string;
    shotId: string;
  }) => Promise<ProjectAsset | null>;
  /** 摘除工程档案（仅删记录，文件不动）。 */
  unlinkAsset: (id: string) => Promise<void>;
  /** 更新素材档案（溯源链与归属调整）。 */
  updateAsset: (payload: {
    id: string;
    kind: string;
    name: string;
    episodeId: string;
    shotId: string;
    genFromAsset: string;
    genFromPrompt: string;
  }) => Promise<void>;

  loadPrompts: (category?: string) => Promise<void>;
  savePrompt: (payload: {
    id?: string;
    title: string;
    content: string;
    category: string;
  }) => Promise<boolean>;
  deletePrompt: (id: string) => Promise<void>;

  /** 跨视图定位请求：工程侧要求切到文件视图并选中 path 首段分组。 */
  locateInFileView: (relativePath: string) => void;
  /** 文件视图消费定位请求后清除（token 递增保证同路径重复定位也生效）。 */
  consumeLocateRequest: () => { path: string; token: number } | null;
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
  prompts: [],
  locateRequest: null,

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

  // ── 场景与镜头 ───────────────────────────────────────────
  // 概览（scenes 含 shots）是唯一数据源，CRUD 后重取当前集保持一致。

  saveScene: async (payload) => {
    const args = { heading: payload.heading, locationId: payload.locationId, note: payload.note };
    try {
      if (payload.id) {
        await invoke("project_update_scene", { id: payload.id, ...args });
      } else {
        await invoke("project_create_scene", { episodeId: payload.episodeId, ...args });
      }
      const { currentEpisodeId } = get();
      if (currentEpisodeId) await get().selectEpisode(currentEpisodeId);
      return true;
    } catch (error) {
      console.error("save scene failed:", error);
      return false;
    }
  },

  deleteScene: async (id) => {
    try {
      await invoke("project_delete_scene", { id });
      const { currentEpisodeId } = get();
      if (currentEpisodeId) await get().selectEpisode(currentEpisodeId);
    } catch (error) {
      console.error("project_delete_scene failed:", error);
    }
  },

  saveShot: async (payload) => {
    try {
      if (payload.id) {
        await invoke("project_update_shot", {
          id: payload.id,
          description: payload.description,
          dialogue: payload.dialogue,
        });
      } else {
        await invoke("project_create_shot", {
          sceneId: payload.sceneId,
          description: payload.description,
          dialogue: payload.dialogue,
        });
      }
      const { currentEpisodeId } = get();
      if (currentEpisodeId) await get().selectEpisode(currentEpisodeId);
      return true;
    } catch (error) {
      console.error("save shot failed:", error);
      return false;
    }
  },

  deleteShot: async (id) => {
    try {
      await invoke("project_delete_shot", { id });
      const { currentEpisodeId } = get();
      if (currentEpisodeId) await get().selectEpisode(currentEpisodeId);
    } catch (error) {
      console.error("project_delete_shot failed:", error);
    }
  },

  setShotCharacters: async (shotId, characterIds) => {
    try {
      await invoke("project_set_shot_characters", { shotId, characterIds });
      const { currentEpisodeId } = get();
      if (currentEpisodeId) await get().selectEpisode(currentEpisodeId);
    } catch (error) {
      console.error("project_set_shot_characters failed:", error);
    }
  },

  setShotProps: async (shotId, propIds) => {
    try {
      await invoke("project_set_shot_props", { shotId, propIds });
      const { currentEpisodeId } = get();
      if (currentEpisodeId) await get().selectEpisode(currentEpisodeId);
    } catch (error) {
      console.error("project_set_shot_props failed:", error);
    }
  },

  linkAsset: async (payload) => {
    try {
      const asset = await invoke<ProjectAsset>("project_link_asset", {
        filePath: payload.filePath,
        kind: payload.kind,
        name: payload.name,
        episodeId: payload.episodeId,
        shotId: payload.shotId,
      });
      const { currentEpisodeId } = get();
      if (currentEpisodeId) await get().selectEpisode(currentEpisodeId);
      return asset;
    } catch (error) {
      console.error("project_link_asset failed:", error);
      return null;
    }
  },

  unlinkAsset: async (id) => {
    try {
      await invoke("project_unlink_asset", { id });
      const { currentEpisodeId } = get();
      if (currentEpisodeId) await get().selectEpisode(currentEpisodeId);
    } catch (error) {
      console.error("project_unlink_asset failed:", error);
    }
  },

  updateAsset: async (payload) => {
    try {
      await invoke("project_update_asset", {
        id: payload.id,
        kind: payload.kind,
        name: payload.name,
        episodeId: payload.episodeId,
        shotId: payload.shotId,
        genFromAsset: payload.genFromAsset,
        genFromPrompt: payload.genFromPrompt,
      });
      const { currentEpisodeId } = get();
      if (currentEpisodeId) await get().selectEpisode(currentEpisodeId);
    } catch (error) {
      console.error("project_update_asset failed:", error);
    }
  },

  loadPrompts: async (category) => {
    try {
      const args = category && category.trim() ? { category: category.trim() } : undefined;
      set({ prompts: await invoke<ProjectPrompt[]>("project_list_prompts", args) });
    } catch (error) {
      console.error("project_list_prompts failed:", error);
    }
  },

  savePrompt: async (payload) => {
    const args = { title: payload.title, content: payload.content, category: payload.category };
    try {
      if (payload.id) {
        await invoke("project_update_prompt", { id: payload.id, ...args });
      } else {
        await invoke("project_create_prompt", args);
      }
      await get().loadPrompts();
      return true;
    } catch (error) {
      console.error("save prompt failed:", error);
      return false;
    }
  },

  deletePrompt: async (id) => {
    try {
      await invoke("project_delete_prompt", { id });
      await get().loadPrompts();
    } catch (error) {
      console.error("project_delete_prompt failed:", error);
    }
  },

  locateInFileView: (relativePath) => {
    const { locateRequest } = get();
    set({
      view: "file",
      locateRequest: { path: relativePath, token: (locateRequest?.token ?? 0) + 1 },
    });
    writeStored(VIEW_STORAGE_KEY, "file");
  },

  consumeLocateRequest: () => {
    const { locateRequest } = get();
    if (!locateRequest) return null;
    set({ locateRequest: null });
    return locateRequest;
  },
}));
