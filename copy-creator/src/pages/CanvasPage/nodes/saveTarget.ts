import type { ResourceFolder } from "../../../types";

// 保存节点目标详情（分组 + 基名）的纯逻辑：与 saveRuntime.tsx 的自动
// 保存管线共用，独立成无组件模块便于单测（react-refresh 约定）。
//
// 命名约定（用户 2026-11-10 定案）：基名留空沿用产物原名（旧行为零变
// 化）；单张直接用基名，多张按「基名-1 / 基名-2」展开；库内同名冲突由
// 后端加「 (1)」序号不覆盖；指定路径目标由前端拼基名（目录内覆盖沿用
// 「另存是用户显式动作」的旧语义，目录选择本身不变）。

/** 库内保存的基名展开：第 index 张（0 起）的 baseName 参数；空基名 =
 *  产物原名（Rust 端留空即沿用）。 */
export function saveBaseNameOf(base: string, count: number, index: number): string {
  const name = base.trim();
  if (!name) return "";
  return count > 1 ? `${name}-${index + 1}` : name;
}

/** 指定路径目标的导出文件名：基名替换产物原名（扩展名取源），多张同
 *  规则展开；空基名沿用原名。 */
export function saveDirFileNameOf(sourcePath: string, base: string, count: number, index: number): string {
  const raw = sourcePath.split(/[\\/]/).pop() ?? "产物";
  const name = base.trim();
  if (!name) return raw;
  const ext = raw.includes(".") ? raw.slice(raw.lastIndexOf(".")) : "";
  const stem = count > 1 ? `${name}-${index + 1}` : name;
  return `${stem}${ext}`;
}

/** 已保存产物指纹：上游路径 + 目标详情（分组/基名）拼接。详情变更即
 *  重存一份（旧文件保留，与换保存目标同语义）。 */
export function saveFingerprintOf(paths: string[], group: string, name: string): string {
  return JSON.stringify([paths, group, name]);
}

export interface SaveGroupRow {
  /** 库内相对路径（空=未分组）。 */
  path: string;
  /** 展示名（末级段名；未分组行用固定文案键）。 */
  label: string;
  count: number;
  /** 树深度（未分组=0，顶级分组=0，子级递增）。 */
  depth: number;
}

/** 分组树拍平成浮层列表：首行固定「未分组」（根节点 name/path 均空），
 *  子分组带缩进深度；name 逐级归位为末级段名。 */
export function flattenResourceGroups(folders: ResourceFolder[]): SaveGroupRow[] {
  const rows: SaveGroupRow[] = [];
  const walk = (folder: ResourceFolder, depth: number) => {
    const isRoot = folder.path === "";
    rows.push({
      path: folder.path,
      label: isRoot ? "" : (folder.path.split("/").pop() ?? folder.name),
      count: folder.count,
      depth: isRoot ? 0 : depth,
    });
    for (const child of folder.children) walk(child, isRoot ? 0 : depth + 1);
  };
  for (const folder of folders) walk(folder, 0);
  return rows;
}
