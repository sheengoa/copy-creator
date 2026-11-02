import { useTranslation } from "react-i18next";
import type { CSSProperties, ReactNode } from "react";
import { Icons } from "../../../components/Icons";
import type { CanvasNode } from "../../../stores/canvasStore";
import { MEDIA_COLOR } from "./colors";
import { NodeHint } from "./NodeHint";
import { outMediaColor } from "./registry";
import type { NodeDefinition } from "./types";

// 节点壳（NodeShell，基座 chrome）：外壳 div（pc-node / fc-type-* /
// pc-resized / pc-selected / pc-spawn + --node-accent + 高度规则）、玻璃
// 头栏、类型化端口条、默认删除工具、四角尺寸手柄。各节点模块只提供
// 内容层（children）。后续新增节点类型沿用此 chrome（决策 9：只需注册
// 类型色与内容层样式）。
//
// DOM 契约：.pc-node[data-key] 是手势委托与实测锚点的基准；data-key /
// .pc-resize[data-corner] / .pc-port[data-port-id]（出口恒 "__out"）保真，
// 连线/选中/缩放/双击全部依赖，不可改动。
//
// 高度规则（视觉标准 B+）：未拖过尺寸手柄的节点高度由内容撑开；
// def.fixedHeight（load_text 常驻编辑框）恒渲染固定高。chrome="note"
// 不加 pc-resized（便签体不吃让位规则），与基座化前行为一致。

interface NodeShellProps {
  def: NodeDefinition;
  node: CanvasNode;
  selected: boolean;
  pulsing: boolean;
  size: { w: number; h: number };
  /** 默认删除工具的回调（调用方包装 deleteNodes([id])）。 */
  onDelete: (id: string) => void;
  /** 附加工具按钮（note 的 edit），渲染在删除钮之前。 */
  toolsExtra?: ReactNode;
  children?: ReactNode;
}

export function NodeShell({ def, node, selected, pulsing, size, onDelete, toolsExtra, children }: NodeShellProps) {
  const { t } = useTranslation();
  const autoHeight = node.height == null;
  const resized = !autoHeight && def.chrome === "standard";
  return (
    <div
      data-key={node.id}
      // pc-resized：落库固定高的节点（拖过手柄/历史高度），预览区
      // 据此切换为「吃掉剩余空间」模式，按钮行永不被推出可视区。
      className={`pc-node fc-type-${node.type}${resized ? " pc-resized" : ""}${selected ? " pc-selected" : ""}${pulsing ? " pc-spawn" : ""}`}
      style={
        {
          left: node.pos_x,
          top: node.pos_y,
          width: size.w,
          height: !autoHeight || def.fixedHeight ? size.h : undefined,
          "--node-accent": def.accent,
        } as CSSProperties
      }
    >
      <div className="pc-node-head">
        <span className="pc-node-kind">{t(`canvas.node.${node.type}`)}</span>
        {node.title && <b className="pc-node-title">{node.title}</b>}
      </div>
      {portBarOf(def, node, t)}
      {children}
      <span className="pc-node-tools">
        {toolsExtra}
        <NodeHint text={t("common.delete")}>
          <button
            type="button"
            className="danger"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(node.id);
            }}
          >
            {Icons.delete}
          </button>
        </NodeHint>
      </span>
      {(["nw", "ne", "sw", "se"] as const).map((corner) => (
        <span key={corner} className={`pc-resize ${corner}`} data-corner={corner} aria-hidden="true" />
      ))}
    </div>
  );
}

// 端口行（对齐工程画布）：每行一个输入口（点 + 名称），首行右端输出
// 口。口点色按媒体类型；data-port-id 供实测锚点与摘线/落点识别。
// note（无口）天然返回 null，与基座化前「不渲染端口条」一致。
function portBarOf(def: NodeDefinition, node: CanvasNode, t: (key: string) => string): ReactNode {
  if (def.ports.ins.length === 0 && !def.ports.out) return null;
  const rows = Math.max(def.ports.ins.length, def.ports.out ? 1 : 0);
  return (
    <div className="pc-port-bar">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="pc-port-row">
          {def.ports.ins[i] ? (
            <>
              <span
                className="pc-port pc-port-in"
                data-port="in"
                data-port-id={def.ports.ins[i].id}
                style={{ background: MEDIA_COLOR[def.ports.ins[i].mediaKind] }}
              />
              <span className="pc-port-name">{t(`canvas.port.${def.ports.ins[i].mediaKind}`)}</span>
            </>
          ) : null}
          {i === 0 && def.ports.out ? (
            <>
              <span className="pc-port-name pc-port-name-out">{t(`canvas.port.${def.ports.out.mediaKind}`)}</span>
              <span
                className="pc-port pc-port-out"
                data-port="out"
                data-port-id="__out"
                style={{ background: outMediaColor(node.type) }}
              />
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}
