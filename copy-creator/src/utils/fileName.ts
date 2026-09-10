// 文件路径取文件名的统一实现：剪贴板、快捷输入、径向菜单共用
// （原四处各有一份相同写法）。

/** 取路径最后一段作为文件名，兼容 Windows 反斜杠；空段回落原值。 */
export function fileNameFromPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}
