import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

// 悬浮说明（用户 2026-11-01 定案）：悬停约 0.3s 浮现的深玻璃小胶囊，
// portal 到 body fixed 定位——不随画布缩放、不被节点滚动区裁切；禁用
// 按钮经包裹层同样触发。替代原生 title，节点内所有操作说明统一走此件。
// 自 FreeCanvas.tsx 整体迁出（基座化 2026-11-03）。
export function NodeHint({ text, children, className }: { text: string; children: ReactNode; className?: string }) {
  const [tip, setTip] = useState<{ left: number; top: number; below?: boolean } | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  // 画布滚轮缩放时锚点随世界移位，说明浮层不跟随重测——就地隐没，
  // 等下次进入锚点再重现。弹层内滚动已被 WheelGate 截住，不会到这里。
  useEffect(() => {
    if (!tip) return;
    window.clearTimeout(timerRef.current);
    const onWheel = () => setTip(null);
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [tip]);

  const show = () => {
    if (!text) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      // 包裹层可能零尺寸（内部是绝对定位的箭头钮），优先取子元素矩形。
      const el = (anchorRef.current?.firstElementChild as HTMLElement | null) ?? anchorRef.current;
      const rect = el?.getBoundingClientRect();
      if (!rect) return;
      // 贴近视口顶缘时改在下方弹出，避免胶囊越出窗口。
      const below = rect.top < 48;
      // 水平夹紧：长文案（≤260px）贴近窗口左右缘时不越界；半宽按文案
      // 长度估算（CJK ≈ 字号宽），短文案几乎不受影响。
      const half = Math.min(130, (text.length * 11 + 24) / 2);
      const cx = rect.left + rect.width / 2;
      const left = Math.min(Math.max(cx, half + 8), window.innerWidth - half - 8);
      setTip({ left, top: below ? rect.bottom + 7 : rect.top - 7, below });
    }, 300);
  };
  const hide = () => {
    window.clearTimeout(timerRef.current);
    setTip(null);
  };

  return (
    <span
      ref={anchorRef}
      className={`fc-hint-anchor${className ? ` ${className}` : ""}`}
      onPointerEnter={show}
      onPointerLeave={hide}
      onPointerDownCapture={hide}
    >
      {children}
      {tip && text && createPortal(
        <div className={`fc-hint${tip.below ? " is-below" : ""}`} style={{ left: tip.left, top: tip.top }}>{text}</div>,
        document.body,
      )}
    </span>
  );
}
