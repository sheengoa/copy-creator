// 领域层：共享记录列表视图的归属判定。
//
// ClipboardPage 与 ResourcePage 常挂载且共用 clipboardStore 的
// records/category（加载代数「后写者赢」）。全局事件（main-window-shown、
// resource-groups-changed、共享搜索词防抖）到达时两个页面的回调都会执行：
// 不设防的一方会在不可见时改写共享视图，把资源记录强加给剪切板页——
// 列表被 isResourceRecord 过滤后显示「暂无剪切板记录」（2026-09 空列表
// 缺陷根因，此前五次修复均未建立归属规则导致反复复发）。
//
// 规则：全局事件回调中只有当前可见的页面才允许重载共享视图；不可见页面
// 的刷新诉求由它被激活时的 active 翻转效应承担。资源页重载额外要求视图
// 归属已是资源（可见时恒成立，防面板切换中间态下的多余抢占）。

export type SharedListView = "clipboard" | "resources";

export interface SharedViewReloadRequest {
  /** 发起重载的页面当前是否可见（App 面板 active）。 */
  pageVisible: boolean;
  /** 发起页绑定的共享视图。 */
  pageView: SharedListView;
  /** 共享 store 当前的 category（视图归属）。 */
  storeCategory: string;
}

/** 全局事件回调中重载共享记录视图的许可判定。 */
export function mayReloadSharedRecordsView(
  request: SharedViewReloadRequest,
): boolean {
  if (!request.pageVisible) return false;
  if (request.pageView === "resources") {
    return request.storeCategory === "resources";
  }
  return true;
}
