import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resolveResourceMediaUrl } from "../../../domain/mediaUrl";
import { joinLibraryPath } from "../../../domain/projectView";

// 画布媒体路径归一与 URL 解析（无组件的纯函数/钩子模块，配合 media.tsx
// 的组件使用）。resource_path（库相对软路径）→ 绝对路径 → token 媒体服务
// URL 的统一出口。自 FreeCanvas.tsx 整体迁出（基座化 2026-11-03）。

/** 画布媒体路径归一：resource_path 的相对路径语义是「资源库相对」
 *  （选择器回填/旧 ref 数据），而 mediaUrl 域层把相对路径拼到存储根
 *  （≠资源库根）——这里先转绝对再交给域层，存量相对路径数据同样修复。 */
export async function resolveCanvasMediaPath(path: string): Promise<string> {
  const trimmed = path.trim();
  if (!trimmed
    || /^(?:https?:|data:|blob:|asset:|file:)/i.test(trimmed)
    || /^[A-Za-z]:[\\/]/.test(trimmed)
    || trimmed.startsWith("\\\\")) {
    return trimmed;
  }
  const root = await invoke<string>("get_resource_library_path").catch(() => "");
  return joinLibraryPath(root, trimmed);
}

/** 画布媒体 URL：路径归一 + 域层解析（token 媒体服务）。 */
export async function resolveCanvasMediaUrl(path: string, version?: string): Promise<string> {
  return resolveResourceMediaUrl(await resolveCanvasMediaPath(path), version);
}

/** 资源媒体 URL（视频/音频播放用），路径变化重解析。 */
export function useMediaUrl(path: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    resolveCanvasMediaUrl(path)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);
  return url;
}
