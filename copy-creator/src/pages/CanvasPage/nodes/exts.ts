// 加载/视频工具节点允许的文件扩展名：OS 拖入、本地选片对话框与选后
// 校验共用同一份（类型不符的媒体在本节点只能得到空白/裂图）。
export const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
export const VIDEO_EXTS = ["mp4", "webm", "mkv", "mov", "avi"];
export const AUDIO_EXTS = ["mp3", "m4a", "aac", "flac", "ogg", "wav", "opus"];

export function extOf(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}
