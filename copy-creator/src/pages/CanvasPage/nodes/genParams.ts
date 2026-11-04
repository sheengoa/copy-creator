import { useCanvasStore, type CanvasNode } from "../../../stores/canvasStore";

// 生成族参数域（无组件模块）：模型/尺寸预设清单、尺寸取值双段展示、
// 参数写回。gen_image 与 gen_video/gen_audio 占位共用。

export const MODEL_PRESET_BASE = ["gpt-image-1", "gemini-2.5-flash-image"];

/** 尺寸条目（2026-11-04 按模型分流，原型定案）：下拉条目主文案 = 比例，
 *  下行弱化注 = 分辨率；tier 档位角标；shape 为宽高比示意小框 [宽,高]
 *  （视图内按真实比例绘制的描边小框，替代横/竖文字）。落库存值：
 *  GPT 项存显式像素（OpenAI 官方仅认 auto + 1:1/3:2/2:3 这几档，其余
 *  会被拒收——旧混装清单是生成报错源头）；Gemini 项 1K 档存比例串
 *  （后端 resolve_request_size 对 "W:H" 原生换算，无 quality 固定落 1K
 *  预设，故 2K 档必须存显式像素）；auto 通用。legacyValues 兼容旧混装
 *  清单的像素存量（仅展示命中用，不参与落库）。 */
export type SizeComboItem = {
  value: string;
  label: string;
  desc?: string;
  tier?: string;
  shape?: readonly [number, number];
  legacyValues?: string[];
};

type SizeItemSeed = {
  value: string;
  ratio: string;
  tier?: string;
  shape?: readonly [number, number];
  resolution?: string;
  /** 分辨率随模型档位浮动（Gemini）→ 加 i18n「约」前缀。 */
  approx?: boolean;
  /** 条目为 auto：desc 用 i18n 跟随模型提示。 */
  autoHint?: boolean;
  legacyValues?: string[];
};

const SHAPE = {
  s11: [11, 11],
  s32: [15, 10],
  s23: [10, 15],
  s169: [15, 8],
  s916: [8, 15],
  s43: [13, 10],
  s34: [10, 13],
} as const satisfies Record<string, readonly [number, number]>;

/** GPT（gpt-image 系）官方支持项。 */
const GPT_SEED: SizeItemSeed[] = [
  { value: "auto", ratio: "auto", autoHint: true },
  { value: "1024x1024", ratio: "1:1", tier: "1K", shape: SHAPE.s11, resolution: "1024 × 1024" },
  { value: "1536x1024", ratio: "3:2", tier: "1K", shape: SHAPE.s32, resolution: "1536 × 1024" },
  { value: "1024x1536", ratio: "2:3", tier: "1K", shape: SHAPE.s23, resolution: "1024 × 1536" },
];

/** Gemini 全比例（后端按最近支持比例归一，分辨率随档位浮动 → 约）；
 *  自定义/未知模型同用此全量（原型定案）。 */
const GEMINI_SEED: SizeItemSeed[] = [
  { value: "auto", ratio: "auto", autoHint: true },
  { value: "1:1", ratio: "1:1", tier: "1K", shape: SHAPE.s11, resolution: "1024 × 1024", approx: true, legacyValues: ["1024x1024"] },
  { value: "3:2", ratio: "3:2", tier: "1K", shape: SHAPE.s32, resolution: "1536 × 1024", approx: true, legacyValues: ["1536x1024"] },
  { value: "2:3", ratio: "2:3", tier: "1K", shape: SHAPE.s23, resolution: "1024 × 1536", approx: true, legacyValues: ["1024x1536"] },
  { value: "16:9", ratio: "16:9", tier: "1K", shape: SHAPE.s169, resolution: "1536 × 864", approx: true, legacyValues: ["1536x864"] },
  { value: "9:16", ratio: "9:16", tier: "1K", shape: SHAPE.s916, resolution: "864 × 1536", approx: true, legacyValues: ["864x1536"] },
  { value: "4:3", ratio: "4:3", tier: "1K", shape: SHAPE.s43, resolution: "1024 × 768", approx: true, legacyValues: ["1024x768"] },
  { value: "3:4", ratio: "3:4", tier: "1K", shape: SHAPE.s34, resolution: "768 × 1024", approx: true, legacyValues: ["768x1024"] },
  // 2K 档：比例串无 quality 时固定落 1K 预设，必须存显式像素（后端按
  // 最大边阈值归档 2K，宽高取最近比例，链路原生）。
  { value: "2048x1152", ratio: "16:9", tier: "2K", shape: SHAPE.s169, resolution: "2048 × 1152" },
  { value: "1152x2048", ratio: "9:16", tier: "2K", shape: SHAPE.s916, resolution: "1152 × 2048" },
];

/** 旧混装清单像素值的跨模型展示兜底（如旧 gpt 节点存过 1536x864）：按
 *  value/legacyValues 命中即以该比例形态展示，不进任何下拉清单。 */
const LEGACY_SEEDS: SizeItemSeed[] = [...GPT_SEED, ...GEMINI_SEED];

/** 按模型分流清单：gpt-image → 官方支持项；gemini → 全比例；自定义/
 *  未知模型 → 全量（原型定案）。 */
export function sizePresetItemsFor(model: string, t: (key: string) => string): SizeComboItem[] {
  const seed = /gemini/i.test(model)
    ? GEMINI_SEED
    : /gpt-image/i.test(model)
      ? GPT_SEED
      : GEMINI_SEED;
  return seed.map((s) => ({
    value: s.value,
    legacyValues: s.legacyValues,
    label: s.ratio,
    tier: s.tier,
    shape: s.shape,
    desc: s.autoHint
      ? t("canvas.genSizeAutoHint")
      : s.resolution
        ? s.approx
          ? `${t("canvas.genSizeApprox")} ${s.resolution}`
          : s.resolution
        : undefined,
  }));
}

/** 尺寸取值展示（用户 2026-11-01 定案「主值 + 弱化尾注」双段；2026-11-04
 *  翻转为比例为主、分辨率为尾注）：命中当前清单 → 比例 + 分辨率注；
 *  未命中 → 跨模型旧值兜底；再否则自定义值原样展示。 */
export const formatSizeDisplay = (
  v: string,
  items: SizeComboItem[],
): { main: string; tail?: string } => {
  const item = items.find((i) => i.value === v || i.legacyValues?.includes(v));
  if (item) return { main: item.label, tail: item.desc };
  const seed = LEGACY_SEEDS.find(
    (s) => s.value === v || s.legacyValues?.includes(v),
  );
  if (seed) {
    // 旧像素值本身精确，不带 approx 前缀（approx 只属比例串路径）。
    return { main: seed.ratio, tail: seed.resolution };
  }
  return { main: v };
};

/** 生成族参数写回（gen_image/gen_video/gen_audio 共用）。 */
export function commitImageParams(
  node: CanvasNode,
  patch: { model?: string; size?: string; count?: number },
) {
  if (node.metadata.kind !== "gen_image" && node.metadata.kind !== "gen_video" && node.metadata.kind !== "gen_audio") return;
  const meta = { ...node.metadata, params: { ...node.metadata.params, ...patch } };
  void useCanvasStore.getState().updateNode(node.id, { metadata: JSON.stringify(meta) });
}
