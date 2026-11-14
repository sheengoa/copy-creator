import { useCallback, useEffect, useState } from "react";
import { resolveResourceMediaUrl } from "../domain/mediaUrl";

/**
 * 资源媒体 URL 解析的唯一挂载点：路径/版本变化时经 domain/mediaUrl 重新
 * 解析（取消保护 + 失败置 failed）。此前剪藏/资源/径向菜单预览等五处各写
 * 一份「resolve → cancelled → setState」样板，收口于此。
 *
 * resolvedSrc 是已解析旁路（调用方手里已有 URL 时跳过解析，ResourceMedia
 * 从列表行带下来的地址），undefined 时走正常解析。failed 覆盖两类失败：
 * 解析失败与 <img>/<video> 元素加载失败（经 reportFailed 由元素 onError
 * 上报，重挂载场景下 src 不变也不至于卡在破图）。
 */
export function useResourceMediaSrc(
  path: string,
  version?: string,
  resolvedSrc?: string,
): { src: string; failed: boolean; reportFailed: () => void } {
  const [src, setSrc] = useState(resolvedSrc ?? "");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(resolvedSrc ?? "");
    setFailed(false);
    if (resolvedSrc) {
      return () => {
        cancelled = true;
      };
    }
    resolveResourceMediaUrl(path, version)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, resolvedSrc, version]);

  return { src, failed, reportFailed: useCallback(() => setFailed(true), []) };
}
