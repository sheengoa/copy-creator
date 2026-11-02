import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

// 滚轮隔离门：弹层/格子区内的滚轮不惊动画布缩放（stopPropagation 截留）。
// 自 FreeCanvas.tsx 整体迁出（基座化 2026-11-03）。
export function WheelGate({ children }: { children: ReactNode }) {
  const gateRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = gateRef.current;
    if (!el) return;
    const isolate = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", isolate);
    return () => el.removeEventListener("wheel", isolate);
  }, []);
  return <div ref={gateRef}>{children}</div>;
}
