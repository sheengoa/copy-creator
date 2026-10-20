import { describe, expect, it } from "vitest";
import {
  FIND_HISTORY_LIMIT,
  normalizeFindHistory,
  parseFindHistory,
  recordFindQuery,
  recordReplacement,
  removeFindHistoryEntry,
  serializeFindHistory,
  type FindHistoryEntry,
} from "./findHistory";

const entry = (query: string, replacement = "", replaced = false): FindHistoryEntry => ({
  query,
  replacement,
  replaced,
});

describe("normalizeFindHistory", () => {
  it("非数组一律空", () => {
    expect(normalizeFindHistory(undefined)).toEqual([]);
    expect(normalizeFindHistory(null)).toEqual([]);
    expect(normalizeFindHistory("nope")).toEqual([]);
    expect(normalizeFindHistory({ query: "x" })).toEqual([]);
  });

  it("丢弃畸形项并钳正字段类型", () => {
    expect(
      normalizeFindHistory([
        null,
        42,
        { query: "" },
        { replacement: "y" },
        { query: "a", replacement: 5, replaced: "yes" },
        { query: "b", replacement: "B", replaced: true },
      ]),
    ).toEqual([entry("a"), entry("b", "B", true)]);
  });

  it("超出容量截断到上限", () => {
    const many = Array.from({ length: FIND_HISTORY_LIMIT + 5 }, (_, i) => ({ query: `q${i}` }));
    const result = normalizeFindHistory(many);
    expect(result).toHaveLength(FIND_HISTORY_LIMIT);
    expect(result[0].query).toBe("q0");
  });
});

describe("parseFindHistory / serializeFindHistory", () => {
  it("序列化与解析往返一致", () => {
    const entries = [entry("a", "A", true), entry("b")];
    expect(parseFindHistory(serializeFindHistory(entries))).toEqual(entries);
  });

  it("缺失/空串/非法 JSON 一律空", () => {
    expect(parseFindHistory(undefined)).toEqual([]);
    expect(parseFindHistory("")).toEqual([]);
    expect(parseFindHistory("{oops")).toEqual([]);
  });
});

describe("recordFindQuery", () => {
  it("空查找词原样返回（不产生空条目）", () => {
    const entries = [entry("a")];
    expect(recordFindQuery(entries, "")).toBe(entries);
  });

  it("新词置顶插入，标记为仅查找", () => {
    expect(recordFindQuery([entry("a", "A", true)], "b")).toEqual([
      entry("b"),
      entry("a", "A", true),
    ]);
  });

  it("重复查找置顶且保留既有替换配对，不降级「替换过」", () => {
    const entries = [entry("x"), entry("a", "A", true), entry("b")];
    expect(recordFindQuery(entries, "a")).toEqual([
      entry("a", "A", true),
      entry("x"),
      entry("b"),
    ]);
  });
});

describe("recordReplacement", () => {
  it("空查找词原样返回", () => {
    const entries = [entry("a")];
    expect(recordReplacement(entries, "", "A")).toBe(entries);
  });

  it("记录查找词 + 替换值对并标记替换过", () => {
    expect(recordReplacement([entry("a")], "x", "y")).toEqual([entry("x", "y", true), entry("a")]);
  });

  it("仅查找过的旧条目原地升级为替换对并置顶", () => {
    const entries = [entry("a"), entry("x")];
    expect(recordReplacement(entries, "a", "A")).toEqual([entry("a", "A", true), entry("x")]);
  });

  it("替换值为空（删除类替换）同样成立", () => {
    expect(recordReplacement([], "a", "")).toEqual([entry("a", "", true)]);
  });
});

describe("removeFindHistoryEntry", () => {
  it("按查找词移除，其余保持顺序", () => {
    const entries = [entry("a"), entry("b", "B", true), entry("c")];
    expect(removeFindHistoryEntry(entries, "b")).toEqual([entry("a"), entry("c")]);
  });

  it("移除不存在的词返回等价内容", () => {
    const entries = [entry("a")];
    expect(removeFindHistoryEntry(entries, "zzz")).toEqual([entry("a")]);
  });
});

describe("容量上限", () => {
  it("置顶插入超出上限时淘汰最旧", () => {
    let entries: FindHistoryEntry[] = Array.from({ length: FIND_HISTORY_LIMIT }, (_, i) =>
      entry(`q${i}`),
    );
    entries = recordFindQuery(entries, "new");
    expect(entries).toHaveLength(FIND_HISTORY_LIMIT);
    expect(entries[0].query).toBe("new");
    expect(entries.at(-1)?.query).toBe(`q${FIND_HISTORY_LIMIT - 2}`);
  });
});
