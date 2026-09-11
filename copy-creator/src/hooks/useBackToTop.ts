import { useCallback, useEffect, useRef, useState } from "react";

interface BackToTopOptions {
  /** 下滑超过该距离（px）后浮现按钮。 */
  threshold?: number;
  /** 为 false 时隐藏按钮并停止监视（如批量选择模式下）。 */
  enabled?: boolean;
  /** 变化后重新评估可见性（如切换 tab / 分组 / 内容数量）。 */
  resetKey?: string | number;
  /**
   * 滚动容器不是调用方能直接挂 ref 的元素时（如滚动发生在某个祖先节点上），
   * 提供解析函数（需用 useCallback 保持稳定）；正常情况用返回的
   * containerRef 挂到滚动容器即可。
   */
  resolveContainer?: () => HTMLElement | null;
}

export interface BackToTopHandle {
  /** 挂到滚动容器元素上（与业务 ref 合并时在回调里转发即可）。 */
  containerRef: (node: HTMLElement | null) => void;
  visible: boolean;
  scrollToTop: () => void;
}

// 停止滚动多久后自动隐藏。按钮悬在列表右下角，常驻会与卡片同一位置的
// 操作按钮（复制/粘贴、径向菜单的展开）重叠导致点不到，只在滚动时短暂
// 出现即可完成「回到顶部」的职责。
const IDLE_HIDE_DELAY_MS = 1500;

// 统一的「回到顶部」逻辑：监视滚动容器，下滑超过阈值浮现，停止滚动片刻
// 后自动淡出，点击平滑回顶。悬停期间按钮保持可见（见 BackToTopButton）。
// 剪贴板、快捷输入、资源列表、资源详情、径向菜单共用这一份实现。
export function useBackToTop(options: BackToTopOptions = {}): BackToTopHandle {
  const { threshold = 240, enabled = true, resetKey, resolveContainer } = options;
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const idleTimerRef = useRef<number | null>(null);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const containerRef = useCallback((node: HTMLElement | null) => {
    setContainer(node);
  }, []);

  // resolveContainer 的解析结果通过 container state 生效。
  useEffect(() => {
    if (!resolveContainer) return;
    setContainer(resolveContainer());
  }, [resolveContainer, resetKey]);

  useEffect(() => {
    if (!container || !enabled) {
      clearIdleTimer();
      setVisible(false);
      return;
    }
    const update = () => {
      if (container.scrollTop > threshold) {
        setVisible(true);
        clearIdleTimer();
        idleTimerRef.current = window.setTimeout(() => {
          idleTimerRef.current = null;
          setVisible(false);
        }, IDLE_HIDE_DELAY_MS);
      } else {
        clearIdleTimer();
        setVisible(false);
      }
    };
    update();
    container.addEventListener("scroll", update, { passive: true });
    return () => {
      container.removeEventListener("scroll", update);
      clearIdleTimer();
    };
  }, [container, enabled, threshold, resetKey, clearIdleTimer]);

  const scrollToTop = useCallback(() => {
    container?.scrollTo({ top: 0, behavior: "smooth" });
  }, [container]);

  return { containerRef, visible, scrollToTop };
}
