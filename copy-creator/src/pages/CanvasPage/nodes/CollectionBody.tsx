import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "../../../components/Icons";
import { useCanvasStore } from "../../../stores/canvasStore";
import { ResourceThumb } from "./media";
import { NodeHint } from "./NodeHint";
import { collectionItemsOf } from "./upstream";
import type { NodeProps } from "./types";

// 合集节点内容层：多线汇入的有序列表——序号 + 缩略/内容 + 拖拽把手
// （剪切板/快捷输入同款）+ 悬停移除。节点体不再放其他内容，为生成等待
// 动画留白。拖拽排序会话是节点级状态，随本组件自持（dnd-kit sortable
// 同款模型）：拖拽全程 DOM 顺序不变——被抓行 1:1 跟手（指针位移直写
// transform），其余行按槽位让位（React 过渡）；松手才提交最终顺序并补
// 一个落位动画。

interface CollectionDragState {
  baseOrder: string[];
  slotTops: number[];
  stride: number;
  fromIndex: number;
  dragIndex: number;
  dy: number;
  order: string[];
}

export function CollectionBody({ node, scale, services }: NodeProps) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const connections = useCanvasStore((s) => s.connections);
  const deleteConnection = useCanvasStore((s) => s.deleteConnection);
  const updateNode = useCanvasStore((s) => s.updateNode);
  const [drag, setDrag] = useState<CollectionDragState | null>(null);
  /** 松手落位动画待办：被抓行松手时的视觉 top 与落位槽 top（均为屏幕
   *  几何），最终顺序渲染后由布局效果按差值滑入。 */
  const dropRef = useRef<{ connId: string; fromTop: number; toTop: number } | null>(null);

  const meta = node.metadata;

  // 松手落位：最终顺序渲染后，被抓行从松手视觉位置滑到落位槽。
  // （hooks 须无条件调用，kind 守卫只在渲染层生效。）
  useLayoutEffect(() => {
    const drop = dropRef.current;
    dropRef.current = null;
    if (!drop) return;
    const row = document.querySelector<HTMLElement>(
      `.pc-node[data-key="${node.id}"] .fc-collection-item[data-conn="${drop.connId}"]`,
    );
    if (!row) return;
    const delta = (drop.fromTop - drop.toTop) / scale;
    // 收尾：内联过渡还原为类定义。transitionend 在后台标签页可能不触发，
    // 加超时兜底（幂等）。
    const settle = () => {
      row.style.transition = "";
      row.removeEventListener("transitionend", settle);
    };
    row.addEventListener("transitionend", settle);
    window.setTimeout(settle, 240);
    if (Math.abs(delta) < 1) {
      // 落点几乎就是目标槽位：无需反向补偿，但拖拽跟手的残值 transform
      // 还挂在行上（行是 keyed 复用的同一 DOM），必须过渡归零——否则行
      // 永久停在松手位置，还撑出表单滚动区把后续行藏进去。
      row.style.transition = "transform 0.16s cubic-bezier(0.2, 0.8, 0.3, 1)";
      row.style.transform = "";
      return;
    }
    row.style.transition = "none";
    row.style.transform = `translateY(${delta}px)`;
    void row.offsetHeight; // 强制回流：让反向位移立刻生效
    row.style.transition = "transform 0.16s cubic-bezier(0.2, 0.8, 0.3, 1)";
    row.style.transform = "";
  }, [drag, scale, node.id]);

  if (meta.kind !== "collection_image" && meta.kind !== "collection_text" && meta.kind !== "collection_video") return null;

  const items = collectionItemsOf(nodes, connections, node, drag ? drag.baseOrder : null, t);

  /** 列表把手拖拽排序（指针实现）：抓起的行 1:1 跟手，其他行在跨槽时
   *  让位过渡；松手提交最终顺序并落位。 */
  const startReorder = (index: number, e: React.PointerEvent<HTMLButtonElement>) => {
    if (items.length < 2) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const listEl = handle.closest(".fc-collection-list");
    if (!listEl) return;
    const baseOrder = items.map((i) => i.from.id);
    const rowTops = items.map((_, i) => {
      const r = listEl.querySelector<HTMLElement>(`.fc-collection-item[data-idx="${i}"]`);
      return r ? r.getBoundingClientRect().top : 0;
    });
    const stride = items.length > 1 ? rowTops[1] - rowTops[0] : 0;
    if (stride <= 0) return;
    const draggedId = baseOrder[index];
    const draggedConnId = items[index].connId;
    const rowEl = handle.closest<HTMLElement>(".fc-collection-item");
    rowEl?.classList.add("is-dragging");
    // 上轮落位的内联过渡若还在（超时兜底前再次抓取），先清掉——内联
    // 样式优先于 .is-dragging 的类定义，会让跟手产生 0.16s 的过渡延迟。
    if (rowEl) rowEl.style.transition = "";
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // 指针不可捕获（合成事件等）：退化为元素监听。
    }
    const y0 = e.clientY;
    let dragIndex = index;
    const logical = [...baseOrder];
    let dy = 0;
    const onMove = (ev: PointerEvent) => {
      dy = ev.clientY - y0;
      // 跟手：行在缩放世界内，transform 必须换算成世界坐标——否则画布
      // 缩放 k≠1 时行移动 k×指针位移，「滑一下跑老远」。
      const dyWorld = dy / scale;
      rowEl?.style.setProperty("transform", `translateY(${dyWorld}px)`);
      // 槽位判定：被抓行中心点落在哪个基准槽位（几何计算，不受动画影响）。
      const centerY = rowTops[index] + dy + stride / 2;
      let idx = Math.floor((centerY - rowTops[0]) / stride);
      idx = Math.max(0, Math.min(items.length - 1, idx));
      if (idx !== dragIndex) {
        const pos = logical.indexOf(draggedId);
        const [moved] = logical.splice(pos, 1);
        logical.splice(idx, 0, moved);
        dragIndex = idx;
        setDrag({
          baseOrder, slotTops: rowTops, stride,
          fromIndex: index, dragIndex, dy, order: [...logical],
        });
      }
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      // transform 保持跟手值不动：DOM 重排提交后，布局效果会在绘制前
      // 把 transform 换成「视觉保持不动」的落位补偿值再过渡归零——
      // 提前设置会以旧布局为基准，松手瞬间跳一下。
      const finalOrder = [...logical];
      dropRef.current = {
        connId: draggedConnId,
        fromTop: rowTops[index] + dy, toTop: rowTops[dragIndex],
      };
      setDrag(null);
      void updateNode(node.id, {
        metadata: JSON.stringify({ ...meta, order: finalOrder }),
      });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  return (
    <div className="fc-node-form">
      {items.length === 0 ? (
        <div className="fc-node-placeholder">{t("canvas.collectionEmpty")}</div>
      ) : (
        <div className="fc-collection-list">
          {items.map((item, i) => {
            const orig = drag ? drag.baseOrder.indexOf(item.from.id) : -1;
            const isDragged = !!drag && orig === drag.fromIndex;
            // 让位位移：stride 是屏幕几何，transform 在缩放世界内，需换算。
            let shift = 0;
            if (drag && orig >= 0 && !isDragged) {
              if (drag.fromIndex < drag.dragIndex && orig > drag.fromIndex && orig <= drag.dragIndex) shift = -drag.stride / scale;
              else if (drag.fromIndex > drag.dragIndex && orig >= drag.dragIndex && orig < drag.fromIndex) shift = drag.stride / scale;
            }
            return (
              <div
                key={item.connId}
                className={`fc-collection-item${isDragged ? " is-dragging" : ""}`}
                data-idx={i}
                data-conn={item.connId}
                style={shift ? { transform: `translateY(${shift}px)` } : undefined}
                /* 行点击 = 追踪源节点（2026-11-04）：平移居中 + 边缘脉冲
                   闪烁；把手/移除各自挡冒泡，排序拖拽的 click 由视口手势
                   压制（suppressClickRef）。 */
                onClick={() => services.locateNode(item.from.id)}
              >
                <span className="fc-collection-idx">{i + 1}</span>
                {item.kind === "image" && item.path ? (
                  <ResourceThumb path={item.path} className="fc-collection-thumb" />
                ) : (
                  <span className={`fc-collection-text${item.kind !== "text" && !item.path ? " is-empty" : ""}`}>
                    {item.kind === "text" || item.label ? item.label : t("canvas.collectionItemEmpty")}
                  </span>
                )}
                <NodeHint text={t("canvas.collectionSortHint")} className="is-handle">
                  <button
                    type="button"
                    className="fc-collection-handle"
                    aria-label={t("canvas.collectionSortHint")}
                    onPointerDown={(e) => startReorder(i, e)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {Icons.drag}
                  </button>
                </NodeHint>
                <NodeHint text={t("common.delete")} className="is-remove">
                  <button
                    type="button"
                    className="fc-collection-remove"
                    aria-label={t("common.delete")}
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteConnection(item.connId);
                    }}
                  >
                    {Icons.close}
                  </button>
                </NodeHint>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
