import { describe, expect, it } from "vitest";
import { touchCache, trimCache } from "./clipboardStore";

// 真 LRU 语义：trimCache 按插入序截断（键序即新近序），命中必须经
// touchCache 刷新，否则长会话淘汰的是最早插入的热点条目。
describe("touchCache 缓存命中刷新新近度", () => {
  it("命中键移到末尾，trim 后保留最近使用的", () => {
    let cache: Record<string, string> = { a: "1", b: "2", c: "3" };
    cache = touchCache(cache, "a");
    expect(Object.keys(cache)).toEqual(["b", "c", "a"]);
    cache = trimCache(cache, 2);
    expect(Object.keys(cache)).toEqual(["c", "a"]);
  });

  it("末尾键命中原对象返回（避免无谓的级联更新）", () => {
    const cache: Record<string, string> = { a: "1", b: "2" };
    expect(touchCache(cache, "b")).toBe(cache);
  });

  it("未命中键原对象返回", () => {
    const cache: Record<string, string> = { a: "1" };
    expect(touchCache(cache, "missing")).toBe(cache);
    expect(touchCache({}, "a")).toEqual({});
  });
});
