// 工程画布配色：连线类型色 / 节点类型色 / 端口专属色 / 兼容表
// （自 ProjectCanvas.tsx 零改动搬运，2026-11-03 引擎拆分阶段 11a）。

/** 连线数据类型色（ComfyUI 每类型一色的惯例）。 */
export const WIRE_TYPE_COLORS: Record<string, string> = {
  image: "#4ade80",
  video: "#a78bfa",
  text: "#fb923c",
  prompt: "#22d3ee",
  audio: "#facc15",
  file: "#94a3b8",
};

/** 节点类型色（标题条与类型名用，向 ComfyUI 的彩色节点语言对齐）。 */
export const NODE_ACCENTS: Record<string, string> = {
  shot: "#60a5fa",
  segment: "#a78bfa",
  output: "#c084fc",
  character: "#f472b6",
  location: "#34d399",
  prop: "#fbbf24",
  script: "#fb923c",
  prompt: "#22d3ee",
  note: "#f6e6a8",
  image: "#4ade80",
  video: "#a78bfa",
  text: "#fb923c",
  audio: "#facc15",
  file: "#94a3b8",
};

/** 参考类输入口可接的数据类型（图/视频/文本/提示词）。 */
export const REF_ACCEPTS = ["image", "video", "text", "prompt"];

/** 摘线到空白建节点：菜单项建出的新源输出口类型。摘线菜单按原口
 *  兼容过滤时用（不接线原样放回的剧本纸片/关联场景/便签与走「换
 *  目标」同名口的片段不在表内，任何来源都可选）。 */
export const ADDNODE_OUT_TYPES: Record<string, string> = {
  character: "image",
  location: "image",
  prop: "image",
  prompt: "prompt",
};

/** 片段输入口专属色：每口一色，与对应节点类型色一致，一眼分辨谁是谁；
 *  「其他」口不限类型，用中性灰。未命中的口（镜头/成片/素材的通用口）
 *  回退连线类型色。 */
export const PORT_COLORS: Record<string, string> = {
  character: "#f472b6",
  location: "#34d399",
  prop: "#fbbf24",
  prompt: "#22d3ee",
  script: "#fb923c",
  other: "#94a3b8",
};
