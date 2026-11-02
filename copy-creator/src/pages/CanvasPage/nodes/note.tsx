import { Icons } from "../../../components/Icons";
import { MEDIA_COLOR } from "./colors";
import type { NodeDefinition } from "./types";

// 便签节点：标准头栏卡 + 琥珀内嵌便签体（琥珀即文本黄），双击进入编辑。
// 无端口、无 pc-resized、自包 fc-note-body、工具条多 edit 钮——chrome
// 走 note 变体。
export const noteDef: NodeDefinition = {
  type: "note",
  chrome: "note",
  menu: { group: "misc", icon: Icons.edit },
  accent: MEDIA_COLOR.text,
  size: { w: 220, h: null },
  minSize: { w: 120, h: 80 },
  fallbackSize: { w: 220, h: 120 },
  ports: { ins: [], out: null },
  formWrap: false,
};
