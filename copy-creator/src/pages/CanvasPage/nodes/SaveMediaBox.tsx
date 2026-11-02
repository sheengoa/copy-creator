import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NodeHint } from "./NodeHint";
import { SaveProductCell, SaveProductView, type SaveProductKind } from "./media";
import { WheelGate } from "./WheelGate";

// 保存节点多图观看（2026-11-01 定案）：默认单图 + 计数角标；点角标媒体
// 盒整切缩略图格（与生成胶片条同语），点小图看那张，再点角标回选。格子
// 区限高 330px 内部滚动（2026-11-02 确认：与单图媒体盒同上限，两态节点
// 高度同量级），滚轮由 WheelGate 截留给格子、不惊动画布缩放；格子常挂
// 载 + hidden 切换——scrollTop 跨切换保留，换一张回来不用重新滚。纯
// 观看态——不改上游主图标记、不影响自动保存（本就全量保存）；上游产物
// 更替（数量或首图路径变化）即回单图第一张，观看态不跨代保留。
export function SaveMediaBox({ paths, kind }: { paths: string[]; kind: SaveProductKind }) {
  const { t } = useTranslation();
  const [view, setView] = useState({ sig: "", grid: false, idx: 0 });
  const sig = `${paths.length}:${paths[0] ?? ""}`;
  useEffect(() => {
    setView((s) => (s.sig === sig ? s : { sig, grid: false, idx: 0 }));
  }, [sig]);
  const onTrack = view.sig === sig;
  const idx = onTrack ? Math.min(view.idx, Math.max(paths.length - 1, 0)) : 0;
  const grid = onTrack && view.grid && paths.length > 1;
  return (
    <>
      {!grid && <SaveProductView path={paths[idx] ?? ""} kind={kind} />}
      {paths.length > 1 && (
        <WheelGate>
          <div className="fc-save-grid" hidden={!grid}>
            {paths.map((p, i) => (
              <button
                key={`${i}:${p}`}
                type="button"
                className={`fc-save-cell${i === idx ? " is-cur" : ""}`}
                aria-label={t("canvas.savePickN", { n: i + 1 })}
                onClick={() => setView({ sig, grid: false, idx: i })}
              >
                <SaveProductCell path={p} kind={kind} />
              </button>
            ))}
          </div>
        </WheelGate>
      )}
      {paths.length > 1 && (
        <NodeHint text={grid ? t("canvas.saveBackSingle") : t("canvas.saveViewAll")}>
          <button
            type="button"
            className={`fc-save-more${grid ? " is-on" : ""}`}
            aria-pressed={grid}
            aria-label={grid ? t("canvas.saveBackSingle") : t("canvas.saveViewAll")}
            onClick={() => setView({ sig, grid: !grid, idx })}
          >
            +{paths.length - 1}
          </button>
        </NodeHint>
      )}
    </>
  );
}
