// 详情页正文列自绘滚动进度条子系统：WebKitGTK 的原生滚动条不可见，
// 用 sticky 轨道 + thumb 反映阅读进度；thumb 位置直接写 style。
// 轨道元素高度为 0（sticky 钉住不占布局），行程几何一律从滚动
// 视口（main）推导，轨道自身 clientHeight 恒为 0 不可用作分母。
// 自 ResourceDetailPage.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）。
// stage 容器（ResizeObserver 观察内容高度跳变）经 params 注入。
// 返回的 findPageScroller 同时供 useBackToTop 与查找替换子系统解析
// 滚动容器：详情页真正的滚动容器是正文列（mainElRef）。

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

const SCROLLBAR_INSET = 14;

export function useDetailScrollThumb({
  stageRef,
}: {
  stageRef: RefObject<HTMLDivElement | null>;
}) {
  // mainEl 用 callback ref + state：hash 直开详情页时记录异步加载、
  // MAIN 晚于组件挂载渲染——普通 ref 的 effect 会因拿到 null 而早退，
  // 滚动监听与初始进度将永不绑定。
  const mainElRef = useRef<HTMLElement | null>(null);
  const [mainElReady, setMainElReady] = useState(false);
  const scrollThumbRef = useRef<HTMLDivElement | null>(null);
  const scrollTrackRef = useRef<HTMLDivElement | null>(null);
  // 拖动进行中挂在 window 上的监听清理函数；组件卸载（HMR、记录删除）
  // 或重复按下时调用，避免监听器悬挂到下一次 pointerup。
  const thumbDragCleanupRef = useRef<(() => void) | null>(null);

  const findPageScroller = useCallback(() => {
    // 滚动收敛后，详情页真正的滚动容器是正文列（mainElRef）。旧实现沿
    // 祖先链找 overflow:auto 的元素，收敛后只会命中零溢出、恒不滚动的
    // 外层面板——scrollTop 恒 0，返回顶部按钮因此永不出现。正文列晚于
    // 组件就绪时（全文异步加载）由 mainElReady 触发本回调重建、hook 重新解析。
    // mainElReady 不在函数体内出现是刻意的：靠依赖数组驱动重建，禁用该规则。
    return mainElRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainElReady]);

  const trackMetrics = useCallback(() => {
    const main = mainElRef.current;
    if (!main) return null;
    const trackH = Math.max(0, main.clientHeight - SCROLLBAR_INSET * 2);
    const max = main.scrollHeight - main.clientHeight;
    const thumbH = Math.max(48, main.clientHeight > 0
      ? trackH * (main.clientHeight / main.scrollHeight)
      : trackH);
    return { main, trackH, max, thumbH };
  }, []);

  const updateScrollThumb = useCallback(() => {
    const metrics = trackMetrics();
    const thumb = scrollThumbRef.current;
    if (!metrics || !thumb) return;
    const { main, trackH, max, thumbH } = metrics;
    const y = SCROLLBAR_INSET + (trackH - thumbH) * (max > 0 ? main.scrollTop / max : 0);
    thumb.style.height = `${Math.round(thumbH)}px`;
    thumb.style.transform = `translateY(${Math.round(y)}px)`;
  }, [trackMetrics]);

  // callback ref：元素挂载/卸载时记录并发出就绪信号（滚动监听随之绑定）
  const setMainElRef = useCallback((el: HTMLElement | null) => {
    mainElRef.current = el;
    setMainElReady(el !== null);
  }, []);

  // thumb 当前顶部（translateY 值，与 updateScrollThumb 的写入口径一致）
  const currentThumbTop = useCallback(
    () => parseFloat(scrollThumbRef.current?.style.transform.replace(/[^\d.-]/g, "") || "0") || 0,
    [],
  );

  // thumb 目标顶部位置换算滚动位置（超出轨道行程时夹取）
  const thumbYToScroll = useCallback((thumbTopY: number) => {
    const metrics = trackMetrics();
    if (!metrics) return;
    const { main, trackH, max, thumbH } = metrics;
    const clamped = Math.max(0, Math.min(thumbTopY - SCROLLBAR_INSET, trackH - thumbH));
    main.scrollTop = max * (clamped / (trackH - thumbH || 1));
  }, [trackMetrics]);

  // 拖动用 window 级原生监听：不依赖 setPointerCapture（各引擎行为
  // 差异大，WebKitGTK 上曾失效），指针快速移动或移出窗口也不丢。
  const beginThumbDrag = useCallback((grabOffset: number) => {
    const track = scrollTrackRef.current;
    if (!track) return;
    const trackTop = () => track.getBoundingClientRect().top;
    const onMove = (ev: PointerEvent) => {
      thumbYToScroll(ev.clientY - trackTop() - grabOffset);
    };
    const onUp = () => {
      thumbDragCleanupRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    thumbDragCleanupRef.current?.();
    thumbDragCleanupRef.current = onUp;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [thumbYToScroll]);

  useEffect(() => () => thumbDragCleanupRef.current?.(), []);

  const handleTrackPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const metrics = trackMetrics();
    const track = scrollTrackRef.current;
    if (!metrics || !track) return;
    event.preventDefault();
    const y = event.clientY - track.getBoundingClientRect().top;
    if (event.target === scrollThumbRef.current) {
      // 抓住 thumb：保持按下点相对 thumb 顶部的偏移，原地进入拖动不跳变
      beginThumbDrag(y - currentThumbTop());
    } else {
      // 点击轨道空白：thumb 中心对齐点击处跳转并进入拖动
      thumbYToScroll(y - metrics.thumbH / 2);
      beginThumbDrag(metrics.thumbH / 2);
    }
  }, [beginThumbDrag, currentThumbTop, thumbYToScroll, trackMetrics]);

  useEffect(() => {
    const main = mainElRef.current;
    if (!mainElReady || !main) return;
    // 滚动/窗口尺寸变化时同步更新 thumb（轻量 style 写入，无需 rAF
    // 节流——后台页面 rAF 被冻结会导致更新完全停摆）。
    const update = () => updateScrollThumb();
    main.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
    // 内容高度变化（content-visibility 块进入视口按真实高度重排、字体
    // 加载完成等）不触发 scroll 事件，main 自身是恒定高的滚动视口也测
    // 不到——观察内容容器 stage，高度跳变时同步 thumb 比例。
    let observer: ResizeObserver | null = null;
    const content = stageRef.current;
    if (typeof ResizeObserver !== "undefined" && content) {
      observer = new ResizeObserver(update);
      observer.observe(content);
    }
    return () => {
      main.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [mainElReady, updateScrollThumb, stageRef]);

  return {
    findPageScroller,
    setMainElRef,
    scrollTrackRef,
    scrollThumbRef,
    handleTrackPointerDown,
  };
}
