// 资源页各对话框的受控状态类型：容器持有，对话框组件只读渲染。
export type ResourceGroupDialogState = {
  mode: "create" | "rename";
  parentPath?: string;
  oldName?: string;
} | null;
export type ResourceMoveDialogState = {
  ids: string[];
  label: string;
  meta: string;
  folders: string[];
} | null;
export type ResourceGroupMoveState = {
  path: string;
  target: string | null;
} | null;
