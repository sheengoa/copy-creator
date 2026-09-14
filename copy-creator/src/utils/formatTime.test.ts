import { describe, expect, it, beforeAll } from "vitest";
import i18n from "../i18n";
import { formatTime, formatRelativeTime } from "./formatTime";

// 固定"现在"，使相对时间断言确定性。
const NOW = new Date("2026-09-11T12:00:00+08:00").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("formatTime", () => {
  it("formats to M/D HH:MM and falls back for unparsable input", () => {
    // 实现按用户本地时区渲染，期望值须从同一 Date 的本地字段推导，
    // 断言才与时区无关（CI 在 UTC、开发机在 UTC+8 均须通过）。
    const date = new Date("2026-09-11T08:05:00+08:00");
    const expected = `${date.getMonth() + 1}/${date.getDate()} ${String(
      date.getHours(),
    ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    expect(formatTime("2026-09-11T08:05:00+08:00")).toBe(expected);
    expect(formatTime("not-a-date")).toBe("not-a-date");
  });
});

describe("formatRelativeTime", () => {
  it("renders just now / minutes / hours / days in Chinese", () => {
    expect(formatRelativeTime(ago(10_000), NOW)).toBe("刚刚");
    expect(formatRelativeTime(ago(3 * 60_000), NOW)).toBe("3 分钟前");
    expect(formatRelativeTime(ago(2 * 60 * 60_000), NOW)).toBe("2 小时前");
    expect(formatRelativeTime(ago(3 * 24 * 60 * 60_000), NOW)).toBe("3 天前");
  });

  it("falls back to absolute time beyond 7 days", () => {
    const value = ago(8 * 24 * 60 * 60_000);
    expect(formatRelativeTime(value, NOW)).toBe(formatTime(value));
  });

  it("falls back to absolute time for unparsable or future input", () => {
    expect(formatRelativeTime("not-a-date", NOW)).toBe("not-a-date");
    const future = new Date(NOW + 60_000).toISOString();
    expect(formatRelativeTime(future, NOW)).toBe(formatTime(future));
  });
});
