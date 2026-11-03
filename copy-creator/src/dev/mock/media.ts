// 浏览器验证专用内存后端：合成媒体（程序化产物缩略图 / 正弦 wav）+
// ai_generate_image 模拟（逐张回传节奏与后端一致）+ 工程概览聚合
// （自 dev/tauriMock.ts 零改动拆分，2026-11-03 阶段 10）。

import {
  assetById,
  clone,
  db,
  mockEmit,
  nextId,
  ts,
} from "./db";

/** 生成模拟运行句柄（供取消）。 */
export const mockGenRuns = new Map<string, { cancelled: boolean }>();

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

export const MOCK_THUMBS = [214, 262, 22, 160, 330, 46, 190, 286, 100, 8, 244, 32, 58, 176, 306].map(makeMockThumb);

/** 程序生成 440Hz 正弦波 wav dataURL（音轨节点 mock 产物，audio 可直接播）。 */
export function makeMockWav(seconds: number): string {
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
export function simulateAiGenerateImage(args: Record<string, unknown>): Promise<unknown> {
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

export function overviewOf(episodeId: string) {
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
