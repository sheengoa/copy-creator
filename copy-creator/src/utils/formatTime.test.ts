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
    expect(formatTime("2026-09-11T08:05:00+08:00")).toBe("9/11 08:05");
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
