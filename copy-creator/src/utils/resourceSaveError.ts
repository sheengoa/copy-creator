// 资源保存类后端错误的结构解析：后端命令以中文字符串返回错误原因，其中
// 一部分是用户可行动的（换一个名称、重新选分组），界面不得把它们吞成
// 「保存失败，请重试」——重试对重名这类失败永远无效。本模块是错误文案
// 结构知识的唯一位置（守卫：architectureGuard 规则 20）；文案本身由
// src-tauri 侧测试锁定（db/tests.rs 断言「已存在同名文件」等）。

export type ResourceSaveError =
  | { kind: "nameExists"; fileName: string } // 目标分组已存在同名文件
  | { kind: "groupMissing" } // 目标分组不存在（可能已被删除）
  | { kind: "nameInvalid"; message: string }; // 名称校验失败（非法字符/保留名等）

const NAME_EXISTS_PREFIX = "已存在同名文件：";
const GROUP_MISSING_MESSAGE = "资源分组不存在";

export function parseResourceSaveError(error: unknown): ResourceSaveError | null {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "";
  if (message.startsWith(NAME_EXISTS_PREFIX)) {
    const fileName = message.slice(NAME_EXISTS_PREFIX.length).trim();
    return fileName ? { kind: "nameExists", fileName } : null;
  }
  if (message === GROUP_MISSING_MESSAGE) return { kind: "groupMissing" };
  // 命名校验失败的消息族（文件名不能为空/超长/以点号开头/包含非法字符/
  // 系统保留名称），与详情页重命名共用 validate_resource_rename_stem 文案。
  if (message.includes("文件名")) return { kind: "nameInvalid", message };
  return null;
}
