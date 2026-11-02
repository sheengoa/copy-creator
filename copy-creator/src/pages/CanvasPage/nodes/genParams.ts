import { useCanvasStore, type CanvasNode } from "../../../stores/canvasStore";

// 生成族参数域（无组件模块）：尺寸/模型预设清单、尺寸取值双段展示、
// 参数写回。gen_image 与 gen_video/gen_audio 占位共用。

/** 生成参数预设（下拉清单；输入框仍可自由键入任意值）。尺寸值取后端
 *  可直接接受的「宽x高」（对齐 ai.rs SIZE_PRESETS_1K/2K），auto 交给
 *  模型自选；hint 作弱化尾注（比例/档位，语言中立），需要本地化的
 *  文案用 hintKey（渲染时经 t 解析）。 */
export const SIZE_PRESET_ITEMS: { value: string; label: string; hint?: string; hintKey?: string }[] = [
  { value: "auto", label: "auto", hintKey: "genSizeAutoHint" },
  { value: "1024x1024", label: "1024x1024", hint: "1:1" },
  { value: "1536x1024", label: "1536x1024", hint: "3:2" },
  { value: "1024x1536", label: "1024x1536", hint: "2:3" },
  { value: "1536x864", label: "1536x864", hint: "16:9" },
  { value: "864x1536", label: "864x1536", hint: "9:16" },
  { value: "1024x768", label: "1024x768", hint: "4:3" },
  { value: "768x1024", label: "768x1024", hint: "3:4" },
  { value: "2048x1152", label: "2048x1152", hint: "16:9 · 2K" },
  { value: "1152x2048", label: "1152x2048", hint: "9:16 · 2K" },
];

export const MODEL_PRESET_BASE = ["gpt-image-1", "gemini-2.5-flash-image"];

/** 尺寸取值展示（用户 2026-11-01 定案）：命中预设时展示「主值 + 比例
 *  尾注」双段（与下拉条目同款），自定义值原样展示。 */
export const formatSizeDisplay = (
  v: string,
  items: { value: string; label: string; hint?: string }[] = SIZE_PRESET_ITEMS,
): { main: string; tail?: string } => {
  const item = items.find((i) => i.value === v);
  return item ? { main: item.label, tail: item.hint } : { main: v };
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
