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
 *  重存一份（旧文件保留，与换保存目标同语义）。
 *  兼容约定：分组/基名双空时保持改版前的 join("\n") 格式逐字一致——
 *  存量节点（指纹是旧格式）升级后首刷不触发冗余重存；设详情后走 JSON
 *  格式，详情清除回双空则与最初无详情保存匹配（不再补存，旧文件保留
 *  原则一致）。 */
export function saveFingerprintOf(paths: string[], group: string, name: string): string {
  if (!group && !name) return paths.join("\n");
  return JSON.stringify([paths, group, name]);
}

/** 保存成功后应落的指纹（2026-11-14 用户定案：命名一次性——名字属于
 *  上一批产物，保存成功即清空，不带入下一批；分组路径保留记忆）。指纹
 *  必须同步按空名计算：只清 auto_name 不动指纹，管线下一拍会因指纹不
 *  符把现有产物冗余重存一份。 */
export function savedFingerprintAfter(paths: string[], group: string): string {
  return saveFingerprintOf(paths, group, "");
}

export interface SaveGroupRow {
  /** 库内相对路径（空=未分组）。 */
  path: string;
  /** 展示名（末级段名；未分组行用固定文案键）。 */
  label: string;
  count: number;
  /** 树深度（未分组=0，顶级分组=0，子级递增）。 */
  depth: number;
  /** 是否有子分组（折叠树箭头与点击展开切换判定）。 */
  hasChildren: boolean;
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
      hasChildren: folder.children.length > 0,
    });
    for (const child of folder.children) walk(child, isRoot ? 0 : depth + 1);
  };
  for (const folder of folders) walk(folder, 0);
  return rows;
}

/** 折叠树可见性（2026-11-14 用户定案：默认只列顶级分组，不再全量拍平）：
 *  未分组行与顶级分组恒可见，子级要求其全部祖先段已展开。 */
export function isGroupRowVisible(path: string, expanded: Set<string>): boolean {
  if (!path) return true;
  const segs = path.split("/");
  for (let i = 1; i < segs.length; i++) {
    if (!expanded.has(segs.slice(0, i).join("/"))) return false;
  }
  return true;
}

/** 选中分组的全部祖先段（记忆链路自动展开：上次选到多深层，打开面板
 *  即展开到该层并高亮，复用路径零点击）。 */
export function groupAncestors(path: string): string[] {
  const segs = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join("/"));
  return out;
}

export interface SaveGroupHit {
  path: string;
  /** 命中的末级段名（高亮渲染用）。 */
  name: string;
  /** 父路径段已 join（空=顶级分组，显示层补「库根」）。 */
  parent: string;
  count: number;
}

/** 分组搜索（2026-11-14 用户定案：多分组深嵌套时快速定位）：末级段名
 *  不区分大小写包含匹配，按树序平铺返回；命中项带父路径看清嵌套位置。 */
export function searchGroupRows(rows: SaveGroupRow[], query: string): SaveGroupHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SaveGroupHit[] = [];
  for (const row of rows) {
    if (!row.path) continue; // 未分组无名字不参与搜索
    if (!row.label.toLowerCase().includes(q)) continue;
    const segs = row.path.split("/");
    hits.push({ path: row.path, name: row.label, parent: segs.slice(0, -1).join("/"), count: row.count });
  }
  return hits;
}
