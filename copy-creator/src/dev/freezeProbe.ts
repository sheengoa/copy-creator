// 开发期渲染冻结探针（仅 DEV）：区分「页面停产帧」与「系统呈现丢帧」。
// rAF 停 = Chromium 帧生产停摆（遮挡误判/渲染挂起族，节流标志应已覆盖）；
// rAF 持续跳动而屏幕上徽章像素不动 = 帧生产正常、呈现路径丢帧
// （WebView2 DirectComposition 族，参见 WebView2Feedback #5574）。
// 徽章定格的是最后一次被呈现的数值——冻结期间徽章像素本身也冻住，
// 唤醒后如出现「⚠ rAF 断」报告即帧生产停摆；唤醒后徽章数值持续刷新
// 却无报告，即呈现丢帧。配合外部抓屏做像素级判定。
export function installFreezeProbe() {
  if (!import.meta.env.DEV) return;
  const log: { t: number; kind: string; ms?: number }[] = [];
  const push = (kind: string, ms?: number) => {
    log.push({ t: Date.now(), kind, ms });
    if (log.length > 300) log.shift();
  };

  // rAF 采样：帧生产一旦恢复，首个回调报告整个停摆时长。
  let rafLast = performance.now();
  let rafMax = 0;
  const loop = (t: number) => {
    const d = t - rafLast;
    rafLast = t;
    if (d > rafMax) rafMax = d;
    if (d > 1500) {
      push("raf-stall", d);
      console.warn(`[freezeProbe] rAF 停摆 ${d.toFixed(0)}ms`);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // 徽章：直接写 DOM（不进 React，零干扰）。定格在屏幕上的最后数值
  // 就是冻结瞬间的内部状态快照。
  const badge = document.createElement("div");
  badge.style.cssText =
    "position:fixed;right:10px;bottom:10px;z-index:2147483647;" +
    "font:10px/1.5 Consolas,monospace;background:rgba(20,22,30,.85);color:#dfe3ee;" +
    "padding:4px 9px;border-radius:8px;pointer-events:none;white-space:pre;text-align:left;";
  document.body.appendChild(badge);

  // 定时采样：定时器停摆时长与 rAF 独立（区分整进程挂起与单停产帧）。
  let timerLast = Date.now();
  let timerMax = 0;
  let report = "";
  window.setInterval(() => {
    const now = Date.now();
    const d = now - timerLast;
    timerLast = now;
    if (d > timerMax) timerMax = d;
    if (d > 1500) push("timer-stall", d);
    if (rafMax > 1500) {
      report =
        `⚠ 帧生产停摆 rAF ${rafMax.toFixed(0)}ms｜定时器 ${timerMax.toFixed(0)}ms` +
        `｜${document.visibilityState}｜${document.hasFocus() ? "有焦" : "失焦"}`;
      push("report", rafMax);
      console.warn(`[freezeProbe] ${report}`);
      rafMax = 0;
      timerMax = 0;
      window.setTimeout(() => {
        report = "";
      }, 30_000);
    }
    const aur = document.querySelector<HTMLElement>(".fc-aurora");
    const p = aur?.style.getPropertyValue("--p") ?? "-";
    const on = aur ? aur.querySelectorAll(".au-fb.is-on").length : 0;
    badge.textContent =
      `帧Δ ${rafMax.toFixed(0)}ms｜钟Δ ${timerMax.toFixed(0)}ms｜` +
      `${document.visibilityState}/${document.hasFocus() ? "焦" : "失"}` +
      `\n--p ${p}｜点亮 ${on}/18` +
      (report ? `\n${report}` : "");
  }, 300);

  document.addEventListener("visibilitychange", () => push(`vis-${document.visibilityState}`));
  window.addEventListener("focus", () => push("focus"));
  window.addEventListener("blur", () => push("blur"));
}
