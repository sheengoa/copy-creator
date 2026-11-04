import { useCanvasStore, type CanvasNode } from "../../../stores/canvasStore";

// 生成族参数域（无组件模块）：模型/尺寸预设清单、尺寸取值双段展示、
// 参数写回。gen_image 与 gen_video/gen_audio 占位共用。

export const MODEL_PRESET_BASE = ["gpt-image-1", "gemini-2.5-flash-image"];

/** 尺寸条目（2026-11-04 二轮定案）：所有模型统一全量清单——7 种比例的
 *  1K 档 + 16:9/9:16 的 2K 档；条目主文案 = 比例，下行弱化注 = 名义
 *  分辨率；tier 档位角标；shape 为宽高比示意小框 [宽,高]。落库存值
 *  统一为显式像素（OpenAI 直取、Gemini 按最近比例归档，链路原生）；
 *  官方 OpenAI 对非官方档位会拒收并如实报错，官方四档始终可用。
 *  legacyValues 兼容按比例串落库的过渡存量（展示命中用）。 */
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

/** 统一全量清单（用户 2026-11-04 定案：不再按模型收窄，各比例与 2K
 *  档全量可选；若渠道为 OpenAI 官方严格校验，非官方档位生成时如实
 *  报错，官方四档始终可用）。 */
const SEED: SizeItemSeed[] = [
  { value: "auto", ratio: "auto", autoHint: true },
  { value: "1024x1024", ratio: "1:1", tier: "1K", shape: SHAPE.s11, resolution: "1024 × 1024", legacyValues: ["1:1"] },
  { value: "1536x1024", ratio: "3:2", tier: "1K", shape: SHAPE.s32, resolution: "1536 × 1024", legacyValues: ["3:2"] },
  { value: "1024x1536", ratio: "2:3", tier: "1K", shape: SHAPE.s23, resolution: "1024 × 1536", legacyValues: ["2:3"] },
  { value: "1536x864", ratio: "16:9", tier: "1K", shape: SHAPE.s169, resolution: "1536 × 864", legacyValues: ["16:9"] },
  { value: "864x1536", ratio: "9:16", tier: "1K", shape: SHAPE.s916, resolution: "864 × 1536", legacyValues: ["9:16"] },
  { value: "1024x768", ratio: "4:3", tier: "1K", shape: SHAPE.s43, resolution: "1024 × 768", legacyValues: ["4:3"] },
  { value: "768x1024", ratio: "3:4", tier: "1K", shape: SHAPE.s34, resolution: "768 × 1024", legacyValues: ["3:4"] },
  { value: "2048x1152", ratio: "16:9", tier: "2K", shape: SHAPE.s169, resolution: "2048 × 1152" },
  { value: "1152x2048", ratio: "9:16", tier: "2K", shape: SHAPE.s916, resolution: "1152 × 2048" },
];

/** 尺寸条目构建（desc 的 auto 提示需 i18n，其余分辨率注语言中立）。 */
export function sizePresetItems(t: (key: string) => string): SizeComboItem[] {
  return SEED.map((s) => ({
    value: s.value,
    legacyValues: s.legacyValues,
    label: s.ratio,
    tier: s.tier,
    shape: s.shape,
    desc: s.autoHint ? t("canvas.genSizeAutoHint") : s.resolution,
  }));
}

/** 尺寸取值展示（用户 2026-11-01 定案「主值 + 弱化尾注」双段；2026-11-04
 *  翻转为比例为主、分辨率为尾注）：命中清单 → 比例 + 分辨率注；比例串
 *  过渡存量经 legacyValues 命中；未命中自定义值原样展示。 */
export const formatSizeDisplay = (
  v: string,
  items: SizeComboItem[],
): { main: string; tail?: string } => {
  const item = items.find((i) => i.value === v || i.legacyValues?.includes(v));
  return item ? { main: item.label, tail: item.desc } : { main: v };
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
