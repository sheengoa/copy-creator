import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

// 悬浮说明（用户 2026-11-01 定案）：悬停约 0.3s 浮现的深玻璃小胶囊，
// portal 到 body fixed 定位——不随画布缩放、不被节点滚动区裁切；禁用
// 按钮经包裹层同样触发。替代原生 title，节点内所有操作说明统一走此件。
// 自 FreeCanvas.tsx 整体迁出（基座化 2026-11-03）。
export function NodeHint({
  text,
  children,
  className,
  side = false,
}: {
  text: string;
  children: ReactNode;
  className?: string;
  /** 卡侧弹出（参数行专用 2026-11-04）：悬浮体浮到节点卡右侧、垂直居中
   *  锚点行。参数三行紧密堆叠（行距约 36px < 悬浮体高 28px + 间隙），
   *  上/下方弹出必压邻行控件（实测「选择预设」盖住上一行输入框），
   *  卡外才是无遮挡带；卡右贴视口缘时翻到卡左侧。 */
  side?: boolean;
}) {
  const [tip, setTip] = useState<{
    left: number;
    top: number;
    mode?: "below" | "side" | "side-flip";
  } | null>(null);
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
      if (side) {
        const card = anchorRef.current?.closest(".pc-node")?.getBoundingClientRect();
        if (card) {
          const w = Math.min(260, text.length * 11 + 24);
          const cy = rect.top + rect.height / 2;
          // 间隙取 24px（卡 padding 13px ≈ 距行末控件 37px）：第一版 10px
          // 时悬浮体贴着行末控件（+ 按钮等），观感仍是堆在控件上。
          const left = card.right + 24;
          if (left + w > window.innerWidth - 8) {
            // 卡右贴视口缘：翻到卡左侧（同样卡外无遮挡带）。
            setTip({ left: card.left - 24, top: cy, mode: "side-flip" });
          } else {
            setTip({ left, top: cy, mode: "side" });
          }
          return;
        }
      }
      // 贴近视口顶缘时改在下方弹出，避免胶囊越出窗口。
      const below = rect.top < 48;
      // 水平夹紧：长文案（≤260px）贴近窗口左右缘时不越界；半宽按文案
      // 长度估算（CJK ≈ 字号宽），短文案几乎不受影响。
      const half = Math.min(130, (text.length * 11 + 24) / 2);
      const cx = rect.left + rect.width / 2;
      const left = Math.min(Math.max(cx, half + 8), window.innerWidth - half - 8);
      setTip({ left, top: below ? rect.bottom + 7 : rect.top - 7, mode: below ? "below" : undefined });
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
        <div
          className={`fc-hint${tip.mode === "below" ? " is-below" : ""}${tip.mode === "side" ? " is-side" : ""}${tip.mode === "side-flip" ? " is-side is-flip" : ""}`}
          style={{ left: tip.left, top: tip.top }}
        >
          {text}
        </div>,
        document.body,
      )}
    </span>
  );
}
