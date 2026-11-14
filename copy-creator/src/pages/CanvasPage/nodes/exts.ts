// 加载/视频工具节点允许的文件扩展名：OS 拖入、本地选片对话框与选后
// 校验共用同一份（类型不符的媒体在本节点只能得到空白/裂图）。
// 图片集合与 domain 解码能力清单同源（DECODABLE_IMAGE_EXTENSIONS 恰为
// 本节点可渲染位图集，此前手写数组是精确重复）；视频/音频是 WebView
// 播放能力白名单——有意窄于生成物全集（排除 m4v/ogv/ts、mid/midi 等播
// 不动或不适配项），配置扩容须在此显式放行，属守卫规则 1 的显式豁免
// （语言特有清单同款）。
import { DECODABLE_IMAGE_EXTENSIONS, getResourceExtension } from "../../../domain/mediaKind";

export const IMAGE_EXTS: readonly string[] = [...DECODABLE_IMAGE_EXTENSIONS];
export const VIDEO_EXTS = ["mp4", "webm", "mkv", "mov", "avi"];
export const AUDIO_EXTS = ["mp3", "m4a", "aac", "flac", "ogg", "opus", "wav"];

// 与 domain 同一实现（旧 extOf 对含点目录会取到错误末段，如
// 「C:\a.v2\file」取到 v2\file；domain 版按文件名段切分无此问题）。
export const extOf = getResourceExtension;
