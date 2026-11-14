// 浏览器验证专用内存后端——自由画布域与 AI 渠道命令分派。自
// dev/tauriMock.ts 零改动拆分（2026-11-14，守卫规则 27 行数上限），数据与
// 事件通道见 ./db，媒体合成与 AI 生成模拟见 ./media。

import {
  canvasDefaultMeta,
  canvasSummaryOf,
  clone,
  db,
  mockEmit,
  MOCK_NOT_HANDLED,
  nextId,
  ts,
  type MockCanvas,
  type MockCanvasConnection,
  type MockCanvasMeta,
  type MockCanvasNode,
} from "./db";
import { makeMockWav, mockGenRuns, MOCK_THUMBS, simulateAiGenerateImage } from "./media";

export function handleCanvasAiCommands(cmd: string, args: Record<string, unknown>): unknown {
  switch (cmd) {
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
    case "canvas_save_to_library":
      // 保存节点入库模拟：按分组/基名拼库内相对路径（与真实现同构，
      // 便于联调目标行/浮层与重存反馈）。
      return (() => {
        const source = String(args.sourcePath ?? "");
        const raw = source.split(/[\\/]/).pop() ?? "产物.png";
        const base = String(args.baseName ?? "").trim();
        const group = String(args.groupPath ?? "").trim();
        const name = base || raw;
        return {
          file_path: group ? `${group}/${name}` : name,
          kind: "image",
          name,
        };
      })();
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
        proxy: String(args.proxy ?? ""),
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
      // 空串 = 清除渠道级代理（与后端语义一致），有值即覆盖。
      row.proxy = String(args.proxy ?? "");
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

    default:
      return MOCK_NOT_HANDLED;
  }
}
