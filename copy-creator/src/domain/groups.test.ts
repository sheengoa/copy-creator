// domain/groups 单元测试：分组树共享操作（展平、折叠展平）。
import { describe, expect, it } from "vitest";
import {
  flattenResourceFolders,
  flattenResourceFoldersVisible,
} from "./groups";
import type { ResourceFolder } from "../types";

function folder(path: string, children: ResourceFolder[] = [], count = 1): ResourceFolder {
  const name = path.split("/").pop() ?? "";
  return { name, path, count, children };
}

const tree: ResourceFolder[] = [
  folder("产出发头", [
    folder("产出发头/0910", [
      folder("产出发头/0910/大容量", [], 2),
      folder("产出发头/0910/2条", [], 3),
    ]),
    folder("产出发头/0908", [], 4),
  ]),
  folder("人物抠图", [], 5),
];

describe("flattenResourceFoldersVisible", () => {
  it("空折叠集合时与全量展平结果一致", () => {
    expect(flattenResourceFoldersVisible(tree, new Set())).toEqual(
      flattenResourceFolders(tree),
    );
  });

  it("折叠中间层级时该分组保留、其后代不产生行", () => {
    const rows = flattenResourceFoldersVisible(tree, new Set(["产出发头/0910"]));
    const paths = rows.map(({ folder: f }) => f.path);
    expect(paths).toEqual([
      "产出发头",
      "产出发头/0910",
      "产出发头/0908",
      "人物抠图",
    ]);
  });

  it("折叠顶层分组时仅隐藏其后代且不影响兄弟", () => {
    const rows = flattenResourceFoldersVisible(tree, new Set(["产出发头"]));
    expect(rows.map(({ folder: f }) => f.path)).toEqual(["产出发头", "人物抠图"]);
    // 折叠分组的 depth 保持其所在层级。
    expect(rows[0].depth).toBe(0);
  });

  it("折叠不存在的路径等价于全展开", () => {
    expect(flattenResourceFoldersVisible(tree, new Set(["不存在的分组"]))).toEqual(
      flattenResourceFolders(tree),
    );
  });
});
