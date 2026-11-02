// 媒体类型色单源（用户 2026-11-01 定案）：节点 accent / 线色 / 端口点色
// 同源，线色跟上游产物类型。文本取深琥珀黄而非系统黄 #FFCC00，保证
// 2.6px 连线在浅色画布上可读。
export const MEDIA_COLOR: Record<"text" | "image" | "video" | "audio", string> = {
  text: "#E6A700",
  image: "#007AFF",
  video: "#AF52DE",
  audio: "#34C759",
};
