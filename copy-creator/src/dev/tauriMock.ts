// 浏览器验证专用内存后端：页面不在 Tauri 环境运行（无 __TAURI_INTERNALS__）
// 时由 main.tsx 动态注入，用于在普通浏览器里跑通工程画布等界面的前端验证
// 与模拟（自动化截图、交互走查）。真实 Tauri 应用永远不会加载本模块。

interface MockSegment {
  id: string;
  episode_id: string;
  asset_id: string | null;
  sort_order: number;
  note: string;
  canvas_x: number | null;
  canvas_y: number | null;
  created_at: string;
  updated_at: string;
}

interface MockNodeLink {
  id: string;
  from_kind: "asset" | "character" | "location" | "prop" | "script" | "segment" | "shot";
  from_id: string;
  to_segment: string;
  to_port: "character" | "location" | "prop" | "script" | "other";
}

interface MockScene {
  id: string;
  episode_id: string;
  location_id: string;
  heading: string;
  note: string;
  sort_order: number;
  canvas_x: number | null;
  canvas_y: number | null;
  created_at: string;
  updated_at: string;
}

interface MockShot {
  id: string;
  scene_id: string;
  episode_id: string;
  description: string;
  dialogue: string;
  status: string;
  camera: string;
  duration: string;
  sort_order: number;
  canvas_x: number | null;
  canvas_y: number | null;
  created_at: string;
  updated_at: string;
}

interface MockAsset {
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
  missing: boolean;
  canvas_x: number | null;
  canvas_y: number | null;
  canvas_w: number | null;
  created_at: string;
  updated_at: string;
}

const ts = () => new Date().toISOString();
let seq = 1;
const nextId = (prefix: string) => `${prefix}-m${seq++}`;

// ── 内存数据库：一剧一集，覆盖八类节点与两类连线的最小样例 ──
const db = {
  show: {
    id: "show-1",
    name: "示例剧 · 星尘档案",
    note: "",
    episode_count: 1,
    created_at: ts(),
    updated_at: ts(),
  },
  episodes: [
    {
      id: "ep-1",
      show_id: "show-1",
      number: 1,
      title: "第 1 集 · 坠落",
      status: "script" as "none" | "script" | "storyboard" | "generating" | "done",
      script_path: "",
      character_ids: ["char-1", "char-2"],
      location_ids: ["loc-1"],
      prop_ids: ["prop-1"],
      shot_count: 3,
      done_shot_count: 0,
      output_asset_id: null as string | null,
      created_at: ts(),
      updated_at: ts(),
    },
    {
      // 空集：验证默认工作流模板（首次进入自动铺骨架）。
      id: "ep-2",
      show_id: "show-1",
      number: 2,
      title: "第 2 集 · 回声",
      status: "none" as "none" | "script" | "storyboard" | "generating" | "done",
      script_path: "",
      character_ids: ["char-1"],
      location_ids: ["loc-2"],
      prop_ids: [],
      shot_count: 0,
      done_shot_count: 0,
      output_asset_id: null as string | null,
      created_at: ts(),
      updated_at: ts(),
    },
  ],
  characters: [
    { id: "char-1", name: "小雨", role_tag: "主角", bio: "", prompt: "", avatar_path: "", reference_paths: "", created_at: ts(), updated_at: ts() },
    { id: "char-2", name: "老周", role_tag: "配角", bio: "", prompt: "", avatar_path: "", reference_paths: "", created_at: ts(), updated_at: ts() },
  ],
  locations: [
    { id: "loc-1", name: "废弃地铁站", int_ext: "int", time_hint: "night", bio: "", prompt: "", ref_path: "", created_at: ts(), updated_at: ts() },
    { id: "loc-2", name: "天台", int_ext: "ext", time_hint: "day", bio: "", prompt: "", ref_path: "", created_at: ts(), updated_at: ts() },
  ],
  props: [
    { id: "prop-1", name: "旧怀表", bio: "", prompt: "", ref_path: "", created_at: ts(), updated_at: ts() },
  ],
  scenes: [
    { id: "sc-1", episode_id: "ep-1", location_id: "loc-1", heading: "地铁站追逃", note: "", sort_order: 0, canvas_x: null, canvas_y: null, created_at: ts(), updated_at: ts() },
    { id: "sc-2", episode_id: "ep-1", location_id: "loc-2", heading: "天台对峙", note: "", sort_order: 1, canvas_x: null, canvas_y: null, created_at: ts(), updated_at: ts() },
  ] as MockScene[],
  shots: [
    { id: "shot-1", scene_id: "sc-1", episode_id: "ep-1", description: "小雨冲下站台台阶", dialogue: "", status: "none", camera: "", duration: "", sort_order: 0, canvas_x: null, canvas_y: null, created_at: ts(), updated_at: ts() },
    { id: "shot-2", scene_id: "sc-1", episode_id: "ep-1", description: "老周在通道尽头回头", dialogue: "", status: "none", camera: "", duration: "", sort_order: 1, canvas_x: null, canvas_y: null, created_at: ts(), updated_at: ts() },
    { id: "shot-3", scene_id: "sc-2", episode_id: "ep-1", description: "两人在天台边缘对视", dialogue: "", status: "none", camera: "", duration: "", sort_order: 0, canvas_x: null, canvas_y: null, created_at: ts(), updated_at: ts() },
  ] as MockShot[],
  assets: [
    { id: "a-1", file_path: "shots/xiaoyu-platform.png", kind: "image", name: "站台冲刺分镜", shot_id: "shot-1", episode_id: "ep-1", gen_from_asset: "", gen_from_prompt: "", gen_params: "", audio_role: "", missing: false, canvas_x: null, canvas_y: null, canvas_w: null, created_at: ts(), updated_at: ts() },
    { id: "a-2", file_path: "shots/laozhou-tunnel.mp4", kind: "video", name: "通道回头镜头", shot_id: "shot-2", episode_id: "ep-1", gen_from_asset: "a-1", gen_from_prompt: "", gen_params: "", audio_role: "", missing: false, canvas_x: null, canvas_y: null, canvas_w: null, created_at: ts(), updated_at: ts() },
    { id: "a-3", file_path: "refs/poster-mood.png", kind: "image", name: "海报氛围参考", shot_id: "", episode_id: "ep-1", gen_from_asset: "", gen_from_prompt: "", gen_params: "", audio_role: "", missing: false, canvas_x: null, canvas_y: null, canvas_w: null, created_at: ts(), updated_at: ts() },
    { id: "a-4", file_path: "segments/seg1-draft.mp4", kind: "video", name: "片段 1 草稿", shot_id: "", episode_id: "ep-1", gen_from_asset: "", gen_from_prompt: "", gen_params: "", audio_role: "", missing: false, canvas_x: null, canvas_y: null, canvas_w: null, created_at: ts(), updated_at: ts() },
    { id: "a-5", file_path: "notes/lines.txt", kind: "text", name: "台词备注", shot_id: "", episode_id: "ep-1", gen_from_asset: "", gen_from_prompt: "", gen_params: "", audio_role: "", missing: false, canvas_x: null, canvas_y: null, canvas_w: null, created_at: ts(), updated_at: ts() },
  ] as MockAsset[],
  links: [
    { id: "link-m1", from_asset: "a-3", to_asset: "a-4", label: "" },
  ],
  segments: [
    { id: "seg-1", episode_id: "ep-1", asset_id: "a-4", sort_order: 0, note: "", canvas_x: null, canvas_y: null, created_at: ts(), updated_at: ts() },
    { id: "seg-2", episode_id: "ep-1", asset_id: null, sort_order: 1, note: "", canvas_x: null, canvas_y: null, created_at: ts(), updated_at: ts() },
  ] as MockSegment[],
  node_links: [
    { id: "nl-m1", from_kind: "character" as const, from_id: "char-1", to_segment: "seg-1", to_port: "character" as const },
    { id: "nl-m2", from_kind: "location" as const, from_id: "loc-1", to_segment: "seg-1", to_port: "location" as const },
  ] as MockNodeLink[],
};

const libraryRoot = "C:\\mock-library";
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const assetById = (id: string) => db.assets.find((a) => a.id === id);

function overviewOf(episodeId: string) {
  const episode = db.episodes.find((e) => e.id === episodeId);
  if (!episode) throw new Error(`episode ${episodeId} not found`);
  const characters = db.characters.filter((c) => episode.character_ids.includes(c.id));
  const locations = db.locations.filter((l) => episode.location_ids.includes(l.id));
  const shotPropIds = db.shots
    .filter((s) => s.episode_id === episodeId)
    .flatMap((s) => (s as unknown as { prop_ids: string[] }).prop_ids ?? []);
  const props = db.props.filter((p) => episode.prop_ids.includes(p.id) || shotPropIds.includes(p.id));
  const scenes = db.scenes
    .filter((s) => s.episode_id === episodeId)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((scene) => ({
      ...scene,
      shot_count: db.shots.filter((s) => s.scene_id === scene.id).length,
      location: db.locations.find((l) => l.id === scene.location_id) ?? null,
      shots: db.shots
        .filter((s) => s.scene_id === scene.id)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((shot) => ({ ...shot, assets: db.assets.filter((a) => a.shot_id === shot.id) })),
    }));
  return {
    episode: clone(episode),
    characters: clone(characters),
    locations: clone(locations),
    props: clone(props),
    scenes,
    loose_assets: clone(db.assets.filter((a) => a.episode_id === episodeId && a.shot_id === "")),
    links: clone(
      db.links.filter((l) => {
        const from = assetById(l.from_asset);
        const to = assetById(l.to_asset);
        return from?.episode_id === episodeId && to?.episode_id === episodeId;
      }),
    ),
    segments: db.segments
      .filter((s) => s.episode_id === episodeId)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s) => ({ ...s, asset: s.asset_id ? assetById(s.asset_id) ?? null : null })),
    node_links: clone(
      db.node_links.filter((l) =>
        db.segments.some((s) => s.id === l.to_segment && s.episode_id === episodeId),
      ),
    ),
  };
}

function handleInvoke(cmd: string, args: Record<string, unknown>): unknown {
  switch (cmd) {
    // ── 剧/集 ──
    case "project_list_shows":
      return clone([db.show]);
    case "project_list_episodes":
      return clone(db.episodes.filter((e) => e.show_id === args.showId));
    case "project_create_show":
      return clone({ ...db.show, name: String(args.name ?? "") });
    case "project_create_episode": {
      const created = {
        id: nextId("ep"),
        show_id: String(args.showId ?? ""),
        number: db.episodes.length + 1,
        title: String(args.title ?? ""),
        status: "none" as const,
        script_path: "",
        character_ids: [],
        location_ids: [],
        prop_ids: [],
        shot_count: 0,
        done_shot_count: 0,
        output_asset_id: null,
        created_at: ts(),
        updated_at: ts(),
      };
      db.episodes.push(created);
      return clone(created);
    }
    case "project_update_episode": {
      const episode = db.episodes.find((e) => e.id === args.id);
      if (episode) {
        if (args.title != null) episode.title = String(args.title);
        if (args.status != null) episode.status = args.status as typeof episode.status;
        if (args.scriptPath != null) episode.script_path = String(args.scriptPath);
        if (args.number != null) episode.number = Number(args.number);
        episode.updated_at = ts();
      }
      return null;
    }
    case "project_get_episode_overview":
      return overviewOf(String(args.episodeId ?? ""));
    case "project_set_episode_output": {
      const episode = db.episodes.find((e) => e.id === args.id);
      if (episode) episode.output_asset_id = String(args.outputAssetId ?? "") || null;
      return null;
    }
    case "project_set_episode_characters": {
      const episode = db.episodes.find((e) => e.id === args.episodeId);
      if (episode) episode.character_ids = (args.characterIds as string[]) ?? [];
      return null;
    }
    case "project_set_episode_locations": {
      const episode = db.episodes.find((e) => e.id === args.episodeId);
      if (episode) episode.location_ids = (args.locationIds as string[]) ?? [];
      return null;
    }
    case "project_set_episode_props": {
      const episode = db.episodes.find((e) => e.id === args.episodeId);
      if (episode) episode.prop_ids = (args.propIds as string[]) ?? [];
      return null;
    }

    // ── 三库 ──
    case "project_list_characters":
      return clone(db.characters);
    case "project_list_locations":
      return clone(db.locations);
    case "project_list_props":
      return clone(db.props);
    case "project_create_character":
      db.characters.push({ id: nextId("char"), name: String(args.name ?? ""), role_tag: String(args.roleTag ?? ""), bio: String(args.bio ?? ""), prompt: String(args.prompt ?? ""), avatar_path: String(args.avatarPath ?? ""), reference_paths: String(args.referencePaths ?? ""), created_at: ts(), updated_at: ts() });
      return null;
    case "project_create_location":
      db.locations.push({ id: nextId("loc"), name: String(args.name ?? ""), int_ext: String(args.intExt ?? ""), time_hint: String(args.timeHint ?? ""), bio: String(args.bio ?? ""), prompt: String(args.prompt ?? ""), ref_path: String(args.refPath ?? ""), created_at: ts(), updated_at: ts() });
      return null;
    case "project_create_prop":
      db.props.push({ id: nextId("prop"), name: String(args.name ?? ""), bio: String(args.bio ?? ""), prompt: String(args.prompt ?? ""), ref_path: String(args.refPath ?? ""), created_at: ts(), updated_at: ts() });
      return null;
    case "project_delete_character":
      db.characters = db.characters.filter((c) => c.id !== args.id);
      return null;
    case "project_delete_location":
      db.locations = db.locations.filter((l) => l.id !== args.id);
      return null;
    case "project_delete_prop":
      db.props = db.props.filter((p) => p.id !== args.id);
      return null;
    case "project_list_prompts":
      return [];

    // ── 场景/镜头 ──
    case "project_create_scene":
      db.scenes.push({ id: nextId("sc"), episode_id: String(args.episodeId ?? ""), location_id: String(args.locationId ?? ""), heading: String(args.heading ?? ""), note: String(args.note ?? ""), sort_order: db.scenes.length, canvas_x: null, canvas_y: null, created_at: ts(), updated_at: ts() });
      return null;
    case "project_create_shot":
      db.shots.push({ id: nextId("shot"), scene_id: String(args.sceneId ?? ""), episode_id: db.scenes.find((s) => s.id === args.sceneId)?.episode_id ?? "", description: String(args.description ?? ""), dialogue: String(args.dialogue ?? ""), status: "none", camera: "", duration: "", sort_order: db.shots.filter((s) => s.scene_id === args.sceneId).length, canvas_x: null, canvas_y: null, created_at: ts(), updated_at: ts() });
      return null;
    case "project_delete_scene":
      db.scenes = db.scenes.filter((s) => s.id !== args.id);
      return null;
    case "project_delete_shot":
      db.shots = db.shots.filter((s) => s.id !== args.id);
      return null;
    case "project_reorder_scenes": {
      const ids = (args.ids as string[]) ?? [];
      ids.forEach((id, index) => {
        const scene = db.scenes.find((s) => s.id === id);
        if (scene) scene.sort_order = index;
      });
      return null;
    }
    case "project_reorder_shots": {
      const ids = (args.ids as string[]) ?? [];
      ids.forEach((id, index) => {
        const shot = db.shots.find((s) => s.id === id);
        if (shot) shot.sort_order = index;
      });
      return null;
    }
    case "project_set_shot_characters":
    case "project_set_shot_props":
      return null;

    // ── 素材与连线 ──
    case "project_link_asset": {
      const created: MockAsset = {
        id: nextId("a"),
        file_path: String(args.filePath ?? ""),
        kind: String(args.kind ?? "file"),
        name: String(args.name ?? ""),
        shot_id: String(args.shotId ?? ""),
        episode_id: String(args.episodeId ?? ""),
        gen_from_asset: "",
        gen_from_prompt: "",
        gen_params: "",
        audio_role: "",
        missing: false,
        canvas_x: null,
        canvas_y: null,
        canvas_w: null,
        created_at: ts(),
        updated_at: ts(),
      };
      db.assets.push(created);
      return clone(created);
    }
    case "project_import_asset":
      return handleInvoke("project_link_asset", args);
    case "project_unlink_asset":
      db.assets = db.assets.filter((a) => a.id !== args.id);
      return null;
    case "project_save_canvas_layout": {
      const payload = (args.payload ?? {}) as {
        assets?: { id: string; x: number | null; y: number | null; w: number | null }[];
        shots?: { id: string; x: number | null; y: number | null }[];
        scenes?: { id: string; x: number | null; y: number | null }[];
        segments?: { id: string; x: number | null; y: number | null }[];
      };
      (payload.assets ?? []).forEach(({ id, x, y, w }) => {
        const asset = assetById(id);
        if (asset) {
          asset.canvas_x = x;
          asset.canvas_y = y;
          asset.canvas_w = w;
        }
      });
      (payload.shots ?? []).forEach(({ id, x, y }) => {
        const shot = db.shots.find((s) => s.id === id);
        if (shot) {
          shot.canvas_x = x;
          shot.canvas_y = y;
        }
      });
      (payload.scenes ?? []).forEach(({ id, x, y }) => {
        const scene = db.scenes.find((s) => s.id === id);
        if (scene) {
          scene.canvas_x = x;
          scene.canvas_y = y;
        }
      });
      (payload.segments ?? []).forEach(({ id, x, y }) => {
        const segment = db.segments.find((s) => s.id === id);
        if (segment) {
          segment.canvas_x = x;
          segment.canvas_y = y;
        }
      });
      return null;
    }
    case "project_link_assets": {
      const from = String(args.fromAsset ?? "");
      const to = String(args.toAsset ?? "");
      const existing = db.links.find(
        (l) => (l.from_asset === from && l.to_asset === to) || (l.from_asset === to && l.to_asset === from),
      );
      if (existing) return clone(existing);
      const created = { id: nextId("link"), from_asset: from, to_asset: to, label: String(args.label ?? "") };
      db.links.push(created);
      return clone(created);
    }
    case "project_unlink_assets":
      db.links = db.links.filter(
        (l) =>
          !(
            (l.from_asset === args.fromAsset && l.to_asset === args.toAsset) ||
            (l.from_asset === args.toAsset && l.to_asset === args.fromAsset)
          ),
      );
      return null;

    // ── 片段工作流 ──
    case "project_add_segment": {
      const episodeId = String(args.episodeId ?? "");
      const created: MockSegment = {
        id: nextId("seg"),
        episode_id: episodeId,
        asset_id: null,
        sort_order: db.segments.filter((s) => s.episode_id === episodeId).length,
        note: "",
        canvas_x: null,
        canvas_y: null,
        created_at: ts(),
        updated_at: ts(),
      };
      db.segments.push(created);
      return clone({ ...created, asset: null });
    }
    case "project_remove_segment":
      db.segments = db.segments.filter((s) => s.id !== args.id);
      db.node_links = db.node_links.filter((l) => l.to_segment !== args.id && l.from_id !== args.id);
      return null;
    case "project_move_segment": {
      const segment = db.segments.find((s) => s.id === args.id);
      if (segment) {
        const siblings = db.segments
          .filter((s) => s.episode_id === segment.episode_id)
          .sort((a, b) => a.sort_order - b.sort_order);
        const index = siblings.findIndex((s) => s.id === segment.id);
        const target = index + Number(args.direction ?? 0);
        if (target >= 0 && target < siblings.length) {
          const other = siblings[target];
          other.sort_order = index;
          segment.sort_order = target;
          segment.updated_at = ts();
        }
      }
      return null;
    }
    case "project_set_segment_asset": {
      const segment = db.segments.find((s) => s.id === args.id);
      if (segment) segment.asset_id = String(args.assetId ?? "") || null;
      return null;
    }
    case "project_link_node": {
      const exists = db.node_links.some(
        (l) =>
          l.from_kind === args.fromKind &&
          l.from_id === args.fromId &&
          l.to_segment === args.toSegment &&
          l.to_port === args.toPort,
      );
      if (!exists) {
        db.node_links.push({
          id: nextId("nl"),
          from_kind: args.fromKind as MockNodeLink["from_kind"],
          from_id: String(args.fromId ?? ""),
          to_segment: String(args.toSegment ?? ""),
          to_port: args.toPort as MockNodeLink["to_port"],
        });
      }
      return null;
    }
    case "project_unlink_node":
      db.node_links = db.node_links.filter(
        (l) =>
          !(
            l.from_kind === args.fromKind &&
            l.from_id === args.fromId &&
            l.to_segment === args.toSegment &&
            l.to_port === args.toPort
          ),
      );
      return null;

    // ── 资源域与通用命令（画布链路会碰到的） ──
    case "get_resource_library_path":
      return libraryRoot;
    case "get_clipboard_records":
      // 供「从资源库选文件」浮层挑一个剧本文件（挂剧本链路验证用）。
      return [
        {
          id: "rec-script-1",
          type: "file",
          content: `${libraryRoot}\\scripts\\第一集剧本.txt`,
          source_app: "mock",
          created_at: ts(),
          storage_mode: "resource",
          resource_path: `${libraryRoot}\\scripts\\第一集剧本.txt`,
          resource_kind: "text",
          resource_group: null,
        },
      ];
    case "get_image_thumbnail":
    case "get_resource_file_thumbnail":
    case "load_resource_video_poster":
      return "";
    case "read_resource_text_preview":
    case "read_resource_text_detail":
    case "read_text_file_content":
      return { content: "第一场：地铁站\n小雨在末班车驶离后奔下台阶，身后传来金属撞击的回响……", truncated: false };
    case "open_resource_file":
    case "reveal_resource_file":
    case "save_resource_video_poster":
    case "set_setting":
    case "set_settings_batch":
    case "validate_autostart_ok":
      return null;
    case "validate_autostart":
      return { enabled: false, file_exists: false, path_correct: true, message: "" };
    case "is_autostart_enabled":
    case "set_autostart":
      return false;
    case "get_quick_input_file_limit":
      return 10485760;
    case "get_setting":
      return "";
    case "project_search":
      return [];
    case "get_resource_groups":
      return [];

    // ── 事件与窗口（Tauri 插件命令） ──
    default:
      if (cmd.startsWith("plugin:")) return null;
      if (/^(list_|get_[a-z_]*groups|get_[a-z_]*records|get_[a-z_]*phrases)/.test(cmd)) return [];
      console.info("[tauriMock] 未模拟的命令:", cmd, args);
      return null;
  }
}

/** 注入内存后端：伪装 __TAURI_INTERNALS__，并预置工程视图的定位键，
 *  使浏览器直接打开 http://localhost:5173 即落在工程画布。 */
export function installBrowserMock(): void {
  const callbacks = new Map<number, (...args: unknown[]) => void>();
  let callbackSeq = 1;
  let eventSeq = 1;

  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: (callback: (...args: unknown[]) => void) => {
      const id = callbackSeq++;
      callbacks.set(id, callback);
      return id;
    },
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      try {
        return Promise.resolve(handleInvoke(cmd, args ?? {}));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    plugin: {},
  };
  // @tauri-apps/api/event 的 unlisten 依赖事件插件内部表。
  (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    registerListener: () => eventSeq++,
    unregisterListener: () => {},
  };

  try {
    window.localStorage.setItem("resource_view_mode", "project");
    window.localStorage.setItem("project_current_show", "show-1");
    window.localStorage.setItem("project_current_episode", "ep-1");
  } catch {
    // 存储不可用：仅影响初始定位。
  }
  console.info("[tauriMock] 已注入浏览器内存后端（仅开发验证用）");
}
