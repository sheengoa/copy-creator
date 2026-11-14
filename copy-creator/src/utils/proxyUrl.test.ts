import { describe, expect, it } from "vitest";
import { isValidProxy } from "./proxyUrl";

describe("isValidProxy（画布 AI 代理地址校验，与后端 normalize_proxy 同语义）", () => {
  it("留空/纯空白 = 不走代理，恒合法", () => {
    expect(isValidProxy("")).toBe(true);
    expect(isValidProxy("   ")).toBe(true);
  });

  it("四种合法协议放行（含大小写与首尾空白容忍）", () => {
    expect(isValidProxy(" http://127.0.0.1:7890 ")).toBe(true);
    expect(isValidProxy("https://proxy.example.com")).toBe(true);
    expect(isValidProxy("socks5://127.0.0.1:7891")).toBe(true);
    expect(isValidProxy("SOCKS5H://127.0.0.1:7891")).toBe(true);
  });

  it("非法前缀或残缺 URL 拦下", () => {
    expect(isValidProxy("ftp://127.0.0.1:21")).toBe(false);
    expect(isValidProxy("127.0.0.1:7890")).toBe(false);
    expect(isValidProxy("http://")).toBe(false);
    expect(isValidProxy("socks4://127.0.0.1:1080")).toBe(false);
  });
});
