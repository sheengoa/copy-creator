// 领域层：本地文件路径 → 可显示/可播放 URL 的唯一出口。
// 全项目任何媒体地址（<img>/<video>/<audio> 的 src）必须经此模块解析；
// convertFileSrc 与媒体服务 token 仅允许出现在本文件（eslint + 架构守卫）。
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

function normalizeLocalPath(value: string): string {
  const trimmed = value.trim();
  if (!/^file:\/\//i.test(trimmed)) return trimmed;
  let path = trimmed.replace(/^file:\/\/(?:localhost)?/i, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the original path when a malformed escape sequence is present.
  }
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

function isAbsoluteLocalPath(value: string): boolean {
  // `\\` 开头覆盖 UNC（\\server\share）与 Windows 扩展路径（\\?\）。
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

/** 剥离 Windows canonicalize 残留的扩展前缀，避免污染路径拼接与媒体 URL。 */
function stripWindowsPathPrefix(value: string): string {
  if (/^\\\\\?\\UNC\\/i.test(value)) return value.replace(/^\\\\\?\\UNC\\/i, "\\\\");
  return value.replace(/^\\\\\?\\/, "");
}

let storagePathPromise: Promise<string> | null = null;
let mediaServerPromise: Promise<{ origin: string; token: string }> | null = null;

function getStoragePath(): Promise<string> {
  if (!storagePathPromise) {
    storagePathPromise = invoke<string>("get_storage_path").catch((error) => {
      storagePathPromise = null;
      throw error;
    });
  }
  return storagePathPromise;
}

function getMediaServer(): Promise<{ origin: string; token: string }> {
  if (!mediaServerPromise) {
    mediaServerPromise = invoke<{ origin: string; token: string }>(
      "get_media_server_origin",
    ).catch((error) => {
      mediaServerPromise = null;
      throw error;
    });
  }
  return mediaServerPromise;
}

/** 把记录里的资源路径解析为绝对路径：file:// 与 Windows 扩展前缀先归一，
 *  远程/数据地址原样返回，绝对路径直接返回，相对路径拼到存储根目录下。
 *  资源区媒体地址与快捷输入的文件短语粘贴共用。 */
export async function resolveAbsoluteResourcePath(path: string): Promise<string> {
  const normalized = stripWindowsPathPrefix(normalizeLocalPath(path));
  if (!normalized) throw new Error("资源路径为空");
  if (/^(?:https?:|data:|blob:|asset:)/i.test(normalized)) return normalized;
  if (isAbsoluteLocalPath(normalized)) return normalized;

  const storagePath = (await getStoragePath()).replace(/[\\/]+$/, "");
  return `${storagePath}/${normalized.replace(/^[\\/]+/, "")}`;
}

export async function resolveResourceAssetUrl(path: string): Promise<string> {
  const absolute = await resolveAbsoluteResourcePath(path);
  return convertFileSrc(absolute);
}

// WebKitGTK 的 <video>/<audio> 无法播放 asset:// 协议地址（媒体协议白名单
// 与 GStreamer 均不支持自定义协议），媒体预览需改走后端回环 HTTP 服务。
export async function resolveResourceMediaUrl(path: string): Promise<string> {
  const absolute = await resolveAbsoluteResourcePath(path);
  if (!isAbsoluteLocalPath(absolute)) return absolute;
  const { origin, token } = await getMediaServer();
  return `${origin}/media?token=${encodeURIComponent(token)}&path=${encodeURIComponent(absolute)}`;
}
