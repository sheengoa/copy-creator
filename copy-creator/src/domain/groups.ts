// 领域层：资源分组树的组织与排序规则（主窗口资源页与径向菜单共用）。
import type { ResourceFolder } from "../types";

export interface FlattenedResourceFolder {
  folder: ResourceFolder;
  depth: number;
}

// 把多级分组路径格式化为「A / B」展示形式；空路径返回空串（未分组由调用方处理）。
export function formatResourceFolderPath(path: string): string {
  return path.split("/").filter(Boolean).join(" / ");
}

export function flattenResourceFolders(
  folders: ResourceFolder[],
  depth = 0,
): FlattenedResourceFolder[] {
  return folders.flatMap((folder) => [
    { folder, depth },
    ...flattenResourceFolders(folder.children ?? [], depth + 1),
  ]);
}

// 求分组树扁平化后的全路径顺序（提交手动排序时按此持久化）。
export function flattenResourceFolderPaths(folders: ResourceFolder[]): string[] {
  return flattenResourceFolders(folders).map(({ folder }) => folder.path);
}

// 求指定父分组（null 为顶层）下的兄弟分组；找不到父分组时返回空数组。
export function getResourceFolderSiblings(
  folders: ResourceFolder[],
  parentPath: string | null,
): ResourceFolder[] {
  if (parentPath === null) return folders;
  return findResourceFolder(folders, parentPath)?.children ?? [];
}

// 按 orderedPaths 重排指定父分组下的兄弟（未提及的兄弟按原顺序排在其后），
// 其余层级保持不变。返回新树，不修改入参。
export function reorderResourceFolderSiblings(
  folders: ResourceFolder[],
  parentPath: string | null,
  orderedPaths: string[],
): ResourceFolder[] {
  const reorder = (level: ResourceFolder[], depth: string | null): ResourceFolder[] => {
    const mapped = level.map((folder) => ({
      ...folder,
      children: reorder(folder.children ?? [], folder.path),
    }));
    if (depth !== parentPath) return mapped;
    const byPath = new Map(mapped.map((folder) => [folder.path, folder]));
    const head = orderedPaths
      .map((path) => byPath.get(path))
      .filter((folder): folder is ResourceFolder => Boolean(folder));
    const tail = mapped.filter((folder) => !orderedPaths.includes(folder.path));
    return [...head, ...tail];
  };
  return reorder(folders, null);
}

export function findResourceFolder(
  folders: ResourceFolder[],
  path: string,
): ResourceFolder | null {
  for (const folder of folders) {
    if (folder.path === path) return folder;
    const found = findResourceFolder(folder.children ?? [], path);
    if (found) return found;
  }
  return null;
}

export function isResourceFolderPath(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

export function getResourceFolderRoot(path: string): string {
  return path.split("/")[0] || "";
}
