// 文本纸片内容（读资源文本头部，组件内自持请求；自 ProjectCanvas.tsx
// 零改动搬运，2026-11-03 引擎拆分阶段 11a）。

import { useEffect, useState } from "react";
import { Icons } from "../../../components/Icons";
import { readResourceTextPreview } from "../../../domain/mediaAssets";

/** 文本纸片内容（读资源文本头部，组件内自持请求）。 */
export function TextPaperBody({ path, name, lines, adaptive = false }: { path: string; name: string; lines?: number; adaptive?: boolean }) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    readResourceTextPreview(path)
      .then((result) => {
        if (!cancelled) setPreview(result.content);
      })
      .catch(() => {
        if (!cancelled) setPreview("");
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return (
    <div className="pc-paper">
      <h5>
        {Icons.file}
        <span>{name}</span>
      </h5>
      <p style={lines && !adaptive ? { WebkitLineClamp: lines } : undefined}>{preview === null ? "…" : preview}</p>
    </div>
  );
}
