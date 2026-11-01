import type { MouseEvent } from "react";

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** 悬停提示文案（如 开/关） */
  title?: string;
  /** 无可见文案时的无障碍名称 */
  ariaLabel?: string;
  /** 行内嵌套场景（如渠道列表行）用于阻断外层行点击冒泡 */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
}

// 设置页开关基准：40×24，亮色开态 #333、暗色开态白（iOS 设置风格）。
// 样式见 styles/ui.css 的 .ui-switch；禁止再手写第二套开关。
export function Toggle({ checked, onChange, disabled, title, ariaLabel, onClick }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      className={`ui-switch ${checked ? "on" : "off"}`}
      onClick={(e) => {
        onClick?.(e);
        onChange(!checked);
      }}
    >
      <span className="ui-switch-thumb" />
    </button>
  );
}
