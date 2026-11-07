// 浏览器验证专用内存后端：invoke 命令分派与插件装配（自 dev/tauriMock.ts
// 零改动拆分，2026-11-03 阶段 10）。数据与事件通道见 ./mock/db，媒体合成
// 与 AI 生成模拟见 ./mock/media；页面不在 Tauri 环境运行（无
// __TAURI_INTERNALS__）时由 main.tsx 动态注入本模块。

import {
  assetById,
  canvasDefaultMeta,
  canvasSummaryOf,
  clone,
  db,
  libraryRoot,
  mockEmit,
  mockEventEntries,
  mockEventListeners,
  nextId,
  nextMockEventId,
  ts,
  type MockAsset,
  type MockCanvas,
  type MockCanvasConnection,
  type MockCanvasMeta,
  type MockCanvasNode,
  type MockEventListener,
  type MockNodeLink,
  type MockSegment,
} from "./mock/db";
import { makeMockWav, mockGenRuns, MOCK_THUMBS, overviewOf, simulateAiGenerateImage } from "./mock/media";

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

    // ── 资源域与通用命令（画布链路会碰到的） ──
    case "get_resource_library_path":
      return libraryRoot;
    case "get_clipboard_records": {
      // 供「从资源库选文件」浮层挑选：剧本文件（挂剧本链路验证）、视频
      // （视频首帧/尾帧节点选片，2026-11-01）、图片与音频（类型过滤与
      // 音频保存/预览链路验证，2026-11-02——浮层按节点类型白名单过滤后
      // 各节点只见自己吃得掉的类型）。resourceGroup 过滤与后端同语义：
      // ""=库根未分组，路径=该分组含子级。
      const mockRecords = [
        {
          id: "rec-script-1",
          type: "file",
          content: `${libraryRoot}/scripts/第一集剧本.txt`,
          source_app: "mock",
          created_at: ts(),
          storage_mode: "resource",
          resource_path: `${libraryRoot}/scripts/第一集剧本.txt`,
          resource_kind: "text",
          resource_group: null,
        },
        {
          id: "rec-video-1",
          type: "file",
          // 指向可真实播放的 vite 静态视频（浏览器 mock 里 <video> 有真
          // 画面，视频工具节点的预览/钳制播放才可验证）。
          content: `${libraryRoot}/mock-clip.mp4`,
          source_app: "mock",
          created_at: ts(),
          storage_mode: "resource",
          resource_path: `${libraryRoot}/mock-clip.mp4`,
          resource_kind: "video",
          resource_group: null,
        },
        {
          id: "rec-image-1",
          type: "file",
          content: `${libraryRoot}/mock-image.png`,
          source_app: "mock",
          created_at: ts(),
          storage_mode: "resource",
          resource_path: `${libraryRoot}/mock-image.png`,
          resource_kind: "image",
          resource_group: null,
        },
        {
          id: "rec-audio-1",
          type: "file",
          content: `${libraryRoot}/mock-tone.wav`,
          source_app: "mock",
          created_at: ts(),
          storage_mode: "resource",
          resource_path: `${libraryRoot}/mock-tone.wav`,
          resource_kind: "audio",
          resource_group: null,
        },
      ];
      const group = typeof args?.resourceGroup === "string" ? args.resourceGroup : null;
      // 关键词过滤与后端同语义（文件名/路径子串，大小写不敏感）——浮层的
      // 「分组内搜索空态 → 在全部文件中搜索」兜底依赖它才可验证。
      const query = typeof args?.search === "string" ? args.search.trim().toLowerCase() : "";
      return mockRecords
        .filter((record) => !query || record.resource_path.toLowerCase().includes(query))
        .filter((record) => {
          if (group === null) return true;
          const prefix = `${libraryRoot}/`;
          if (!record.resource_path.startsWith(prefix)) return false;
          const dir = record.resource_path
            .slice(prefix.length)
            .replace(/[^\\/]+$/, "")
            .replace(/[\\/]+$/, "");
          if (group === "") return dir === "";
          return dir === group || dir.startsWith(`${group}/`) || dir.startsWith(`${group}\\`);
        });
    }
    case "get_image_thumbnail":
    case "get_resource_file_thumbnail": {
      // 浏览器 mock 的真预览：mock 库根即 vite 静态目录（mock/db.ts 的
      // libraryRoot），图片缩略图命令直接取原文件字节转 base64，列表与
      // 选择浮层的图片行因此有真画面可看（此前恒回空串 → 空 data URL
      // 永远裂图）。调用方按 image/png 包 data URL，故仅对 png 静态资产
      // 生效；非 http 路径或取不到回空串，走「无预览」占位回退，与后端
      // 解不动格式的语义一致。视频封面帧不在此列：load_resource_video_
      // poster 会被包成 image/jpeg，字节错配必裂图，现场抽帧已可用。
      const thumbPath = String(args?.path ?? "");
      if (!/^https?:/i.test(thumbPath)) return "";
      return fetch(thumbPath)
        .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(String(res.status)))))
        .then((buffer) => {
          const bytes = new Uint8Array(buffer);
          let binary = "";
          for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
          return btoa(binary);
        })
        .catch(() => "");
    }
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
      // 「从资源库选文件」浮层的分组树：mock 库里 scripts/、segments/ 两个
      // 顶级分组（与上方资源路径对应），根下另有三个直放文件（视频/图片/
      // 音频），首项固定为「未分组」空路径根。
      return [
        { name: "", path: "", count: 3, children: [] },
        { name: "scripts", path: "scripts", count: 1, children: [] },
        { name: "segments", path: "segments", count: 1, children: [] },
      ];

    // ── 上传链路（详情窗口「上传文件」）：选本机文件 → 复制入库 ──
    case "select_resource_trace_file":
      return { path: `${libraryRoot}\\scripts\\第一集剧本.txt` };
    case "import_resource_file":
      return { file_path: "scripts/第一集剧本.txt", kind: "text", name: "第一集剧本.txt" };

    // ── 画布域（自由生图工作流） ──
    case "canvas_list":
      return clone(db.canvases.map(canvasSummaryOf))
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    case "canvas_get": {
      const canvas = db.canvases.find((c) => c.id === args.canvasId);
      if (!canvas) throw new Error(`画布不存在：${String(args.canvasId)}`);
      return {
        canvas: clone(canvas),
        nodes: clone(db.canvas_nodes.filter((n) => n.canvas_id === canvas.id)),
        connections: clone(db.canvas_connections.filter((c) => c.canvas_id === canvas.id)),
      };
    }
    case "canvas_create": {
      const name = String(args.name ?? "").trim() || "未命名画布";
      const created: MockCanvas = {
        id: nextId("cv"), name,
        viewport_x: 0, viewport_y: 0, viewport_k: 1, groups: [],
        created_at: ts(), updated_at: ts(),
      };
      db.canvases.push(created);
      return canvasSummaryOf(created);
    }
    case "canvas_rename": {
      const canvas = db.canvases.find((c) => c.id === args.id);
      if (canvas) {
        canvas.name = String(args.name ?? "").trim();
        canvas.updated_at = ts();
      }
      return null;
    }
    case "canvas_delete": {
      const id = String(args.id ?? "");
      db.canvases = db.canvases.filter((c) => c.id !== id);
      db.canvas_nodes = db.canvas_nodes.filter((n) => n.canvas_id !== id);
      db.canvas_connections = db.canvas_connections.filter((c) => c.canvas_id !== id);
      return null;
    }
    case "canvas_set_viewport": {
      const canvas = db.canvases.find((c) => c.id === args.id);
      if (canvas) {
        canvas.viewport_x = Number(args.x ?? 0);
        canvas.viewport_y = Number(args.y ?? 0);
        canvas.viewport_k = Number(args.k ?? 1);
      }
      return null;
    }
    case "canvas_create_node": {
      const node: MockCanvasNode = {
        id: nextId("cn"),
        canvas_id: String(args.canvasId ?? ""),
        type: args.nodeType as MockCanvasNode["type"],
        title: String(args.title ?? ""),
        pos_x: Number(args.posX ?? 0),
        pos_y: Number(args.posY ?? 0),
        width: args.width != null ? Number(args.width) : null,
        height: args.height != null ? Number(args.height) : null,
        metadata: args.metadata ? (JSON.parse(String(args.metadata)) as MockCanvasMeta) : canvasDefaultMeta(args.nodeType as MockCanvasNode["type"]),
        resource_path: String(args.resourcePath ?? ""),
        created_at: ts(),
        updated_at: ts(),
      };
      db.canvas_nodes.push(node);
      const canvas = db.canvases.find((c) => c.id === node.canvas_id);
      if (canvas) canvas.updated_at = ts();
      // 真实后端建节点不 emit（前端 store 本地 push）；mock 补发是为了让
      // 绕过 store 的测试钩子（evaluate 直调 IPC 建节点）也能刷进图谱。
      // 补发必须延后到宏任务：同步 emit 会在 invoke 未 resolve、store 未
      // 本地 push 时触发重取，store 的本地 append 随后落在重取之后，同一
      // 节点进两次（2026-11-03 修复）。延后重取发生在 push 落定之后，
      // 正常路径幂等（整体替换），绕过 store 的写入照常刷进。
      setTimeout(() => mockEmit("canvas-changed", null), 0);
      return clone(node);
    }
    case "canvas_update_node": {
      const node = db.canvas_nodes.find((n) => n.id === args.id);
      if (node) {
        if (args.title != null) node.title = String(args.title);
        if (args.metadata != null) node.metadata = JSON.parse(String(args.metadata)) as MockCanvasMeta;
        if (args.resourcePath != null) node.resource_path = String(args.resourcePath);
        node.updated_at = ts();
        const canvas = db.canvases.find((c) => c.id === node.canvas_id);
        if (canvas) canvas.updated_at = ts();
        // 对齐真实后端（canvas_update_node emit canvas-changed，跨窗口同步）。
        mockEmit("canvas-changed", null);
      }
      return node ? clone(node) : null;
    }
    case "canvas_save_layout": {
      const canvasId = String(args.canvasId ?? "");
      for (const entry of (args.nodes as { id: string; pos_x: number; pos_y: number; width: number | null; height: number | null }[]) ?? []) {
        const node = db.canvas_nodes.find((n) => n.id === entry.id && n.canvas_id === canvasId);
        if (node) {
          node.pos_x = entry.pos_x;
          node.pos_y = entry.pos_y;
          node.width = entry.width;
          node.height = entry.height;
        }
      }
      return null;
    }
    case "canvas_delete_node": {
      const id = String(args.id ?? "");
      db.canvas_nodes = db.canvas_nodes.filter((n) => n.id !== id);
      db.canvas_connections = db.canvas_connections.filter((c) => c.from_node !== id && c.to_node !== id);
      mockEmit("canvas-changed", null);
      return null;
    }
    case "canvas_connect": {
      const canvasId = String(args.canvasId ?? "");
      const from = String(args.fromNode ?? "");
      const to = String(args.toNode ?? "");
      const existing = db.canvas_connections.find(
        (c) => c.canvas_id === canvasId && c.from_node === from && c.to_node === to,
      );
      if (existing) return clone(existing);
      const conn: MockCanvasConnection = { id: nextId("cc"), canvas_id: canvasId, from_node: from, to_node: to, to_port: String(args.toPort ?? ""), created_at: ts() };
      db.canvas_connections.push(conn);
      mockEmit("canvas-changed", null);
      return clone(conn);
    }
    case "canvas_rewire": {
      const row = db.canvas_connections.find((c) => c.id === args.id);
      if (!row) throw new Error(`连线不存在：${String(args.id)}`);
      const to = String(args.toNode ?? "");
      const merged = db.canvas_connections.find(
        (c) => c.canvas_id === row.canvas_id && c.from_node === row.from_node && c.to_node === to,
      );
      if (merged && merged.id !== row.id) {
        db.canvas_connections = db.canvas_connections.filter((c) => c.id !== row.id);
        return clone(merged);
      }
      row.to_node = to;
      row.to_port = String(args.toPort ?? row.to_port ?? "");
      return clone(row);
    }
    case "canvas_delete_connection": {
      db.canvas_connections = db.canvas_connections.filter((c) => c.id !== args.id);
      return null;
    }
    case "canvas_set_groups": {
      const canvas = db.canvases.find((c) => c.id === args.id);
      if (!canvas) throw new Error(`画布不存在：${String(args.id)}`);
      canvas.groups = JSON.parse(String(args.groups ?? "[]"));
      canvas.updated_at = ts();
      return { id: canvas.id, groups: clone(canvas.groups) };
    }
    case "canvas_pick_save_path":
    case "canvas_pick_save_dir":
      // 浏览器环境没有系统对话框：返回空串＝用户取消（前端静默）。
      return "";
    case "ai_generate_image":
      // 完整生成模拟：事件逐张回传 + 阻塞到完成（对齐后端时序）。
      return simulateAiGenerateImage(args);
    case "canvas_extract_video_frame": {
      // 视频抽帧模拟（2026-11-01）：约 0.9s 后回一张 mock 帧图（dataURL
      // 直接可显示，下游聚合/自动保存走通用 resource_path 语义）。
      const which = String(args.which ?? "first");
      return new Promise((resolve) => {
        setTimeout(() => {
          const idx = which === "last" ? 7 : 3;
          resolve({ path: MOCK_THUMBS[idx % MOCK_THUMBS.length] });
        }, 900);
      });
    }
    case "canvas_video_timeline": {
      // 视频工具时间轴模拟（2026-11-02）：时长与 mock 短片对齐（8s，
      // 真机后端按 4 帧/秒 24–150 生成），32 帧渐变小图铺「画面轨」；
      // 竖屏 9:16 验证竖版画面的铺格还原。
      const thumbs = Array.from({ length: 32 }, (_, i) => ({
        t: (i * 8) / 32,
        path: MOCK_THUMBS[i % MOCK_THUMBS.length],
      }));
      return { duration: 8, w: 104, h: 185, thumbnails: thumbs };
    }
    case "canvas_seek_video_frame": {
      // 任意时刻抽帧：按秒数取最近的 mock 帧图。
      const secs = Number(args.secs ?? 0);
      return new Promise((resolve) => {
        setTimeout(() => {
          const idx = Math.floor(secs) % MOCK_THUMBS.length;
          resolve({ path: MOCK_THUMBS[Math.max(0, idx)] });
        }, 900);
      });
    }
    case "canvas_convert_video_gif":
      // 转 GIF：回一张 mock 帧图当动图占位（img 可直接显示）。
      return new Promise((resolve) => {
        setTimeout(() => resolve({ path: MOCK_THUMBS[5] }), 1400);
      });
    case "canvas_extract_audio": {
      // 抽音轨：程序生成一小段 wav dataURL（440Hz 正弦 2 秒），audio 元素可直接播。
      return new Promise((resolve) => {
        setTimeout(() => resolve({ path: makeMockWav(2) }), 900);
      });
    }
    case "ai_cancel_generation": {
      const run = mockGenRuns.get(String(args.requestId ?? ""));
      if (run) run.cancelled = true;
      return null;
    }

    // ── 画布 AI 渠道（设置页，内存 CRUD） ──
    case "list_ai_channels":
      return clone([...db.ai_channels].sort((a, b) => a.sortOrder - b.sortOrder));
    case "create_ai_channel": {
      const protocol = String(args.protocol ?? "openai");
      const row = {
        id: nextId("ch"),
        name: String(args.name ?? "") || (protocol === "gemini" ? "Gemini" : "OpenAI 兼容"),
        protocol,
        baseUrl: String(args.baseUrl ?? ""),
        apiKeyPreview: String(args.apiKey ?? "").slice(0, 8) + "..." + String(args.apiKey ?? "").slice(-4),
        apiKeySet: String(args.apiKey ?? "").trim() !== "",
        model: String(args.model ?? ""),
        price: (args.price ?? null) as number | null,
        currency: String(args.currency ?? "$"),
        enabled: true,
        status: "normal",
        lastError: "",
        lastLatencyMs: null as number | null,
        lastTestedAt: "",
        cooldownUntilMs: 0,
        sortOrder: db.ai_channels.length,
      };
      db.ai_channels.push(row);
      return clone(db.ai_channels);
    }
    case "update_ai_channel": {
      const row = db.ai_channels.find((c) => c.id === args.id);
      if (!row) throw new Error(`渠道不存在：${String(args.id)}`);
      row.name = String(args.name ?? row.name);
      row.protocol = String(args.protocol ?? row.protocol);
      row.baseUrl = String(args.baseUrl ?? row.baseUrl);
      const apiKey = args.apiKey == null ? "" : String(args.apiKey);
      if (apiKey.trim() !== "") row.apiKeyPreview = apiKey.slice(0, 8) + "..." + apiKey.slice(-4);
      row.model = String(args.model ?? "");
      row.price = (args.price ?? null) as number | null;
      row.currency = String(args.currency ?? "$");
      return clone([...db.ai_channels].sort((a, b) => a.sortOrder - b.sortOrder));
    }
    case "delete_ai_channel":
      db.ai_channels = db.ai_channels.filter((c) => c.id !== args.id);
      return null;
    case "reorder_ai_channels": {
      const ids = (args.ids ?? []) as string[];
      for (const [index, id] of ids.entries()) {
        const row = db.ai_channels.find((c) => c.id === id);
        if (row) row.sortOrder = index;
      }
      return null;
    }
    case "set_ai_channel_enabled": {
      const row = db.ai_channels.find((c) => c.id === args.id);
      if (row) {
        row.enabled = Boolean(args.enabled);
        if (row.enabled) {
          row.status = "normal";
          row.lastError = "";
          row.cooldownUntilMs = 0;
        }
      }
      return null;
    }
    case "restore_ai_channel": {
      const row = db.ai_channels.find((c) => c.id === args.id);
      if (row) {
        row.status = "normal";
        row.lastError = "";
        row.cooldownUntilMs = 0;
      }
      return null;
    }
    case "ai_test_channel": {
      const row = db.ai_channels.find((c) => c.id === args.channelId);
      const latencyMs = 300 + Math.floor(Math.random() * 900);
      if (row) {
        row.lastLatencyMs = latencyMs;
        row.lastTestedAt = ts();
        row.status = "normal";
        row.lastError = "";
      }
      return { ok: true, latencyMs };
    }

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
        // 事件插件命令：listen 把 handler 回调登记进 mockEventListeners，
        // 供 mockEmit 广播；unlisten 按 eventId 真正摘除。
        if (cmd === "plugin:event|listen") {
          const cb = callbacks.get(Number(args?.handler));
          if (cb && typeof args?.event === "string") {
            const entry = { event: args.event, cb: cb as MockEventListener };
            const eventId = nextMockEventId();
            mockEventListeners.push(entry);
            mockEventEntries.set(eventId, entry);
            return Promise.resolve(eventId);
          }
          return Promise.resolve(nextMockEventId());
        }
        if (cmd === "plugin:event|unlisten") {
          const entry = mockEventEntries.get(Number(args?.eventId));
          if (entry) {
            const idx = mockEventListeners.indexOf(entry);
            if (idx >= 0) mockEventListeners.splice(idx, 1);
            mockEventEntries.delete(Number(args?.eventId));
          }
          return Promise.resolve(null);
        }
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
  // 测试钩子：允许页面上下文（Playwright 等）广播 mock 事件，例如驱动
  // OS 拖入链路 mockEmit("tauri://drag-drop", { paths, position })。
  (window as unknown as { __TAURI_MOCK_EMIT__?: (event: string, payload: unknown) => void }).__TAURI_MOCK_EMIT__ =
    mockEmit;

  try {
    window.localStorage.setItem("resource_view_mode", "project");
    window.localStorage.setItem("project_current_show", "show-1");
    window.localStorage.setItem("project_current_episode", "ep-1");
  } catch {
    // 存储不可用：仅影响初始定位。
  }
  console.info("[tauriMock] 已注入浏览器内存后端（仅开发验证用）");
}
