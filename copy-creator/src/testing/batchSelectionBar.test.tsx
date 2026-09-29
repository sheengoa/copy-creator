// @vitest-environment jsdom
// 守护测试：BatchSelectionBar 的可选「恢复」槽位（回收站多选在用）。
// 该槽位曾因 dev 热更新停在半程被误判缺失，这里把渲染契约钉死：
// 传入 onRestore 必出现「恢复」按钮且可触发，未传则不出现。
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "../i18n";
import BatchSelectionBar from "../components/BatchSelectionBar";

// vitest 未开 globals，testing-library 的自动清理不生效，需手动卸载，
// 否则上一用例的「恢复」按钮会泄漏进负向断言。
afterEach(cleanup);

type BarProps = Parameters<typeof BatchSelectionBar>[0];

function renderBar(overrides: Partial<BarProps> = {}) {
  return render(
    <BatchSelectionBar
      selectedCount={1}
      totalCount={2}
      allSelected={false}
      onToggleAll={() => {}}
      onDelete={() => {}}
      onCancel={() => {}}
      {...overrides}
    />,
  );
}

describe("BatchSelectionBar 恢复槽位", () => {
  it("传入 onRestore 时渲染「恢复」按钮并可触发回调", () => {
    let clicked = false;
    renderBar({
      onRestore: () => {
        clicked = true;
      },
    });
    screen.getByText("恢复").click();
    expect(clicked).toBe(true);
  });

  it("未传 onRestore 时不渲染「恢复」", () => {
    renderBar();
    expect(screen.queryByText("恢复")).toBeNull();
  });
});
