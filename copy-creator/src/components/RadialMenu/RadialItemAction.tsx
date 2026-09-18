// 径向条目动作按钮的唯一出口：动作区按钮必须经本组件渲染——共享基类
// 挂载（radial-menu-item-action：盒子尺寸/hover 显现/焦点环/图标尺寸）
// 与事件冒泡拦截（点击/右键不触发条目粘贴，按下不武装拖拽）在此收口，
// 新增按钮不可能漏带基类或漏拦截冒泡（守卫规则 17）。专有差异（实心
// 收心态、预览触发标记）通过 className / data-* 传入。
import type { ComponentProps } from "react";

export default function RadialItemAction({
  className,
  onPointerDown,
  onClick,
  onContextMenu,
  ...rest
}: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...rest}
      className={`radial-menu-item-action${className ? ` ${className}` : ""}`}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown?.(event);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(event);
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick?.(event);
      }}
    />
  );
}
