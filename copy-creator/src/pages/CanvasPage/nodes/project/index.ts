import { characterDef, locationDef, propDef } from "./entities";
import { outputDef } from "./output";
import { promptPaperDef } from "./promptPaper";
import { segmentDef } from "./segment";
import { scriptPaperDef } from "./scriptPaper";
import { shotDef } from "./shot";

// 工程节点 defs（工程视图节点化 2026-11-05 阶段 B）：与自由画布节点同
// 体系注册（scope: "project"，便签 both 在自由画布侧），节点 chrome/
// 手势/引擎全部走自由画布基座。镜头/成片 menuHidden（画布不新建）。

export const PROJECT_NODE_DEFS = [
  shotDef,
  segmentDef,
  characterDef,
  locationDef,
  propDef,
  scriptPaperDef,
  promptPaperDef,
  outputDef,
];
