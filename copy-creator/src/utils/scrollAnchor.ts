// 列表滚动锚点：后台事件会整窗替换列表数据（粘贴使用重排、资源增删、
// 打开菜单刷新），视口上方的行集合一旦变化，WebKitGTK 没有 scroll
// anchoring，用户停留的内容就被顶走，感知为「停留位置被重置」。这里
// 把「视口顶条目 + 偏移」显式记住，同视图内容更新后重新对位；视图
// 本身切换（tab/类别/分组）时不恢复。主窗口资源页的 pendingScrollTopRef
// 是同一问题的像素级兜底，本模块提供条目级精确对位（守卫：规则 21）。

export interface ListScrollAnchor {
  /** 视图标识：tab/类别/分组拼串，视图切换后锚点作废。 */
  viewKey: string;
  /** 视口顶（部分可见也算）条目的标识；列表无条目时为 null。 */
  itemId: string | null;
  /** 锚点条目顶边相对容器视口顶边的距离（px）。 */
  offsetInViewport: number;
  /** 捕获时的像素滚动位置：锚点条目已不存在时兜底恢复用。 */
  scrollTop: number;
}

/** 捕获容器当前的滚动锚点。容器为空返回 null。 */
export function captureListScrollAnchor(
  container: HTMLElement | null,
  viewKey: string,
): ListScrollAnchor | null {
  if (!container) return null;
  const containerTop = container.getBoundingClientRect().top;
  let itemId: string | null = null;
  let offsetInViewport = 0;
  for (const child of Array.from(container.children)) {
    const element = child as HTMLElement;
    const id = element.dataset?.radialItemId;
    if (!id) continue;
    const rect = element.getBoundingClientRect();
    // 第一个底边仍在容器上缘之下的条目即视口顶条目（上方条目已滚出）。
    if (rect.bottom > containerTop) {
      itemId = id;
      offsetInViewport = rect.top - containerTop;
      break;
    }
  }
  return { viewKey, itemId, offsetInViewport, scrollTop: container.scrollTop };
}

/** 恢复锚点：找到锚点条目并把它的视口位置摆回捕获时的偏移；条目已
 * 不存在时退回像素位置（浏览器自行钳制）。viewKey 不匹配视为视图已
 * 切换，不动滚动位置。返回是否按条目精确对位。 */
export function applyListScrollAnchor(
  container: HTMLElement | null,
  anchor: ListScrollAnchor | null,
  viewKey: string,
): boolean {
  if (!container || !anchor || anchor.viewKey !== viewKey) return false;
  if (anchor.itemId !== null) {
    const containerTop = container.getBoundingClientRect().top;
    for (const child of Array.from(container.children)) {
      const element = child as HTMLElement;
      if (element.dataset?.radialItemId !== anchor.itemId) continue;
      const delta = element.getBoundingClientRect().top - containerTop;
      container.scrollTop += delta - anchor.offsetInViewport;
      return true;
    }
  }
  container.scrollTop = anchor.scrollTop;
  return false;
}
