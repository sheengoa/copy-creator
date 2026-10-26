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
  location_ids: string[];
  prop_ids: string[];
  shot_count: number;
  done_shot_count: number;
  created_at: string;
  updated_at: string;
  /** 本集成片输出来源：素材 id 或 "shot:<id>"；null = 尚未连接。 */
  output_asset_id: string | null;
}

export interface ProjectCharacter {
  id: string;
  name: string;
  role_tag: string;
  bio: string;
  prompt: string;
  avatar_path: string;
  reference_paths: string;
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
  gen_params: string;
  audio_role: string;
  /** 文件是否已不在当前资源库根下（overview 命令逐档案检测）。 */
  missing: boolean;
  /** 工程画布摆放坐标（世界像素；null = 未摆放过，画布自动布局）。 */
  canvas_x: number | null;
  canvas_y: number | null;
  canvas_w: number | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectShot {
  id: string;
  scene_id: string;
  episode_id: string;
  description: string;
  dialogue: string;
  status: string;
  camera: string;
  duration: string;
  character_ids: string[];
  prop_ids: string[];
  assets: ProjectAsset[];
  /** 画布上空镜头卡坐标（有素材的镜头以素材节点上的标签表达归属）。 */
  canvas_x: number | null;
  canvas_y: number | null;
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
  /** 画布分组框位置（世界像素；尺寸由成员包围盒动态推导）。 */
  canvas_x: number | null;
  canvas_y: number | null;
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

/** 工程侧可打开的全局面板（三库 + 提示词库）。 */
export type ProjectPanelKind = "characters" | "locations" | "props" | "prompts";

export interface ProjectLibraryPanelState {
  kind: ProjectPanelKind;
  mode: "browse" | "pick";
}

export interface ProjectSearchItem {
  kind: "show" | "episode" | "character" | "location" | "prop" | "prompt";
  id: string;
  title: string | null;
  show_id?: string | null;
  content?: string | null;
}

/** 工程画布的手动工作流连线（生成链由 gen_from_asset 推导，不入库）。 */
export interface ProjectAssetLink {
  id: string;
  from_asset: string;
  to_asset: string;
  label: string;
}

/** 片段（AI 分段生成的视频分段），按 sort_order 拼接成本集成片。 */
export interface ProjectSegment {
  id: string;
  episode_id: string;
  asset_id: string | null;
  sort_order: number;
  note: string;
  canvas_x: number | null;
  canvas_y: number | null;
  created_at: string;
  updated_at: string;
  /** 产出视频素材整对象（后端带出，未挂产出时缺省）。 */
  asset?: ProjectAsset & { missing?: boolean };
}

/** 片段输入口连线：来源跨库资料/剧本/素材/另一片段/镜头。 */
export interface ProjectNodeLink {
  id: string;
  from_kind: "asset" | "character" | "location" | "prop" | "script" | "segment" | "shot";
  from_id: string;
  to_segment: string;
  to_port: "character" | "location" | "prop" | "script" | "other";
}

export interface EpisodeOverview {
  episode: ProjectEpisode;
  characters: ProjectCharacter[];
  locations: ProjectLocation[];
  props: ProjectProp[];
  scenes: ProjectScene[];
  loose_assets: ProjectAsset[];
  links: ProjectAssetLink[];
  segments: ProjectSegment[];
  node_links: ProjectNodeLink[];
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
  libraryPanel: ProjectLibraryPanelState | null;
  searchResults: ProjectSearchItem[];
  searchLoading: boolean;

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
  /** 树内上下移动集：本地换位 + 后端全量顺序回写。 */
  moveEpisode: (episodeId: string, direction: -1 | 1) => Promise<void>;
  /** 修改集号（1-999，同剧内唯一；冲突报错返回 false）。 */
  updateEpisodeNumber: (id: string, number: number) => Promise<boolean>;
  selectEpisode: (episodeId: string) => Promise<void>;
  /** 后端 project-changed 事件后的整体重取：保持当前选中位置不变。 */
  refresh: () => Promise<void>;

  loadCharacters: () => Promise<void>;
  saveCharacter: (
    payload: { id?: string; name: string; role_tag: string; bio: string; prompt: string; avatar_path: string; reference_paths: string },
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
  moveScene: (sceneId: string, direction: -1 | 1) => Promise<void>;
  saveShot: (payload: {
    id?: string;
    sceneId: string;
    description: string;
    dialogue: string;
    status: string;
    camera: string;
    duration: string;
  }) => Promise<boolean>;
  deleteShot: (id: string) => Promise<void>;
  moveShot: (shotId: string, direction: -1 | 1) => Promise<void>;
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
  /** 库外文件导入并挂靠：后端复制进库根「未分组」→ 登记资源记录 →
   *  落工程档案。错误不吞（选择器负责展示），用户取消以外都应可见。 */
  importAsset: (payload: {
    sourcePath: string;
    episodeId: string;
    shotId: string;
  }) => Promise<ProjectAsset>;
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
    genParams: string;
    audioRole: string;
  }) => Promise<void>;

  /** 批量保存画布布局（素材/镜头/场景坐标）：本地即时更新 + 静默落库，
   *  不触发 overview 重取（拖拽结束才调用，画布自身是事实来源）。 */
  saveCanvasLayout: (payload: {
    assets: { id: string; x: number | null; y: number | null; w: number | null }[];
    shots: { id: string; x: number | null; y: number | null }[];
    scenes: { id: string; x: number | null; y: number | null }[];
    segments?: { id: string; x: number | null; y: number | null }[];
  }) => Promise<void>;
  /** 手动连出工作流参考线（重复幂等）；成功后本地追加并返回连线。 */
  linkAssets: (fromAsset: string, toAsset: string, label?: string) => Promise<ProjectAssetLink | null>;
  /** 摘除一条手动连线（按两端素材，方向不限）。 */
  unlinkAssets: (fromAsset: string, toAsset: string) => Promise<void>;
  /** 设置本集成片输出来源（素材 id 或 "shot:<id>"；null 清除）。 */
  setEpisodeOutput: (episodeId: string, outputAssetId: string | null) => Promise<void>;
  /** 本集出场场景关联（整组替换）。 */
  setEpisodeLocations: (episodeId: string, locationIds: string[]) => Promise<void>;
  /** 本集出场道具关联（整组替换；与镜头挂靠按并集并存）。 */
  setEpisodeProps: (episodeId: string, propIds: string[]) => Promise<void>;
  /** 新建空片段（排到拼接序末尾），失败返回 null。 */
  addSegment: (episodeId: string) => Promise<ProjectSegment | null>;
  removeSegment: (id: string) => Promise<void>;
  moveSegment: (id: string, direction: -1 | 1) => Promise<void>;
  /** 挂靠/清除片段产出视频。 */
  setSegmentAsset: (id: string, assetId: string | null) => Promise<void>;
  /** 片段输入口连线（幂等）：本地即时追加 + 落库。 */
  linkNode: (
    episodeId: string,
    fromKind: ProjectNodeLink["from_kind"],
    fromId: string,
    toSegment: string,
    toPort: ProjectNodeLink["to_port"],
  ) => Promise<void>;
  /** 摘除片段输入口连线：本地即时过滤 + 落库。 */
  unlinkNode: (
    fromKind: ProjectNodeLink["from_kind"],
    fromId: string,
    toSegment: string,
    toPort: ProjectNodeLink["to_port"],
  ) => Promise<void>;

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

  openLibraryPanel: (kind: ProjectPanelKind) => void;
  closeLibraryPanel: () => void;
  /** 工程跨表搜索（防抖由调用方负责）。 */
  runProjectSearch: (query: string) => Promise<void>;
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
  libraryPanel: null,
  searchResults: [],
  searchLoading: false,

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

  moveEpisode: async (episodeId, direction) => {
    const episodes = get().episodes;
    const index = episodes.findIndex((episode) => episode.id === episodeId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= episodes.length) return;
    const reordered = reorderList(episodes, index, target);
    const ids = reordered.map((episode) => episode.id);
    // 本地先行换位（树的即时反馈），后端按新顺序重写 sort_order，失败回滚。
    set({ episodes: reordered });
    try {
      await invoke("project_reorder_episodes", { showId: get().currentShowId ?? "", ids });
    } catch (error) {
      console.error("project_reorder_episodes failed:", error);
      set({ episodes });
    }
  },

  updateEpisodeNumber: async (id, number) => {
    if (!Number.isInteger(number) || number < 1 || number > 999) return false;
    const episode = get().episodes.find((item) => item.id === id);
    if (!episode) return false;
    try {
      await invoke("project_update_episode", {
        id,
        number,
        title: episode.title,
        status: episode.status,
        scriptPath: episode.script_path,
      });
      await get().refresh();
      return true;
    } catch (error) {
      console.error("project_update_episode number failed:", error);
      return false;
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
      referencePaths: payload.reference_paths,
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

  moveScene: async (sceneId, direction) => {
    const overview = get().overview;
    const scenes = overview?.scenes ?? [];
    const index = scenes.findIndex((scene) => scene.id === sceneId);
    const target = index + direction;
    if (!overview || index < 0 || target < 0 || target >= scenes.length) return;
    const reordered = reorderList(scenes, index, target);
    const ids = reordered.map((scene) => scene.id);
    // 概览是场景列表唯一数据源：先本地换位给即时反馈，失败靠重取回滚。
    set({ overview: { ...overview, scenes: reordered } });
    try {
      await invoke("project_reorder_scenes", { episodeId: get().currentEpisodeId ?? "", ids });
    } catch (error) {
      console.error("project_reorder_scenes failed:", error);
      const { currentEpisodeId } = get();
      if (currentEpisodeId) await get().selectEpisode(currentEpisodeId);
    }
  },

  saveShot: async (payload) => {
    try {
      if (payload.id) {
        await invoke("project_update_shot", {
          id: payload.id,
          description: payload.description,
          dialogue: payload.dialogue,
          status: payload.status,
          camera: payload.camera,
          duration: payload.duration,
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

  moveShot: async (shotId, direction) => {
    const overview = get().overview;
    if (!overview) return;
    const scene = overview.scenes.find((item) => item.shots.some((shot) => shot.id === shotId));
    if (!scene) return;
    const index = scene.shots.findIndex((shot) => shot.id === shotId);
    const target = index + direction;
    if (target < 0 || target >= scene.shots.length) return;
    const reordered = reorderList(scene.shots, index, target);
    const ids = reordered.map((shot) => shot.id);
    set({
      overview: {
        ...overview,
        scenes: overview.scenes.map((item) =>
          item.id === scene.id ? { ...item, shots: reordered } : item,
        ),
      },
    });
    try {
      await invoke("project_reorder_shots", { sceneId: scene.id, ids });
    } catch (error) {
      console.error("project_reorder_shots failed:", error);
      const { currentEpisodeId } = get();
      if (currentEpisodeId) await get().selectEpisode(currentEpisodeId);
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

  importAsset: async (payload) => {
    const asset = await invoke<ProjectAsset>("project_import_asset", {
      sourcePath: payload.sourcePath,
      episodeId: payload.episodeId,
      shotId: payload.shotId,
    });
    const { currentEpisodeId } = get();
    if (currentEpisodeId) await get().selectEpisode(currentEpisodeId);
    return asset;
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
        genParams: payload.genParams,
        audioRole: payload.audioRole,
      });
      const { currentEpisodeId } = get();
      if (currentEpisodeId) await get().selectEpisode(currentEpisodeId);
    } catch (error) {
      console.error("project_update_asset failed:", error);
    }
  },

  saveCanvasLayout: async (payload) => {
    // 本地即时回写（overview 内嵌结构的对应字段），静默落库；失败仅
    // 记日志，画布保留用户摆位、下次改动会再保存。
    const overview = get().overview;
    if (overview) {
      const assetMap = new Map(payload.assets.map((item) => [item.id, item]));
      const shotMap = new Map(payload.shots.map((item) => [item.id, item]));
      const sceneMap = new Map(payload.scenes.map((item) => [item.id, item]));
      const segmentMap = new Map((payload.segments ?? []).map((item) => [item.id, item]));
      const patchAsset = (asset: ProjectAsset): ProjectAsset => {
        const patch = assetMap.get(asset.id);
        return patch
          ? { ...asset, canvas_x: patch.x, canvas_y: patch.y, canvas_w: patch.w }
          : asset;
      };
      set({
        overview: {
          ...overview,
          loose_assets: overview.loose_assets.map(patchAsset),
          segments: overview.segments.map((segment) => {
            const patch = segmentMap.get(segment.id);
            return patch
              ? { ...segment, canvas_x: patch.x, canvas_y: patch.y }
              : segment;
          }),
          scenes: overview.scenes.map((scene) => {
            const scenePatch = sceneMap.get(scene.id);
            return {
              ...scene,
              canvas_x: scenePatch ? scenePatch.x : scene.canvas_x,
              canvas_y: scenePatch ? scenePatch.y : scene.canvas_y,
              shots: scene.shots.map((shot) => {
                const shotPatch = shotMap.get(shot.id);
                return shotPatch
                  ? { ...shot, canvas_x: shotPatch.x, canvas_y: shotPatch.y }
                  : {
                      ...shot,
                      assets: shot.assets.map(patchAsset),
                    };
              }),
            };
          }),
        },
      });
    }
    try {
      await invoke("project_save_canvas_layout", { payload });
    } catch (error) {
      console.error("project_save_canvas_layout failed:", error);
    }
  },

  linkAssets: async (fromAsset, toAsset, label) => {
    try {
      const link = await invoke<ProjectAssetLink>("project_link_assets", {
        fromAsset,
        toAsset,
        label: label ?? "",
      });
      const overview = get().overview;
      if (overview && !overview.links.some((item) => item.id === link.id)) {
        set({ overview: { ...overview, links: [...overview.links, link] } });
      }
      return link;
    } catch (error) {
      console.error("project_link_assets failed:", error);
      return null;
    }
  },

  unlinkAssets: async (fromAsset, toAsset) => {
    try {
      await invoke("project_unlink_assets", { fromAsset, toAsset });
      const overview = get().overview;
      if (overview) {
        set({
          overview: {
            ...overview,
            links: overview.links.filter(
              (item) =>
                !(
                  (item.from_asset === fromAsset && item.to_asset === toAsset) ||
                  (item.from_asset === toAsset && item.to_asset === fromAsset)
                ),
            ),
          },
        });
      }
    } catch (error) {
      console.error("project_unlink_assets failed:", error);
    }
  },

  setEpisodeOutput: async (episodeId, outputAssetId) => {
    // 本地即时回写 + 静默落库（与 saveCanvasLayout 同策略：画布是事实
    // 来源，成片连线由 output_asset_id 推导渲染）。
    const overview = get().overview;
    if (overview && overview.episode.id === episodeId) {
      set({
        overview: {
          ...overview,
          episode: { ...overview.episode, output_asset_id: outputAssetId },
        },
      });
    }
    try {
      await invoke("project_set_episode_output", {
        id: episodeId,
        outputAssetId: outputAssetId ?? "",
      });
    } catch (error) {
      console.error("project_set_episode_output failed:", error);
    }
  },

  setEpisodeLocations: async (episodeId, locationIds) => {
    try {
      await invoke("project_set_episode_locations", { episodeId, locationIds });
      // 关联后概览重取：资料框新节点立即可见（与 setEpisodeCharacters 同策略；
      // 不重取则面板标记与画布都毫无反应，像点击失效）。
      await get().selectEpisode(episodeId);
    } catch (error) {
      console.error("project_set_episode_locations failed:", error);
    }
  },

  setEpisodeProps: async (episodeId, propIds) => {
    try {
      await invoke("project_set_episode_props", { episodeId, propIds });
      await get().selectEpisode(episodeId);
    } catch (error) {
      console.error("project_set_episode_props failed:", error);
    }
  },

  addSegment: async (episodeId) => {
    try {
      const segment = await invoke<ProjectSegment>("project_add_segment", { episodeId });
      const overview = get().overview;
      if (overview && overview.episode.id === episodeId) {
        set({ overview: { ...overview, segments: [...overview.segments, segment] } });
      }
      return segment;
    } catch (error) {
      console.error("project_add_segment failed:", error);
      return null;
    }
  },

  removeSegment: async (id) => {
    try {
      await invoke("project_remove_segment", { id });
    } catch (error) {
      console.error("project_remove_segment failed:", error);
    }
  },

  moveSegment: async (id, direction) => {
    try {
      await invoke("project_move_segment", { id, direction });
    } catch (error) {
      console.error("project_move_segment failed:", error);
    }
  },

  setSegmentAsset: async (id, assetId) => {
    try {
      await invoke("project_set_segment_asset", { id, assetId: assetId ?? "" });
    } catch (error) {
      console.error("project_set_segment_asset failed:", error);
    }
  },

  linkNode: async (episodeId, fromKind, fromId, toSegment, toPort) => {
    // 本地即时追加（与 linkAssets 同策略），落库由后端幂等兜底。
    const overview = get().overview;
    if (overview) {
      const exists = overview.node_links.some(
        (item) =>
          item.from_kind === fromKind &&
          item.from_id === fromId &&
          item.to_segment === toSegment &&
          item.to_port === toPort,
      );
      if (!exists) {
        set({
          overview: {
            ...overview,
            node_links: [
              ...overview.node_links,
              { id: `local-${Date.now()}`, from_kind: fromKind, from_id: fromId, to_segment: toSegment, to_port: toPort },
            ],
          },
        });
      }
    }
    try {
      await invoke("project_link_node", { episodeId, fromKind, fromId, toSegment, toPort });
    } catch (error) {
      console.error("project_link_node failed:", error);
    }
  },

  unlinkNode: async (fromKind, fromId, toSegment, toPort) => {
    const overview = get().overview;
    if (overview) {
      set({
        overview: {
          ...overview,
          node_links: overview.node_links.filter(
            (item) =>
              !(
                item.from_kind === fromKind &&
                item.from_id === fromId &&
                item.to_segment === toSegment &&
                item.to_port === toPort
              ),
          ),
        },
      });
    }
    try {
      await invoke("project_unlink_node", { fromKind, fromId, toSegment, toPort });
    } catch (error) {
      console.error("project_unlink_node failed:", error);
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

  openLibraryPanel: (kind) => {
    set({ libraryPanel: { kind, mode: "browse" } });
  },

  closeLibraryPanel: () => {
    set({ libraryPanel: null });
  },

  runProjectSearch: async (query) => {
    const keyword = query.trim();
    if (!keyword) {
      set({ searchResults: [], searchLoading: false });
      return;
    }
    set({ searchLoading: true });
    try {
      const results = await invoke<ProjectSearchItem[]>("project_search", { query: keyword });
      set({ searchResults: results, searchLoading: false });
    } catch (error) {
      console.error("project_search failed:", error);
      set({ searchResults: [], searchLoading: false });
    }
  },
}));

/** 列表元素换位（纯函数，move* 动作共用）。 */
function reorderList<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
