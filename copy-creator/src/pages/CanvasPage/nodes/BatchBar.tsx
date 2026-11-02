import { useTranslation } from "react-i18next";
import { useGenRuntime } from "./genRuntimeCtx";

// 批量生成浮动条：多选 ≥2 个图像生成节点时出现，队列顺序执行。
export function BatchBar({ selectedGenIds }: { selectedGenIds: string[] }) {
  const { t } = useTranslation();
  const { genStarting, runBatch } = useGenRuntime();
  if (selectedGenIds.length < 2 || genStarting) return null;
  return (
    <div className="fc-batchbar" onPointerDown={(e) => e.stopPropagation()}>
      <button onClick={() => void runBatch()}>
        {t("canvas.batchGenerate", { count: selectedGenIds.length })}
      </button>
    </div>
  );
}
