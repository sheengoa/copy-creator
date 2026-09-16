import { describe, expect, it } from "vitest";
import { mayReloadSharedRecordsView } from "./viewOwnership";

describe("mayReloadSharedRecordsView", () => {
  it("不可见页面一律不得重载共享视图（两个页面同规）", () => {
    expect(
      mayReloadSharedRecordsView({
        pageVisible: false,
        pageView: "clipboard",
        storeCategory: "all",
      }),
    ).toBe(false);
    expect(
      mayReloadSharedRecordsView({
        pageVisible: false,
        pageView: "resources",
        storeCategory: "resources",
      }),
    ).toBe(false);
  });

  it("可见的剪切板页可以重载：视图归自己时直接重载，被资源占用时负责夺回", () => {
    expect(
      mayReloadSharedRecordsView({
        pageVisible: true,
        pageView: "clipboard",
        storeCategory: "all",
      }),
    ).toBe(true);
    expect(
      mayReloadSharedRecordsView({
        pageVisible: true,
        pageView: "clipboard",
        storeCategory: "text",
      }),
    ).toBe(true);
    expect(
      mayReloadSharedRecordsView({
        pageVisible: true,
        pageView: "clipboard",
        storeCategory: "resources",
      }),
    ).toBe(true);
  });

  it("可见的资源页只在资源视图归属自己时重载（防面板切换中间态抢占）", () => {
    expect(
      mayReloadSharedRecordsView({
        pageVisible: true,
        pageView: "resources",
        storeCategory: "resources",
      }),
    ).toBe(true);
    expect(
      mayReloadSharedRecordsView({
        pageVisible: true,
        pageView: "resources",
        storeCategory: "all",
      }),
    ).toBe(false);
  });

  it("回归锚点：不可见资源页 + 资源视图（历史抢占领态）必须被拒绝", () => {
    // main-window-shown 同时唤醒两页回调时的历史胜负序：
    // 剪切板回调先执行、资源回调后执行并覆盖共享视图——该态即本模块要杜绝的根源。
    expect(
      mayReloadSharedRecordsView({
        pageVisible: false,
        pageView: "resources",
        storeCategory: "resources",
      }),
    ).toBe(false);
  });
});
