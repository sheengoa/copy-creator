import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icons } from "../../../components/Icons";
import { NodeHint } from "./NodeHint";
import { WheelGate } from "./WheelGate";

// 参数组合框标准（用户 2026-11-01 定案「后续均按此」）：预设下拉 + 自由
// 键入并存（输入框失焦提交，点选预设即提交）；清单为与节点同源的毛玻璃
// 卡，portal 到窗口层 fixed 定位（防节点表单 overflow 裁切），WheelGate
// 滚轮隔离。自 FreeCanvas.tsx 整体迁出（基座化 2026-11-03）。
export function ParamCombo({
  comboKey,
  value,
  items,
  placeholder,
  toggleTitle,
  display,
  onCommit,
}: {
  comboKey: string;
  value: string;
  items: { value: string; label: string; hint?: string }[];
  placeholder?: string;
  toggleTitle: string;
  /** 非编辑态的取值展示：按当前值格式化为「主值 + 弱化尾注」（与下拉
   *  条目同款双段），点按换回原始输入框编辑——面板显示的是「选择后的
   *  样子」而非原始存储串。 */
  display?: (value: string) => { main: string; tail?: string } | null;
  onCommit: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 外点关闭（捕获阶段：画布空白按下不该先触发框选）。portal 弹层不在
  // rootRef 内，须放行——否则按下瞬间卸载弹层，条目的 click 永远收不到。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    // 展示态下输入框未挂载，锚点统一取容器矩形（宽度与控件一致）。
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ left: rect.left, top: rect.bottom + 4, width: rect.width });
    setOpen(true);
  };

  const applyPreset = (v: string) => {
    if (inputRef.current) inputRef.current.value = v;
    setEditing(false);
    setOpen(false);
    onCommit(v);
  };

  const fmt = display ? display(value) : null;
  const showDisplay = !editing && !!value && !!fmt?.tail;

  return (
    <div className="fc-combo" ref={rootRef}>
      {showDisplay && fmt ? (
        <button
          type="button"
          className="fc-node-input fc-combo-display"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setEditing(true)}
        >
          <span className="fc-combo-display-main">{fmt.main}</span>
          {fmt.tail && <span className="fc-combo-display-tail">{fmt.tail}</span>}
        </button>
      ) : (
        <input
          ref={inputRef}
          className="fc-node-input fc-combo-input"
          key={comboKey}
          defaultValue={value}
          placeholder={placeholder}
          autoFocus={editing}
          onBlur={(e) => {
            onCommit(e.target.value.trim());
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              // Esc：回退到已提交值并退出编辑（blur 原值提交，无副作用）。
              // 对展示态流程同样成立——输入框只在编辑态挂载。
              e.currentTarget.value = value;
              e.currentTarget.blur();
              setOpen(false);
            }
          }}
        />
      )}
      <NodeHint text={toggleTitle}>
        <button
          type="button"
          className={`fc-combo-toggle${open ? " is-open" : ""}`}
          aria-label={toggleTitle}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={toggle}
        >
          {Icons.chevronDown}
        </button>
      </NodeHint>
      {open && anchor && createPortal(
        <WheelGate>
          <div
            ref={popRef}
            className="fc-combo-pop"
            style={{ left: anchor.left, top: anchor.top, width: anchor.width }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {items.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`fc-combo-item${item.value === value ? " is-current" : ""}`}
                onClick={() => applyPreset(item.value)}
              >
                <span className="fc-combo-label">{item.label}</span>
                {item.hint && <span className="fc-combo-hint">{item.hint}</span>}
                {item.value === value && <i aria-hidden="true">{Icons.check}</i>}
              </button>
            ))}
          </div>
        </WheelGate>,
        document.body,
      )}
    </div>
  );
}
