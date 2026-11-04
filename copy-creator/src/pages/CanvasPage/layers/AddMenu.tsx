import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "../../../components/Icons";
import type { CanvasNode, CanvasNodeType } from "../../../stores/canvasStore";
import type { RefObject } from "react";
import { menuGroups, menuIconOf, NODE_DEFS, PORT_DEFS } from "../nodes/registry";
import { WheelGate } from "../nodes/WheelGate";
import type { DragState } from "../engine/gestureTypes";
import type { AddMenuState } from "../engine/useCanvasGestures";

// 双击空白的节点选择框（ComfyUI 搜索框的对应物）。2026-11-04 白玻璃精修
// 定案：媒体类型色裸图标（--tint）+ 双行条目 + 搜索聚焦环 + ESC 键帽 +
// 分组标题吸顶带计数 + 底部键位提示条；键盘 ↑↓ 选择、↵ 添加（与指针
// 建节点共用 commitAddNode，落菜单打开点）。分组过滤、连线续接的
// accepts 过滤、贴近视口下缘的限高滚动不变。
export function AddMenu({
  addMenu,
  addMenuQuery,
  setAddMenuQuery,
  closeAddMenu,
  discardDetachedWire,
  commitAdd,
  dragRef,
  vpRef,
  nodes,
}: {
  addMenu: AddMenuState;
  addMenuQuery: string;
  setAddMenuQuery(q: string): void;
  closeAddMenu(): void;
  discardDetachedWire(detached: { connId: string }): void;
  commitAdd(drag: Extract<DragState, { kind: "addnode" }>): void;
  dragRef: RefObject<DragState | null>;
  vpRef: RefObject<HTMLDivElement | null>;
  nodes: CanvasNode[];
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 键盘导航的扁平序号（可见条目顺序）；悬停同步它，滚动跟随高亮。 */
  const [activeIdx, setActiveIdx] = useState(0);

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

  const query = addMenuQuery.trim().toLowerCase();
  // 过滤后的分组与扁平可见序（键盘导航用）；查询变化即回到首项。
  const groups = menuGroups
    .map((group) => ({
      ...group,
      types: group.types.filter(
        (type) => t(`canvas.node.${type}`).toLowerCase().includes(query) && menuFilterType(type),
      ),
    }))
    .filter((group) => group.types.length > 0);
  const visible = groups.flatMap((g) => g.types);
  useEffect(() => {
    setActiveIdx(0);
  }, [addMenuQuery]);
  useEffect(() => {
    if (activeIdx > visible.length - 1) setActiveIdx(Math.max(0, visible.length - 1));
  }, [activeIdx, visible.length]);
  // 高亮项跟随滚动：换页/过滤后保持可见。
  useEffect(() => {
    listRef.current
      ?.querySelector(`.pc-addmenu-item[data-idx="${activeIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  /** 键盘回车建节点：与指针点击同一 commitAdd（落菜单打开的世界点）。 */
  const commitActive = () => {
    const type = visible[activeIdx];
    if (!type) return;
    commitAdd({
      kind: "addnode",
      sx: 0,
      sy: 0,
      moved: false,
      fox: addMenu.wx,
      foy: addMenu.wy,
      frameKey: type,
      wire: addMenu.wire,
      detached: addMenu.detached,
    });
    closeAddMenu();
  };

  return (
    <WheelGate>
      <div
        // 菜单锚定读视口实测尺寸（vpRef）——引擎既有惯例：视口实测
        // 以 ref 承载、弹出时直读，定点豁免 react-hooks/refs。
        className="pc-addmenu"
        style={{
          // eslint-disable-next-line react-hooks/refs -- 视口实测渲染期直读，见上
          left: Math.max(8, Math.min(addMenu.sx, (vpRef.current?.clientWidth ?? 600) - 292)),
          top: addMenu.sy,
          // eslint-disable-next-line react-hooks/refs -- 同上
          maxHeight: Math.max(150, (vpRef.current?.clientHeight ?? 600) - addMenu.sy - 12),
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="pc-addmenu-search">
          {Icons.search}
          <input
            placeholder={t("project.canvas.addNodeSearch")}
            value={addMenuQuery}
            onChange={(event) => setAddMenuQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // 取消菜单＝不建节点直接退出：摘下的线就此断开。
                if (addMenu.detached) discardDetachedWire(addMenu.detached);
                closeAddMenu();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                if (visible.length) setActiveIdx((i) => (visible.length ? (i + 1) % visible.length : 0));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                if (visible.length) setActiveIdx((i) => (i - 1 + visible.length) % visible.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                commitActive();
              }
            }}
            // 聚焦必须带 preventScroll：默认聚焦会滚动视口容器把输入框
            // 露出来，表现为整个画布节点集体平移。
            ref={(el) => {
              el?.focus({ preventScroll: true });
            }}
          />
          <span className="pc-addmenu-esc">ESC</span>
        </div>
        <div className="pc-addmenu-list" ref={listRef}>
          {groups.map((group) => (
            <div key={group.key} className="pc-addmenu-group">
              <div className="pc-addmenu-group-title">
                {t(`canvas.menu.${group.key}`)}
                <span className="pc-addmenu-count">{group.types.length}</span>
              </div>
              {group.types.map((type) => {
                const idx = visible.indexOf(type);
                return (
                  <button
                    key={type}
                    type="button"
                    className={`pc-addmenu-item${idx === activeIdx ? " is-active" : ""}`}
                    data-idx={idx}
                    style={{ "--tint": NODE_DEFS[type].accent } as CSSProperties}
                    onMouseEnter={() => setActiveIdx(idx)}
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
                    <span className="pc-addmenu-go">{Icons.chevronRight}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="pc-addmenu-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            {t("project.canvas.addNodeKbdSelect")}
          </span>
          <span>
            <kbd>↵</kbd>
            {t("project.canvas.addNodeKbdAdd")}
          </span>
          <span>
            <kbd>ESC</kbd>
            {t("project.canvas.addNodeKbdClose")}
          </span>
        </div>
      </div>
    </WheelGate>
  );
}
