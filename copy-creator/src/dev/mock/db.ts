// 浏览器验证专用内存后端（仅开发验证用，真实 Tauri 应用永不加载）：
// 类型 + 内存数据库种子 + 事件回传通道（自 dev/tauriMock.ts 零改动拆分，
// 2026-11-03 阶段 10）。媒体合成与命令分派见 ./media 与 ../tauriMock。

// 可真实播放的 8 秒测试视频（testsrc 烧录时间码，dev 资产由 vite 静态
// 服务）：浏览器 mock 里 <video> 要有真画面/可播放，才能验证视频工具
// 节点的预览 seek、选区钳制播放等时间更新类交互。vite 给根相对 URL
// （/src/...），会被媒体解析当成 POSIX 绝对本地路径转进媒体服务（浏览器
// mock 无服务，实测「媒体无法加载」）；补全为完整 http URL 走直通分支。
import mockClipSrc from "../mock-clip.mp4?url";
const mockClipUrl = new URL(mockClipSrc, window.location.origin).href;


export interface MockSegment {
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

export interface MockNodeLink {
  id: string;
  from_kind: "asset" | "character" | "location" | "prop" | "script" | "segment" | "shot";
  from_id: string;
  to_segment: string;
  to_port: "character" | "location" | "prop" | "prompt" | "script" | "other";
  /** 发出节点身份（grp:<组id>），空串 = 非组来源（与后端 owner_key 同义）。 */
  owner_key?: string;
}

// ── 画布域（db/canvas.rs 三表的内存对应物） ──────────────────

export interface MockCanvas {
  id: string;
  name: string;
  viewport_x: number;
  viewport_y: number;
  viewport_k: number;
  groups: { id: string; label: string; members: string[] }[];
  created_at: string;
  updated_at: string;
}

export type MockCanvasMeta = Record<string, unknown>;

export interface MockCanvasNode {
  id: string;
  canvas_id: string;
  type:
    | "gen_image" | "gen_video" | "gen_audio"
    | "load_text" | "load_image" | "load_audio" | "load_video"
    | "video_first_frame" | "video_last_frame"
    | "video_seek_frame" | "video_to_gif" | "video_extract_audio"
    | "save_image" | "save_video" | "save_audio"
    | "preview_image" | "preview_video" | "preview_audio"
    | "collection_image" | "collection_text" | "collection_video"
    | "note";
  title: string;
  pos_x: number;
  pos_y: number;
  width: number | null;
  height: number | null;
  metadata: MockCanvasMeta;
  resource_path: string;
  created_at: string;
  updated_at: string;
}

export interface MockCanvasConnection {
  id: string;
  canvas_id: string;
  from_node: string;
  to_node: string;
  to_port: string;
  created_at: string;
}

/** 画布 AI 渠道（设置页 mock）：与 stores/settingsStore 的 AiChannel 对齐。 */
export interface MockAiChannel {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  apiKeyPreview: string;
  apiKeySet: boolean;
  model: string;
  price: number | null;
  currency: string;
  enabled: boolean;
  status: string;
  lastError: string;
  lastLatencyMs: number | null;
  lastTestedAt: string;
  cooldownUntilMs: number;
  sortOrder: number;
}

export interface MockScene {
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

export interface MockShot {
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

export interface MockAsset {
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

export const ts = () => new Date().toISOString();
// id 计数从 100 起跳：初始样例数据的手写 id（nl-m1、nl-m2、seg-1…）占用
// 了低位段，运行期新生成的 id 撞上会让「删一行/React key」错乱到另一行
// （实测：新连线与初始连线同 id，摘一条删掉两条）。
let seq = 100;
export const nextId = (prefix: string) => `${prefix}-m${seq++}`;

// ── 内存数据库：一剧一集，覆盖八类节点与两类连线的最小样例 ──
export const db = {
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
    { id: "char-1", name: "小雨", role_tag: "主角", bio: "", prompt: "", avatar_path: "", reference_paths: "", voice_path: "tones/xiaoyu-qingleng.wav", created_at: ts(), updated_at: ts() },
    { id: "char-2", name: "老周", role_tag: "配角", bio: "", prompt: "", avatar_path: "", reference_paths: "", voice_path: "", created_at: ts(), updated_at: ts() },
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
  // 画布域种子：预置一个画布 + 提示词→生图 最小工作流，浏览器直接有内容可查。
  canvases: [
    { id: "cv-1", name: "示例画布", viewport_x: 0, viewport_y: 0, viewport_k: 1, groups: [], created_at: ts(), updated_at: ts() },
  ] as MockCanvas[],
  canvas_nodes: [
    {
      id: "cn-1", canvas_id: "cv-1", type: "load_text" as const, title: "",
      pos_x: 120, pos_y: 160, width: 260, height: 170,
      metadata: { kind: "load_text", content: "一只戴礼帽的猫，水彩风格，高细节" },
      resource_path: "", created_at: ts(), updated_at: ts(),
    },
    {
      id: "cn-2", canvas_id: "cv-1", type: "gen_image" as const, title: "",
      pos_x: 480, pos_y: 110, width: 280, height: null,
      metadata: { kind: "gen_image", params: { model: "", size: "", count: 4 }, status: "idle", error: "", images: [] },
      resource_path: "", created_at: ts(), updated_at: ts(),
    },
    {
      id: "cn-3", canvas_id: "cv-1", type: "save_image" as const, title: "",
      pos_x: 860, pos_y: 150, width: 250, height: null,
      metadata: { kind: "save_image", status: "", error: "", target: "", saved_path: "" },
      resource_path: "", created_at: ts(), updated_at: ts(),
    },
    {
      // 视频首帧节点（2026-11-01）：预置已加载视频，供抽帧链路验证。
      id: "cn-4", canvas_id: "cv-1", type: "video_first_frame" as const, title: "",
      pos_x: 480, pos_y: 430, width: 280, height: null,
      metadata: { kind: "video_first_frame", video_path: mockClipUrl },
      resource_path: "", created_at: ts(), updated_at: ts(),
    },
    {
      // 视频尾帧节点（2026-11-01）：空态展示，验证拖入/执行链路。
      id: "cn-5", canvas_id: "cv-1", type: "video_last_frame" as const, title: "",
      pos_x: 800, pos_y: 430, width: 280, height: null,
      metadata: { kind: "video_last_frame", video_path: "" },
      resource_path: "", created_at: ts(), updated_at: ts(),
    },
    {
      // 视频工具节点（2026-11-02）：抽帧已载视频（验证时间轴/选点/执行）、
      // GIF 与音轨空态，验证建菜单/拖入链路。
      id: "cn-6", canvas_id: "cv-1", type: "video_seek_frame" as const, title: "",
      pos_x: 480, pos_y: 760, width: 460, height: null,
      metadata: { kind: "video_seek_frame", video_path: mockClipUrl, start_secs: 0, duration_secs: 0, format: "" },
      resource_path: "", created_at: ts(), updated_at: ts(),
    },
    {
      id: "cn-7", canvas_id: "cv-1", type: "video_to_gif" as const, title: "",
      pos_x: 900, pos_y: 760, width: 460, height: null,
      metadata: { kind: "video_to_gif", video_path: "", start_secs: 0, duration_secs: 3, format: "" },
      resource_path: "", created_at: ts(), updated_at: ts(),
    },
    {
      id: "cn-8", canvas_id: "cv-1", type: "video_extract_audio" as const, title: "",
      pos_x: 1420, pos_y: 760, width: 460, height: null,
      metadata: { kind: "video_extract_audio", video_path: "", start_secs: 0, duration_secs: 0, format: "" },
      resource_path: "", created_at: ts(), updated_at: ts(),
    },
  ] as MockCanvasNode[],
  canvas_connections: [
    { id: "cc-1", canvas_id: "cv-1", from_node: "cn-1", to_node: "cn-2", to_port: "text", created_at: ts() },
    { id: "cc-2", canvas_id: "cv-1", from_node: "cn-2", to_node: "cn-3", to_port: "in", created_at: ts() },
  ] as MockCanvasConnection[],
  // 画布 AI 渠道（设置页）：两条示例渠道，覆盖健康/未测试两种状态，
  // 供浏览器验证渠道管理与调度交互。
  ai_channels: [
    {
      id: "ch-1", name: "示例渠道 A", protocol: "openai", baseUrl: "https://api.openai.com",
      apiKeyPreview: "sk-mock1...abcd", apiKeySet: true, model: "gpt-image-1",
      price: 0.04, currency: "$", enabled: true, status: "normal", lastError: "",
      lastLatencyMs: 980, lastTestedAt: ts(), cooldownUntilMs: 0, sortOrder: 0,
    },
    {
      id: "ch-2", name: "示例渠道 B", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com",
      apiKeyPreview: "AIza-mock...wxyz", apiKeySet: true, model: "",
      price: null, currency: "$", enabled: true, status: "normal", lastError: "",
      lastLatencyMs: null, lastTestedAt: "", cooldownUntilMs: 0, sortOrder: 1,
    },
  ] as MockAiChannel[],
};

/** 画布节点默认 metadata（对齐 Rust NodeMeta::default_for）。 */
export function canvasDefaultMeta(type: MockCanvasNode["type"]): MockCanvasMeta {
  switch (type) {
    case "load_text": return { kind: "load_text", content: "" };
    case "note": return { kind: "note", content: "" };
    case "load_image": case "load_video": case "load_audio":
    case "preview_image": case "preview_video": case "preview_audio":
      return { kind: type };
    case "video_first_frame": case "video_last_frame":
      return { kind: type, video_path: "" };
    case "video_seek_frame": case "video_extract_audio":
      return { kind: type, video_path: "", start_secs: 0, duration_secs: 0, format: "" };
    case "video_to_gif":
      return { kind: type, video_path: "", start_secs: 0, duration_secs: 3, format: "" };
    case "gen_image":
      return { kind: "gen_image", params: { model: "", size: "", count: 1 }, status: "idle", error: "", images: [] };
    case "gen_video": case "gen_audio":
      return { kind: type, params: { model: "", size: "", count: 1 }, status: "idle", error: "" };
    case "save_image": case "save_video": case "save_audio":
      return { kind: type, status: "", error: "", target: "", saved_path: "" };
    case "collection_image": case "collection_text": case "collection_video":
      return { kind: type, order: [] };
  }
}

export function canvasSummaryOf(canvas: MockCanvas) {
  return {
    ...clone(canvas),
    node_count: db.canvas_nodes.filter((n) => n.canvas_id === canvas.id).length,
    connection_count: db.canvas_connections.filter((c) => c.canvas_id === canvas.id).length,
  };
}

// 库根指向 vite 静态目录：资源浮层按「库内相对路径」约定过滤记录
// （relativeLibraryPath 为空即丢弃），mock 视频须在库根之内才会出现在
// 浮层；库内路径经 joinLibraryPath 拼回后是可播放的 http URL，预览/
// 视频工具节点全链路可用。文本记录同改斜杠风格保持一致。
export const libraryRoot = `${window.location.origin}/src/dev`;
export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const assetById = (id: string) => db.assets.find((a) => a.id === id);


// ── 事件回传通道：installBrowserMock 拦截 plugin:event|listen 登记回调，
// mockEmit 按 {event,id,payload} 广播——逐张回传/canvas-changed 都走它。

export type MockEventListener = (e: { event: string; id: number; payload: unknown }) => void;
export const mockEventListeners: { event: string; cb: MockEventListener }[] = [];
// listen 返回的 eventId → 条目：unlisten 据此真正摘除。不摘会导致
// 组件随依赖重挂时监听器滚雪球，一次 mockEmit 触发多次响应。
export const mockEventEntries = new Map<number, { event: string; cb: MockEventListener }>();
let mockEventSeq = 1;
/** 装配层取事件 id（mockEventSeq 为模块私有，ESM 导入侧不可赋值）。 */
export function nextMockEventId(): number {
  return mockEventSeq++;
}

export function mockEmit(event: string, payload: unknown): void {
  for (const l of [...mockEventListeners]) {
    if (l.event === event) l.cb({ event, id: mockEventSeq++, payload });
  }
}
