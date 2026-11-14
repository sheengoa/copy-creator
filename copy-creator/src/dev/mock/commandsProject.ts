// 浏览器验证专用内存后端——工程域命令分派（剧/集/三库/场景镜头/素材连线/
// 片段工作流）。自 dev/tauriMock.ts 零改动拆分（2026-11-14，守卫规则 27
// 行数上限），数据与事件通道见 ./db，媒体合成与 AI 生成模拟见 ./media。

import {
  assetById,
  clone,
  db,
  MOCK_NOT_HANDLED,
  nextId,
  ts,
  type MockAsset,
  type MockNodeLink,
  type MockSegment,
} from "./db";
import { overviewOf } from "./media";

function linkAsset(args: Record<string, unknown>): MockAsset {
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
  return created;
}

export function handleProjectCommands(cmd: string, args: Record<string, unknown>): unknown {
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
      db.characters.push({ id: nextId("char"), name: String(args.name ?? ""), role_tag: String(args.roleTag ?? ""), bio: String(args.bio ?? ""), prompt: String(args.prompt ?? ""), avatar_path: String(args.avatarPath ?? ""), reference_paths: String(args.referencePaths ?? ""), voice_path: String(args.voicePath ?? ""), created_at: ts(), updated_at: ts() });
      return null;
    case "project_update_character":
      {
        const c = db.characters.find((row) => row.id === args.id);
        if (c) {
          c.name = String(args.name ?? c.name);
          c.role_tag = String(args.roleTag ?? c.role_tag);
          c.bio = String(args.bio ?? c.bio);
          c.prompt = String(args.prompt ?? c.prompt);
          c.avatar_path = String(args.avatarPath ?? c.avatar_path);
          c.reference_paths = String(args.referencePaths ?? c.reference_paths);
          c.voice_path = String(args.voicePath ?? c.voice_path ?? "");
          c.updated_at = ts();
        }
        return null;
      }
    case "project_set_character_voice":
      {
        const c = db.characters.find((row) => row.id === args.id);
        if (c) {
          c.voice_path = String(args.voicePath ?? "");
          c.updated_at = ts();
        }
        return null;
      }
    case "project_set_references":
      {
        // 三库参考图集（详情窗大图列表添加/移除）：按 kind 分派整体覆写。
        const table = args.kind === "character" ? db.characters : args.kind === "location" ? db.locations : db.props;
        const row = (table as Array<Record<string, unknown>>).find((r) => r.id === args.id);
        if (row) {
          row.reference_paths = JSON.stringify(args.paths ?? []);
          row.updated_at = ts();
        }
        return null;
      }
    case "project_set_image_bindings":
      {
        // 每图绑定（形象卡方案 A）：按 kind 分派整体覆写（后端序列化会按
        // path 去重归一，mock 直存即可）。
        const table = args.kind === "character" ? db.characters : args.kind === "location" ? db.locations : db.props;
        const row = (table as Array<Record<string, unknown>>).find((r) => r.id === args.id);
        if (row) {
          row.image_bindings = JSON.stringify(args.bindings ?? []);
          row.updated_at = ts();
        }
        return null;
      }
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
    case "project_link_asset":
      return clone(linkAsset(args));
    case "project_import_asset":
      return handleProjectCommands("project_link_asset", args);
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
          l.to_port === args.toPort &&
          (l.owner_key ?? "") === String(args.ownerKey ?? ""),
      );
      if (!exists) {
        db.node_links.push({
          id: nextId("nl"),
          from_kind: args.fromKind as MockNodeLink["from_kind"],
          from_id: String(args.fromId ?? ""),
          to_segment: String(args.toSegment ?? ""),
          to_port: args.toPort as MockNodeLink["to_port"],
          owner_key: String(args.ownerKey ?? ""),
        });
      }
      return null;
    }
    case "project_unlink_node": {
      const owner = args.ownerKey != null ? String(args.ownerKey) : null;
      db.node_links = db.node_links.filter(
        (l) =>
          !(
            l.from_kind === args.fromKind &&
            l.from_id === args.fromId &&
            l.to_segment === args.toSegment &&
            l.to_port === args.toPort &&
            // 空 owner 只删无主行：实例线（owner=eph:）/组线不受牵连
            //（与 Rust project_unlink_node 同语义，同实体多节点）。
            (owner ? (l.owner_key ?? "") === owner : !(l.owner_key ?? ""))
          ),
      );
      return null;
    }

    default:
      return MOCK_NOT_HANDLED;
  }
}
