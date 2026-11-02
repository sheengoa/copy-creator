import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { GenWaitPhase } from "./genRuntimeCtx";

// 生成等待「流光」动效（2026-11-01 原型定稿移植）：起步两团大光 + 随
// p=received/total 逐团点亮的光团群 + 律动波/斜向光带 + 每张回传一拍的
// 心跳亮拍；fuse/bloom 谢幕由相位机驱动（is-merge → is-bloom），exit 淡出。
// 自 FreeCanvas.tsx 整体迁出（基座化 2026-11-03）。

/** 光团群布局：3×6 抖动网格铺 18 团（避免随机留空隙），阈值均匀铺在
 *  进度轴上（data-th → p=received/total 逐团点亮）。浮现后各自缓慢漂移
 *  呼吸；律动波相位 = 横向位置（--wx）；融合向量指向舞台中心——百分比
 *  存 --gl/--gt，CSS 端用 cqw/cqh 换算成位移，节点宽窄自适应。 */
function buildAuroraBlobs(): { th: number; outer: CSSProperties; mid: CSSProperties; inner: CSSProperties }[] {
  const colors = ["var(--accent)", "var(--au-violet, #AF52DE)"];
  const blobs: { th: number; outer: CSSProperties; mid: CSSProperties; inner: CSSProperties }[] = [];
  let k = 0;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 6; c++) {
      const size = (k % 7 === 3 ? 78 : 34) + Math.random() * 34;
      const leftPct = ((c + 0.5) / 6) * 100 + (Math.random() * 12 - 6);
      const topPct = ((r + 0.5) / 3) * 100 + (Math.random() * 18 - 9);
      blobs.push({
        th: (k + 1) / 19,
        outer: {
          width: `${size.toFixed(0)}px`,
          height: `${size.toFixed(0)}px`,
          left: `${leftPct.toFixed(1)}%`,
          top: `${topPct.toFixed(1)}%`,
          "--b-o": (0.46 + Math.random() * 0.3).toFixed(2),
          "--b-c": colors[k % 2],
          "--b-blur": `${(8 + Math.random() * 6).toFixed(1)}px`,
          "--gl": leftPct.toFixed(1),
          "--gt": topPct.toFixed(1),
        } as CSSProperties,
        mid: { "--wx": Math.min(1, Math.max(0, leftPct / 100)).toFixed(3) } as CSSProperties,
        inner: {
          "--dx": `${(Math.random() * 40 - 20).toFixed(0)}px`,
          "--dy": `${(Math.random() * 22 - 11).toFixed(0)}px`,
          "--ds": (1.05 + Math.random() * 0.26).toFixed(2),
          "--d-dur": `${(6 + Math.random() * 5).toFixed(2)}s`,
          "--d-del": `${(-Math.random() * 6).toFixed(2)}s`,
        } as CSSProperties,
      });
      k++;
    }
  }
  return blobs;
}

export function GenAuroraStage({
  phase,
  total,
  received,
  celebrated,
}: {
  phase: GenWaitPhase;
  total: number;
  received: number;
  celebrated: boolean;
}) {
  const blobs = useMemo(() => buildAuroraBlobs(), []);
  const [beat, setBeat] = useState(0);
  const beatSeen = useRef(0);
  useEffect(() => {
    // 心跳亮拍：每张回传一拍（key 重挂重放动画）。
    if (received > beatSeen.current) {
      beatSeen.current = received;
      setBeat((b) => b + 1);
    }
  }, [received]);
  // 时间保底密度（2026-11-01 定案）：密度轴原来纯按回传进度
  // （p = received/total），单张/极少张时进度没有中间值——执行全程只剩
  // 起步两团大光干转，真机单张 ~28s 尤其明显。按 30s 标称时长给时间轴
  // 兜底：有效进度取 max(真实进度, 时间进度)，密度随时间推移照样渐密，
  // 真实回传快时自然接管；封顶 0.93 给谢幕融合留场。
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setElapsedMs(Date.now() - started), 600);
    return () => window.clearInterval(timer);
  }, []);
  const progressP = total > 0 ? received / total : 0;
  const timeP = Math.min(elapsedMs / 30000, 0.93);
  const p = Math.max(progressP, timeP);
  const cls = ["fc-aurora"];
  if (p >= 0.5) cls.push("is-half");
  // 融合/扩散态一路保留到淡出（celebrated）：光满着谢幕，不在退场时散开。
  const merged = phase === "fuse" || phase === "bloom" || (phase === "exit" && celebrated);
  if (merged) cls.push("is-merge");
  if (phase === "bloom" || (phase === "exit" && celebrated)) cls.push("is-bloom");
  if (phase === "exit") cls.push("is-out");
  return (
    <div className={cls.join(" ")} style={{ "--p": p.toFixed(3) } as CSSProperties} aria-hidden>
      <span className="au-blob au-a" />
      <span className="au-blob au-b" />
      <span className="au-field">
        {blobs.map((b, i) => (
          <span key={i} className={p >= b.th ? "au-fb is-on" : "au-fb"} style={b.outer}>
            {/* 三层结构与 CSS 选择器一一对应：外层浮现（.au-fb）、
                中层律动波（> span，--wx 相位）、内层渐变+漂移
                （> span > span，--dx/--dy/--ds）。此前拍扁成两个兄弟
                span，`> span > span` 渐变规则匹配不到任何元素，光团群
                从未绘制——整场只剩常驻双光，「渐密」不可见。 */}
            <span style={b.mid}>
              <span style={b.inner} />
            </span>
          </span>
        ))}
      </span>
      <span className="au-fused" />
      <span className="au-sheen" />
      <span className="au-sheen2">
        <span />
      </span>
      <span className="au-flare" />
      {beat > 0 && <span key={beat} className="au-beatflash" />}
    </div>
  );
}
