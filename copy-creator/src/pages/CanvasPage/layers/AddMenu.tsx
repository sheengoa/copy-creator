import { useTranslation } from "react-i18next";
import type { CanvasNode, CanvasNodeType } from "../../../stores/canvasStore";
import type { RefObject } from "react";
import { menuGroups, menuIconOf, PORT_DEFS } from "../nodes/registry";
import { WheelGate } from "../nodes/WheelGate";
import type { DragState } from "../engine/gestureTypes";
import type { AddMenuState } from "../engine/useCanvasGestures";

// 双击空白的节点选择框（自 FreeCanvas.tsx 渲染区零改动搬运，2026-11-03
// 引擎拆分阶段 6c）。ComfyUI 搜索框的对应物：按生成/加载/输出三类分组；
// 左上角锚在指针处；贴近视口下缘时按剩余空间限高，分组列表区内滚动——
// 底部被裁掉又滚不到的项等于选不了。拖线/摘线到空白弹出时只列能接上的
// 节点类型（menuFilterType accepts 过滤）。

export function AddMenu({
  addMenu,
  addMenuQuery,
  setAddMenuQuery,
  closeAddMenu,
  discardDetachedWire,
  dragRef,
  vpRef,
  nodes,
}: {
  addMenu: AddMenuState;
  addMenuQuery: string;
  setAddMenuQuery(q: string): void;
  closeAddMenu(): void;
  discardDetachedWire(detached: { connId: string }): void;
  dragRef: RefObject<DragState | null>;
  vpRef: RefObject<HTMLDivElement | null>;
  nodes: CanvasNode[];
}) {
  const { t } = useTranslation();

  // 连线续接的 accepts 过滤（拖线/摘线到空白时只列能接上的节点类型）。
  const menuFilterType = (type: CanvasNodeType): boolean => {
    const pending = addMenu.wire ?? (addMenu.detached ? { fromKey: addMenu.detached.fromKey, fromDir: "in" as const, fromPortId: "" } : null);
    if (!pending) return true;
    const fromNode = nodes.find((n) => n.id === pending.fromKey);
    if (!fromNode) return true;
    if (pending.fromDir === "out") {
      // 正拖：新节点需要能接住上游类型的输入口。
      return PORT_DEFS[type].ins.some((p) => p.accepts.includes(fromNode.type));
    }
    if (pending.fromDir === "in" && !addMenu.detached) {
      // 反拖：新节点是上游，需有 out 且被源输入口接受。
      const inDef = PORT_DEFS[fromNode.type].ins.find((p) => p.id === pending.fromPortId);
      return !!PORT_DEFS[type].out && (!inDef || inDef.accepts.includes(type));
    }
    // 摘线：新节点作为下游，需要能接住原上游的口。
    return PORT_DEFS[type].ins.some((p) => p.accepts.includes(fromNode.type));
  };

  return (
    <WheelGate>
      <div
        // 菜单锚定读视口实测尺寸（vpRef）——引擎既有惯例：视口实测
        // 以 ref 承载、弹出时直读，定点豁免 react-hooks/refs。
        className="pc-addmenu"
        style={{
          // eslint-disable-next-line react-hooks/refs -- 视口实测渲染期直读，见上
          left: Math.max(8, Math.min(addMenu.sx, (vpRef.current?.clientWidth ?? 600) - 266)),
          top: addMenu.sy,
          // eslint-disable-next-line react-hooks/refs -- 同上
          maxHeight: Math.max(150, (vpRef.current?.clientHeight ?? 600) - addMenu.sy - 12),
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
      <input
        className="pc-addmenu-search"
        placeholder={t("project.canvas.addNodeSearch")}
        value={addMenuQuery}
        onChange={(event) => setAddMenuQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // 取消菜单＝不建节点直接退出：摘下的线就此断开。
            if (addMenu.detached) discardDetachedWire(addMenu.detached);
            closeAddMenu();
          }
        }}
        // 聚焦必须带 preventScroll：默认聚焦会滚动视口容器把输入框
        // 露出来，表现为整个画布节点集体平移。
        ref={(el) => {
          el?.focus({ preventScroll: true });
        }}
      />
      <div className="pc-addmenu-list">
      {menuGroups
        .map((group) => ({
          ...group,
          types: group.types.filter(
            (type) =>
              t(`canvas.node.${type}`).toLowerCase().includes(addMenuQuery.trim().toLowerCase()) &&
              menuFilterType(type),
          ),
        }))
        .filter((group) => group.types.length > 0)
        .map((group) => (
          <div key={group.key} className="pc-addmenu-group">
            <div className="pc-addmenu-group-title">{t(`canvas.menu.${group.key}`)}</div>
            {group.types.map((type) => (
              <button
                key={type}
                type="button"
                className="pc-addmenu-item"
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  event.preventDefault();
                  // 立即捕获指针：菜单按钮随 setAddMenu(null) 卸载，
                  // 卸载后浏览器释放捕获，pointerup 按 hit-test 落到
                  // 视口、照常冒泡给 window 的 onUp 收尾。
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {
                    // 指针已不可捕获（合成事件等）：退化为无捕获。
                  }
                  dragRef.current = {
                    kind: "addnode", sx: event.clientX, sy: event.clientY, moved: false,
                    fox: addMenu.wx, foy: addMenu.wy, frameKey: type,
                    wire: addMenu.wire,
                    detached: addMenu.detached,
                  };
                  closeAddMenu();
                }}
              >
                {menuIconOf(type)}
                <span>{t(`canvas.node.${type}`)}</span>
                <small>{t(`canvas.typeHint.${type}`)}</small>
              </button>
            ))}
          </div>
        ))}
      </div>
      </div>
    </WheelGate>
  );
}
