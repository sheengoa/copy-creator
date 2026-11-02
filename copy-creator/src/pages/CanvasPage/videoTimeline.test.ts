import { describe, expect, it } from "vitest";
import {
  clampRange,
  filmstripCells,
  formatTimecode,
  rangeHandleEnd,
  rangeHandleStart,
  rangeTranslate,
  timeAtClientX,
} from "./videoTimeline";

describe("timeAtClientX", () => {
  const rect = { left: 100, width: 200 };
  it("比例法换算并免疫缩放（比例只依赖 rect）", () => {
    expect(timeAtClientX(100, rect, 30)).toBe(0);
    expect(timeAtClientX(200, rect, 30)).toBe(15);
    expect(timeAtClientX(300, rect, 30)).toBeCloseTo(30);
  });

  it("越界与退化输入夹紧", () => {
    expect(timeAtClientX(50, rect, 30)).toBe(0);
    expect(timeAtClientX(500, rect, 30)).toBe(30);
    expect(timeAtClientX(200, { left: 0, width: 0 }, 30)).toBe(0);
    expect(timeAtClientX(200, rect, 0)).toBe(0);
    expect(timeAtClientX(Number.NaN, rect, 30)).toBe(0);
  });
});

describe("clampRange", () => {
  it("时长夹进 [min, max]", () => {
    expect(clampRange(0, 0.1, 0.5, 10, 30)).toEqual({ start: 0, duration: 0.5 });
    expect(clampRange(0, 30, 0.5, 10, 30)).toEqual({ start: 0, duration: 10 });
  });

  it("起点夹进轨道尾部（时长合法时不动时长）", () => {
    expect(clampRange(28, 3, 0.5, 10, 30)).toEqual({ start: 27, duration: 3 });
    expect(clampRange(-5, 2, 0.5, 10, 30)).toEqual({ start: 0, duration: 2 });
  });
});

describe("rangeHandleStart / rangeHandleEnd", () => {
  const min = 0.5;
  const max = 10;
  const trackDur = 30;

  it("拖左手柄右端固定", () => {
    const r = rangeHandleStart({ start: 10, duration: 5 }, 8, min, max, trackDur);
    expect(r).toEqual({ start: 8, duration: 7 });
  });

  it("左手柄不得越过右端减最短时长", () => {
    const r = rangeHandleStart({ start: 10, duration: 5 }, 16, min, max, trackDur);
    // 右端 15 固定：左端最多到 14.5
    expect(r).toEqual({ start: 14.5, duration: 0.5 });
  });

  it("拖右手柄左端固定，上限受 max 与轨道尾", () => {
    expect(rangeHandleEnd({ start: 10, duration: 5 }, 20, min, max, trackDur))
      .toEqual({ start: 10, duration: 10 });
    // 越过轨道尾：钳到尾部
    const r = rangeHandleEnd({ start: 25, duration: 3 }, 40, min, max, trackDur);
    expect(r).toEqual({ start: 25, duration: 5 });
  });
});

describe("rangeTranslate", () => {
  it("按抓取偏移整体平移", () => {
    // 抓在选区内偏移 1s 的位置（t=11，start=10）→ 平移到 t=15 时 start=14
    const r = rangeTranslate({ start: 10, duration: 5 }, 15, 1, 0.5, 10, 30);
    expect(r).toEqual({ start: 14, duration: 5 });
  });

  it("平移夹紧两端不越轨", () => {
    expect(rangeTranslate({ start: 10, duration: 5 }, 0, 1, 0.5, 10, 30))
      .toEqual({ start: 0, duration: 5 });
    expect(rangeTranslate({ start: 10, duration: 5 }, 40, 1, 0.5, 10, 30))
      .toEqual({ start: 25, duration: 5 });
  });
});

describe("formatTimecode", () => {
  it("mm:ss.cc 为主形态", () => {
    expect(formatTimecode(0)).toBe("00:00.00");
    expect(formatTimecode(12.48)).toBe("00:12.48");
    expect(formatTimecode(62.05)).toBe("01:02.05");
  });

  it("超过一小时收敛为 h:mm:ss", () => {
    expect(formatTimecode(3723)).toBe("1:02:03");
  });

  it("非法输入归零", () => {
    expect(formatTimecode(Number.NaN)).toBe("00:00.00");
    expect(formatTimecode(-3)).toBe("00:00.00");
  });
});

describe("filmstripCells", () => {
  it("帧富余：按轨道宽/帧宽定格数并均匀抽稀（460 宽轨道、16:9 帧 ≈ 6 格）", () => {
    const cells = filmstripCells(120, 460, 16 / 9, 40);
    const maxCells = Math.round(460 / ((16 / 9) * 40));
    expect(cells.length).toBe(maxCells);
    // 升序抽稀：首帧必取、间隔均匀，末格落在自己覆盖区间内。
    expect(cells[0]).toBe(0);
    expect(cells.every((v, i) => i === 0 || v > cells[i - 1])).toBe(true);
    expect(cells[cells.length - 1]).toBe(Math.floor(((maxCells - 1) * 120) / maxCells));
    expect(cells[cells.length - 1]).toBeLessThan(120);
  });

  it("竖屏帧格子更窄更密（9:16 → 460/22.5 ≈ 20 格）", () => {
    const cells = filmstripCells(120, 460, 9 / 16, 40);
    expect(cells.length).toBe(Math.round(460 / ((9 / 16) * 40)));
    expect(cells.length).toBeGreaterThan(15);
  });

  it("帧不足时一格一帧（不重复铺满）", () => {
    expect(filmstripCells(4, 460, 16 / 9, 40)).toEqual([0, 1, 2, 3]);
  });

  it("退化输入：无帧返回空、非法比例回退 16:9、极窄轨道保底 2 格", () => {
    expect(filmstripCells(0, 460, 16 / 9, 40)).toEqual([]);
    expect(filmstripCells(10, 460, Number.NaN, 40).length).toBe(
      Math.round(460 / ((16 / 9) * 40)),
    );
    const narrow = filmstripCells(120, 10, 16 / 9, 40);
    expect(narrow.length).toBe(2);
    expect(narrow[0]).toBe(0);
    expect(narrow[1]).toBeLessThan(120);
  });
});
