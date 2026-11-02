// 浏览器验证专用内存后端：页面不在 Tauri 环境运行（无 __TAURI_INTERNALS__）
// 时由 main.tsx 动态注入，用于在普通浏览器里跑通工程画布等界面的前端验证
// 与模拟（自动化截图、交互走查）。真实 Tauri 应用永远不会加载本模块。

// 可真实播放的 8 秒测试视频（testsrc 烧录时间码，dev 资产由 vite 静态
// 服务）：浏览器 mock 里 <video> 要有真画面/可播放，才能验证视频工具
// 节点的预览 seek、选区钳制播放等时间更新类交互。vite 给根相对 URL
// （/src/...），会被媒体解析当成 POSIX 绝对本地路径转进媒体服务（浏览器
// mock 无服务，实测「媒体无法加载」）；补全为完整 http URL 走直通分支。
import mockClipSrc from "./mock-clip.mp4?url";
const mockClipUrl = new URL(mockClipSrc, window.location.origin).href;

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
  to_port: "character" | "location" | "prop" | "prompt" | "script" | "other";
  /** 发出节点身份（grp:<组id>），空串 = 非组来源（与后端 owner_key 同义）。 */
  owner_key?: string;
}

// ── 画布域（db/canvas.rs 三表的内存对应物） ──────────────────

interface MockCanvas {
  id: string;
  name: string;
  viewport_x: number;
  viewport_y: number;
  viewport_k: number;
  groups: { id: string; label: string; members: string[] }[];
  created_at: string;
  updated_at: string;
}

type MockCanvasMeta = Record<string, unknown>;

interface MockCanvasNode {
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

interface MockCanvasConnection {
  id: string;
  canvas_id: string;
  from_node: string;
  to_node: string;
  to_port: string;
  created_at: string;
}

/** 画布 AI 渠道（设置页 mock）：与 stores/settingsStore 的 AiChannel 对齐。 */
interface MockAiChannel {
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
// id 计数从 100 起跳：初始样例数据的手写 id（nl-m1、nl-m2、seg-1…）占用
// 了低位段，运行期新生成的 id 撞上会让「删一行/React key」错乱到另一行
// （实测：新连线与初始连线同 id，摘一条删掉两条）。
let seq = 100;
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
function canvasDefaultMeta(type: MockCanvasNode["type"]): MockCanvasMeta {
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

function canvasSummaryOf(canvas: MockCanvas) {
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
const libraryRoot = `${window.location.origin}/src/dev`;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const assetById = (id: string) => db.assets.find((a) => a.id === id);

// ── 事件回传通道：installBrowserMock 拦截 plugin:event|listen 登记回调，
// mockEmit 按 {event,id,payload} 广播——逐张回传/canvas-changed 都走它。

type MockEventListener = (e: { event: string; id: number; payload: unknown }) => void;
const mockEventListeners: { event: string; cb: MockEventListener }[] = [];
// listen 返回的 eventId → 条目：unlisten 据此真正摘除。不摘会导致
// 组件随依赖重挂时监听器滚雪球，一次 mockEmit 触发多次响应。
const mockEventEntries = new Map<number, { event: string; cb: MockEventListener }>();
let mockEventSeq = 1;

function mockEmit(event: string, payload: unknown): void {
  for (const l of [...mockEventListeners]) {
    if (l.event === event) l.cb({ event, id: mockEventSeq++, payload });
  }
}

/** 生成模拟运行句柄（供取消）。 */
const mockGenRuns = new Map<string, { cancelled: boolean }>();

/** 程序化产物图：渐变 + 光斑 dataURL（与原型 makeThumb 同思路）。 */
function makeMockThumb(hue: number): string {
  // 9:16 竖版产物：贴近短视频工作流的素材比例，让「内容节点完整显示
  // （媒体盒两侧留黑边）vs 控制台紧凑封面」的差异在 mock 里真实可见。
  const c = document.createElement("canvas");
  c.width = 104;
  c.height = 185;
  const g = c.getContext("2d");
  if (!g) return "";
  const grad = g.createLinearGradient(0, 0, 104, 185);
  grad.addColorStop(0, `hsl(${hue} 72% 66%)`);
  grad.addColorStop(1, `hsl(${hue + 46} 78% 38%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 104, 185);
  for (let i = 0; i < 4; i++) {
    g.beginPath();
    g.fillStyle = `hsla(${hue + 30 + i * 55} 92% 78% / 0.5)`;
    g.arc(18 + Math.random() * 70, 16 + Math.random() * 155, 12 + Math.random() * 18, 0, 6.29);
    g.fill();
  }
  g.beginPath();
  g.fillStyle = "rgba(255,255,255,0.85)";
  g.arc(76, 26, 9, 0, 6.29);
  g.fill();
  return c.toDataURL("image/png");
}

const MOCK_THUMBS = [214, 262, 22, 160, 330, 46, 190, 286, 100, 8, 244, 32, 58, 176, 306].map(makeMockThumb);

/** 程序生成 440Hz 正弦波 wav dataURL（音轨节点 mock 产物，audio 可直接播）。 */
function makeMockWav(seconds: number): string {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate * Math.max(0.2, seconds));
  const dataSize = samples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const amp = 0.32 * Math.sin(2 * Math.PI * 440 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 2 * t));
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, amp)) * 32767, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/** ai_generate_image 模拟（2026-11-01 生成等待动效验证）：generating 落库
 *  → canvas-changed → started 事件 → 逐张回传（间隔 620-1140ms，与真实
 *  并发节奏同量级）→ 汇总落库 + canvas-changed → 命令 resolve（阻塞到
 *  全部槽位落定，与后端一致）。走向由 window.__tauriMockGenMode 控制：
 *  done 全成（默认）/ fail 全败 / partial 指定槽失败；取消走
 *  ai_cancel_generation（被取消的槽位不回传，与后端 __cancelled__ 一致）。 */
function simulateAiGenerateImage(args: Record<string, unknown>): Promise<unknown> {
  const nodeId = String(args.nodeId ?? "");
  const node = db.canvas_nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("节点不存在");
  const meta = node.metadata as { kind: string; params: { count: number }; status: string };
  if (meta.kind !== "gen_image") throw new Error("节点 metadata 类型异常");
  if (meta.status === "generating") throw new Error("该节点正在生成中，请等它完成或先取消");
  const count = Math.min(15, Math.max(1, meta.params.count || 1));
  const requestId = nextId("req");
  const mode = (window as unknown as { __tauriMockGenMode?: string }).__tauriMockGenMode ?? "done";
  node.metadata = { ...node.metadata, status: "generating", error: "", images: [] };
  node.updated_at = ts();
  mockEmit("canvas-changed", null);
  mockEmit("canvas-generation-started", { requestId, nodeId });

  const run = { cancelled: false };
  mockGenRuns.set(requestId, run);
  const received: { slot: number; url: string }[] = [];
  const errors: string[] = [];
  let slotDelay = 900;
  const schedule: { at: number; slot: number; fail: boolean }[] = [];
  for (let slot = 0; slot < count; slot++) {
    const fail = mode === "fail" || (mode === "partial" && slot === 1);
    schedule.push({ at: slotDelay, slot, fail });
    slotDelay += 620 + Math.floor(Math.random() * 520);
  }
  const finalizeAt = slotDelay + 300;
  return new Promise((resolve) => {
    for (const { at, slot, fail } of schedule) {
      window.setTimeout(() => {
        if (run.cancelled) return; // 取消的槽位不回传（与后端语义一致）
        if (fail) {
          const err = "模拟生成失败：请求超时（60s）";
          errors.push(err);
          mockEmit("canvas-generation-progress", { requestId, nodeId, slot, error: err });
          return;
        }
        const url = MOCK_THUMBS[slot % MOCK_THUMBS.length];
        received.push({ slot, url });
        mockEmit("canvas-generation-progress", { requestId, nodeId, slot, dataUrl: url });
      }, at);
    }
    window.setTimeout(() => {
      mockGenRuns.delete(requestId);
      const sorted = [...received].sort((a, b) => a.slot - b.slot);
      const saved = sorted.map(({ url }, idx) => ({
        width: 1024,
        height: 1024,
        bytes: 1024,
        resource_path: url,
        primary: idx === 0,
      }));
      const cancelled = run.cancelled;
      const status = saved.length === 0 || cancelled || errors.length > 0 ? "error" : "done";
      const errorMsg =
        cancelled
          ? `已取消（保留 ${saved.length} 张已完成）`
          : errors.length === 0
            ? ""
            : saved.length === 0
              ? errors[0]
              : `${saved.length}/${count} 张成功：${errors[0]}`;
      node.metadata = { ...node.metadata, status, error: errorMsg, images: saved };
      node.updated_at = ts();
      mockEmit("canvas-changed", null);
      resolve({
        requestId,
        status,
        error: errorMsg,
        images: clone(saved),
        cancelled,
        canvasName: "示例画布",
        nodeName: "图片",
      });
    }, finalizeAt);
  });
}

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
            (owner ? (l.owner_key ?? "") === owner : true)
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
        }
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
            const eventId = mockEventSeq++;
            mockEventListeners.push(entry);
            mockEventEntries.set(eventId, entry);
            return Promise.resolve(eventId);
          }
          return Promise.resolve(mockEventSeq++);
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
