// 工程画布配色：连线类型色 / 节点类型色 / 端口专属色 / 兼容表
// （自 ProjectCanvas.tsx 零改动搬运，2026-11-03 引擎拆分阶段 11a）。

/** 连线数据类型色：媒体四类（图/视频/文本/音频）与自由画布
 *  MEDIA_COLOR 单源对齐（同类型同色，两画布一致）；prompt/file 为
 *  工程域专属类型，保留各自专属色。 */
export const WIRE_TYPE_COLORS: Record<string, string> = {
  image: "#007AFF",
  video: "#AF52DE",
  text: "#E6A700",
  prompt: "#22d3ee",
  audio: "#34C759",
  file: "#94a3b8",
};

/** 节点类型色（类型名文字与端口/选中 accent 用）。工程域身份类型
 *  （镜头/片段/成片/角色/场景/道具/剧本/提示词）保留专属色；素材
 *  媒体类型与 WIRE_TYPE_COLORS 同源对齐。 */
export const NODE_ACCENTS: Record<string, string> = {
  shot: "#60a5fa",
  segment: "#a78bfa",
  output: "#c084fc",
  character: "#f472b6",
  location: "#34d399",
  prop: "#fbbf24",
  script: "#fb923c",
  prompt: "#22d3ee",
  note: "#E6A700",
  image: "#007AFF",
  video: "#AF52DE",
  text: "#E6A700",
  audio: "#34C759",
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
