import { useCallback, useEffect, useState } from "react";

/**
 * 画布层「按集持久化状态」三件套的统一实现：加载 effect + 原始 setter +
 * persist 回调（写入并落盘 localStorage）。此前该模式在 ProjectCanvas 里
 * 手写了十余份，此 hook 收敛为单一出处。
 *
 * 语义约定（与各手写版本逐字一致）：
 * - 键为 `project_canvas_${name}_${episodeId}`，值存 JSON；
 * - episodeId 为空串是 selectEpisode 刷新途中的瞬态（概览先置空），
 *   不能当作切集去清空按集记忆，直接跳过加载；
 * - 读取/解析失败一律回退 fallback（存储损坏只损失记忆，不崩画布）；
 * - persist 写失败（存储不可用）仅不记忆，状态仍更新。
 *
 * fallback 与 parse 会进入 effect 依赖，必须传模块级常量/纯函数保持
 * 引用稳定（组件内联字面量会导致每渲染重载）。
 */
export function usePerEpisodeStorage<T>(
  episodeId: string,
  name: string,
  fallback: T,
  parse: (raw: string) => T = JSON.parse as (raw: string) => T,
): [T, React.Dispatch<React.SetStateAction<T>>, (next: T) => void] {
  const key = `project_canvas_${name}_${episodeId}`;
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    if (!episodeId) return; // 刷新瞬态：跳过加载，保留当前值。
    let next = fallback;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw != null) next = parse(raw);
    } catch {
      next = fallback;
    }
    setValue(next);
  }, [key, episodeId, fallback, parse]);
  const persist = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // 存储不可用：仅不记忆。
      }
    },
    [key],
  );
  return [value, setValue, persist];
}
