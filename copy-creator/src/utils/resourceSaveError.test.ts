import { describe, expect, it } from "vitest";
import { parseResourceSaveError } from "./resourceSaveError";

describe("parseResourceSaveError", () => {
  it("识别重名错误并提取冲突文件名", () => {
    expect(parseResourceSaveError("已存在同名文件：开箱烘鞋器.txt")).toEqual({
      kind: "nameExists",
      fileName: "开箱烘鞋器.txt",
    });
  });

  it("重名错误缺文件名时不归类", () => {
    expect(parseResourceSaveError("已存在同名文件：")).toBeNull();
    expect(parseResourceSaveError("已存在同名文件： ")).toBeNull();
  });

  it("识别目标分组不存在", () => {
    expect(parseResourceSaveError("资源分组不存在")).toEqual({ kind: "groupMissing" });
    // 近似但不同的消息不得误判（原文展示由调用方兜底）。
    expect(parseResourceSaveError("资源分组不存在于清单")).toBeNull();
  });

  it("识别名称校验失败消息族", () => {
    expect(parseResourceSaveError("文件名包含非法字符")).toEqual({
      kind: "nameInvalid",
      message: "文件名包含非法字符",
    });
    expect(parseResourceSaveError("该文件名是系统保留名称")).toEqual({
      kind: "nameInvalid",
      message: "该文件名是系统保留名称",
    });
  });

  it("其余错误返回 null，调用方回退泛化文案", () => {
    expect(parseResourceSaveError("资源文件写入失败: disk full")).toBeNull();
    expect(parseResourceSaveError(new Error("network down"))).toBeNull();
    expect(parseResourceSaveError(undefined)).toBeNull();
    expect(parseResourceSaveError(42)).toBeNull();
  });
});
